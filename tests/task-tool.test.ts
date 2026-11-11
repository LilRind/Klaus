/**
 * s06 Subagent 离线验收（对齐 README"试一下"观察点）
 *
 * - 子上下文隔离：父 history 无中间轨迹，只收到最终文本；
 * - 单层委派：子工具集无 task（调 task 得到未找到 observation）；
 * - 共享权限闸门与 hooks；
 * - 30 轮上限；
 * - 父子共享同一工作区（文件修改互相可见）。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createTaskTool } from "../src/tools/builtin/task-tool";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { FunctionTool } from "../src/tools/tool";
import { WriteFileTool, ReadFileTool } from "../src/tools/builtin/file-tools";
import { HookRegistry } from "../src/hooks/hook-registry";
import { PermissionChecker } from "../src/security/permission";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

afterEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "log").mockRestore();
});

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function turn(...toolCalls: ToolCallRequest[]): ToolInvocationResult {
  return { content: null, toolCalls };
}

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

const echo = new FunctionTool((input) => `echo:${input}`, {
  name: "echo",
  description: "回声",
  func: (input) => `echo:${input}`,
  parametersDescription: 'JSON: {"text": "..."}',
  parametersSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  argsFunc: (args) => `echo:${String(args.text)}`,
});

describe("s06 Subagent", () => {
  it("子上下文隔离：父只收到最终文本，中间轨迹不进父 history", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    // 子 LLM：一轮工具 + 最终回答
    const subLlm = new ScriptedLLM([], [
      turn(call("s1", "echo", { text: "查一下" })),
      finalTurn("项目使用 vitest"),
    ]);
    const task = createTaskTool({ llm: subLlm, tools: [echo] });
    // 父 LLM：调 task → 收结论
    const parentLlm = new ScriptedLLM([], [
      turn(call("p1", "task", { prompt: "查明测试框架" })),
      finalTurn("结论：vitest"),
    ]);
    const registry = new ToolRegistry().register(echo).register(task);
    const parent = new FunctionCallAgent("parent", parentLlm, registry);

    const answer = await parent.run("这个项目用什么测试框架？用子任务查");

    expect(answer).toBe("结论：vitest");
    // 父 history：user → assistant(task) → tool(最终文本) → assistant
    expect(parent.getHistory().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const taskResult = parent.getHistory()[2];
    expect(taskResult?.content).toBe("项目使用 vitest");
    // 父看不到子的中间工具轨迹（无 echo 结果进入父上下文）
    expect(
      parent.getHistory().some((m) => m.content.includes("echo:")),
    ).toBe(false);
    expect(
      parentLlm.toolCallsList[1]?.messages.some((m) => m.content?.includes("echo:")),
    ).toBe(false);
  });

  it("单层委派：子 agent 调 task 得到未找到工具的 observation", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const subLlm = new ScriptedLLM([], [
      turn(call("s1", "task", { prompt: "再套一层" })),
      finalTurn("无法再委派，直接回答"),
    ]);
    const task = createTaskTool({ llm: subLlm, tools: [echo] });
    // 把 task 也注册进父注册表（真实装配形态）
    const parentLlm = new ScriptedLLM([], [
      turn(call("p1", "task", { prompt: "干活" })),
      finalTurn("完成"),
    ]);
    const registry = new ToolRegistry().register(echo).register(task);
    const parent = new FunctionCallAgent("parent", parentLlm, registry);
    await parent.run("开始");

    // 子的第二轮消息里：对 task 的调用返回"未找到工具"
    const subSecondCall = subLlm.toolCallsList[1]?.messages ?? [];
    const toolMsg = subSecondCall.find(
      (m) => m.role === "tool" && m.toolCallId === "s1",
    );
    expect(toolMsg?.content).toContain("未找到工具 'task'");
  });

  it("共享权限闸门：子 agent 的工具调用同样被拒并回喂", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const checker = new PermissionChecker({
      denyRules: [
        { tools: ["echo"], test: () => "子任务禁止执行工具" },
      ],
    });
    const subLlm = new ScriptedLLM([], [
      turn(call("s1", "echo", { text: "hi" })),
      finalTurn("工具被拒，改为直接回答"),
    ]);
    const task = createTaskTool({ llm: subLlm, tools: [echo], permissionChecker: checker });
    const parentLlm = new ScriptedLLM([], [
      turn(call("p1", "task", { prompt: "干活" })),
      finalTurn("完成"),
    ]);
    const registry = new ToolRegistry().register(echo).register(task);
    const parent = new FunctionCallAgent("parent", parentLlm, registry);
    await parent.run("开始");

    const subToolMsg = subLlm.toolCallsList[1]?.messages.find(
      (m) => m.role === "tool" && m.toolCallId === "s1",
    );
    expect(subToolMsg?.content).toContain("⛔ 权限已拒绝");
    expect(subToolMsg?.content).toContain("子任务禁止执行工具");
  });

  it("子 hooks 独立：不触发父自定义 hooks（安全仍共享权限闸门）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const seen: string[] = [];
    const hooks = new HookRegistry().register("PreToolUse", (c) => {
      seen.push(c.function.name);
      return undefined;
    });
    const subLlm = new ScriptedLLM([], [
      turn(call("s1", "echo", { text: "a" })),
      finalTurn("子完成"),
    ]);
    const task = createTaskTool({ llm: subLlm, tools: [echo], hooks });
    const parentLlm = new ScriptedLLM([], [
      turn(call("p1", "task", { prompt: "干活" })),
      finalTurn("完成"),
    ]);
    const registry = new ToolRegistry().register(echo).register(task);
    const parent = new FunctionCallAgent("parent", parentLlm, registry, { hooks });
    await parent.run("开始");

    // 父注册表只看到父自己的 task 调用；子的 echo 走子自己的 [sub-hook] hooks
    expect(seen).toEqual(["task"]);
  });

  it("30 轮上限：子 agent 达到上限后强制收尾并返回文本", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const subTurns: ToolInvocationResult[] = Array.from({ length: 30 }, (_, i) =>
      turn(call(`s${i}`, "echo", { text: String(i) })),
    );
    const subLlm = new ScriptedLLM(["强制收尾：已完成"], subTurns);
    const task = createTaskTool({ llm: subLlm, tools: [echo] });
    const output = await task.executeArgs({ prompt: "停不下来的任务" });

    expect(output).toBe("强制收尾：已完成");
    expect(subLlm.toolCallsList).toHaveLength(30);
    expect(subLlm.invokeCount).toBe(1); // nudge 后的纯文本收尾调用
  });

  it("父子共享工作区：子 agent 写的文件父 agent 读得到", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const root = path.join("test_tmp", `sub_${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(root, { recursive: true });
    const write = new WriteFileTool({ workspace: root });
    const read = new ReadFileTool({ workspace: root });

    const subLlm = new ScriptedLLM([], [
      turn(call("s1", "write_file", { path: "shared.txt", content: "from sub" })),
      finalTurn("已写入 shared.txt"),
    ]);
    const task = createTaskTool({ llm: subLlm, tools: [write] });
    const parentLlm = new ScriptedLLM([], [
      turn(call("p1", "task", { prompt: "写入 shared.txt" })),
      turn(call("p2", "read_file", { path: "shared.txt" })),
      finalTurn("读到 from sub"),
    ]);
    const registry = new ToolRegistry().register(write).register(read).register(task);
    const parent = new FunctionCallAgent("parent", parentLlm, registry);
    const answer = await parent.run("让子任务写文件，然后读给我");

    expect(answer).toBe("读到 from sub");
    const readResult = parentLlm.toolCallsList[2]?.messages.find(
      (m) => m.role === "tool" && m.toolCallId === "p2",
    );
    expect(readResult?.content).toContain("from sub");
    await fs.rm(root, { recursive: true, force: true });
  });

  it("子 agent 轨迹带 [sub-tool] 前缀，hook 日志带 [sub-hook] 前缀", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.join(" "));
    });
    const subLlm = new ScriptedLLM([], [
      turn(call("s1", "echo", { text: "查" })),
      finalTurn("结论"),
    ]);
    const task = createTaskTool({ llm: subLlm, tools: [echo] });
    await task.executeArgs({ prompt: "查点东西" });
    spy.mockRestore();

    // 子的工具轨迹带 [sub-tool]，hook 日志带 [sub-hook]
    expect(logs.some((line) => line.includes("[sub-tool] 🔧 第 1 轮"))).toBe(true);
    expect(logs.some((line) => line.includes("[sub-tool]    > echo"))).toBe(true);
    expect(logs.some((line) => line.includes("[sub-hook] PreToolUse: echo"))).toBe(true);
    expect(logs.some((line) => line.includes("[sub-hook] Stop"))).toBe(true);
    // 边界标记仍是装配层输出（无前缀）
    expect(logs.some((line) => line.includes("[Subagent started]"))).toBe(true);
  });
});
