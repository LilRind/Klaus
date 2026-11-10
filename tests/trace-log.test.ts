import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentTraceLog } from "../src/core/trace-log";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { CalculatorTool } from "../src/tools/builtin/calculator";
import { WriteFileTool } from "../src/tools/builtin/file-tools";
import {
  createStandardPermissionChecker,
} from "../src/security/permission";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolInvocationResult } from "../src/core/llm";
import { promises as fs } from "node:fs";
import path from "node:path";

const tempDirs: string[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  await Promise.all(
    workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

function toolCall(id: string, name: string, args: string): ToolInvocationResult {
  return {
    content: null,
    toolCalls: [{ id, type: "function" as const, function: { name, arguments: args } }],
  };
}

describe("AgentTraceLog 双格式落盘", () => {
  it("hook 事件（s04 桥接）：jsonl 可读回，md 含挂点名与摘要", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-"));
    tempDirs.push(dir);
    const log = new AgentTraceLog("agent-hook", dir);

    await log.emit({
      type: "hook",
      hookEvent: "PreToolUse",
      toolName: "write_file",
      detail: "策略检查通过",
    });
    await log.emit({ type: "hook", hookEvent: "Stop" });

    const events = await log.readDay();
    expect(events.map((e) => e.type)).toEqual(["hook", "hook"]);
    expect(events[0]?.hookEvent).toBe("PreToolUse");
    expect(events[0]?.toolName).toBe("write_file");
    expect(events[1]?.hookEvent).toBe("Stop");

    const md = await readFile(
      join(dir, `agent-hook-${new Date().toISOString().slice(0, 10)}.md`),
      "utf8",
    );
    expect(md).toContain("🪝 hook PreToolUse · write_file");
    expect(md).toContain("策略检查通过");
    expect(md).toContain("🪝 hook Stop");
  });

  it("emit 追加 JSONL（ts/session 自动补齐），readDay 可读回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-"));
    tempDirs.push(dir);
    const log = new AgentTraceLog("agent-x", dir);

    await log.emit({ type: "run_start", input: "帮我算 6*7" });
    await log.emit({
      type: "tool_call",
      iteration: 1,
      toolCallId: "c1",
      toolName: "calculator",
      args: '{"expression":"6*7"}',
    });

    const events = await log.readDay();
    expect(events.map((e) => e.type)).toEqual(["run_start", "tool_call"]);
    expect(events[0]?.input).toBe("帮我算 6*7");
    expect(events[0]?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(events[0]?.session).toMatch(/^agent-x_\d{8}_\d{6}$/);
    expect(events[1]?.toolName).toBe("calculator");
    // 同一实例共享 session
    expect(events[1]?.session).toBe(events[0]?.session);
  });

  it("md 转录默认开启：可读块与 jsonl 同目录同名", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-md-"));
    tempDirs.push(dir);
    const log = new AgentTraceLog("agent-y", dir);

    await log.emit({ type: "run_start", input: "列出文件" });
    await log.emit({
      type: "tool_call",
      iteration: 1,
      toolName: "glob",
      args: '{"pattern":"**/*.ts"}',
    });
    await log.emit({
      type: "tool_result",
      iteration: 1,
      toolName: "glob",
      output: "src/a.ts\nsrc/b.ts",
      durationMs: 12,
    });
    await log.emit({ type: "loop_end", rounds: 2 });
    await log.emit({ type: "run_end", answer: "共两个文件", durationMs: 800 });

    const md = await readFile(
      join(dir, `agent-y-${new Date().toISOString().slice(0, 10)}.md`),
      "utf-8",
    );
    expect(md).toContain("# 执行轨迹（agent: agent-y");
    expect(md.match(/# 执行轨迹/g)).toHaveLength(1); // 头只写一次
    expect(md).toContain("👤 输入");
    expect(md).toContain("列出文件");
    expect(md).toContain("🔧 第 1 轮 · 调用 glob");
    expect(md).toContain("结果（12ms）");
    expect(md).toContain("✔ 循环结束（共 2 轮模型调用）");
    expect(md).toContain("📝 最终回答");
  });

  it("markdown: false 时只写 JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-jsonl-only-"));
    tempDirs.push(dir);
    const log = new AgentTraceLog("agent-z", dir, { markdown: false });
    await log.emit({ type: "run_start", input: "x" });
    expect(await log.readDay()).toHaveLength(1);
    await expect(
      readFile(join(dir, `agent-z-${new Date().toISOString().slice(0, 10)}.md`), "utf-8"),
    ).rejects.toBeTruthy();
  });

  it("写日志失败不抛错（fail-open），只警告一次", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new AgentTraceLog("bad", "C:\\invalid<>path");
    await expect(log.emit({ type: "run_start", input: "x" })).resolves.toBeUndefined();
    await expect(log.emit({ type: "run_start", input: "y" })).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});

describe("FunctionCallAgent × AgentTraceLog 集成", () => {
  it("完整事件序列：run_start → tool_call/tool_result → loop_end → run_end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-int-"));
    tempDirs.push(dir);
    const log = new AgentTraceLog("fc", dir, { markdown: false });
    const llm = new ScriptedLLM([], [
      toolCall("c1", "calculator", '{"expression":"6*7"}'),
      { content: "42", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, new ToolRegistry().register(new CalculatorTool()), {
      traceLog: log,
    });
    await agent.run("6*7 等于几");

    const events = await log.readDay();
    expect(events.map((e) => e.type)).toEqual([
      "run_start",
      "tool_call",
      "tool_result",
      "loop_end",
      "run_end",
    ]);
    expect(events[1]?.args).toBe('{"expression":"6*7"}'); // 完整原文，可复现
    expect(events[2]?.output).toBe("42");
    expect(events[2]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[3]?.rounds).toBe(2);
    expect(events[4]?.answer).toBe("42");
  });

  it("强制收尾路径：forced_final 事件存在且无 loop_end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-forced-"));
    tempDirs.push(dir);
    const log = new AgentTraceLog("fc", dir, { markdown: false });
    const llm = new ScriptedLLM(["根据结果回答"], [
      toolCall("c1", "calculator", '{"expression":"1+1"}'),
    ]);
    const agent = new FunctionCallAgent("fc", llm, new ToolRegistry().register(new CalculatorTool()), {
      traceLog: log,
      maxToolIterations: 1,
    });
    await agent.run("算 1+1");

    const types = (await log.readDay()).map((e) => e.type);
    expect(types).toContain("forced_final");
    expect(types).not.toContain("loop_end");
    expect(types.at(-1)).toBe("run_end");
  });

  it("权限拒绝以 tool_result 原文落盘（⛔ observation 可审计）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "trace-deny-"));
    tempDirs.push(dir);
    const root = path.join("test_tmp", `trace_${Math.random().toString(36).slice(2)}`);
    workspaces.push(root);
    await fs.mkdir(root, { recursive: true });
    const log = new AgentTraceLog("fc", dir, { markdown: false });
    const registry = new ToolRegistry()
      .register(new WriteFileTool({ workspace: root }))
      .setPermissionChecker(createStandardPermissionChecker({ workspaceRoot: root }));
    const llm = new ScriptedLLM([], [
      toolCall("c1", "write_file", '{"path":".git/x.sh","content":"x"}'),
      { content: "被拒绝", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, registry, { traceLog: log });
    await agent.run("写 .git/x.sh");

    const denied = (await log.readDay()).find((e) => e.type === "tool_result");
    expect(denied?.output).toContain("⛔ 权限已拒绝");
    expect(denied?.output).toContain(".git");
  });
});
