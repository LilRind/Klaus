/**
 * s17 Goal Loop 类型与常量（对齐 lcc GoalState / GoalEvaluation /
 * StopDecision / SessionResult / 常量）
 *
 * 核心理念：模型不再调用工具只代表"这一轮想停"；目标是否完成，
 * 由一个独立判断器读对话证据决定。Stop hook（s04）管"这轮该不该停"，
 * Goal gate 管"整个任务完没完成"——两道闸门在自然退出点串联。
 */

/** 判断器输入的一条对话消息（Message 的结构化超集，历史可直接传入） */
export interface GoalTranscriptMessage {
  role: string;
  content: string;
  /** assistant 消息可携带的工具调用（渲染成 [tool_use] 行） */
  toolCalls?: ReadonlyArray<{
    function?: { name?: string; arguments?: string };
  }>;
}

/** 活跃目标状态（对齐 lcc GoalState） */
export interface GoalState {
  condition: string;
  iterations: number;
  setAt: number;
  tokensAtStart: number;
  lastReason: string | null;
}

/** 判断器的一次结论（对齐 lcc GoalEvaluation） */
export interface GoalEvaluation {
  ok: boolean;
  reason: string;
  impossible: boolean;
}

/** 判断器接口（PromptGoalEvaluator 之外的宿主可注入任意实现） */
export interface GoalEvaluator {
  evaluate(
    condition: string,
    transcript: readonly GoalTranscriptMessage[],
  ): Promise<GoalEvaluation>;
}

/** goal_status 事件（对齐 lcc _record 的事件形状，restore 数据源） */
export interface GoalEvent {
  type: "goal_status";
  condition: string;
  active: boolean;
  met: boolean;
  failed: boolean;
  reason: string;
  iterations: number;
  duration: number;
}

export type GoalStopAction =
  | "allow" // 无活跃目标：放行（退出语义与 s01 相同）
  | "defer" // 后台任务在跑：暂不判断，交还控制权
  | "error" // 评估器调用失败：交还控制权，目标保留
  | "achieved" // 判断器认定达成：清除目标
  | "failed" // 判断器认定不可能：清除目标（失败，不伪装成功）
  | "block" // 未达成：注入理由继续（消耗迭代配额）
  | "limit"; // 连续 block 超上限：交还控制权，目标保留

/** goal 命令 / 评估器不可安全使用时的错误（对齐 lcc GoalError） */
export class GoalError extends Error {}

/** Stop 决策（对齐 lcc StopDecision；condition 供 block 消息格式化） */
export interface GoalStopDecision {
  action: GoalStopAction;
  reason?: string;
  condition?: string;
}

/**
 * Goal gate 接入契约（FunctionCallAgent 消费的最小接口）：
 * GoalController 天然满足它；beginQuery 在每轮开始时重置连续 block 计数。
 */
export interface GoalGate {
  beginQuery?(): void;
  evaluateAfterTurn(
    transcript: readonly GoalTranscriptMessage[],
    backgroundRunning: boolean,
  ): Promise<GoalStopDecision>;
}

/** 目标条件长度上限（对齐 lcc MAX_GOAL_LENGTH） */
export const MAX_GOAL_LENGTH = 4000;

/** /goal clear 的同义别名（对齐 lcc CLEAR_ALIASES） */
export const CLEAR_ALIASES: ReadonlySet<string> = new Set([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
]);

/** 连续 block 上限缺省值（对齐 lcc DEFAULT_STOP_HOOK_BLOCK_CAP） */
export const DEFAULT_STOP_HOOK_BLOCK_CAP = 8;
