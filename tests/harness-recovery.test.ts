/**
 * s15 LLM 错误恢复离线测试（对齐 lcc RecoveryState / retry_delay / with_retry）：
 * 错误分类双通道、指数退避 + 抖动边界、连续 529 切 fallback、
 * fatal 原样抛出、截断判定与升级计数。
 * sleep / random 全部注入——零真实等待。
 */

import { describe, expect, it } from "vitest";
import {
  classifyLLMError,
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  LlmRecovery,
  MAX_RETRIES,
  retryDelay,
} from "../src/harness/llm-recovery";
import type {
  ChatLLM,
  LLMProvider,
  ToolInvocationResult,
  ToolSchema,
} from "../src/core/llm";
import type { ChatMessage } from "../src/core/message";

type Script = Error | "ok";

/** 按脚本逐个失败/成功的 LLM 桩（记录每次收到的 maxTokens） */
class ScriptedFlakyLLM implements ChatLLM {
  readonly model: string;
  readonly provider: LLMProvider = "custom";
  readonly calls: { maxTokens: number | undefined }[] = [];

  constructor(model: string, private readonly script: Script[]) {
    this.model = model;
  }

  async invoke(): Promise<string> {
    return "";
  }

  async *stream(): AsyncGenerator<string> {
    yield "";
  }

  async invokeWithTools(
    _messages: ChatMessage[],
    _tools: ToolSchema[],
    options?: { maxTokens?: number },
  ): Promise<ToolInvocationResult> {
    this.calls.push({ maxTokens: options?.maxTokens });
    const next = this.script.shift();
    if (next === undefined || next === "ok") {
      return { content: `done(${this.model})`, toolCalls: [] };
    }
    throw next;
  }
}

describe("classifyLLMError（lcc name/message 双通道 + cause.status 扩展）", () => {
  it("消息含 429 / ratelimit / rate limit → rate_limited", () => {
    expect(classifyLLMError(new Error("HTTP 429 too many requests"))).toBe("rate_limited");
    expect(classifyLLMError(new Error("Rate limit reached"))).toBe("rate_limited");
    const named = new Error("quota");
    named.name = "RateLimitError";
    expect(classifyLLMError(named)).toBe("rate_limited");
  });

  it("消息含 529 / overloaded → overloaded；其余 → fatal", () => {
    expect(classifyLLMError(new Error("529 overloaded_error"))).toBe("overloaded");
    expect(classifyLLMError(new Error("Provider is overloaded"))).toBe("overloaded");
    const named = new Error("upstream");
    named.name = "APIConnectionOverloadedError";
    expect(classifyLLMError(named)).toBe("overloaded");
    expect(classifyLLMError(new Error("invalid api key"))).toBe("fatal");
  });

  it("cause 链上的 status 429/529 被识别（OpenAI SDK APIError 形态）", () => {
    const cause = Object.assign(new Error("wrapped"), { status: 429 });
    const wrapped = new Error("LLM 调用失败: wrapped", { cause });
    expect(classifyLLMError(wrapped)).toBe("rate_limited");
    const cause529 = Object.assign(new Error("wrapped"), { status: 529 });
    expect(classifyLLMError(new Error("wrap", { cause: cause529 }))).toBe("overloaded");
  });
});

describe("retryDelay（对齐 lcc min(500×2ⁿ, 32s) + ≤25% 抖动）", () => {
  it("随机源为 0 时退化为精确基值；首拍 500ms", () => {
    expect(retryDelay(0, () => 0)).toBe(500);
    expect(retryDelay(1, () => 0)).toBe(1000);
  });

  it("指数增长封顶 32s；抖动上界 +25%", () => {
    expect(retryDelay(10, () => 0)).toBe(32_000);
    expect(retryDelay(10, () => 1)).toBe(40_000);
    const first = retryDelay(0, () => 1);
    expect(first).toBeGreaterThan(500);
    expect(first).toBeLessThanOrEqual(625);
  });
});

describe("LlmRecovery.invokeWithRetry（对齐 lcc with_retry）", () => {
  it("429 退避重试后成功；sleep 收到指数延迟；成功清零计数", async () => {
    const primary = new ScriptedFlakyLLM("main", [
      new Error("HTTP 429"),
      new Error("rate limit"),
      "ok",
    ]);
    const sleeps: number[] = [];
    const recovery = new LlmRecovery({
      primary,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0,
    });
    const result = await recovery.invokeWithRetry(async (llm, options) =>
      llm.invokeWithTools!([], [], options),
    );
    expect(result.content).toBe("done(main)");
    expect(sleeps).toEqual([500, 1000]);
    expect(primary.calls).toHaveLength(3);
  });

  it("fatal 错误原样抛出，不重试不睡眠", async () => {
    const primary = new ScriptedFlakyLLM("main", [new Error("invalid api key")]);
    let slept = 0;
    const recovery = new LlmRecovery({
      primary,
      sleep: async () => {
        slept += 1;
      },
    });
    await expect(
      recovery.invokeWithRetry(async (llm, options) =>
        llm.invokeWithTools!([], [], options),
      ),
    ).rejects.toThrow("invalid api key");
    expect(slept).toBe(0);
    expect(primary.calls).toHaveLength(1);
  });

  it("耗尽 MAX_RETRIES 抛 Max retries 错误", async () => {
    const primary = new ScriptedFlakyLLM(
      "main",
      Array.from({ length: MAX_RETRIES }, () => new Error("429")),
    );
    const recovery = new LlmRecovery({ primary, sleep: async () => {} });
    await expect(
      recovery.invokeWithRetry(async (llm, options) =>
        llm.invokeWithTools!([], [], options),
      ),
    ).rejects.toThrow(`Max retries (${MAX_RETRIES}) exceeded`);
    expect(primary.calls).toHaveLength(MAX_RETRIES);
  });

  it("连续 529 达阈值切换 fallback，后续调用走降级模型", async () => {
    const primary = new ScriptedFlakyLLM("main", [
      new Error("529 overloaded"),
      new Error("529 overloaded"),
    ]);
    const fallback = new ScriptedFlakyLLM("backup", ["ok"]);
    const switches: string[] = [];
    const recovery = new LlmRecovery({
      primary,
      fallback,
      sleep: async () => {},
      random: () => 0,
      onRetry: (info) => {
        if (info.switchedToFallback) switches.push(recovery.currentModel);
      },
    });
    const result = await recovery.invokeWithRetry(async (llm, options) =>
      llm.invokeWithTools!([], [], options),
    );
    expect(result.content).toBe("done(backup)");
    expect(recovery.onFallback).toBe(true);
    expect(switches).toEqual(["backup"]);
    // 阈值 2：主模型两次 529 后切换；第三次调用（MAX_RETRIES 内）走 fallback
    expect(primary.calls).toHaveLength(2);
    expect(fallback.calls).toHaveLength(1);
  });

  it("未配置 fallback 时 529 只退避不切换", async () => {
    const primary = new ScriptedFlakyLLM("main", [
      new Error("529 overloaded"),
      "ok",
    ]);
    const recovery = new LlmRecovery({ primary, sleep: async () => {} });
    const result = await recovery.invokeWithRetry(async (llm, options) =>
      llm.invokeWithTools!([], [], options),
    );
    expect(result.content).toBe("done(main)");
    expect(recovery.onFallback).toBe(false);
  });
});

describe("截断判定与升级计数（对齐 lcc stop_reason/max_tokens 分支）", () => {
  it("length / max_tokens 视为截断，其他 finishReason 不算", () => {
    expect(LlmRecovery.isTruncation({ content: "x", toolCalls: [], finishReason: "length" })).toBe(true);
    expect(LlmRecovery.isTruncation({ content: "x", toolCalls: [], finishReason: "max_tokens" })).toBe(true);
    expect(LlmRecovery.isTruncation({ content: "x", toolCalls: [], finishReason: "stop" })).toBe(false);
    expect(LlmRecovery.isTruncation({ content: "x", toolCalls: [] })).toBe(false);
  });

  it("beginTurn 重置升级/续跑/连续 529 状态并回到主模型", async () => {
    const primary = new ScriptedFlakyLLM("main", []);
    const fallback = new ScriptedFlakyLLM("backup", []);
    const recovery = new LlmRecovery({
      primary,
      fallback,
      sleep: async () => {},
    });
    recovery.markEscalated();
    recovery.countRecovery();
    expect(recovery.currentMaxTokens).toBe(ESCALATED_MAX_TOKENS);
    recovery.beginTurn();
    expect(recovery.hasEscalated).toBe(false);
    expect(recovery.recoveryCount).toBe(0);
    expect(recovery.currentMaxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(recovery.onFallback).toBe(false);
  });
});
