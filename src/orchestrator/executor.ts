/**
 * S18 执行器（来源：dsh-superagent src/executor/dsh.ts 的进程内等价物）。
 *
 * InProcessExecutor：一票一个 FunctionCallAgent 实例 + 一个独立 workspace 目录
 * （dsh"一票一 Session 一目录"的单进程翻译）；WorkerSlots 同步预留并发槽防竞态
 * （dsh WorkerSlots 裁剪版——人超配 +1 属 follow-up 批次）。worker 无人值守：
 * 不向控制台输出，一切结果经 Engine.report → outbox → reply effect 投递。
 * ExecutorPort 的 carrier 形态（外部 CLI 子进程）为遗留项，接口已预留。
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { ChatLLM } from "../core/llm";
import { FunctionCallAgent } from "../agents/function-call-agent";
import { ToolRegistry } from "../tools/registry";
import {
  EditFileTool,
  GlobTool,
  ReadFileTool,
  WriteFileTool,
} from "../tools/builtin/file-tools";
import type { Ticket } from "./model";
import type { EngineForExecutor } from "./engine";
import type { OrchestrationStore } from "./store";
import { Later, type EffectPayloads } from "./effects";

/** 并发槽（dsh WorkerSlots）：同步预留，两个 launch 不可能抢走最后一个名额。 */
export class WorkerSlots {
  private readonly starting = new Set<string>();

  constructor(
    private readonly running: () => string[],
    private readonly max: () => number,
  ) {}

  used(): number {
    return new Set([...this.running(), ...this.starting]).size;
  }

  reserve(ticketId: string): void {
    if (this.starting.has(ticketId)) return;
    if (this.used() >= this.max()) throw new Later("无空闲 worker 槽");
    this.starting.add(ticketId);
  }

  free(ticketId: string): void {
    this.starting.delete(ticketId);
  }
}

/** worker 的最小执行面（测试可注入假实现；外部 CLI carrier 未来实现同一接口）。 */
export interface WorkerAgent {
  run(prompt: string): Promise<string>;
}

export type WorkerAgentFactory = (ticket: Ticket, workspaceDir: string) => WorkerAgent;

/** 默认工厂：每票新建 FunctionCallAgent，file 四件套工具锁定在该票目录内。 */
export function defaultAgentFactory(llm: ChatLLM): WorkerAgentFactory {
  return (ticket, workspaceDir) => {
    const registry = new ToolRegistry()
      .register(new ReadFileTool({ workspace: workspaceDir }))
      .register(new WriteFileTool({ workspace: workspaceDir }))
      .register(new EditFileTool({ workspace: workspaceDir }))
      .register(new GlobTool({ workspace: workspaceDir }));
    return new FunctionCallAgent(
      `worker-${ticket.id}`,
      llm,
      registry,
      {
        systemPrompt: `你是工单 ${ticket.id}（${ticket.title}）的执行 worker，无人值守。工作目录即你的唯一工作区。完成后在最终回答中说明：做了什么、关键产出路径、遗留问题；不要向人提问。`,
      },
    );
  };
}

/** 组装给 worker 的任务说明（scope 是唯一边界，title 只是标识）。 */
export function assignmentPrompt(ticket: Ticket): string {
  return [
    `工单：${ticket.title}`,
    `边界：${ticket.mandate.scope}`,
    "请在此工位目录内完成上述工作；不越界、不等待人工；完成后给出最终总结。",
  ].join("\n");
}

export interface InProcessExecutorOptions {
  engine: EngineForExecutor;
  store: OrchestrationStore;
  slots: WorkerSlots;
  workspaceRoot: string;
  /** 必传：注入 LLM 工厂（defaultAgentFactory(llm)）或测试假工厂。 */
  createAgent: WorkerAgentFactory;
  now?: () => string;
}

export class InProcessExecutor {
  constructor(private readonly options: InProcessExecutorOptions) {}

  workspaceOf(ticketId: string): string {
    return path.join(this.options.workspaceRoot, ticketId);
  }

  /** effects.launch handler：槽满抛 Later（不计失败），其余失败一律 report failed。 */
  async launch(payload: EffectPayloads["launch"]): Promise<void> {
    const { engine, store, slots } = this.options;
    const ticket = store.getTicket(payload.ticketId);
    if (!ticket || ticket.ended) return; // 票已不存在/已结束：静默完成
    const assignment = store.getAssignment(payload.assignmentId);
    if (!assignment || assignment.status !== "pending") return;
    slots.reserve(ticket.id);
    let started = false;
    try {
      await mkdir(this.workspaceOf(ticket.id), { recursive: true });
      engine.assignmentStarted(ticket.id);
      started = true;
      const agent = this.options.createAgent(ticket, this.workspaceOf(ticket.id));
      const answer = await agent.run(assignmentPrompt(ticket));
      engine.report(ticket.id, { kind: "ready", text: answer.trim() || "(无总结)" });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (started) {
        engine.report(ticket.id, { kind: "failed", text: `worker 执行失败：${text}` });
        return;
      }
      throw error; // assignmentStarted 之前失败：让 effect 记错重试
    } finally {
      slots.free(ticket.id);
    }
  }
}
