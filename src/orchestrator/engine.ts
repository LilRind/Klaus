/**
 * S18 编排领域内核（来源：dsh-superagent src/core/engine.ts 裁剪移植）。
 *
 * Engine 是 trigger/ticket/assignment/report/decision/outbox 的唯一写入者：
 * - 全同步命令，每命令 store.atomic() 单事务；副作用（launch/reply）只在事务内
 *   入队 effect 行，由 Effects 在提交后执行（transactional outbox）；
 * - 调用方只拿角色 Pick 接口：REPL 不能 report，worker 不能 decide/stop；
 * - clowder 不变量：assignment 恰一终态且不可撤销（ended 后再 report 抛错）；
 *   同 Ticket 的 outbox 消息按入队 seq 严格顺序投递。
 */

import {
  newId,
  type Assignment,
  type AssignmentOutcome,
  type Decision,
  type DomainEvent,
  type OutboxMessage,
  type Ticket,
  type TicketOutcome,
  type Trigger,
  type WorkerReport,
} from "./model";
import type { AssessmentOutcome } from "./assessment";
import type { OrchestrationStore } from "./store";

export class OrchestratorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrchestratorError";
  }
}

export interface EngineOptions {
  store: OrchestrationStore;
  /** ISO 时间源（测试注入固定时钟）。 */
  now?: () => string;
  /** 领域事件订阅（默认丢弃）。 */
  emit?: (event: DomainEvent) => void;
}

export interface StatusSummary {
  /** 三问之一：什么在等你（带 Attention 的活票）。 */
  waitingForYou: Ticket[];
  /** 三问之二：在跑什么（assignment running/pending 的活票）。 */
  working: Ticket[];
  /** 三问之三：哪里坏了（failed 结束的票 + 有失败记录的 effect）。 */
  failedTickets: Ticket[];
  failedEffects: { kind: string; key: string; attempts: number; error: string }[];
}

export interface EngineSnapshot {
  tickets: Ticket[];
  decisions: Decision[];
  outbox: OutboxMessage[];
}

/** 批 2 启动对账摘要：被打断 / 已续跑 / 因超上限熔断的票。 */
export interface RecoverySummary {
  interrupted: string[];
  relaunched: string[];
  failedByLimit: string[];
}

/**
 * 每票中断续跑上限（超过熔断为 failed）。来源：dsh 的"连续失败阈值"惯例
 * （FAILURES_BEFORE_ERROR=3 / TRANSIENT_TRIES=3 / REQUEUES=2），应用于 restart 场景。
 */
export const RECOVERY_LIMIT = 3;

/** REPL 角色：提交/判定/停止/查看。 */
export type EngineForRepl = Pick<
  Engine,
  "receive" | "decide" | "stopTicket" | "answerAttention" | "status" | "snapshot"
>;
/** worker 角色：只报事实（assignmentStarted / report），拿不到 decide/stop。 */
export type EngineForExecutor = Pick<Engine, "assignmentStarted" | "report">;

export class Engine {
  private readonly store: OrchestrationStore;
  private readonly now: () => string;
  private readonly emitEvent: (event: DomainEvent) => void;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.now = options.now ?? (() => new Date().toISOString());
    this.emitEvent = options.emit ?? (() => {});
  }

  // ---- REPL：输入与判定 ----

  /** 存一条 Trigger（按 id 幂等：重复提交返回 duplicate，不产生新事件）。 */
  receive(trigger: Trigger): "stored" | "duplicate" {
    return this.store.atomic(() => {
      if (this.store.getTrigger(trigger.id) !== undefined) return "duplicate";
      this.store.saveTrigger(trigger);
      this.emit({ type: "trigger.received", triggerId: trigger.id });
      return "stored";
    });
  }

  /**
   * 落账研判结论（一个 Trigger 恰好一个 Decision）：
   * ignore 只记 Decision；accept 为每张子票建 Ticket + pending Assignment，
   * 并在同一事务内为每票入队 launch effect。
   */
  decide(triggerId: string, outcome: AssessmentOutcome): Decision {
    return this.store.atomic(() => {
      const trigger = this.store.getTrigger(triggerId);
      if (!trigger) throw new OrchestratorError("unknownTrigger", `未知 Trigger ${triggerId}`);
      for (const decision of this.store.listDecisions()) {
        if (decision.triggerId === triggerId) {
          throw new OrchestratorError("alreadyDecided", `Trigger ${triggerId} 已有 Decision`);
        }
      }
      const at = this.now();
      const ticketIds: string[] = [];
      if (outcome.kind === "accept") {
        for (const draft of outcome.tickets) {
          const ticketId = newId("t");
          const assignmentId = newId("a");
          const ticket: Ticket = {
            id: ticketId,
            title: draft.title,
            scope: draft.scope,
            mandate: { strength: "explicit", basis: "assessment", scope: draft.scope },
            triggerId,
            createdAt: at,
            assignmentId,
          };
          const assignment: Assignment = {
            id: assignmentId,
            ticketId,
            status: "pending",
            createdAt: at,
          };
          this.store.saveTicket(ticket);
          this.store.saveAssignment(assignment);
          this.store.enqueueEffect("launch", ticketId, { ticketId, assignmentId });
          this.emit({ type: "ticket.created", ticketId });
          ticketIds.push(ticketId);
        }
      }
      const reason =
        outcome.kind === "ignore" && outcome.code
          ? `${outcome.reason}（${outcome.code}）`
          : outcome.reason;
      const decision: Decision = {
        id: newId("d"),
        triggerId,
        kind: outcome.kind,
        reason,
        ticketIds,
        at,
      };
      this.store.saveDecision(decision);
      this.emit({ type: "decision.recorded", triggerId, kind: decision.kind });
      return decision;
    });
  }

  // ---- 人工 ----

  /**
   * 批 2 启动对账（dsh Restart + clowder sweep 的裁剪融合）：
   * running assignment → ended('interrupted')；票无 Attention（不在等人）时
   * interruptions+1，未超上限则新建 pending assignment 续跑（launch effect 带
   * recovery 标记），超上限熔断为 failed 并出一条失败消息。:memory: 测试可直接调用。
   */
  recoverAfterRestart(): RecoverySummary {
    return this.store.atomic(() => {
      const summary: RecoverySummary = { interrupted: [], relaunched: [], failedByLimit: [] };
      for (const ticket of this.store.listTickets()) {
        if (ticket.ended || ticket.attention) continue;
        const assignment = ticket.assignmentId
          ? this.store.getAssignment(ticket.assignmentId)
          : undefined;
        if (assignment?.status !== "running") continue;
        this.endAssignment(assignment, "interrupted", "进程重启");
        const count = (ticket.interruptions ?? 0) + 1;
        ticket.interruptions = count;
        if (count > RECOVERY_LIMIT) {
          this.endTicket(ticket, "failed", `中断恢复超过上限 ${RECOVERY_LIMIT} 次`);
          this.queueReply(
            ticket.id,
            `工单 ${ticket.title}（${ticket.id}）已熔断：进程重启打断 ${count} 次，请检查工作目录后重新提交。`,
          );
          summary.failedByLimit.push(ticket.id);
        } else {
          const assignmentId = newId("a");
          this.store.saveAssignment({
            id: assignmentId,
            ticketId: ticket.id,
            status: "pending",
            createdAt: this.now(),
          });
          ticket.assignmentId = assignmentId;
          this.store.saveTicket(ticket);
          this.store.enqueueEffect("launch", ticket.id, {
            ticketId: ticket.id,
            assignmentId,
            recovery: true,
          });
          summary.relaunched.push(ticket.id);
        }
        summary.interrupted.push(ticket.id);
      }
      return summary;
    });
  }

  /** 停一张活票：running assignment 终止为 stopped，票结束为 stopped，出一条通知。 */
  stopTicket(ticketId: string, reason: string): Ticket {
    return this.store.atomic(() => {
      const ticket = this.requireLive(ticketId);
      const assignment = ticket.assignmentId
        ? this.store.getAssignment(ticket.assignmentId)
        : undefined;
      if (assignment && assignment.status === "running") {
        this.endAssignment(assignment, "stopped", reason);
      }
      this.clearAttention(ticket);
      this.endTicket(ticket, "stopped", reason);
      this.queueReply(ticketId, `工单 ${ticket.title}（${ticketId}）已按人工指令停止：${reason}`);
      return ticket;
    });
  }

  /**
   * 批 2 回答 Attention：清除待答问题，并把答案合并入队 deliver effect
   * （dsh Input 投递的最小版；同票答案按到达顺序累积，一次投递多轮）。
   */
  answerAttention(ticketId: string, text: string): Ticket {
    return this.store.atomic(() => {
      const ticket = this.requireLive(ticketId);
      if (!ticket.attention) {
        throw new OrchestratorError("noAttention", `工单 ${ticketId} 当前没有待答问题`);
      }
      ticket.attention = undefined;
      this.store.saveTicket(ticket);
      this.emit({ type: "attention.cleared", ticketId });
      const existing = this.store.getEffectPayload("deliver", ticketId) as
        | { ticketId: string; texts: string[] }
        | undefined;
      const texts = [...(existing?.texts ?? []), text];
      this.store.enqueueEffect("deliver", ticketId, { ticketId, texts });
      return ticket;
    });
  }

  // ---- worker 事实上报 ----

  /** pending → running（非 pending 抛错，防重复启动）。 */
  assignmentStarted(ticketId: string): Assignment {
    return this.store.atomic(() => {
      const ticket = this.requireLive(ticketId);
      const assignment = this.requireAssignment(ticket);
      if (assignment.status !== "pending") {
        throw new OrchestratorError(
          "assignmentNotPending",
          `工单 ${ticketId} 的 assignment 已启动`,
        );
      }
      assignment.status = "running";
      assignment.startedAt = this.now();
      this.store.saveAssignment(assignment);
      this.emit({ type: "assignment.started", ticketId, assignmentId: assignment.id });
      return assignment;
    });
  }

  /**
   * worker 汇报（五态状态机）：
   * progress 只记录；blocked 置 Attention 并出一条提问消息；ready/failed 结束
   * assignment+ticket 并出结果/失败消息；dropped 双双结束但不出消息（无需人处理）。
   * assignment 已 ended 再 report 抛错——恰一终态不可撤销（clowder 不变量）。
   */
  report(ticketId: string, report: Omit<WorkerReport, "at">): Ticket {
    return this.store.atomic(() => {
      const ticket = this.requireLive(ticketId);
      const assignment = this.requireAssignment(ticket);
      if (assignment.status !== "running") {
        throw new OrchestratorError(
          "assignmentNotRunning",
          `工单 ${ticketId} 的 assignment 已结束，拒绝重复汇报`,
        );
      }
      const at = this.now();
      const attention =
        report.kind === "blocked"
          ? (report.attention ?? { question: report.text, at })
          : report.attention;
      const full: WorkerReport = { ...report, at, attention };
      this.store.appendReport(ticketId, full);
      this.emit({ type: "report.recorded", ticketId, kind: report.kind });
      if (report.kind === "progress") {
        // 只记录
      } else if (report.kind === "blocked") {
        ticket.attention = attention;
        this.store.saveTicket(ticket);
        this.emit({ type: "attention.raised", ticketId });
        this.queueReply(
          ticketId,
          `工单 ${ticket.title}（${ticketId}）需要你的决定：${attention?.question ?? report.text}`,
        );
      } else if (report.kind === "ready") {
        this.endAssignment(assignment, "completed", "worker 报告 ready");
        this.clearAttention(ticket);
        this.endTicket(ticket, "completed", "ready");
        this.queueReply(ticketId, `工单 ${ticket.title}（${ticketId}）完成：\n${report.text}`);
      } else if (report.kind === "failed") {
        this.endAssignment(assignment, "failed", report.text);
        this.clearAttention(ticket);
        this.endTicket(ticket, "failed", report.text);
        this.queueReply(ticketId, `工单 ${ticket.title}（${ticketId}）失败：\n${report.text}`);
      } else {
        this.endAssignment(assignment, "dropped", report.text);
        this.clearAttention(ticket);
        this.endTicket(ticket, "dropped", report.text);
      }
      return ticket;
    });
  }

  // ---- 查询 ----

  /** 注意力面板三问（dsh 面板哲学的 REPL 版）。 */
  status(): StatusSummary {
    const working: Ticket[] = [];
    const waitingForYou: Ticket[] = [];
    const failedTickets: Ticket[] = [];
    for (const ticket of this.store.listTickets()) {
      if (ticket.ended) {
        if (ticket.ended.outcome === "failed") failedTickets.push(ticket);
        continue;
      }
      if (ticket.attention) waitingForYou.push(ticket);
      const assignment = ticket.assignmentId
        ? this.store.getAssignment(ticket.assignmentId)
        : undefined;
      if (assignment?.status === "running" || assignment?.status === "pending") {
        working.push(ticket);
      }
    }
    return {
      waitingForYou,
      working,
      failedTickets,
      failedEffects: this.store.listEffectFailures().map((row) => ({
        kind: row.kind,
        key: row.key,
        attempts: row.attempts,
        error: row.error,
      })),
    };
  }

  snapshot(): EngineSnapshot {
    return {
      tickets: this.store.listTickets(),
      decisions: this.store.listDecisions(),
      outbox: this.store.listOutbox(),
    };
  }

  // ---- 内部 ----

  private requireLive(ticketId: string): Ticket {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket) throw new OrchestratorError("unknownTicket", `未知工单 ${ticketId}`);
    if (ticket.ended) {
      throw new OrchestratorError(
        "ticketEnded",
        `工单 ${ticketId} 已结束（${ticket.ended.outcome}）`,
      );
    }
    return ticket;
  }

  private requireAssignment(ticket: Ticket): Assignment {
    const assignment = ticket.assignmentId
      ? this.store.getAssignment(ticket.assignmentId)
      : undefined;
    if (!assignment) {
      throw new OrchestratorError("unknownAssignment", `工单 ${ticket.id} 缺少 assignment`);
    }
    return assignment;
  }

  private endAssignment(
    assignment: Assignment,
    outcome: AssignmentOutcome,
    reason: string,
  ): void {
    assignment.status = "ended";
    assignment.ended = { outcome, at: this.now(), reason };
    this.store.saveAssignment(assignment);
    this.emit({
      type: "assignment.ended",
      ticketId: assignment.ticketId,
      assignmentId: assignment.id,
      outcome,
    });
  }

  private endTicket(ticket: Ticket, outcome: TicketOutcome, reason: string): void {
    ticket.ended = { outcome, at: this.now(), reason };
    this.store.saveTicket(ticket);
    this.emit({ type: "ticket.ended", ticketId: ticket.id, outcome });
  }

  private clearAttention(ticket: Ticket): void {
    if (ticket.attention) {
      ticket.attention = undefined;
      this.emit({ type: "attention.cleared", ticketId: ticket.id });
    }
  }

  /** 先存后发：消息入 outbox（queued），reply effect 提交后按 seq 投递。 */
  private queueReply(ticketId: string, text: string): void {
    const message: OutboxMessage = {
      id: newId("m"),
      ticketId,
      text,
      status: "queued",
      queuedAt: this.now(),
    };
    this.store.saveOutbox(message);
    this.store.enqueueEffect("reply", message.id, { messageId: message.id });
  }

  private emit(event: DomainEvent): void {
    this.emitEvent(event);
  }
}
