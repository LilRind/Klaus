import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MultiagentOrchestrator } from "../../src/multiagent/orchestrator";
import { scriptedLlm, type ScriptedInvoke } from "./test-llm";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tempRoot = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "s18-"));
  dirs.push(dir);
  return dir;
};

const decomposeReply = JSON.stringify({
  complexity: 0.6,
  strategy: "parallel",
  subtasks: [
    { id: "t1", description: "查甲公司营收", dependencies: [], produces: [], consumes: [], suggestedTools: [] },
    { id: "t2", description: "查乙公司营收", dependencies: [], produces: [], consumes: [], suggestedTools: [] },
  ],
});

describe("MultiagentOrchestrator e2e", () => {
  it("auto → DAG parallel 全链路 + journal 事件序列", async () => {
    const calls: ScriptedInvoke[] = [];
    const root = tempRoot();
    const orch = new MultiagentOrchestrator({
      llm: scriptedLlm([decomposeReply, "甲营收 100 亿", "乙营收 200 亿", "综合：甲 100 / 乙 200"], calls),
      journalRoot: root,
    });
    const run = await orch.run("对比两家公司营收");
    expect(run.line).toBe("dag");
    expect(run.final).toBe("综合：甲 100 / 乙 200");
    const journalPath = path.join(root, run.runId, "events.jsonl");
    const types = readFileSync(journalPath, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as { type: string }).map((e) => e.type);
    expect(types[0]).toBe("run.started");
    expect(types).toContain("decompose.completed");
    expect(types).toContain("route.decision");
    expect(types.filter((t) => t === "task.completed")).toHaveLength(2);
    expect(types.at(-1)).toBe("run.completed");
  });

  it("mode=simple 直通：不调分解，最终即模型直答", async () => {
    const calls: ScriptedInvoke[] = [];
    const orch = new MultiagentOrchestrator({
      llm: scriptedLlm(["直答结果"], calls),
      mode: "simple",
      journalRoot: tempRoot(),
    });
    const run = await orch.run("今天天气如何");
    expect(run.line).toBe("simple");
    expect(run.final).toBe("直答结果");
    expect(calls).toHaveLength(1);
    expect(run.events.map((e) => e.type)).not.toContain("decompose.completed");
  });

  it("分解降级 → simple 兜底并记录错误码", async () => {
    const orch = new MultiagentOrchestrator({
      llm: scriptedLlm(["坏输出", "兜底直答"]),
      journalRoot: tempRoot(),
    });
    const run = await orch.run("随意输入");
    expect(run.line).toBe("simple");
    expect(run.final).toBe("兜底直答");
    expect(run.events).toContainEqual(expect.objectContaining({ type: "decompose.degraded", code: "invalidJson" }));
  });
});
