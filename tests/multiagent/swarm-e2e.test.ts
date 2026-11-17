import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MultiagentOrchestrator } from "../../src/multiagent/orchestrator";
import { scriptedLlm } from "./test-llm";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("swarm e2e（3.7）：orchestrator mode=swarm 全链路", () => {
  it("initial_plan→spawn→publish→idle→final_reply + journal 时间线", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "s18e-"));
    dirs.push(root);
    const leadReplies = [
      JSON.stringify({
        actions: [
          { type: "create_task", id: "t1", description: "调研三家竞品" },
          { type: "spawn_agent", agentId: "w1", role: "researcher", taskId: "t1", taskDescription: "调研三家竞品" },
        ],
      }),
      JSON.stringify({ actions: [{ type: "final_reply", content: "完成：三家竞品要点已汇总" }] }),
    ];
    const workerReplies = [
      '{"type":"publish_data","topic":"findings","data":"竞品A/B/C 要点"}',
      '{"type":"idle","keyFindings":"调研完成"}',
    ];
    const orchestrator = new MultiagentOrchestrator({
      llm: scriptedLlm([]),
      mode: "swarm",
      journalRoot: root,
      now: () => new Date("2026-11-17T00:00:00Z"),
      swarmOptions: {
        leadLlm: scriptedLlm(leadReplies),
        workerLlm: scriptedLlm(workerReplies),
      },
    });
    const run = await orchestrator.run("调研三家竞品并汇总");
    expect(run.line).toBe("swarm");
    expect(run.final).toBe("完成：三家竞品要点已汇总");
    const journalPath = path.join(root, run.runId, "events.jsonl");
    const types = readFileSync(journalPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => (JSON.parse(line) as { type: string }).type);
    for (const expected of [
      "run.started",
      "route.decision",
      "lead.decision",
      "swarm.agent_started",
      "workspace.append",
      "agent.idle",
      "swarm.final",
      "run.completed",
    ]) {
      expect(types).toContain(expected);
    }
  });
});
