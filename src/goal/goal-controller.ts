/**
 * s17 Goal Controller（对齐 lcc GoalController）
 *
 * 会话级目标状态 + 自然退出点的 Stop 决策：模型不再调用工具时，
 * 先过 s04 Stop hook，再过这里——独立判断器读对话证据，未达成就把
 * 理由注回同一循环继续；达成清除目标；不可能记失败；判断器出错或
 * 连续 block 超上限交还控制权但**绝不伪装完成、绝不偷清目标**。
 */

import {
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  MAX_GOAL_LENGTH,
  GoalError,
  type GoalEvaluator,
  type GoalEvent,
  type GoalState,
  type GoalStopDecision,
  type GoalTranscriptMessage,
} from "./goal-types";

export interface GoalControllerOptions {
  /** 连续 block 上限（缺省 8；env CLAUDE_CODE_STOP_HOOK_BLOCK_CAP 装配层注入） */
  blockCap?: number;
  /** 外部事件流（宿主持久化 goal_status 用）；缺省内部收集 */
  events?: GoalEvent[];
}

export class GoalController {
  active: GoalState | null = null;
  lastStatus: GoalEvent | null = null;
  private readonly blockCap: number;
  readonly events: GoalEvent[];
  private consecutiveBlocks = 0;

  constructor(
    private readonly evaluator: GoalEvaluator,
    options: GoalControllerOptions = {},
  ) {
    this.blockCap = options.blockCap ?? DEFAULT_STOP_HOOK_BLOCK_CAP;
    if (this.blockCap < 1) {
      throw new GoalError("block_cap must be at least 1");
    }
    this.events = options.events ?? [];
  }

  /** 每次用户查询（/goal 或普通输入）开始时重置连续 block 计数 */
  beginQuery(): void {
    this.consecutiveBlocks = 0;
  }

  /** 设置目标（≤4000 字符）；替换旧目标时记录 replaced 事件 */
  setGoal(condition: string, tokensAtStart = 0): GoalState {
    const trimmed = condition.trim();
    if (!trimmed) {
      throw new GoalError("goal condition cannot be empty");
    }
    if (trimmed.length > MAX_GOAL_LENGTH) {
      throw new GoalError(
        `goal condition cannot exceed ${MAX_GOAL_LENGTH} characters`,
      );
    }
    if (this.active !== null) {
      this.record({
        active: false,
        met: false,
        failed: false,
        reason: "replaced by a new goal",
      });
    }
    this.active = {
      condition: trimmed,
      iterations: 0,
      setAt: Date.now(),
      tokensAtStart,
      lastReason: null,
    };
    this.consecutiveBlocks = 0;
    this.record({ active: true, met: false, failed: false, reason: "goal set" });
    return this.active;
  }

  /** 清除目标（lcc clear）；无目标返回 No goal set */
  clear(reason = "cleared"): string {
    if (this.active === null) return "No goal set";
    const condition = this.active.condition;
    this.record({ active: false, met: false, failed: false, reason });
    this.active = null;
    this.consecutiveBlocks = 0;
    return `Goal cleared: ${condition}`;
  }

  /** 状态查询（对齐 lcc status：活跃 / 达成 / 失败 / 无目标） */
  status(currentTokens = 0): string {
    if (this.active === null) {
      if (this.lastStatus?.met) {
        return (
          `Goal achieved: ${this.lastStatus.condition}\n` +
          `Reason: ${this.lastStatus.reason}`
        );
      }
      if (this.lastStatus?.failed) {
        return (
          `Goal failed: ${this.lastStatus.condition}\n` +
          `Reason: ${this.lastStatus.reason}`
        );
      }
      return "No goal set";
    }
    const elapsed = Math.max(0, Math.floor((Date.now() - this.active.setAt) / 1000));
    const spent = Math.max(0, currentTokens - this.active.tokensAtStart);
    const lines = [
      `Goal active: ${this.active.condition}`,
      `Elapsed: ${elapsed}s`,
      `Evaluations: ${this.active.iterations}`,
      `Tokens: ${spent}`,
    ];
    if (this.active.lastReason) {
      lines.push(`Last reason: ${this.active.lastReason}`);
    }
    return lines.join("\n");
  }

  /**
   * 自然退出点的 Stop 决策（对齐 lcc evaluate_after_turn）：
   * 无目标 → allow；后台在跑 → defer；评估器异常 → error（目标保留）；
   * ok → achieved 清除；impossible → failed 清除；否则 block（超 cap → limit）。
   */
  async evaluateAfterTurn(
    transcript: readonly GoalTranscriptMessage[],
    backgroundRunning = false,
  ): Promise<GoalStopDecision> {
    if (this.active === null) {
      return { action: "allow" };
    }
    if (backgroundRunning) {
      return { action: "defer", reason: "background work is still running" };
    }

    const state = this.active;
    let evaluation;
    try {
      evaluation = await this.evaluator.evaluate(state.condition, transcript);
    } catch (error) {
      const reason = `${error instanceof Error ? error.name : "Error"}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      state.lastReason = reason;
      this.record({ active: true, met: false, failed: false, reason });
      return { action: "error", reason, condition: state.condition };
    }

    state.iterations += 1;
    state.lastReason = evaluation.reason;

    if (evaluation.ok) {
      this.record({
        active: false,
        met: true,
        failed: false,
        reason: evaluation.reason,
      });
      this.active = null;
      this.consecutiveBlocks = 0;
      return { action: "achieved", reason: evaluation.reason };
    }

    if (evaluation.impossible) {
      this.record({
        active: false,
        met: false,
        failed: true,
        reason: evaluation.reason,
      });
      this.active = null;
      this.consecutiveBlocks = 0;
      return { action: "failed", reason: evaluation.reason };
    }

    this.consecutiveBlocks += 1;
    this.record({
      active: true,
      met: false,
      failed: false,
      reason: evaluation.reason,
    });
    if (this.consecutiveBlocks > this.blockCap) {
      return {
        action: "limit",
        reason: `goal remains active, but the Stop hook blocked ${this.blockCap} consecutive turns`,
        condition: state.condition,
      };
    }
    return {
      action: "block",
      reason: evaluation.reason,
      condition: state.condition,
    };
  }

  private record(outcome: {
    active: boolean;
    met: boolean;
    failed: boolean;
    reason: string;
  }): void {
    const state = this.active;
    const event: GoalEvent = {
      type: "goal_status",
      condition: state?.condition ?? "",
      active: outcome.active,
      met: outcome.met,
      failed: outcome.failed,
      reason: outcome.reason,
      iterations: state?.iterations ?? 0,
      duration: state ? Math.max(0, (Date.now() - state.setAt) / 1000) : 0,
    };
    this.events.push(event);
    this.lastStatus = event;
  }

  /** 从宿主保存的事件流恢复（对齐 lcc restore：只复活最后一个活跃目标） */
  static restore(
    evaluator: GoalEvaluator,
    events: readonly GoalEvent[],
    options: GoalControllerOptions = {},
  ): GoalController {
    const controller = new GoalController(evaluator, {
      ...options,
      events: [...events],
    });
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event === undefined || event.type !== "goal_status") continue;
      controller.lastStatus = { ...event };
      if (event.active) {
        controller.active = {
          condition: String(event.condition),
          iterations: 0,
          setAt: Date.now(),
          tokensAtStart: 0,
          lastReason: null,
        };
      }
      break;
    }
    return controller;
  }
}
