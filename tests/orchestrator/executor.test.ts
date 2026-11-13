/** S18 Executor：并发槽 / 进程内 worker 生命周期（dsh WorkerSlots + DshExecutor 等价物）。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OrchestrationStore } from "../../src/orchestrator/store";
import { Engine } from "../../src/orchestrator/engine";
import {
  InProcessExecutor,
  WorkerSlots,
  assignmentPrompt,
  defaultAgentFactory,
  type WorkerAgentFactory,
} from "../../src/orchestrator/executor";
import type { AssessmentOutcome } from "../../src/orchestrator/assessment";
import { Later } from "../../src/orchestrator/effects";
import { ScriptedLLM } from "../scripted-llm";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const NOW = "2026-11-13T00:00:00.000Z";

const makeFixture = (createAgent: WorkerAgentFactory, max = 3) => {
  dir = mkdtempSync(path.join(tmpdir(), "orch-exec-"));
  const store = new OrchestrationStore(":memory:");
  const engine = new Engine({ store, now: () => NOW });
  const workspaceRoot = path.join(dir, "workspaces");
  const slots = new WorkerSlots(() => [], () => max);
  const executor = new InProcessExecutor({
    engine,
    store,
    slots,
    workspaceRoot,
    createAgent,
  });
  const accept: AssessmentOutcome = {
    kind: "accept",
    reason: "r",
    tickets: [{ title: "T", scope: "做 T" }],
  };
  store.atomic(() => {
    store.saveTrigger({
      id: "in-1",
      text: "做 T",
      at: NOW,
      human: true,
      addressed: "direct",
    });
  });
  const decision = engine.decide("in-1", accept);
  return { store, engine, executor, decision, workspaceRoot };
};

describe("WorkerSlots", () => {
  it("预留占用名额；满则抛 Later；free 释放", () => {
    const slots = new WorkerSlots(() => ["running-1"], () => 2);
    slots.reserve("t1");
    expect(slots.used()).toBe(2);
    expect(() => slots.reserve("t2")).toThrow(Later);
    slots.free("t1");
    slots.reserve("t2");
    expect(slots.used()).toBe(2);
  });

  it("同 id 重复 reserve 幂等", () => {
    const slots = new WorkerSlots(() => [], () => 1);
    slots.reserve("t1");
    slots.reserve("t1");
    expect(slots.used()).toBe(1);
  });
});

describe("InProcessExecutor.launch", () => {
  it("全链路：建目录 → started → ready 报告 → 票完成", async () => {
    const prompts: string[] = [];
    const { store, engine, executor, decision, workspaceRoot } = makeFixture(
      (ticket, ws) => ({
        run: async (prompt) => {
          prompts.push(prompt);
          expect(ws.startsWith(workspaceRoot)).toBe(true);
          expect(ticket.id).toBeTruthy();
          return "完成总结";
        },
      }),
    );
    const ticketId = decision.ticketIds[0]!;
    await executor.launch({ ticketId, assignmentId: store.getTicket(ticketId)!.assignmentId! });
    expect(statSync(path.join(workspaceRoot, ticketId)).isDirectory()).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("做 T");
    const ticket = store.getTicket(ticketId)!;
    expect(ticket.ended?.outcome).toBe("completed");
    expect(store.listReports(ticketId)[0]?.text).toBe("完成总结");
    expect(store.listOutbox()[0]?.text).toContain("完成总结");
  });

  it("worker 抛错 → failed 报告（assignment 终态 failed）", async () => {
    const { store, executor, decision } = makeFixture(() => ({
      run: async () => {
        throw new Error("模型超时");
      },
    }));
    const ticketId = decision.ticketIds[0]!;
    await executor.launch({ ticketId, assignmentId: store.getTicket(ticketId)!.assignmentId! });
    expect(store.getTicket(ticketId)?.ended?.outcome).toBe("failed");
    expect(store.getAssignment(store.getTicket(ticketId)!.assignmentId!)?.ended?.outcome).toBe(
      "failed",
    );
  });

  it("槽满抛 Later（effect 层重排不计失败）", async () => {
    const { store, executor, decision } = makeFixture(() => ({ run: async () => "ok" }), 0);
    const ticketId = decision.ticketIds[0]!;
    await expect(
      executor.launch({ ticketId, assignmentId: store.getTicket(ticketId)!.assignmentId! }),
    ).rejects.toBeInstanceOf(Later);
    const ticket = store.getTicket(ticketId)!;
    expect(ticket.ended).toBeUndefined(); // 未启动，票保持 pending
  });

  it("票已结束时 launch 静默完成（幂等）", async () => {
    const { store, engine, executor, decision } = makeFixture(() => ({ run: async () => "ok" }));
    const ticketId = decision.ticketIds[0]!;
    engine.stopTicket(ticketId, "不需要");
    await executor.launch({ ticketId, assignmentId: store.getTicket(ticketId)!.assignmentId! });
    expect(store.getTicket(ticketId)?.ended?.outcome).toBe("stopped");
  });
});

describe("assignmentPrompt / defaultAgentFactory", () => {
  it("任务说明包含边界与无人值守纪律", () => {
    const prompt = assignmentPrompt({
      id: "t-1",
      title: "T",
      scope: "S",
      mandate: { strength: "explicit", basis: "assessment", scope: "S" },
      triggerId: "in-1",
      createdAt: NOW,
    });
    expect(prompt).toContain("边界：S");
    expect(prompt).toContain("NEEDS_DECISION");
  });

  it("默认工厂产出 FunctionCallAgent（file 四件套锁定工位目录）", () => {
    const agent = defaultAgentFactory(new ScriptedLLM([], []))(
      {
        id: "t-1",
        title: "T",
        scope: "S",
        mandate: { strength: "explicit", basis: "assessment", scope: "S" },
        triggerId: "in-1",
        createdAt: NOW,
      },
      path.join(tmpdir(), "ws"),
    );
    expect(typeof agent.run).toBe("function");
  });
});
