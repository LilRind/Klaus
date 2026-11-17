/**
 * s18 Swarm Lead（来源：SN swarm_workflow.go Lead 循环 + lead_protocol.py 12 Action）。
 * decide：无工具 LLM → parseLeadActions 校验（非法降级 noop）；空 checkpoint 跳过 LLM；
 * 连续 2 轮空 checkpoint 强制 done；interim 节流 60s。execute：动作分发给
 * 任务板/工人/邮箱/文件（file_read 0 token 直读）。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import type { ChatLLM } from "../../core/llm";
import type { LeadAction, LeadEvent, P2PMessageType } from "../model";
import { extractJsonObject } from "../decompose";
import type { MailboxStore } from "../mailbox";
import type { WorkspaceStore } from "../workspace";
import type { TaskBoardStore } from "./board";

const LEAD_SYSTEM_PROMPT = [
  "你是多 Agent 团队的 Lead（协调者）。根据事件与团队状态，输出下一步动作列表。",
  '只输出 JSON：{"actions":[{...},...]}，每个动作一个对象。动作词汇表：',
  '{"type":"create_task","id":"t1","description":"...","dependsOn":[]}',
  '{"type":"spawn_agent","agentId":"w1","role":"researcher","taskId":"t1","taskDescription":"...","tier":"small|medium|large"}',
  '{"type":"assign_task","agentId":"w1","taskId":"t2","taskDescription":"..."}',
  '{"type":"cancel_task","taskId":"t1"} {"type":"revise_plan","create":[...],"update":[...],"cancel":["t1"]}',
  '{"type":"send_message","to":"w1","content":"..."} {"type":"broadcast","content":"..."}',
  '{"type":"shutdown_agent","agentId":"w1"} {"type":"interim_reply","content":"给用户的简短进展"}',
  '{"type":"final_reply","content":"最终回答"} {"type":"synthesize"} {"type":"done"}',
  '{"type":"file_read","path":"相对路径"}（0 成本地读产物）',
  "原则：worker idle 且质量不足→先 file_read 核查再 RETRY；无活可派且全 idle→final_reply 或 synthesize 后 done。",
].join("\n");

const KNOWN_ACTION_TYPES = new Set([
  "spawn_agent", "assign_task", "create_task", "cancel_task", "revise_plan",
  "send_message", "broadcast", "shutdown_agent", "interim_reply", "final_reply",
  "synthesize", "done", "file_read", "tool_call", "noop",
]);

function coerceAction(raw: unknown): LeadAction | { type: "noop"; reason: string } {
  if (raw === null || typeof raw !== "object") {
    return { type: "noop", reason: "动作不是对象" };
  }
  const value = raw as Record<string, unknown>;
  const type = value.type;
  if (typeof type !== "string" || !KNOWN_ACTION_TYPES.has(type)) {
    return { type: "noop", reason: `非法动作 ${String(type)}` };
  }
  return value as unknown as LeadAction;
}

/** 解析 Lead 输出：支持 {"actions":[...]} 或裸数组；非法动作逐个降级 noop。 */
export function parseLeadActions(text: string): LeadAction[] {
  const parsed = extractJsonObject(text);
  if (parsed === undefined) return [{ type: "noop", reason: "输出不含 JSON" }];
  const list = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === "object" && Array.isArray((parsed as Record<string, unknown>).actions)
      ? ((parsed as Record<string, unknown>).actions as unknown[])
      : [parsed];
  return list.map((item) => coerceAction(item));
}

export interface LeadWorkerHandle {
  agentId: string;
  role: string;
  status: "running" | "idle" | "done";
  assign(task: { id: string; description: string }): boolean;
  requestShutdown(): void;
}

export interface LeadEngineOptions {
  llm: ChatLLM;
  workspace: WorkspaceStore;
  mailbox: MailboxStore;
  board: TaskBoardStore;
  spawnWorker: (action: Extract<LeadAction, { type: "spawn_agent" }>) => LeadWorkerHandle;
  workers: () => LeadWorkerHandle[];
  emit: (type: string, data?: Record<string, unknown>) => void;
  onInterim?: (content: string) => void;
  workspaceRoot?: string;
  now?: () => number;
  interimThrottleMs?: number;
  maxWorkers?: number;
}

export class LeadEngine {
  lastObservation = "";
  private finalReplyValue: string | undefined;
  private doneRequested = false;
  private synthesizeRequested = false;
  private idleCheckpoints = 0;
  private lastInterimAt = Number.NEGATIVE_INFINITY;
  private lastWorkspaceSeq = 0;

  constructor(private readonly options: LeadEngineOptions) {}

  get finalReply(): string | undefined {
    return this.finalReplyValue;
  }

  get isDone(): boolean {
    return this.doneRequested;
  }

  get wantsSynthesis(): boolean {
    return this.synthesizeRequested;
  }

  /** 一次决策。空 checkpoint（全忙且无 pending）跳过 LLM；连续 2 轮强制 done。 */
  async decide(event: LeadEvent): Promise<LeadAction[]> {
    if (event.type === "checkpoint") {
      const workers = this.options.workers();
      const allBusy = workers.length > 0 && workers.every((worker) => worker.status === "running");
      const noPending = this.options.board.pending().length === 0;
      if (allBusy && noPending) {
        this.idleCheckpoints += 1;
        if (this.idleCheckpoints >= 2) {
          this.options.emit("checkpoint.forced_done", { consecutive: this.idleCheckpoints });
          return [{ type: "done" }];
        }
        this.options.emit("checkpoint.skipped", { consecutive: this.idleCheckpoints });
        return [];
      }
    }
    this.idleCheckpoints = 0;

    const fresh = this.options.workspace.listAll(this.lastWorkspaceSeq);
    if (fresh.length > 0) this.lastWorkspaceSeq = fresh.at(-1)?.seq ?? this.lastWorkspaceSeq;
    const context = [
      `## 事件\n${JSON.stringify(event)}`,
      `## 任务板\n${this.options.board.snapshot()}`,
      `## 团队状态\n${this.options.workers().map((w) => `${w.agentId}(${w.role})=${w.status}`).join("\n") || "（无 worker）"}`,
      `## Workspace 新数据\n${fresh.map((e) => `[${e.topic}] ${JSON.stringify(e.entry)}`).join("\n") || "（无）"}`,
      this.lastObservation ? `## 最近观察\n${this.lastObservation}` : "",
    ].filter(Boolean).join("\n\n");
    const raw = await this.options.llm.invoke(
      [
        { role: "system", content: LEAD_SYSTEM_PROMPT },
        { role: "user", content: context },
      ],
      { temperature: 0.3 },
    );
    const actions = parseLeadActions(raw);
    this.options.emit("lead.decision", { types: actions.map((a) => a.type) });
    return actions;
  }

  /** 执行动作列表（逐个分发并打点）。 */
  async execute(actions: LeadAction[]): Promise<void> {
    for (const action of actions) {
      await this.executeOne(action);
    }
  }

  private async executeOne(action: LeadAction): Promise<void> {
    const emit = this.options.emit;
    switch (action.type) {
      case "noop":
        emit("lead.noop", { reason: action.reason });
        return;
      case "create_task": {
        this.options.board.create({ id: action.id, description: action.description, dependsOn: action.dependsOn });
        emit("task.created", { taskId: action.id });
        return;
      }
      case "cancel_task": {
        this.options.board.cancel(action.taskId);
        emit("task.cancelled", { taskId: action.taskId });
        return;
      }
      case "revise_plan": {
        for (const create of action.create ?? []) {
          this.options.board.create({ id: create.id, description: create.description, dependsOn: create.dependsOn });
          emit("task.created", { taskId: create.id });
        }
        for (const update of action.update ?? []) {
          this.options.board.update(update.id, update.description);
        }
        for (const cancel of action.cancel ?? []) this.options.board.cancel(cancel);
        emit("lead.revised_plan", { created: action.create?.length ?? 0, cancelled: action.cancel?.length ?? 0 });
        return;
      }
      case "spawn_agent": {
        const current = this.options.workers().length;
        if (current >= (this.options.maxWorkers ?? 6)) {
          emit("swarm.spawn.rejected", { agentId: action.agentId, current });
          return;
        }
        const worker = this.options.spawnWorker(action);
        if (action.taskId) this.options.board.claim(action.taskId, worker.agentId);
        emit("swarm.agent_started", { agentId: worker.agentId, role: worker.role, taskId: action.taskId });
        return;
      }
      case "assign_task": {
        const worker = this.options.workers().find((w) => w.agentId === action.agentId);
        const task = this.options.board.get(action.taskId);
        const description = action.taskDescription ?? task?.description ?? action.taskId;
        const ok = worker?.assign({ id: action.taskId, description }) ?? false;
        if (ok) this.options.board.claim(action.taskId, action.agentId);
        emit(ok ? "swarm.assigned" : "swarm.assign.rejected", { agentId: action.agentId, taskId: action.taskId });
        return;
      }
      case "send_message": {
        this.options.mailbox.send("lead", action.to, action.messageType ?? "info", { content: action.content });
        emit("lead.message", { to: action.to });
        return;
      }
      case "broadcast": {
        for (const worker of this.options.workers()) {
          this.options.mailbox.send("lead", worker.agentId, "info", { content: action.content });
        }
        emit("lead.broadcast", { count: this.options.workers().length });
        return;
      }
      case "shutdown_agent": {
        this.options.workers().find((w) => w.agentId === action.agentId)?.requestShutdown();
        emit("swarm.shutdown_requested", { agentId: action.agentId });
        return;
      }
      case "interim_reply": {
        const now = this.options.now?.() ?? Date.now();
        const throttle = this.options.interimThrottleMs ?? 60_000;
        if (now - this.lastInterimAt < throttle) {
          emit("interim.throttled", { content: action.content });
          return;
        }
        this.lastInterimAt = now;
        this.options.onInterim?.(action.content);
        emit("interim.sent", { content: action.content });
        return;
      }
      case "final_reply": {
        this.finalReplyValue = action.content;
        emit("swarm.final", { chars: action.content.length });
        return;
      }
      case "synthesize": {
        this.synthesizeRequested = true;
        emit("swarm.synthesize_requested", {});
        return;
      }
      case "done": {
        this.doneRequested = true;
        emit("swarm.done", {});
        return;
      }
      case "file_read": {
        const root = this.options.workspaceRoot;
        if (!root) {
          this.lastObservation = "（未配置 workspaceRoot，file_read 不可用）";
          emit("lead.file_read_failed", { path: action.path });
          return;
        }
        try {
          const content = readFileSync(path.join(root, action.path), "utf-8");
          this.lastObservation = `file_read ${action.path}:\n${content}`;
          emit("lead.file_read", { path: action.path, chars: content.length });
        } catch (error) {
          this.lastObservation = `file_read ${action.path} 失败：${error instanceof Error ? error.message : String(error)}`;
          emit("lead.file_read_failed", { path: action.path });
        }
        return;
      }
      case "tool_call": {
        this.lastObservation = "（Lead 工具执行未配置，动作按 noop 处理）";
        emit("lead.noop", { reason: "lead tool_call 未配置" });
        return;
      }
    }
  }
}
