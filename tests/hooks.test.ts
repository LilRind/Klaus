/**
 * s04 Hooks 离线验收（对齐 README"试一下"观察点）
 *
 * - 四挂点触发顺序与短路语义；
 * - PreToolUse 软拦截：本次执行被阻止、原因作为 observation 回喂、循环继续；
 * - Stop 强制续跑：注入 user 消息继续循环，且受 maxToolIterations 有界约束；
 * - 不传 hooks 时零影响（存量行为，由全量回归兜底）。
 */

import { describe, expect, it, vi, afterEach } from "vitest";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { FunctionTool } from "../src/tools/tool";
import { CalculatorTool } from "../src/tools/builtin/calculator";
import {
  HookRegistry,
  logHook,
  summaryHook,
} from "../src/hooks/hook-registry";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

afterEach(() => {
  vi.restoreAllMocks();
});

function structuredEchoRegistry(): ToolRegistry {
  return new ToolRegistry().registerFunction({
    name: "echo",
    description: "回声（结构化）",
    parametersDescription: 'JSON: {"text": "..."}',
    parametersSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    func: (input) => `echo:${input}`,
    argsFunc: (args) => `echo:${String(args.text)}`,
  });
}

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function turn(...toolCalls: ToolCallRequest[]): ToolInvocationResult {
  return { content: null, toolCalls };
}

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

describe("HookRegistry", () => {
  it("UserPromptSubmit / PostToolUse 按注册顺序通知，不短路", () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    registry.register("UserPromptSubmit", () => order.push("a"));
    registry.register("UserPromptSubmit", () => order.push("b"));
    registry.register("PostToolUse", () => order.push("post"));

    registry.triggerUserPromptSubmit("hello");
    registry.triggerPostToolUse(call("1", "echo", { text: "x" }), "out");
    expect(order).toEqual(["a", "b", "post"]);
  });

  it("PreToolUse：首个非空返回值短路，后续回调不执行", () => {
    const registry = new HookRegistry();
    const second = vi.fn(() => undefined);
    registry.register("PreToolUse", () => undefined);
    registry.register("PreToolUse", () => "被策略阻止");
    registry.register("PreToolUse", second);

    const blocked = registry.triggerPreToolUse(call("1", "bash", { command: "del x" }));
    expect(blocked).toBe("被策略阻止");
    expect(second).not.toHaveBeenCalled();
  });

  it("Stop：非空返回值短路；全部为空返回 undefined", () => {
    const registry = new HookRegistry();
    registry.register("Stop", () => undefined);
    registry.register("Stop", () => "请再检查一次结果");
    expect(registry.triggerStop([])).toBe("请再检查一次结果");

    const quiet = new HookRegistry().register("Stop", () => undefined);
    expect(quiet.triggerStop([])).toBeUndefined();
  });

  it("unregister 移除指定回调 / 清空事件", () => {
    const registry = new HookRegistry();
    const cb = () => "x";
    registry.register("PreToolUse", cb);
    expect(registry.count("PreToolUse")).toBe(1);
    registry.unregister("PreToolUse", cb);
    expect(registry.count("PreToolUse")).toBe(0);
    registry.register("Stop", () => undefined);
    registry.unregister("Stop");
    expect(registry.count("Stop")).toBe(0);
  });

  it("内置 hook：logHook 打印工具名，summaryHook 统计 tool 消息数", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    logHook(call("1", "bash", { command: "dir" }));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[HOOK] PreToolUse: bash"));

    summaryHook([
      { role: "user", content: "hi" },
      { role: "tool", content: "o1" },
      { role: "tool", content: "o2" },
    ]);
    expect(log).toHaveBeenLastCalledWith(
      expect.stringContaining("session used 2 tool calls"),
    );
  });
});

describe("FunctionCallAgent × Hooks（s04 对齐）", () => {
  it("四挂点在一个 run 里的触发顺序", async () => {
    const llm = new ScriptedLLM([], [
      turn(call("c1", "echo", { text: "hi" })),
      finalTurn("done"),
    ]);
    const events: string[] = [];
    const hooks = new HookRegistry()
      .register("UserPromptSubmit", (q) => events.push(`submit:${q}`))
      .register("PreToolUse", () => {
        events.push("pre");
        return undefined;
      })
      .register("PostToolUse", (_c, output) => events.push(`post:${output}`))
      .register("Stop", () => {
        events.push("stop");
        return undefined;
      });

    const agent = new FunctionCallAgent("a", llm, structuredEchoRegistry(), { hooks });
    const answer = await agent.run("任务");

    expect(answer).toBe("done");
    expect(events).toEqual([
      "submit:任务",
      "pre",
      "post:echo:hi",
      "stop",
    ]);
  });

  it("PreToolUse 软拦截：工具不执行，原因回喂，循环继续", async () => {
    const executed: string[] = [];
    const registry = new ToolRegistry().registerFunction({
      name: "danger",
      description: "危险工具",
      parametersDescription: "JSON",
      parametersSchema: { type: "object", properties: {} },
      func: () => {
        executed.push("不应执行");
        return "never";
      },
      argsFunc: () => {
        executed.push("不应执行");
        return "never";
      },
    });
    const hooks = new HookRegistry().register("PreToolUse", (c) =>
      c.function.name === "danger" ? "策略禁止 danger 工具" : undefined,
    );
    const llm = new ScriptedLLM([], [
      turn(call("c1", "danger", {})),
      finalTurn("已改道"),
    ]);

    const agent = new FunctionCallAgent("a", llm, registry, { hooks });
    const answer = await agent.run("试试危险操作");

    expect(answer).toBe("已改道");
    expect(executed).toEqual([]);
    // 拦截原因作为 tool observation 回喂，模型下一轮看得到
    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe("⛔ hook 拦截: 策略禁止 danger 工具");
    // 拦截的调用同样进入 history 轨迹
    expect(agent.getHistory().some((m) => m.role === "tool" && m.content.includes("hook 拦截"))).toBe(true);
  });

  it("Stop 强制续跑：注入 user 消息继续循环；再次退出时放行", async () => {
    const llm = new ScriptedLLM([], [
      finalTurn("初稿"),
      finalTurn("终稿"),
    ]);
    let stopCount = 0;
    const hooks = new HookRegistry().register("Stop", () => {
      stopCount += 1;
      return stopCount === 1 ? "请复核一次再结束" : undefined;
    });

    const agent = new FunctionCallAgent("a", llm, structuredEchoRegistry(), { hooks });
    const answer = await agent.run("写个总结");

    expect(answer).toBe("终稿");
    expect(stopCount).toBe(2);
    // 续跑消息进入 history 与下一次模型调用
    expect(agent.getHistory().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(agent.getHistory()[2]?.content).toBe("请复核一次再结束");
    expect(llm.toolCallsList[1]?.messages.some((m) => m.role === "user" && m.content === "请复核一次再结束")).toBe(true);
  });

  it("Stop 持续强制续跑受轮数上限约束：走 nudge 强制收尾且不再触发 Stop", async () => {
    const llm = new ScriptedLLM(["强制收尾的回答"], [
      finalTurn("第1版"),
      finalTurn("第2版"),
      finalTurn("第3版"),
    ]);
    let stopCount = 0;
    const hooks = new HookRegistry().register("Stop", () => {
      stopCount += 1;
      return "继续";
    });

    const agent = new FunctionCallAgent("a", llm, structuredEchoRegistry(), {
      hooks,
      maxToolIterations: 3,
    });
    const answer = await agent.run("停不下来的任务");

    expect(answer).toBe("强制收尾的回答");
    // 3 次自然退出尝试全部被续跑顶掉；第 4 次直接 nudge 收尾（不触发 Stop）
    expect(stopCount).toBe(3);
    expect(llm.invokeCount).toBe(1);
    const nudge = llm.calls[0]?.messages.at(-1);
    expect(nudge?.role).toBe("user");
    expect(nudge?.content).toContain("不要再调用任何工具");
  });
});

describe("ToolRegistry.assertAllStructured（决策 5 装配校验）", () => {
  it("全部结构化时通过并返回 this（链式）", () => {
    const registry = structuredEchoRegistry();
    expect(registry.assertAllStructured()).toBe(registry);
  });

  it("存在纯字符串契约工具（如存量 calculator）时抛错并列名", () => {
    const registry = new ToolRegistry().register(new CalculatorTool());
    expect(() => registry.assertAllStructured()).toThrow(/calculator/);
  });
});
