/**
 * S18 执行器（来源：dsh-superagent src/executor/dsh.ts 的进程内等价物）。
 *
 * InProcessExecutor：一票一个 FunctionCallAgent 实例 + 一个独立 workspace 目录
 * （dsh"一票一 Session 一目录"的单进程翻译）；WorkerSlots 同步预留并发槽防竞态
 * （dsh WorkerSlots 裁剪版——人超配 +1 属 follow-up 批次）。worker 无人值守：
 * 不向控制台输出，一切结果经 Engine.report → outbox → reply effect 投递。
 * ExecutorPort 的 carrier 形态（外部 CLI 子进程）为遗留项，接口已预留。
 */

import { appendFile, mkdir } from "node:fs/promises";
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
        systemPrompt: `你是工单 ${ticket.id}（${ticket.title}）的执行 worker，无人值守。工作目录即你的唯一工作区。完成后在最终回答中说明：做了什么、关键产出路径、遗留问题。若确需人工决策，最终回答第一行输出 "NEEDS_DECISION: <一句话问题>"。`,
      },
    );
  };
}

/** worker 需人工决策时的首行标记（批 2 协议：进程内 worker 产生 blocked 的唯一通道）。 */
export const NEEDS_DECISION_PREFIX = "NEEDS_DECISION:";

/** recovery note：dsh docs/003 Restart 原文精神的中文版。 */
export const RECOVERY_NOTE =
  "此工单曾被打断。先读本目录 transcript.jsonl 与已有产出，避免重复外部动作，再继续完成。";

/** 组装给 worker 的任务说明（scope 是唯一边界，title 只是标识）。 */
export function assignmentPrompt(ticket: Ticket, recovery = false): string {
  const lines = [
    `工单：${ticket.title}`,
    `边界：${ticket.mandate.scope}`,
    '若需人工决策才能继续：最终回答第一行输出 "NEEDS_DECISION: <一句话问题>"，其余行给出上下文。',
    "请在此工位目录内完成上述工作；不越界、完成后给出最终总结。",
  ];
  if (recovery) lines.unshift(RECOVERY_NOTE);
  return lines.join("\n");
}

/** 解析 worker 回答：NEEDS_DECISION 首行 → blocked 问题；否则为普通完成总结。 */
export function parseWorkerAnswer(
  answer: string,
): { blocked: true; question: string } | { blocked: false } {
  const firstLine = answer.split("\n", 1)[0] ?? "";
  const match = firstLine.match(/^NEEDS_DECISION:\s*(.+)$/);
  if (match) return { blocked: true, question: match[1]!.trim() };
  return { blocked: false };
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
  /** 保活的 worker 实例（blocked 等答案的票；票终态或重新 launch 时清理/覆盖）。 */
  private readonly agents = new Map<string, WorkerAgent>();

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
      this.agents.set(ticket.id, agent);
      const prompt = assignmentPrompt(ticket, payload.recovery === true);
      const answer = await agent.run(prompt);
      await this.appendTranscript(ticket.id, prompt, answer);
      this.settle(ticket.id, answer);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      this.agents.delete(ticket.id);
      if (started) {
        engine.report(ticket.id, { kind: "failed", text: `worker 执行失败：${text}` });
        return;
      }
      throw error; // assignmentStarted 之前失败：让 effect 记错重试
    } finally {
      slots.free(ticket.id);
    }
  }

  /**
   * effects.deliver handler（批 2）：把累积的 answer 依次追加为 worker 对话轮。
   * 已读边界（dsh claim→history 的同构）：每轮 run 完成 + report 后才算消费——
   * 中途崩溃则 effect 行未删，重启 pump 重投（幂等：重复收到 answer 最多重复作答）。
   * 票已终态：清实例并静默完成（删行不投）。
   */
  async deliver(payload: EffectPayloads["deliver"]): Promise<void> {
    const { store } = this.options;
    const ticket = store.getTicket(payload.ticketId);
    if (!ticket || ticket.ended) {
      this.agents.delete(payload.ticketId);
      return;
    }
    const agent = this.agents.get(payload.ticketId);
    if (!agent) {
      throw new Error(`工单 ${payload.ticketId} 没有保活的 worker 实例（deliver 无法投递）`);
    }
    for (const text of payload.texts) {
      const current = store.getTicket(payload.ticketId);
      if (!current || current.ended) break;
      const answer = await agent.run(text);
      await this.appendTranscript(payload.ticketId, text, answer);
      this.settle(payload.ticketId, answer);
    }
  }

  /** 是否有保活实例（测试/诊断用）。 */
  hasAgent(ticketId: string): boolean {
    return this.agents.has(ticketId);
  }

  /** 解析回答并落 report：blocked 保活实例；ready 清理实例。 */
  private settle(ticketId: string, answer: string): void {
    const parsed = parseWorkerAnswer(answer.trim());
    if (parsed.blocked) {
      this.options.engine.report(ticketId, { kind: "blocked", text: parsed.question });
      return;
    }
    this.options.engine.report(ticketId, {
      kind: "ready",
      text: answer.trim() || "(无总结)",
    });
    this.agents.delete(ticketId);
  }

  /** transcript 接档（dsh ticket/<id>/transcript 资源的最小版）：每轮 input/answer 追加 JSONL。 */
  private async appendTranscript(ticketId: string, input: string, answer: string): Promise<void> {
    const entry = {
      at: this.options.now?.() ?? new Date().toISOString(),
      ticketId,
      input,
      answer,
    };
    await appendFile(
      path.join(this.workspaceOf(ticketId), "transcript.jsonl"),
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  }
}
