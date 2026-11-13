/** S18 组装层端到端：submit → 研判 → 拆票 → 并发 worker → outbox 投递（REPL 全链路）。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

const acceptJson = (tickets: { title: string; scope: string }[]) =>
  JSON.stringify({
    decision: "accept",
    reason: "明确请求",
    intent_evidence: "用户原话",
    tickets,
  });

const fakeWorkers =
  (timeline: string[] = []): WorkerAgentFactory =>
  (ticket) => ({
    run: async () => {
      timeline.push(`start:${ticket.id}`);
      await new Promise((resolve) => setTimeout(resolve, 15));
      timeline.push(`end:${ticket.id}`);
      return `完成：${ticket.title}`;
    },
  });

describe("createOrchestrator 全链路", () => {
  it("一句话拆两票：并发执行 → 两份 ready 汇报按序投递到 sink", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-flow-"));
    const timeline: string[] = [];
    const messages: OutboxMessage[] = [];
    const llm = new ScriptedLLM([
      acceptJson([
        { title: "A", scope: "做 A" },
        { title: "B", scope: "做 B" },
      ]),
    ]);
    const orchestrator = createOrchestrator({
      workspaceRoot: path.join(dir, "ws"),
      llm,
      maxWorkers: 3,
      onMessage: (message) => messages.push(message),
      createAgent: fakeWorkers(timeline),
    });
    const result = await orchestrator.submit("帮我做 A 和 B");
    expect(result.decision.kind).toBe("accept");
    expect(result.decision.ticketIds).toHaveLength(2);
    await orchestrator.pump();

    // 并发（两个 start 都先于两个 end）
    expect(timeline[0]).toMatch(/^start:/);
    expect(timeline[1]).toMatch(/^start:/);
    expect(timeline.filter((item) => item.startsWith("start:"))).toHaveLength(2);

    // 两票都完成，消息按 outbox seq 顺序投递且标 sent
    const snapshot = orchestrator.engine.snapshot();
    expect(snapshot.tickets.every((t) => t.ended?.outcome === "completed")).toBe(true);
    expect(messages).toHaveLength(2);
    expect(snapshot.outbox.every((m) => m.status === "sent")).toBe(true);
    // 不同 Ticket 的消息互不等待（对齐 dsh 语义），完成顺序不假定
    expect([...messages].map((m) => m.text).sort()).toEqual([
      expect.stringContaining("完成：A"),
      expect.stringContaining("完成：B"),
    ]);
    orchestrator.close();
  });

  it("maxWorkers=1：两票严格串行（槽约束生效）", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-flow-serial-"));
    const timeline: string[] = [];
    let clock = 1_000;
    const llm = new ScriptedLLM([
      acceptJson([
        { title: "A", scope: "做 A" },
        { title: "B", scope: "做 B" },
      ]),
    ]);
    const orchestrator = createOrchestrator({
      workspaceRoot: path.join(dir, "ws"),
      llm,
      maxWorkers: 1,
      effectClock: () => clock,
      createAgent: fakeWorkers(timeline),
    });
    await orchestrator.submit("两件事");
    await orchestrator.pump();
    // 第二票槽满 Later（due = clock+2000），推进时钟后重试
    clock += 2_000;
    await orchestrator.pump();
    // 严格串行：start → end → start → end（第二票开始前第一票已结束）
    expect(timeline).toHaveLength(4);
    expect(timeline[0]?.startsWith("start:")).toBe(true);
    expect(timeline[1]?.startsWith("end:")).toBe(true);
    expect(timeline[2]?.startsWith("start:")).toBe(true);
    expect(timeline[3]?.startsWith("end:")).toBe(true);
    orchestrator.close();
  });

  it("研判 ignore：无票无消息", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-flow-ignore-"));
    const messages: OutboxMessage[] = [];
    const llm = new ScriptedLLM(['{"decision":"ignore","reason":"打招呼"}']);
    const orchestrator = createOrchestrator({
      workspaceRoot: path.join(dir, "ws"),
      llm,
      onMessage: (message) => messages.push(message),
    });
    const result = await orchestrator.submit("你好");
    expect(result.decision.kind).toBe("ignore");
    await orchestrator.pump();
    expect(orchestrator.engine.snapshot().tickets).toHaveLength(0);
    expect(messages).toHaveLength(0);
    orchestrator.close();
  });

  it("研判输出坏 JSON：降级 ignore 且带错误码", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-flow-badjson-"));
    const llm = new ScriptedLLM(["我觉得没法做"]);
    const orchestrator = createOrchestrator({
      workspaceRoot: path.join(dir, "ws"),
      llm,
    });
    const result = await orchestrator.submit("随便说点啥");
    expect(result.decision.kind).toBe("ignore");
    expect(result.decision.reason).toContain("invalidJson");
    orchestrator.close();
  });

  it("blocked 汇报经 outbox 送达 sink，票出现在三问的 waiting 里", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "orch-flow-blocked-"));
    const messages: OutboxMessage[] = [];
    const llm = new ScriptedLLM([acceptJson([{ title: "A", scope: "做 A" }])]);
    const orchestrator = createOrchestrator({
      workspaceRoot: path.join(dir, "ws"),
      llm,
      onMessage: (message) => messages.push(message),
      createAgent: () => ({ run: async () => "ok" }),
    });
    const result = await orchestrator.submit("做 A");
    const ticketId = result.decision.ticketIds[0]!;
    orchestrator.engine.assignmentStarted(ticketId);
    orchestrator.engine.report(ticketId, { kind: "blocked", text: "选哪个方案？" });
    await orchestrator.pump();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toContain("选哪个方案？");
    expect(
      orchestrator.engine.status().waitingForYou.map((ticket) => ticket.id),
    ).toContain(ticketId);
    orchestrator.close();
  });
});
