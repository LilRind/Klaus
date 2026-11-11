/**
 * s17 Goal Loop 离线验收（对齐 lcc test_goal_loop.py）
 *
 * - transcript 渲染：完整最近消息 + 过长最新消息掐头留尾；tool_use/tool_result 平文渲染；
 * - PromptGoalEvaluator：无工具独立 JSON 判据 + 严格校验（冲突终态拒绝）；
 * - GoalController：allow/defer/block/achieved/failed/error/limit 全分支、
 *   clear 别名、长度上限、restore 只复活活跃目标；
 * - FunctionCallAgent 集成：未达成自动续跑、工具结果进判断器、
 *   后台 defer、block 消耗迭代配额、Stop hook 先行。
 */

import { describe, expect, it } from "vitest";
import { GoalController } from "../src/goal/goal-controller";
import {
  CLEAR_ALIASES,
  DEFAULT_STOP_HOOK_BLOCK_CAP,
  MAX_GOAL_LENGTH,
} from "../src/goal/goal-types";
import {
  parseGoalEvaluation,
  PromptGoalEvaluator,
  transcriptText,
} from "../src/goal/goal-evaluator";
import type {
  GoalEvaluation,
  GoalEvaluator,
  GoalTranscriptMessage,
} from "../src/goal/goal-types";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { HookRegistry } from "../src/hooks/hook-registry";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

function toolCall(id: string, name: string, args: unknown): ToolCallRequest {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

/** 桩评估器：固定返回（状态机测试不关心对话内容） */
function stubEvaluator(result: Partial<GoalEvaluation>): GoalEvaluator {
  return {
    async evaluate() {
      return {
        ok: result.ok ?? false,
        reason: result.reason ?? "not yet",
        impossible: result.impossible ?? false,
      };
    },
  };
}

describe("transcript 渲染", () => {
  it("plainContent：assistant 带 [tool_use]，tool 带 [tool_result]", () => {
    const transcript: GoalTranscriptMessage[] = [
      { role: "user", content: "fix the tests" },
      {
        role: "assistant",
        content: "running tests",
        toolCalls: [
          { function: { name: "bash", arguments: '{"command":"npm test"}' } },
        ],
      },
      { role: "tool", content: "exit_code=0\n3 passed" },
    ];
    const text = transcriptText(transcript);
    expect(text).toContain("USER:");
    expect(text).toContain('[tool_use bash {"command":"npm test"}]');
    expect(text).toContain("[tool_result exit_code=0\n3 passed]");
  });

  it("超限丢弃最旧完整消息，保留最近的", () => {
    const old = "A".repeat(20000);
    const recent = "B".repeat(100);
    const text = transcriptText(
      [
        { role: "user", content: old },
        { role: "user", content: recent },
      ],
      1000,
    );
    expect(text).toContain(recent);
    expect(text).not.toContain("A".repeat(50));
  });

  it("单条过长最新消息掐头 3/4 留尾 1/4 + 中间标记", () => {
    const head = "H".repeat(2000);
    const middle = "M".repeat(30000);
    const tail = "T".repeat(2000);
    const text = transcriptText(
      [{ role: "user", content: head + middle + tail }],
      24000,
    );
    expect(text).toContain("[middle omitted]");
    expect(text).toContain("H".repeat(100));
    expect(text).toContain("T".repeat(100));
    expect(text.length).toBeLessThanOrEqual(24100);
  });
});

describe("PromptGoalEvaluator", () => {
  it("无工具独立 JSON 判据：payload/completion_condition/system 逐项对齐", async () => {
    const llm = new ScriptedLLM(['{"ok": true, "reason": "tests passed"}']);
    const evaluator = new PromptGoalEvaluator(llm);
    const result = await evaluator.evaluate("npm test exits 0", [
      { role: "user", content: "run tests" },
    ]);
    expect(result).toEqual({ ok: true, reason: "tests passed", impossible: false });
    const call = llm.calls[0]!;
    expect(call.options?.maxTokens).toBe(512);
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]?.role).toBe("system");
    expect(call.messages[0]?.content).toContain("independent completion evaluator");
    expect(call.messages[0]?.content).toContain("You have no tools");
    const userContent = call.messages[1]?.content ?? "";
    expect(userContent).toContain("Input data (JSON):");
    expect(userContent).toContain('"completion_condition":"npm test exits 0"');
    expect(userContent).toContain('"conversation":"USER:');
    expect(userContent).toContain("Return only JSON:");
  });

  it("剥代码围栏解析", async () => {
    const llm = new ScriptedLLM([
      '```json\n{"ok": false, "reason": "no exit code", "impossible": false}\n```',
    ]);
    const result = await new PromptGoalEvaluator(llm).evaluate("c", []);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no exit code");
  });

  it("严格校验全分支（非法 JSON / 非对象 / 坏字段 / 冲突终态）", () => {
    expect(() => parseGoalEvaluation("not json")).toThrow(
      "goal evaluator returned invalid JSON",
    );
    expect(() => parseGoalEvaluation('"string"')).toThrow(
      "goal evaluator must return a JSON object",
    );
    expect(() => parseGoalEvaluation('{"reason":"r"}')).toThrow(
      "goal evaluator response requires boolean 'ok'",
    );
    expect(() => parseGoalEvaluation('{"ok":true,"reason":"  "}')).toThrow(
      "goal evaluator response requires non-empty 'reason'",
    );
    expect(() =>
      parseGoalEvaluation('{"ok":false,"reason":"r","impossible":"yes"}'),
    ).toThrow("goal evaluator 'impossible' must be boolean");
    expect(() =>
      parseGoalEvaluation('{"ok":true,"reason":"r","impossible":true}'),
    ).toThrow("goal evaluator cannot return both ok and impossible");
  });
});

describe("GoalController 状态机", () => {
  it("无目标 allow；后台在跑 defer 且不调评估器", async () => {
    const controller = new GoalController(stubEvaluator({ ok: false }));
    expect((await controller.evaluateAfterTurn([], false)).action).toBe("allow");
    let called = 0;
    const counting = new GoalController({
      async evaluate() {
        called += 1;
        return { ok: false, reason: "x", impossible: false };
      },
    });
    counting.setGoal("cond");
    const decision = await counting.evaluateAfterTurn([], true);
    expect(decision.action).toBe("defer");
    expect(decision.reason).toBe("background work is still running");
    expect(called).toBe(0);
    expect(counting.active).not.toBeNull();
  });

  it("block：注入理由、目标保留、迭代计数增长", async () => {
    const controller = new GoalController(
      stubEvaluator({ ok: false, reason: "no evidence" }),
    );
    controller.setGoal("tests pass");
    const decision = await controller.evaluateAfterTurn([], false);
    expect(decision.action).toBe("block");
    expect(decision.reason).toBe("no evidence");
    expect(decision.condition).toBe("tests pass");
    expect(controller.active?.iterations).toBe(1);
    expect(controller.active?.lastReason).toBe("no evidence");
  });

  it("ok → achieved 清除目标；impossible → failed 清除目标", async () => {
    const achieved = new GoalController(stubEvaluator({ ok: true, reason: "done" }));
    achieved.setGoal("c");
    expect((await achieved.evaluateAfterTurn([], false)).action).toBe("achieved");
    expect(achieved.active).toBeNull();
    expect(achieved.lastStatus).toMatchObject({ met: true, active: false });

    const failed = new GoalController(
      stubEvaluator({ ok: false, reason: "impossible to verify", impossible: true }),
    );
    failed.setGoal("c");
    const decision = await failed.evaluateAfterTurn([], false);
    expect(decision.action).toBe("failed");
    expect(failed.active).toBeNull();
    expect(failed.lastStatus).toMatchObject({ failed: true, active: false });
  });

  it("评估器抛错 → error 交还控制权、目标保留、last_reason 留痕", async () => {
    const controller = new GoalController({
      async evaluate() {
        throw new Error("api down");
      },
    });
    controller.setGoal("c");
    const decision = await controller.evaluateAfterTurn([], false);
    expect(decision.action).toBe("error");
    expect(decision.reason).toContain("api down");
    expect(controller.active).not.toBeNull();
    expect(controller.active?.lastReason).toContain("api down");
  });

  it("block cap：连续超限 → limit（目标保留）；beginQuery 重置", async () => {
    const controller = new GoalController(stubEvaluator({ ok: false }), {
      blockCap: 2,
    });
    controller.setGoal("c");
    expect((await controller.evaluateAfterTurn([], false)).action).toBe("block");
    expect((await controller.evaluateAfterTurn([], false)).action).toBe("block");
    const limited = await controller.evaluateAfterTurn([], false);
    expect(limited.action).toBe("limit");
    expect(limited.reason).toContain("blocked 2 consecutive turns");
    expect(controller.active).not.toBeNull();
    controller.beginQuery();
    expect((await controller.evaluateAfterTurn([], false)).action).toBe("block");
  });

  it("默认 block cap = 8；cap < 1 拒绝构造", () => {
    expect(DEFAULT_STOP_HOOK_BLOCK_CAP).toBe(8);
    expect(
      () => new GoalController(stubEvaluator({ ok: false }), { blockCap: 0 }),
    ).toThrow("block_cap must be at least 1");
  });

  it("set/clear：长度上限、替换事件、clear 别名全覆盖", () => {
    const controller = new GoalController(stubEvaluator({ ok: false }));
    expect(() => controller.setGoal("   ")).toThrow(
      "goal condition cannot be empty",
    );
    expect(() => controller.setGoal("x".repeat(MAX_GOAL_LENGTH + 1))).toThrow(
      `goal condition cannot exceed ${MAX_GOAL_LENGTH} characters`,
    );
    controller.setGoal("first");
    controller.setGoal("second");
    expect(controller.events.some((e) => e.reason === "replaced by a new goal")).toBe(true);
    expect(controller.active?.condition).toBe("second");
    for (const alias of CLEAR_ALIASES) {
      controller.setGoal("c");
      expect(controller.clear(alias)).toContain("Goal cleared: c");
      expect(controller.active).toBeNull();
    }
    expect(controller.clear("cleared")).toBe("No goal set");
    expect(controller.events.some((e) => e.reason === "goal set")).toBe(true);
  });

  it("status：活跃 / 达成 / 无目标三态", async () => {
    const controller = new GoalController(stubEvaluator({ ok: false }));
    expect(controller.status()).toBe("No goal set");
    controller.setGoal("npm test exits 0");
    const active = controller.status();
    expect(active).toContain("Goal active: npm test exits 0");
    expect(active).toContain("Evaluations: 0");
    const done = new GoalController(stubEvaluator({ ok: true, reason: "ok" }));
    done.setGoal("c");
    await done.evaluateAfterTurn([], false);
    expect(done.status()).toContain("Goal achieved: c");
    expect(done.status()).toContain("Reason: ok");
  });

  it("restore：只复活最后一条 active 事件；inactive 不复活", () => {
    const base = { type: "goal_status" as const, met: false, failed: false };
    const restored = GoalController.restore(stubEvaluator({ ok: false }), [
      { ...base, condition: "old", active: false, reason: "achieved", iterations: 3, duration: 5 },
      { ...base, condition: "current", active: true, reason: "goal set", iterations: 0, duration: 0 },
    ]);
    expect(restored.active?.condition).toBe("current");
    expect(restored.active?.iterations).toBe(0);
    expect(restored.lastStatus?.condition).toBe("current");

    const inert = GoalController.restore(stubEvaluator({ ok: false }), [
      { ...base, condition: "old", active: false, reason: "achieved", iterations: 3, duration: 5 },
    ]);
    expect(inert.active).toBeNull();
    expect(inert.lastStatus?.condition).toBe("old");
  });
});

describe("FunctionCallAgent 集成", () => {
  function buildAgent(options: {
    toolResponses: ToolInvocationResult[];
    evaluatorResponses: string[];
    goalGate: GoalController;
    isBackgroundRunning?: () => boolean;
    hooks?: HookRegistry;
    maxToolIterations?: number;
  }) {
    const llm = new ScriptedLLM(options.evaluatorResponses, options.toolResponses);
    const agent = new FunctionCallAgent("goal-agent", llm, new ToolRegistry(), {
      maxToolIterations: options.maxToolIterations ?? 6,
      ...(options.hooks ? { hooks: options.hooks } : {}),
      goalGate: options.goalGate,
      ...(options.isBackgroundRunning
        ? { isBackgroundRunning: options.isBackgroundRunning }
        : {}),
    });
    return { agent, llm };
  }

  it("未达成自动续跑直到达成：block 消息注入、评估器看到完整对话", async () => {
    const evaluatorLlm = new ScriptedLLM([
      '{"ok": false, "reason": "no test output in conversation yet"}',
      '{"ok": true, "reason": "exit code 0 visible"}',
    ]);
    const goal = new GoalController(new PromptGoalEvaluator(evaluatorLlm));
    goal.setGoal("npm test exits with code 0");
    const { agent, llm } = buildAgent({
      toolResponses: [
        finalTurn("attempt 1 (no evidence)"),
        finalTurn("attempt 2: all 3 tests passed, exit 0"),
      ],
      evaluatorResponses: [],
      goalGate: goal,
    });
    const answer = await agent.run("fix the tests until npm test exits 0");
    expect(answer).toBe("attempt 2: all 3 tests passed, exit 0");
    expect(goal.active).toBeNull();

    const secondWorkerCall = llm.toolCallsList[1]?.messages ?? [];
    expect(
      secondWorkerCall.some(
        (m) =>
          m.role === "user" &&
          typeof m.content === "string" &&
          m.content.includes("[Goal still active]"),
      ),
    ).toBe(true);
    const secondEvaluatorCall = evaluatorLlm.calls[1]?.messages ?? [];
    expect(secondEvaluatorCall[1]?.content).toContain("[Goal still active]");
    expect(secondEvaluatorCall[1]?.content).toContain("attempt 1");
    expect(goal.lastStatus).toMatchObject({ met: true, reason: "exit code 0 visible" });
  });

  it("工具结果进入判断器对话（tool_use/tool_result 平文）", async () => {
    const evaluatorLlm = new ScriptedLLM([
      '{"ok": true, "reason": "tool result shows success"}',
    ]);
    const goal = new GoalController(
      new PromptGoalEvaluator(evaluatorLlm),
    );
    goal.setGoal("create hello.py");
    const registry = new ToolRegistry();
    registry.registerFunction({
      name: "echo_tool",
      description: "echo",
      parametersSchema: {
        type: "object",
        properties: { input: { type: "string" } },
        required: ["input"],
      },
      func: async () => "hello file created",
    });
    const llm = new ScriptedLLM([], [
      {
        content: null,
        toolCalls: [toolCall("call-1", "echo_tool", { input: "hi" })],
      },
      finalTurn("done"),
    ]);
    const agent = new FunctionCallAgent("goal-agent", llm, registry, {
      goalGate: goal,
    });
    await agent.run("create hello.py");
    const evaluatorUser = evaluatorLlm.calls[0]?.messages[1]?.content ?? "";
    expect(evaluatorUser).toContain("[tool_use echo_tool");
    expect(evaluatorUser).toContain("[tool_result hello file created]");
  });

  it("后台在跑 → defer：不评估、run 正常返回、目标保留", async () => {
    const goal = new GoalController(stubEvaluator({ ok: false }));
    goal.setGoal("c");
    const { agent } = buildAgent({
      toolResponses: [finalTurn("waiting for background")],
      evaluatorResponses: [],
      goalGate: goal,
      isBackgroundRunning: () => true,
    });
    const answer = await agent.run("keep working");
    expect(answer).toBe("waiting for background");
    expect(goal.active).not.toBeNull();
    // lcc 同款：defer 不记录事件、不调评估器——判断被推迟而非失败
    expect(goal.events.every((e) => e.reason !== "background work is still running")).toBe(true);
  });

  it("block 永不满足 → 消耗迭代配额后强制收尾，目标保留不过 gate", async () => {
    const evaluatorLlm = new ScriptedLLM([
      '{"ok": false, "reason": "not yet 1"}',
      '{"ok": false, "reason": "not yet 2"}',
    ]);
    const goal = new GoalController(new PromptGoalEvaluator(evaluatorLlm));
    goal.setGoal("c");
    const { agent, llm } = buildAgent({
      toolResponses: [finalTurn("stop 1"), finalTurn("stop 2")],
      evaluatorResponses: ["forced final answer"],
      goalGate: goal,
      maxToolIterations: 2,
    });
    const answer = await agent.run("work");
    expect(answer).toBe("forced final answer");
    expect(llm.calls).toHaveLength(1); // worker 只有强制收尾走 invoke
    expect(evaluatorLlm.calls).toHaveLength(2);
    expect(goal.active).not.toBeNull();
    expect(goal.active?.iterations).toBe(2);
  });

  it("s04 Stop hook 先行：hook 强制续跑时 goal gate 不调用", async () => {
    const evaluatorLlm = new ScriptedLLM(['{"ok": true, "reason": "ok now"}']);
    const goal = new GoalController(new PromptGoalEvaluator(evaluatorLlm));
    goal.setGoal("c");
    const hooks = new HookRegistry();
    let stopCalls = 0;
    hooks.register("Stop", () => {
      stopCalls += 1;
      return stopCalls === 1 ? "not done yet, keep going" : undefined;
    });
    const { agent, llm } = buildAgent({
      toolResponses: [finalTurn("stop 1"), finalTurn("stop 2")],
      evaluatorResponses: [],
      goalGate: goal,
      hooks,
    });
    await agent.run("work");
    expect(stopCalls).toBe(2);
    expect(llm.calls).toHaveLength(0); // worker 两次都自然结束，没走过强制收尾
    expect(evaluatorLlm.calls).toHaveLength(1); // 只有第二次 stop 才评估
    expect(goal.active).toBeNull();
  });
});
