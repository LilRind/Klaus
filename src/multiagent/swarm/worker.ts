/**
 * s18 Swarm Worker（来源：SN roles/swarm/agent_protocol.py 单 Action 协议）。
 * 每轮恰好一个 Action（tool_call/publish_data/send_message/idle/done）；
 * 六项上下文注入；收敛检测（连续无工具/迭代上限）强制 idle；idle→reassign
 * 保留 Running Notes（keepLastN=5）且预算 +15、重派上限 2（SN 同款防护栏）。
 */

import type { ChatLLM } from "../../core/llm";
import type { ToolRegistry } from "../../tools/registry";
import { DEFAULTS, type P2PMessageType } from "../model";
import { extractJsonObject } from "../decompose";
import type { MailboxStore } from "../mailbox";
import type { WorkspaceStore } from "../workspace";
import { rolePrompt } from "./roles";

const WORKER_SYSTEM_PROMPT = [
  "你是多 Agent 团队的 worker。每轮只输出一个 Action JSON 对象（不要输出其他文字）：",
  '{"type":"tool_call","tool":"工具名","params":{...}}',
  '{"type":"publish_data","topic":"主题","data":"要广播的发现"}',
  '{"type":"send_message","to":"同伴或lead","messageType":"info","content":"..."}',
  '{"type":"idle","keyFindings":"关键发现摘要"}',
  '{"type":"done","summary":"最终交付说明"}',
  "规则：需要外部信息/落盘就 tool_call；有对全队有价值的发现就 publish_data；",
  "任务完成或无法继续时 idle（附 key_findings）；彻底交付后 done。",
].join("\n");

export interface WorkerTask {
  id: string;
  description: string;
}

export interface SwarmWorkerOptions {
  agentId: string;
  role: string;
  llm: ChatLLM;
  workspace: WorkspaceStore;
  mailbox: MailboxStore;
  tools: ToolRegistry;
  rosterSummary?: () => string;
  boardSummary?: () => string;
  iterationLimit?: number;
  noToolRoundsLimit?: number;
  now?: () => string;
  onEvent?: (event: { type: string; [key: string]: unknown }) => void;
}

export type WorkerSignal =
  | { type: "idle"; keyFindings?: string }
  | { type: "done"; summary?: string };

interface WorkerActionShape {
  type?: unknown;
  tool?: unknown;
  params?: unknown;
  topic?: unknown;
  data?: unknown;
  to?: unknown;
  messageType?: unknown;
  content?: unknown;
  keyFindings?: unknown;
  summary?: unknown;
}

export class SwarmWorker {
  readonly agentId: string;
  readonly role: string;
  status: "idle" | "running" | "done" = "idle";
  runningNotes: string[] = [];
  reassignCount = 0;

  private currentTask: WorkerTask | undefined;
  private readonly history: Array<{ role: "user" | "assistant"; content: string }> = [];
  private usedIterations = 0;
  private lastWorkspaceSeq = 0;
  private consecutiveNoTool = 0;
  private shutdownRequested = false;

  constructor(private readonly options: SwarmWorkerOptions) {
    this.agentId = options.agentId;
    this.role = options.role;
  }

  requestShutdown(): void {
    this.shutdownRequested = true;
  }

  /** 派活/重派：首个任务直接接受；重派上限 2；running 中拒绝新任务。 */
  assign(task: WorkerTask): boolean {
    if (this.currentTask && this.status === "running") return false;
    if (this.currentTask && this.reassignCount >= DEFAULTS.maxReassigns) return false;
    if (this.currentTask) {
      this.reassignCount += 1;
      // SN keepLastNOnReassign=5：保留最近 5 条历史
      if (this.history.length > 5) this.history.splice(0, this.history.length - 5);
    }
    this.currentTask = task;
    this.status = "running";
    this.consecutiveNoTool = 0;
    return true;
  }

  private iterationBudget(): number {
    return (this.options.iterationLimit ?? DEFAULTS.iterationLimit) + 15 * this.reassignCount;
  }

  private buildContext(): string {
    const sections: string[] = [];
    sections.push(`## 当前任务\n${this.currentTask?.id ?? "-"}：${this.currentTask?.description ?? ""}`);
    if (this.options.rosterSummary) sections.push(`## 团队名册\n${this.options.rosterSummary()}`);
    if (this.options.boardSummary) sections.push(`## 任务板\n${this.options.boardSummary()}`);
    const workspaceFresh = this.options.workspace.listAll(this.lastWorkspaceSeq);
    if (workspaceFresh.length > 0) {
      this.lastWorkspaceSeq = workspaceFresh.at(-1)?.seq ?? this.lastWorkspaceSeq;
      sections.push(
        `## Workspace 新数据\n${workspaceFresh.map((e) => `[${e.topic}] ${JSON.stringify(e.entry)}`).join("\n")}`,
      );
    }
    const inbox = this.options.mailbox.readInbox(this.agentId);
    if (inbox.length > 0) {
      sections.push(`## 收件箱\n${inbox.map((m) => `${m.from}(${m.type}): ${JSON.stringify(m.payload)}`).join("\n")}`);
    }
    if (this.runningNotes.length > 0) {
      sections.push(`## Running Notes\n${this.runningNotes.join("\n")}`);
    }
    sections.push(`## 预算\n第 ${this.usedIterations + 1} 轮 / 上限 ${this.iterationBudget()}`);
    const recent = this.history.slice(-3).map((m) => `${m.role}: ${m.content.slice(0, 400)}`);
    if (recent.length > 0) sections.push(`## 最近动作\n${recent.join("\n")}`);
    return sections.join("\n\n");
  }

  private record(role: "user" | "assistant", content: string): void {
    this.history.push({ role, content });
  }

  private forceIdle(reason: string): WorkerSignal {
    this.runningNotes.push(`强制收敛：${reason}`);
    this.status = "idle";
    return { type: "idle", keyFindings: `强制收敛（${reason}）` };
  }

  /** 单任务迭代循环：直到 idle/done/强制收敛。 */
  async runTask(): Promise<WorkerSignal> {
    if (!this.currentTask) throw new Error("没有待执行任务，先 assign");
    this.status = "running";

    while (true) {
      if (this.shutdownRequested) return this.forceIdle("收到 shutdown 请求");
      if (this.usedIterations >= this.iterationBudget()) {
        return this.forceIdle(`迭代上限 ${this.iterationBudget()}`);
      }

      const context = this.buildContext();
      this.record("user", context);
      const raw = await this.options.llm.invoke(
        [
          { role: "system", content: `${WORKER_SYSTEM_PROMPT}\n\n# 角色方法论：${this.rolePromptLine()}` },
          ...this.history,
        ],
        { temperature: 0.3 },
      );
      this.record("assistant", raw);
      this.usedIterations += 1;

      const parsed = extractJsonObject(raw) as WorkerActionShape | undefined;
      if (!parsed || typeof parsed.type !== "string") {
        this.record("user", "观察：无法解析 Action JSON，请只输出一个 Action 对象。");
        this.consecutiveNoTool += 1;
        if (this.consecutiveNoTool >= (this.options.noToolRoundsLimit ?? 3)) {
          return this.forceIdle(`连续 ${this.consecutiveNoTool} 轮无有效工具动作`);
        }
        continue;
      }

      switch (parsed.type) {
        case "tool_call": {
          const tool = String(parsed.tool ?? "");
          const params =
            parsed.params && typeof parsed.params === "object"
              ? (parsed.params as Record<string, unknown>)
              : {};
          let observation: string;
          try {
            observation = await this.options.tools.executeToolArgs(tool, params);
          } catch (error) {
            observation = `工具调用失败：${error instanceof Error ? error.message : String(error)}`;
          }
          this.options.onEvent?.({ type: "worker.tool_call", agentId: this.agentId, tool });
          this.record("user", `工具结果：${observation}`);
          this.consecutiveNoTool = 0;
          break;
        }
        case "publish_data": {
          const topic = String(parsed.topic ?? "findings");
          this.options.workspace.append(topic, { data: String(parsed.data ?? ""), agentId: this.agentId });
          this.options.onEvent?.({ type: "worker.publish", agentId: this.agentId, topic });
          this.record("user", `观察：已广播到主题 ${topic}。`);
          this.bumpNoTool();
          break;
        }
        case "send_message": {
          const messageType = (typeof parsed.messageType === "string"
            ? parsed.messageType
            : "info") as P2PMessageType;
          this.options.mailbox.send(this.agentId, String(parsed.to ?? "lead"), messageType, {
            content: String(parsed.content ?? ""),
          });
          this.options.onEvent?.({ type: "worker.message", agentId: this.agentId, to: String(parsed.to ?? "") });
          this.record("user", `观察：消息已发送给 ${String(parsed.to ?? "")}。`);
          this.bumpNoTool();
          break;
        }
        case "idle": {
          const keyFindings = typeof parsed.keyFindings === "string" ? parsed.keyFindings : undefined;
          this.runningNotes.push(`完成 ${this.currentTask.id}: ${keyFindings ?? "(无摘要)"}`);
          this.status = "idle";
          this.options.onEvent?.({ type: "worker.idle", agentId: this.agentId });
          return { type: "idle", keyFindings };
        }
        case "done": {
          const summary = typeof parsed.summary === "string" ? parsed.summary : undefined;
          this.runningNotes.push(`交付 ${this.currentTask.id}: ${summary ?? "(无摘要)"}`);
          this.status = "done";
          this.options.onEvent?.({ type: "worker.done", agentId: this.agentId });
          return { type: "done", summary };
        }
        default: {
          this.record("user", `观察：未知 Action 类型 ${String(parsed.type)}，请从五种 Action 中选择。`);
          this.bumpNoTool();
        }
      }

      if (this.consecutiveNoTool >= (this.options.noToolRoundsLimit ?? 3)) {
        return this.forceIdle(`连续 ${this.consecutiveNoTool} 轮无工具调用`);
      }
    }
  }

  private bumpNoTool(): void {
    this.consecutiveNoTool += 1;
  }

  private rolePromptLine(): string {
    return rolePrompt(this.role);
  }
}
