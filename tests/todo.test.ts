/**
 * s05 TodoWrite 离线验收（对齐 README"试一下"观察点）
 *
 * - TodoManager 全部校验分支（≤20 / 非空 content / 单 in_progress / JSON 字符串）；
 * - todo_write 工具契约（结构化 + 渲染回喂）；
 * - reminder：连续 3 个工具轮未写 todo → 注入提醒并清零；
 *   使用 todo_write 计数清零；未注册 todo_write 的装配不受影响。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { TodoManager, TODO_MAX_ITEMS } from "../src/todo/todo-manager";
import { TodoWriteTool } from "../src/tools/builtin/todo-write-tool";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { FunctionTool } from "../src/tools/tool";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

afterEach(() => {
  vi.restoreAllMocks();
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

describe("TodoManager（s05 对齐）", () => {
  it("整表替换 + 渲染符号 [ ] / [>] / [x]", () => {
    const manager = new TodoManager();
    const rendered = manager.update([
      { content: "读代码", status: "completed" },
      { content: "写方案", status: "in_progress" },
      { content: "跑测试", status: "pending" },
    ]);
    expect(rendered).toBe("[x] 读代码\n[>] 写方案\n[ ] 跑测试");
    expect(manager.items).toHaveLength(3);
  });

  it("超过 20 项拒绝", () => {
    const manager = new TodoManager();
    const many = Array.from({ length: TODO_MAX_ITEMS + 1 }, (_, i) => ({
      content: `任务${i}`,
      status: "pending" as const,
    }));
    expect(() => manager.update(many)).toThrow(/最多 20 项/);
  });

  it("空 content / 非法 status / 多个 in_progress 各自拒绝", () => {
    const manager = new TodoManager();
    expect(() => manager.update([{ content: "  ", status: "pending" }])).toThrow(
      /非空 content/,
    );
    expect(() =>
      manager.update([{ content: "a", status: "done" as never }]),
    ).toThrow(/status 非法/);
    expect(() =>
      manager.update([
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ]),
    ).toThrow(/只能有一个 in_progress/);
  });

  it("JSON 数组字符串输入可用；非 JSON 字符串给出示例提示", () => {
    const manager = new TodoManager();
    const rendered = manager.update(
      '[{"content":"a","status":"pending"}]',
    );
    expect(rendered).toBe("[ ] a");
    expect(() => manager.update("不是 JSON")).toThrow(/JSON 数组/);
  });

  it("空列表渲染占位；整表替换会覆盖旧计划", () => {
    const manager = new TodoManager();
    expect(manager.render()).toBe("(empty todo list)");
    manager.update([{ content: "旧任务", status: "pending" }]);
    manager.update([{ content: "新任务", status: "completed" }]);
    expect(manager.render()).toBe("[x] 新任务");
  });
});

describe("TodoWriteTool（s05 对齐）", () => {
  it("executeArgs：更新共享 manager 并返回渲染结果", async () => {
    const tool = new TodoWriteTool();
    const output = await tool.executeArgs({
      todos: [
        { content: "第一步", status: "in_progress" },
        { content: "第二步", status: "pending" },
      ],
    });
    expect(output).toBe("[>] 第一步\n[ ] 第二步");
    expect(tool.manager.items).toHaveLength(2);
  });

  it("校验失败返回 ❌ observation（不抛异常，回喂模型）", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tool = new TodoWriteTool();
    const output = await tool.executeArgs({
      todos: [{ content: "a", status: "in_progress" }, { content: "b", status: "in_progress" }],
    });
    expect(output).toMatch(/^❌ .*in_progress/);
  });

  it("execute 字符串入口：JSON 直通；缺 todos 字段提示", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const tool = new TodoWriteTool();
    const output = await tool.execute('[{"content":"a","status":"pending"}]');
    expect(output).toBe("[ ] a");
    expect(await tool.executeArgs({})).toBe("❌ 缺少 todos 字段");
  });
});

function echoRegistry(): ToolRegistry {
  return new ToolRegistry().registerFunction({
    name: "echo",
    description: "回声",
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

describe("FunctionCallAgent reminder（s05 对齐）", () => {
  it("连续 3 个工具轮未写 todo：第 3 轮后注入 reminder 并清零", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const todo = new TodoWriteTool();
    const registry = echoRegistry().register(todo);
    const llm = new ScriptedLLM([], [
      turn(call("c1", "echo", { text: "1" })),
      turn(call("c2", "echo", { text: "2" })),
      turn(call("c3", "echo", { text: "3" })),
      finalTurn("完成"),
    ]);
    const agent = new FunctionCallAgent("a", llm, registry);
    await agent.run("长任务");

    const reminder = agent
      .getHistory()
      .find((m) => m.content.includes("<reminder>Update your todos.</reminder>"));
    expect(reminder?.role).toBe("user");
    // reminder 位于第 3 轮全部 tool 消息之后
    const roles = agent.getHistory().map((m) => m.role);
    expect(roles.filter((r) => r === "tool")).toHaveLength(3);
    // 第 4 次模型调用（收尾轮）能看到 reminder
    expect(
      llm.toolCallsList[3]?.messages.some(
        (m) => m.role === "user" && m.content?.includes("<reminder>"),
      ),
    ).toBe(true);
  });

  it("使用 todo_write 的轮次计数清零，不触发 reminder", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const registry = echoRegistry().register(new TodoWriteTool());
    const llm = new ScriptedLLM([], [
      turn(call("c1", "echo", { text: "1" })),
      turn(call("c2", "echo", { text: "2" })),
      turn(
        call("c3", "todo_write", {
          todos: [{ content: "a", status: "in_progress" }],
        }),
      ),
      finalTurn("完成"),
    ]);
    const agent = new FunctionCallAgent("a", llm, registry);
    await agent.run("任务");
    expect(
      agent.getHistory().some((m) => m.content.includes("<reminder>")),
    ).toBe(false);
  });

  it("未注册 todo_write 的装配完全不受 reminder 影响", async () => {
    const llm = new ScriptedLLM([], [
      turn(call("c1", "echo", { text: "1" })),
      turn(call("c2", "echo", { text: "2" })),
      turn(call("c3", "echo", { text: "3" })),
      turn(call("c4", "echo", { text: "4" })),
      finalTurn("完成"),
    ]);
    const agent = new FunctionCallAgent("a", llm, echoRegistry());
    await agent.run("无 todo 的任务");
    expect(
      agent.getHistory().some((m) => m.content.includes("<reminder>")),
    ).toBe(false);
  });
});
