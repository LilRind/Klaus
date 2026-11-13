/**
 * S18 多 Agent 编排领域模型（非 lcc 复刻；来源：dsh-superagent 裁剪版 + clowder 单终态不变量）。
 *
 * 裁剪决策（相对 dsh，见 Needs_improvement/lcc-ts/S18多Agent编排-方案.md）：
 * - 保留：Trigger 幂等 / Mandate(strength) / Ticket / Assignment / Report 五态 /
 *   Attention 结构化问题 / Decision / Outbox。
 * - 简化：Gate——本地 REPL 单人场景恒为 explicit 直通，strength 字段按 dsh 预留
 *   （GitHub Source 批次启用准入）。
 * - 砍掉（后续批次）：admission 表 / bot 名单 / policy 版本化 / follow-up 所有权 /
 *   handback / Thread 攒批 Eval / Source 插件。
 */

/** 授权强度（dsh Strength）：MVP 里 REPL 直达恒为 explicit，字段为 Source 批次预留。 */
export type Strength = "explicit" | "inferred";

/** 一次不可变的用户输入事件（dsh Trigger 裁剪版：本地 REPL 直达）。 */
export interface Trigger {
  id: string;
  text: string;
  at: string;
  human: true;
  addressed: "direct";
}

/** 授权凭据（dsh Mandate 裁剪版）：记录这票工作的强度与来源。 */
export interface Mandate {
  strength: Strength;
  /** basis 预留多来源：MVP 只有 repl 与 assessment（研判拆出的子票）。 */
  basis: "repl" | "assessment";
  scope: string;
}

/** 待人工决定的结构化问题（dsh Attention）：一次一个问题，禁止从自由文本推断。 */
export interface Attention {
  question: string;
  at: string;
}

/** worker 汇报五态（dsh Report 状态机）。 */
export type ReportKind = "progress" | "ready" | "blocked" | "failed" | "dropped";

export interface WorkerReport {
  kind: ReportKind;
  text: string;
  at: string;
  /** blocked 时必须携带（或由 text 生成）的问题。 */
  attention?: Attention;
}

export type AssignmentStatus = "pending" | "running" | "ended";

/** 恰一终态且不可撤销（clowder 不变量）；interrupted = 进程重启对账（批 2）。 */
export type AssignmentOutcome =
  | "completed"
  | "failed"
  | "dropped"
  | "stopped"
  | "interrupted";

export interface AssignmentEnded {
  outcome: AssignmentOutcome;
  at: string;
  reason: string;
}

export interface Assignment {
  id: string;
  ticketId: string;
  status: AssignmentStatus;
  createdAt: string;
  startedAt?: string;
  ended?: AssignmentEnded;
}

export type TicketOutcome = "completed" | "failed" | "dropped" | "stopped";

export interface TicketEnded {
  outcome: TicketOutcome;
  at: string;
  reason: string;
}

/** 工单：一次授权工作的载体（一票一 assignment 一 worker 一目录）。 */
export interface Ticket {
  id: string;
  title: string;
  scope: string;
  mandate: Mandate;
  triggerId: string;
  createdAt: string;
  /** 当前（首个）assignment 的 id。 */
  assignmentId?: string;
  attention?: Attention;
  /** 被进程重启打断的次数（批 2 恢复上限依据）。 */
  interruptions?: number;
  ended?: TicketEnded;
}

export type DecisionKind = "accept" | "ignore";

/** 研判结论（dsh Decision 裁剪版）：一个 Trigger 恰好一个 Decision。 */
export interface Decision {
  id: string;
  triggerId: string;
  kind: DecisionKind;
  reason: string;
  ticketIds: string[];
  at: string;
}

export type OutboxStatus = "queued" | "sent" | "dropped";

/** 出站消息（dsh Outbox 裁剪版）：同 Ticket 严格按 seq 顺序投递。 */
export interface OutboxMessage {
  id: string;
  ticketId: string;
  text: string;
  status: OutboxStatus;
  queuedAt: string;
  sentAt?: string;
}

/** 领域事件（dsh DomainEvents 子集）：Engine 每次变更后发出，REPL/测试可订阅。 */
export type DomainEvent =
  | { type: "trigger.received"; triggerId: string }
  | { type: "decision.recorded"; triggerId: string; kind: DecisionKind }
  | { type: "ticket.created"; ticketId: string }
  | { type: "ticket.ended"; ticketId: string; outcome: TicketOutcome }
  | { type: "assignment.started"; ticketId: string; assignmentId: string }
  | {
      type: "assignment.ended";
      ticketId: string;
      assignmentId: string;
      outcome: AssignmentOutcome;
    }
  | { type: "report.recorded"; ticketId: string; kind: ReportKind }
  | { type: "attention.raised"; ticketId: string }
  | { type: "attention.cleared"; ticketId: string };

export const liveTicket = (ticket: Ticket): boolean => !ticket.ended;

/** id 生成：`<prefix>-<base36 时间>-<自增>`，进程内单调（重启后时间位保证不碰撞）。 */
let idCounter = 0;
export function newId(prefix: string, now: () => number = Date.now): string {
  idCounter += 1;
  return `${prefix}-${now().toString(36)}-${idCounter.toString(36)}`;
}
