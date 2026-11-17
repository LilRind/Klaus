import { describe, expect, it } from "vitest";
import { WorkspaceStore } from "../../src/multiagent/workspace";
import { MailboxStore } from "../../src/multiagent/mailbox";
import {
  broadcastTaskRequest,
  completeNegotiation,
  submitOffer,
  type Offer,
} from "../../src/multiagent/negotiation";

describe("WorkspaceStore", () => {
  it("跨主题全局 seq 严格递增", () => {
    const ws = new WorkspaceStore({ now: () => "t" });
    const a = ws.append("a", { v: 1 });
    const b = ws.append("b", { v: 2 });
    expect(b.seq).toBeGreaterThan(a.seq);
  });

  it("超过 1MB 拒绝且不消耗 seq", () => {
    const ws = new WorkspaceStore({ now: () => "t" });
    const before = ws.append("a", { ok: true }).seq;
    const huge = "x".repeat(1024 * 1024 + 10);
    expect(() => ws.append("a", { blob: huge })).toThrow(/1MB/);
    const after = ws.append("a", { ok: 2 });
    expect(after.seq).toBe(before + 1);
  });

  it("sinceSeq 增量读取不重复", () => {
    const ws = new WorkspaceStore({ now: () => "t" });
    ws.append("market", { i: 1 });
    const first = ws.list("market");
    expect(first).toHaveLength(1);
    const second = ws.append("market", { i: 2 });
    expect(ws.list("market", first[0]?.seq ?? 0).map((e) => e.seq)).toEqual([second.seq]);
    expect(ws.list("market", second.seq)).toHaveLength(0);
  });

  it("onAppend 钩子记录全部写入（journal 接入点）", () => {
    const appended: string[] = [];
    const ws = new WorkspaceStore({ now: () => "t", onAppend: (e) => appended.push(e.topic) });
    ws.append("x", 1);
    ws.append("y", 2);
    expect(appended).toEqual(["x", "y"]);
  });
});

describe("MailboxStore", () => {
  it("读取即消费：第二次读取为空", () => {
    const box = new MailboxStore({ now: () => "t" });
    box.send("lead", "w1", "delegation", { taskId: "t1" });
    expect(box.readInbox("w1")).toHaveLength(1);
    expect(box.readInbox("w1")).toHaveLength(0);
  });

  it("非法类型拒绝并列出支持类型", () => {
    const box = new MailboxStore({ now: () => "t" });
    expect(() => box.send("a", "b", "urgent" as never, {})).toThrow(/request.*offer/);
  });

  it("per-box seq 递增且互不干扰", () => {
    const box = new MailboxStore({ now: () => "t" });
    const m1 = box.send("a", "w1", "info", {});
    const m2 = box.send("b", "w2", "info", {});
    const m3 = box.send("a", "w1", "info", {});
    expect(m1.seq).toBe(1);
    expect(m2.seq).toBe(1);
    expect(m3.seq).toBe(2);
  });
});

describe("negotiation 三步协商", () => {
  it("最高置信度中标，未中标方收到通知", () => {
    const box = new MailboxStore({ now: () => "t" });
    broadcastTaskRequest(box, "lead", ["w1", "w2"], { taskId: "t9", description: "深挖定价", skills: ["research"] });
    submitOffer(box, "w1", "lead", "t9", 0.5);
    submitOffer(box, "w2", "lead", "t9", 0.9);
    const offers = box
      .readInbox("lead")
      .filter((m) => m.type === "offer")
      .map((m) => ({ from: m.from, confidence: Number(m.payload.confidence ?? 0) })) as Offer[];
    const outcome = completeNegotiation(box, "lead", offers, { taskId: "t9" });
    expect(outcome.winner.from).toBe("w2");
    const w2 = box.readInbox("w2");
    const w1 = box.readInbox("w1");
    expect(w2.some((m) => m.type === "accept")).toBe(true);
    expect(w1.some((m) => m.type === "info" && String(m.payload.result ?? "").includes("未中标"))).toBe(true);
  });
});
