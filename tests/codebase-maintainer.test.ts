import { describe, expect, it } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { ToolInvocationResult } from "../src/core/llm";
import { MemoryConfig } from "../src";
import { ScriptedLLM } from "./scripted-llm";
import { CodebaseMaintainer } from "../examples/9/codebase-maintainer";

function noToolCalls(): ToolInvocationResult {
  return { content: "已完成分析", toolCalls: [] };
}

function makeMaintainer() {
  const llm = new ScriptedLLM([], [noToolCalls()]);
  const maintainer = new CodebaseMaintainer({
    project: "ut_project",
    codebasePath: ".",
    llm,
    memoryOptions: {
      config: new MemoryConfig({
        embedModelType: "tfidf",
        databasePath: path.join("test_tmp", `ut_memory_${Math.random().toString(36).slice(2)}.db`),
      }),
    },
  });
  return { llm, maintainer };
}

describe("CodebaseMaintainer（Agentic 主线）", () => {
  it("注册三大工具且 schema 可用", () => {
    const { maintainer } = makeMaintainer();
    const names = maintainer.agent.toolRegistry.listTools().map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["terminal", "note", "memory"]));
    const schemas = maintainer.agent.buildToolSchemas();
    expect(schemas.map((s) => s.function.name)).toEqual(
      expect.arrayContaining(["terminal", "note", "memory"]),
    );
    expect(maintainer.agent.systemPrompt).toContain("terminal");
    expect(maintainer.agent.systemPrompt).toContain("note");
  });

  it("run：笔记上下文注入 + agent 单入口", async () => {
    const { llm, maintainer } = makeMaintainer();
    await maintainer.createNote({
      title: "API 错误处理缺失",
      content: "api_client 无超时重试",
      type: "blocker",
    });
    const answer = await maintainer.run("检查 API 错误处理进度");
    expect(answer).toBe("已完成分析");
    const messages = llm.toolCallsList[0]?.messages ?? [];
    expect(messages.some((m) => m.content?.includes("当前任务"))).toBe(true);
    expect(messages.some((m) => m.role === "system")).toBe(true);
    await fs.rm("./ut_project_notes", { recursive: true, force: true });
  });
});
