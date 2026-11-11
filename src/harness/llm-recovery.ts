/**
 * s15 LLM 错误恢复（对齐 lcc s15_integrated_harness/code.py:2230-2278 与
 * 3187-3199 的 RecoveryState / retry_delay / with_retry / 截断处理）。
 *
 * 职责：429/529 指数退避重试、连续 529 切换 fallback 模型、响应截断
 * （finish_reason）升级与续跑计数。prompt too long 的 reactive compact
 * 不在此层——它留在 FunctionCallAgent 的既有 reactive 路径（外层优先，
 * 对齐 lcc agent_loop catch 的顺序）。
 */
import type { ChatLLM, ToolInvocationResult } from "../core/llm";

/** 最多重试次数（对齐 lcc MAX_RETRIES） */
export const MAX_RETRIES = 3;
/** 连续 529 次数阈值，达到后切换 fallback 模型（对齐 lcc MAX_CONSECUTIVE_529） */
export const MAX_CONSECUTIVE_529 = 2;
/** 截断续跑最大次数（对齐 lcc MAX_RECOVERY_RETRIES） */
export const MAX_RECOVERY_RETRIES = 2;
/** 退避基值毫秒（对齐 lcc BASE_DELAY_MS） */
export const BASE_DELAY_MS = 500;
/** 退避封顶毫秒（对齐 lcc retry_delay 的 32000 上限） */
export const MAX_DELAY_MS = 32_000;
/** 常规轮 max_tokens（对齐 lcc DEFAULT_MAX_TOKENS） */
export const DEFAULT_MAX_TOKENS = 8_000;
/** 截断升级后的 max_tokens（对齐 lcc ESCALATED_MAX_TOKENS） */
export const ESCALATED_MAX_TOKENS = 16_000;
/** 续跑提示词（逐字对齐 lcc CONTINUATION_PROMPT） */
export const CONTINUATION_PROMPT =
  "Continue from the previous response. Do not repeat completed work.";

export type LLMFailureClass = "rate_limited" | "overloaded" | "fatal";

/**
 * 错误分类（对齐 lcc with_retry 的 name/message 双通道判定，并扩展
 * OpenAI SDK 的 cause 链 status 检查）：
 * - rate_limited：名称含 ratelimit / 文本含 429 / cause.status === 429
 * - overloaded：名称含 overloaded / 文本含 529 或 overloaded / status === 529
 * - fatal：其余（原样抛出，不重试）
 */
export function classifyLLMError(error: unknown): LLMFailureClass {
  let current: unknown = error;
  const texts: string[] = [];
  for (let depth = 0; current !== undefined && current !== null && depth < 5; depth += 1) {
    if (current instanceof Error) {
      texts.push(current.name.toLowerCase(), current.message.toLowerCase());
      const status = (current as { status?: unknown }).status;
      if (status === 429) return "rate_limited";
      if (status === 529) return "overloaded";
      current = (current as { cause?: unknown }).cause;
    } else {
      texts.push(String(current).toLowerCase());
      current = undefined;
    }
  }
  const joined = texts.join("\n");
  if (
    joined.includes("ratelimit") ||
    joined.includes("rate limit") ||
    joined.includes("429")
  ) {
    return "rate_limited";
  }
  if (joined.includes("overloaded") || joined.includes("529")) {
    return "overloaded";
  }
  return "fatal";
}

/**
 * 退避延迟（对齐 lcc retry_delay，code.py:2239-2241）：
 * min(BASE_DELAY_MS × 2^attempt, 32s) + [0, 25%] 随机抖动，单位毫秒。
 */
export function retryDelay(
  attempt: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
  return base + random() * base * 0.25;
}

export interface LlmRecoveryOptions {
  primary: ChatLLM;
  /** 连续 529 达阈值后的降级模型；缺省时 529 只重试不切换（lcc 同款） */
  fallback?: ChatLLM;
  /** 退避睡眠；测试注入假时钟 */
  sleep?: (ms: number) => Promise<void>;
  /** 抖动随机源；测试注入固定值 */
  random?: () => number;
  /** 重试/切换观测点（日志与测试断言用） */
  onRetry?: (info: {
    kind: Exclude<LLMFailureClass, "fatal">;
    attempt: number;
    delayMs: number;
    switchedToFallback: boolean;
  }) => void;
}

/**
 * 每 agent 轮（run/runEventTurn）持有独立可变状态——beginTurn() 对齐
 * lcc 在 agent_loop 顶部 `state = RecoveryState()` 的新建语义。
 */
export class LlmRecovery {
  private readonly primary: ChatLLM;
  private readonly fallback: ChatLLM | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly onRetry: LlmRecoveryOptions["onRetry"];

  private active: ChatLLM;
  /** 截断升级是否已用掉（对齐 lcc has_escalated） */
  private escalated = false;
  /** 截断续跑已用次数（对齐 lcc recovery_count） */
  private recoveries = 0;
  /** 连续 529 计数（对齐 lcc consecutive_529） */
  private consecutiveOverloaded = 0;

  constructor(options: LlmRecoveryOptions) {
    if (typeof options.primary.invokeWithTools !== "function") {
      throw new Error("LlmRecovery: primary LLM 必须支持 invokeWithTools");
    }
    if (options.fallback && typeof options.fallback.invokeWithTools !== "function") {
      throw new Error("LlmRecovery: fallback LLM 必须支持 invokeWithTools");
    }
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry;
    this.active = options.primary;
  }

  /** 当前生效模型名（观测点） */
  get currentModel(): string {
    return this.active.model;
  }

  /** 是否已切换到 fallback（观测点） */
  get onFallback(): boolean {
    return this.fallback !== undefined && this.active === this.fallback;
  }

  /** 本轮调用使用的 max_tokens（升级后为 ESCALATED_MAX_TOKENS） */
  get currentMaxTokens(): number {
    return this.escalated ? ESCALATED_MAX_TOKENS : DEFAULT_MAX_TOKENS;
  }

  get hasEscalated(): boolean {
    return this.escalated;
  }

  get recoveryCount(): number {
    return this.recoveries;
  }

  /** 每个 agent 轮开始时重置（对齐 lcc 每轮新建 RecoveryState） */
  beginTurn(): void {
    this.escalated = false;
    this.recoveries = 0;
    this.consecutiveOverloaded = 0;
    this.active = this.primary;
  }

  /** 截断升级标记（agent 循环在首次截断时置位） */
  markEscalated(): void {
    this.escalated = true;
  }

  /** 正常轮成功后重置升级标志（对齐 lcc code.py:3201-3202） */
  resetEscalation(): void {
    this.escalated = false;
  }

  /** 续跑次数 +1（agent 循环注入 CONTINUATION_PROMPT 后调用） */
  countRecovery(): void {
    this.recoveries += 1;
  }

  /**
   * 包装一次模型调用（对齐 lcc with_retry）：成功清零连续 529；
   * 429/529 按 retryDelay 退避重试；连续 529 达阈值切 fallback；
   * fatal 原样抛出；耗尽 MAX_RETRIES 抛 Max retries 错误。
   */
  async invokeWithRetry(
    fn: (llm: ChatLLM, options: { maxTokens: number }) => Promise<ToolInvocationResult>,
  ): Promise<ToolInvocationResult> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
      try {
        const result = await fn(this.active, { maxTokens: this.currentMaxTokens });
        this.consecutiveOverloaded = 0;
        return result;
      } catch (error) {
        const kind = classifyLLMError(error);
        if (kind === "fatal") throw error;
        let switchedToFallback = false;
        if (kind === "overloaded") {
          this.consecutiveOverloaded += 1;
          if (this.consecutiveOverloaded >= MAX_CONSECUTIVE_529 && this.fallback) {
            this.active = this.fallback;
            this.consecutiveOverloaded = 0;
            switchedToFallback = true;
          }
        }
        const delayMs = retryDelay(attempt, this.random);
        this.onRetry?.({ kind, attempt: attempt + 1, delayMs, switchedToFallback });
        await this.sleep(delayMs);
      }
    }
    throw new Error(`Max retries (${MAX_RETRIES}) exceeded`);
  }

  /** 截断判定：OpenAI "length" / Anthropic "max_tokens"（对齐 stop_reason 分支） */
  static isTruncation(result: ToolInvocationResult): boolean {
    return result.finishReason === "length" || result.finishReason === "max_tokens";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
