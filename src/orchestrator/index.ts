/**
 * S18 编排系统组装层：Store + Engine + Effects + Executor 一条龙。
 *
 * 组装契约（dsh Runtime 裁剪版）：
 * - effects.launch → InProcessExecutor.launch（槽满抛 Later 不计失败）；
 * - effects.reply → outbox 投递到 onMessage sink 并标记 sent（ordered 保序）；
 * - effects.deliver → InProcessExecutor.deliver（answer 追加轮，ordered）；
 * - submit(text) 是 REPL 的全链路入口：Trigger → assessTrigger → Engine.decide。
 * - 文件库：proper-lockfile 目录锁（复刻 dsh runtime）+ 启动崩溃恢复 sweep。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { lockSync } from "proper-lockfile";
import type { ChatLLM } from "../core/llm";
import {
  newId,
  type Decision,
  type DomainEvent,
  type OutboxMessage,
  type Trigger,
} from "./model";
import { OrchestrationStore } from "./store";
import { Effects } from "./effects";
import { Engine, OrchestratorError, type RecoverySummary } from "./engine";
import {
  InProcessExecutor,
  WorkerSlots,
  defaultAgentFactory,
  type WorkerAgentFactory,
} from "./executor";
import { assessTrigger, type AssessmentOutcome } from "./assessment";

export * from "./model";
export * from "./kv";
export * from "./store";
export * from "./effects";
export * from "./assessment";
export * from "./executor";
export * from "./engine";

export interface OrchestratorOptions {
  /** SQLite 库路径；默认 ":memory:"（REPL 传文件路径获得跨重启状态）。 */
  dbPath?: string;
  /** worker 工位根目录：每票一个子目录。 */
  workspaceRoot: string;
  /** 研判器与 worker 共用的 LLM（测试注入 ScriptedLLM）。 */
  llm: ChatLLM;
  /** 并发 worker 槽上限，默认 3。 */
  maxWorkers?: number;
  /** Engine 时钟（ISO 字符串，测试注入）。 */
  now?: () => string;
  /** Effects 时钟（毫秒，测试注入）。 */
  effectClock?: () => number;
  /** 领域事件订阅。 */
  onEvent?: (event: DomainEvent) => void;
  /** outbox 投递 sink（REPL 打印）；不传则消息标 sent 后丢弃文本。 */
  onMessage?: (message: OutboxMessage) => void;
  /** worker 工厂（测试注入假 agent）。 */
  createAgent?: WorkerAgentFactory;
  /** 启动时执行崩溃恢复 sweep；文件库默认 true，":memory:" 默认 false。 */
  recoverOnStart?: boolean;
}

export interface SubmitResult {
  trigger: Trigger;
  outcome: AssessmentOutcome;
  decision: Decision;
}

export interface Orchestrator {
  readonly engine: Engine;
  readonly store: OrchestrationStore;
  readonly effects: Effects;
  readonly executor: InProcessExecutor;
  /** 全链路提交：Trigger → 研判 → Decision。 */
  submit(text: string): Promise<SubmitResult>;
  /** 回答某票 Attention（入队 deliver effect，worker 下一轮收到）。 */
  answer(ticketId: string, text: string): void;
  /** 启动恢复摘要（未发生恢复或关闭恢复时为 undefined）。 */
  readonly recovery: RecoverySummary | undefined;
  /** 泵 effect 队列（REPL 提交后/定时调用；测试手动驱动）。 */
  pump(): Promise<void>;
  close(): void;
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const dbPath = options.dbPath ?? ":memory:";
  const useLock = dbPath !== ":memory:";
  if (useLock) mkdirSync(dirname(dbPath), { recursive: true });
  // 目录锁（复刻 dsh runtime.ts：lockSync + stale 30s + onCompromised）
  let compromised: Error | undefined;
  let releaseLock: (() => void) | undefined;
  if (useLock) {
    const release = lockSync(dirname(dbPath), {
      stale: 30_000,
      onCompromised: (error: Error) => {
        // dsh 完整版置 runtimeHealth=error 并中止 Sources；本实现由 pump 抛出
        compromised = error;
      },
    });
    releaseLock = () => release();
  }
  const store = new OrchestrationStore(dbPath);
  const nowIso = options.now ?? (() => new Date().toISOString());
  const engine = new Engine({ store, now: nowIso, emit: options.onEvent });
  const effects = new Effects(store, options.effectClock);

  const runningTickets = (): string[] => {
    const ids: string[] = [];
    for (const ticket of store.listTickets()) {
      const assignment = ticket.assignmentId
        ? store.getAssignment(ticket.assignmentId)
        : undefined;
      if (assignment?.status === "running") ids.push(ticket.id);
    }
    return ids;
  };
  const slots = new WorkerSlots(runningTickets, () => options.maxWorkers ?? 3);
  const executor = new InProcessExecutor({
    engine,
    store,
    slots,
    workspaceRoot: options.workspaceRoot,
    createAgent: options.createAgent ?? defaultAgentFactory(options.llm),
  });

  effects.handle("launch", (payload) => executor.launch(payload), { concurrent: true });
  effects.handle("deliver", (payload) => executor.deliver(payload), { ordered: true });
  effects.handle(
    "reply",
    (payload) => {
      const message = store.getOutbox(payload.messageId);
      if (!message || message.status !== "queued") return;
      options.onMessage?.(message);
      message.status = "sent";
      message.sentAt = nowIso();
      store.saveOutbox(message);
    },
    { ordered: true },
  );

  const recovery =
    options.recoverOnStart ?? useLock ? engine.recoverAfterRestart() : undefined;

  return {
    engine,
    store,
    effects,
    executor,
    recovery,
    async submit(text: string): Promise<SubmitResult> {
      const trigger: Trigger = {
        id: newId("in"),
        text,
        at: nowIso(),
        human: true,
        addressed: "direct",
      };
      if (engine.receive(trigger) === "duplicate") {
        throw new OrchestratorError("duplicateTrigger", `Trigger ${trigger.id} 重复提交`);
      }
      const outcome = await assessTrigger(options.llm, trigger);
      const decision = engine.decide(trigger.id, outcome);
      return { trigger, outcome, decision };
    },
    answer(ticketId: string, text: string): void {
      engine.answerAttention(ticketId, text);
    },
    pump: () => {
      if (compromised) throw compromised;
      return effects.drain();
    },
    close: () => {
      store.close();
      releaseLock?.();
    },
  };
}
