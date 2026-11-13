/** S18 Engine：命令语义 / 幂等 / 单终态 / 状态机 / 角色 Pick（dsh + clowder）。 */
import { describe, expect, it } from "vitest";
import { OrchestrationStore } from "../../src/orchestrator/store";
import {
  Engine,
  OrchestratorError,
} from "../../src/orchestrator/engine";
import type { DomainEvent, Trigger } from "../../src/orchestrator/model";
import type { AssessmentOutcome } from "../../src/orchestrator/assessment";

const NOW = "2026-11-13T00:00:00.000Z";

const makeEngine = () => {
  const store = new OrchestrationStore(":memory:");
  const events: DomainEvent[] = [];
  const engine = new Engine({ store, now: () => NOW, emit: (event) => events.push(event) });
  return { store, engine, events };
};

const makeTrigger = (id: string, text = "做点什么"): Trigger => ({
  id,
  text,
  at: NOW,
  human: true,
  addressed: "direct",
});

const accept = (n = 1): AssessmentOutcome => ({
  kind: "accept",
  reason: "明确请求",
  tickets: Array.from({ length: n }, (_, i) => ({
    title: `任务${i + 1}`,
    scope: `第 ${i + 1} 件事`,
  })),
});

const ignore: AssessmentOutcome = { kind: "ignore", reason: "闲聊" };

/** 建一张已 running 的票（多数用例的前置）。 */
const runningTicket = (engine: Engine) => {
  engine.receive(makeTrigger("in-1"));
  const decision = engine.decide("in-1", accept(1));
  const ticketId = decision.ticketIds[0]!;
  engine.assignmentStarted(ticketId);
  return ticketId;
};

describe("Engine.receive", () => {
  it("按 id 幂等：同 id 第二次返回 duplicate 且不发事件", () => {
    const { engine, events } = makeEngine();
    expect(engine.receive(makeTrigger("in-1"))).toBe("stored");
    expect(engine.receive(makeTrigger("in-1"))).toBe("duplicate");
    expect(events.filter((e) => e.type === "trigger.received")).toHaveLength(1);
  });
});

describe("Engine.decide", () => {
  it("accept 建 N 票 + pending assignment + launch effect（同事务）", () => {
    const { store, engine, events } = makeEngine();
    engine.receive(makeTrigger("in-1"));
    const decision = engine.decide("in-1", accept(3));
    expect(decision.kind).toBe("accept");
    expect(decision.ticketIds).toHaveLength(3);
    const tickets = store.listTickets();
    expect(tickets).toHaveLength(3);
    expect(tickets.every((t) => t.assignmentId !== undefined)).toBe(true);
    expect(store.listDueEffects(0).filter((r) => r.kind === "launch")).toHaveLength(3);
    expect(events.filter((e) => e.type === "ticket.created")).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("decision.recorded");
  });

  it("ignore 只记 Decision，不建票", () => {
    const { store, engine } = makeEngine();
    engine.receive(makeTrigger("in-1"));
    const decision = engine.decide("in-1", ignore);
    expect(decision.kind).toBe("ignore");
    expect(store.listTickets()).toHaveLength(0);
    expect(store.listDueEffects(0)).toHaveLength(0);
  });

  it("一个 Trigger 只能 decide 一次", () => {
    const { engine } = makeEngine();
    engine.receive(makeTrigger("in-1"));
    engine.decide("in-1", ignore);
    expect(() => engine.decide("in-1", ignore)).toThrow(OrchestratorError);
  });

  it("未知 Trigger 拒绝", () => {
    const { engine } = makeEngine();
    expect(() => engine.decide("nope", ignore)).toThrow(/未知 Trigger/);
  });
});

describe("Engine.report 状态机", () => {
  it("progress：只记录，票仍在跑", () => {
    const { engine } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "progress", text: "写了一半" });
    const ticket = engine.snapshot().tickets.find((t) => t.id === id);
    expect(ticket?.ended).toBeUndefined();
    expect(engine.status().working).toHaveLength(1);
  });

  it("blocked：置 Attention 并入队一条提问消息", () => {
    const { store, engine, events } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "blocked", text: "选 A 还是 B？" });
    const ticket = store.getTicket(id);
    expect(ticket?.attention?.question).toBe("选 A 还是 B？");
    expect(engine.status().waitingForYou).toHaveLength(1);
    expect(store.listOutbox()).toHaveLength(1);
    expect(events.some((e) => e.type === "attention.raised")).toBe(true);
  });

  it("ready：assignment+ticket 双双 completed，结果入 outbox", () => {
    const { store, engine, events } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "ready", text: "完成总结" });
    const ticket = store.getTicket(id);
    expect(ticket?.ended?.outcome).toBe("completed");
    const assignment = store.getAssignment(ticket!.assignmentId!);
    expect(assignment?.ended?.outcome).toBe("completed");
    expect(store.listOutbox()[0]?.text).toContain("完成");
    expect(events.at(-1)?.type).toBe("ticket.ended");
  });

  it("failed：双双 failed，失败消息入 outbox", () => {
    const { store, engine } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "failed", text: "环境坏了" });
    expect(store.getTicket(id)?.ended?.outcome).toBe("failed");
    expect(engine.status().failedTickets).toHaveLength(1);
    expect(store.listOutbox()[0]?.text).toContain("失败");
  });

  it("dropped：双双结束但不出消息（无需人处理）", () => {
    const { store, engine } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "dropped", text: "复现不存在" });
    expect(store.getTicket(id)?.ended?.outcome).toBe("dropped");
    expect(store.listOutbox()).toHaveLength(0);
  });

  it("单终态：assignment ended 后再 report 抛错（clowder 不变量）", () => {
    const { engine } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "ready", text: "done" });
    expect(() => engine.report(id, { kind: "ready", text: "again" })).toThrow(
      /已结束|拒绝重复汇报/,
    );
  });

  it("已结束的票不能 assignmentStarted / report", () => {
    const { engine } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "ready", text: "done" });
    expect(() => engine.assignmentStarted(id)).toThrow(/已结束/);
    expect(() => engine.report(id, { kind: "progress", text: "x" })).toThrow(/已结束/);
  });

  it("assignmentStarted 幂等防护：非 pending 抛错", () => {
    const { engine } = makeEngine();
    const id = runningTicket(engine); // 已 started
    expect(() => engine.assignmentStarted(id)).toThrow(/已启动/);
  });
});

describe("Engine.stopTicket", () => {
  it("停止 running 票：assignment stopped + 通知消息", () => {
    const { store, engine } = makeEngine();
    const id = runningTicket(engine);
    engine.stopTicket(id, "不需要了");
    const ticket = store.getTicket(id)!;
    expect(ticket.ended?.outcome).toBe("stopped");
    expect(store.getAssignment(ticket.assignmentId!)?.ended?.outcome).toBe("stopped");
    expect(store.listOutbox()[0]?.text).toContain("停止");
  });

  it("已结束的票不能停止", () => {
    const { engine } = makeEngine();
    const id = runningTicket(engine);
    engine.report(id, { kind: "ready", text: "done" });
    expect(() => engine.stopTicket(id, "x")).toThrow(/已结束/);
  });
});

describe("Engine.status 三问", () => {
  it("waiting / working / problems 各归其位", () => {
    const { engine } = makeEngine();
    engine.receive(makeTrigger("in-1"));
    const [id1] = engine.decide("in-1", accept(2)).ticketIds;
    engine.assignmentStarted(id1!);
    engine.report(id1!, { kind: "blocked", text: "选哪个？" });
    const status = engine.status();
    expect(status.waitingForYou.map((t) => t.id)).toContain(id1);
    expect(status.working).toHaveLength(2); // blocked 票仍活 + 另一张 pending
    expect(status.failedTickets).toHaveLength(0);
  });
});
