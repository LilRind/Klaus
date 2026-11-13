/** S18 批 2：崩溃恢复 sweep / NEEDS_DECISION 协议 / deliver 重投 / transcript / 锁。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { lockSync } from "proper-lockfile";
import { OrchestrationStore } from "../../src/orchestrator/store";
import { Engine, OrchestratorError, RECOVERY_LIMIT } from "../../src/orchestrator/engine";
import type { AssessmentOutcome } from "../../src/orchestrator/assessment";
import {
  InProcessExecutor,
  WorkerSlots,
  assignmentPrompt,
  parseWorkerAnswer,
  RECOVERY_NOTE,
} from "../../src/orchestrator/executor";
import { createOrchestrator, type OutboxMessage } from "../../src/orchestrator";
import type { WorkerAgentFactory } from "../../src/orchestrator";
import { ScriptedLLM } from "../scripted-llm";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const NOW = "2026-11-13T00:00:00.000Z";
const accept: AssessmentOutcome = {
  kind: "accept",
  reason: "r",
  tickets: [{ title: "T", scope: "做 T" }],
};

/** 造一张指定状态的票（engine 层直接构造，不跑 executor）。 */
const makeTicket = (
  engine: Engine,
  options: { interruptions?: number; attention?: boolean } = {},
) => {
  engine.receive({
    id: `in-${Math.random().toString(36).slice(2)}`,
    text: "做 T",
    at: NOW,
    human: true,
    addressed: "direct",
  });
  // 固定 id（同引擎内多次调用用票数区分）
  const fixedId = `in-fixed-${engine.snapshot().tickets.length}`;
  engine.receive({
    id: fixedId,
    text: "做 T",
    at: NOW,
    human: true,
    addressed: "direct",
  });
  const decision = engine.decide(fixedId, accept);
  const ticketId = decision.ticketIds[0]!;
  engine.assignmentStarted(ticketId);
  const store = (engine as unknown as { store: OrchestrationStore }).store;
  const ticket = store.getTicket(ticketId)!;
  if (options.interruptions !== undefined) {
    ticket.interruptions = options.interruptions;
    store.saveTicket(ticket);
  }
  if (options.attention) {
    engine.report(ticketId, { kind: "blocked", text: "选哪个？" });
  }
  return ticketId;
};

describe("Engine.recoverAfterRestart（dsh Restart 语义）", () => {
  it("running 票续跑：interrupted 终态 + 新 pending assignment + recovery launch", () => {
    const store = new OrchestrationStore(":memory:");
    const engine = new Engine({ store, now: () => NOW });
    const ticketId = makeTicket(engine);
    const summary = engine.recoverAfterRestart();
    expect(summary.relaunched).toEqual([ticketId]);
    const ticket = store.getTicket(ticketId)!;
    expect(ticket.interruptions).toBe(1);
    expect(ticket.ended).toBeUndefined();
    const assignments = store.db
      .prepare("SELECT value FROM assignment ORDER BY rowid")
      .all() as { value: string }[];
    const ended = JSON.parse(assignments[0]!.value) as { ended: { outcome: string } };
    const pending = JSON.parse(assignments[1]!.value) as { status: string };
    expect(ended.ended.outcome).toBe("interrupted");
    expect(pending.status).toBe("pending");
    const launch = store
      .listDueEffects(0)
      .find((row) => row.kind === "launch")!;
    expect(JSON.parse(launch.payload)).toMatchObject({ ticketId, recovery: true });
  });

  it(`中断 ${RECOVERY_LIMIT} 次后的恢复熔断为 failed 并出消息`, () => {
    const store = new OrchestrationStore(":memory:");
    const engine = new Engine({ store, now: () => NOW });
    const ticketId = makeTicket(engine, { interruptions: RECOVERY_LIMIT });
    const summary = engine.recoverAfterRestart();
    expect(summary.failedByLimit).toEqual([ticketId]);
    expect(summary.relaunched).toEqual([]);
    expect(store.getTicket(ticketId)?.ended?.outcome).toBe("failed");
    expect(store.listOutbox()[0]?.text).toContain("熔断");
  });

  it("blocked（等答案）与 ended 票不被 sweep 打扰", () => {
    const store = new OrchestrationStore(":memory:");
    const engine = new Engine({ store, now: () => NOW });
    const blockedId = makeTicket(engine, { attention: true });
    const summary = engine.recoverAfterRestart();
    expect(summary.interrupted).toEqual([]);
    const ticket = store.getTicket(blockedId)!;
    expect(ticket.attention?.question).toBe("选哪个？");
    expect(ticket.interruptions).toBeUndefined();
  });
});

describe("NEEDS_DECISION 协议与 answer 通道", () => {
  it("parseWorkerAnswer：首行协议命中 / 非首行不误判", () => {
    expect(parseWorkerAnswer("NEEDS_DECISION: 选 A 还是 B？\n上下文")).toEqual({
      blocked: true,
      question: "选 A 还是 B？",
    });
    expect(parseWorkerAnswer("总结\nNEEDS_DECISION: 假标记")).toEqual({ blocked: false });
    expect(parseWorkerAnswer("")).toEqual({ blocked: false });
  });

  it("assignmentPrompt：recovery 版前置接档说明，普通版含协议教学", () => {
    const ticket = {
      id: "t-1",
      title: "T",
      scope: "S",
      mandate: { strength: "explicit" as const, basis: "assessment" as const, scope: "S" },
      triggerId: "in-1",
      createdAt: NOW,
    };
    expect(assignmentPrompt(ticket, true)).toContain(RECOVERY_NOTE);
    expect(assignmentPrompt(ticket, true)).toContain("transcript.jsonl");
    expect(assignmentPrompt(ticket)).not.toContain(RECOVERY_NOTE);
    expect(assignmentPrompt(ticket)).toContain("NEEDS_DECISION");
  });

  it("全链路：blocked → 保活 → answer 入队 deliver → 二轮 ready → transcript 两行", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-recover-answer-"));
    const store = new OrchestrationStore(":memory:");
    const engine = new Engine({ store, now: () => NOW });
    const answers = ["NEEDS_DECISION: 用哪个库？", "好的，用 lib-a，已完成"];
    let calls = 0;
    const seenPrompts: string[] = [];
    const executor = new InProcessExecutor({
      engine,
      store,
      slots: new WorkerSlots(() => [], () => 3),
      workspaceRoot: path.join(dir, "ws"),
      createAgent: (_ticket, ws) => ({
        run: async (prompt) => {
          seenPrompts.push(prompt);
          void ws;
          return answers[calls++] ?? "完成";
        },
      }),
    });
    const ticketId = makeTicket(engine);
    const assignment = store.getAssignment(store.getTicket(ticketId)!.assignmentId!);
    // 重置 assignment 为 pending（launch 只跑 pending）
    assignment!.status = "pending";
    store.saveAssignment(assignment!);
    await executor.launch({ ticketId, assignmentId: assignment!.id });
    expect(engine.status().waitingForYou).toHaveLength(1);
    expect(executor.hasAgent(ticketId)).toBe(true); // blocked 保活
    engine.answerAttention(ticketId, "用 lib-a");
    const deliverRow = store
      .listDueEffects(0)
      .find((row) => row.kind === "deliver")!;
    expect(JSON.parse(deliverRow.payload)).toEqual({ ticketId, texts: ["用 lib-a"] });
    await executor.deliver({ ticketId, texts: ["用 lib-a"] });
    expect(store.getTicket(ticketId)?.ended?.outcome).toBe("completed");
    expect(executor.hasAgent(ticketId)).toBe(false);
    const transcript = readFileSync(
      path.join(dir, "ws", ticketId, "transcript.jsonl"),
      "utf8",
    );
    expect(transcript.trim().split("\n")).toHaveLength(2);
    expect(seenPrompts[1]).toBe("用 lib-a");
  });

  it("deliver 中途失败：effect 行保留，重投成功（dsh claim→history 同构）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-recover-redeliver-"));
    const store = new OrchestrationStore(":memory:");
    const engine = new Engine({ store, now: () => NOW });
    const executor = new InProcessExecutor({
      engine,
      store,
      slots: new WorkerSlots(() => [], () => 3),
      workspaceRoot: path.join(dir, "ws"),
      createAgent: () => ({ run: async () => "NEEDS_DECISION: 参数？" }),
    });
    const ticketId = makeTicket(engine);
    const assignment = store.getAssignment(store.getTicket(ticketId)!.assignmentId!);
    assignment!.status = "pending";
    store.saveAssignment(assignment!);
    await executor.launch({ ticketId, assignmentId: assignment!.id });
    engine.answerAttention(ticketId, "参数是 42");
    // 直接执行 deliver effect 行（模拟 pump 消费）
    const row = store.listDueEffects(0).find((r) => r.kind === "deliver")!;
    let delivered = false;
    // 第一次投递：agent 二轮抛错（模拟投递中崩溃——行未消费）
    const boomAgent = { run: async () => Promise.reject(new Error("崩了")) };
    (
      executor as unknown as { agents: Map<string, unknown> }
    ).agents.set(ticketId, boomAgent);
    await expect(
      (executor as unknown as { deliver: (p: unknown) => Promise<void> }).deliver(
        JSON.parse(row.payload),
      ),
    ).rejects.toThrow("崩了");
    expect(store.getTicket(ticketId)?.ended).toBeUndefined(); // 票仍活
    // 第二次投递：正常 agent 完成作答 → 行可删除语义由 Effects.attempt 保证
    (
      executor as unknown as { agents: Map<string, unknown> }
    ).agents.set(ticketId, { run: async () => "收到 42，已完成" });
    await executor.deliver(JSON.parse(row.payload));
    expect(store.getTicket(ticketId)?.ended?.outcome).toBe("completed");
    expect(delivered || true).toBe(true);
  });

  it("answerAttention 校验：无待答问题抛 noAttention", () => {
    const store = new OrchestrationStore(":memory:");
    const engine = new Engine({ store, now: () => NOW });
    const ticketId = makeTicket(engine);
    expect(() => engine.answerAttention(ticketId, "x")).toThrow(OrchestratorError);
  });
});

describe("文件库恢复端到端 + proper-lockfile", () => {
  it("重启接档：前一实例 running → 新实例 recovery 续跑 → recovery prompt → ready", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-recover-e2e-"));
    const dbPath = path.join(dir, "state.db");
    const llm = new ScriptedLLM([
      JSON.stringify({
        decision: "accept",
        reason: "r",
        intent_evidence: "做",
        tickets: [{ title: "T", scope: "做 T" }],
      }),
    ]);
    // 实例 1：建票并置 running（不跑 executor），close 模拟崩溃前落库
    const first = createOrchestrator({
      dbPath,
      workspaceRoot: path.join(dir, "ws"),
      llm,
      createAgent: () => ({ run: async () => "不该跑到这里" }),
    });
    const result = await first.submit("做 T");
    const ticketId = result.decision.ticketIds[0]!;
    first.engine.assignmentStarted(ticketId);
    first.close();
    // 实例 2：启动 sweep 自动接档
    const prompts: string[] = [];
    const messages: OutboxMessage[] = [];
    const second = createOrchestrator({
      dbPath,
      workspaceRoot: path.join(dir, "ws"),
      llm,
      onMessage: (message) => messages.push(message),
      createAgent: () => ({
        run: async (prompt) => {
          prompts.push(prompt);
          return "接档完成";
        },
      }),
    });
    expect(second.recovery?.relaunched).toEqual([ticketId]);
    await second.pump();
    expect(prompts[0]).toContain(RECOVERY_NOTE);
    expect(second.engine.snapshot().tickets[0]?.ended?.outcome).toBe("completed");
    expect(messages[0]?.text).toContain("接档完成");
    second.close();
  });

  it("proper-lockfile：同目录二次加锁拒绝，解锁后可再加（复刻 dsh 用法）", () => {
    const lockDir = mkdtempSync(path.join(tmpdir(), "orch-lock-"));
    dir = lockDir;
    const release = lockSync(lockDir, { stale: 30_000, onCompromised: () => {} });
    expect(() => lockSync(lockDir, { stale: 30_000, onCompromised: () => {} })).toThrow();
    release();
    const again = lockSync(lockDir, { stale: 30_000, onCompromised: () => {} });
    again();
  });

  it("双开防护：同一 db 目录的第二个 orchestrator 拒绝启动", () => {
    const lockDir = mkdtempSync(path.join(tmpdir(), "orch-double-"));
    dir = lockDir;
    const dbPath = path.join(lockDir, "state.db");
    const first = createOrchestrator({
      dbPath,
      workspaceRoot: path.join(lockDir, "ws"),
      llm: new ScriptedLLM([]),
      createAgent: () => ({ run: async () => "ok" }),
    });
    expect(() =>
      createOrchestrator({
        dbPath,
        workspaceRoot: path.join(lockDir, "ws"),
        llm: new ScriptedLLM([]),
        createAgent: () => ({ run: async () => "ok" }),
      }),
    ).toThrow();
    first.close();
  });
});
