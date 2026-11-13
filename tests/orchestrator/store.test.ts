/** S18 Store：kv / atomic 事务 / effect 入队语义（dsh 移植）。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { KV } from "../../src/orchestrator/kv";
import { OrchestrationStore, SCHEMA_VERSION } from "../../src/orchestrator/store";

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

const makeStore = (): OrchestrationStore => {
  dir = mkdtempSync(path.join(tmpdir(), "orch-store-"));
  return new OrchestrationStore(path.join(dir, "state.db"));
};

describe("OrchestrationStore", () => {
  it("建库即写 schema 版本", () => {
    const store = makeStore();
    expect(store.get(KV.store.schema)).toBe(SCHEMA_VERSION);
    store.close();
  });

  it("kv get/set 往返与覆盖", () => {
    const store = makeStore();
    store.set(KV.engine.seq, 3);
    expect(store.get(KV.engine.seq)).toBe(3);
    store.set(KV.engine.seq, 7);
    expect(store.get(KV.engine.seq)).toBe(7);
    store.close();
  });

  it("atomic：fn 抛错整体回滚", () => {
    const store = makeStore();
    store.set(KV.engine.seq, 1);
    expect(() =>
      store.atomic(() => {
        store.set(KV.engine.seq, 99);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.get(KV.engine.seq)).toBe(1);
    store.close();
  });

  it("effect enqueue：新行递增 seq；同 (kind,key) 重新入队保留队列位置且 generation+1", () => {
    const store = makeStore();
    store.enqueueEffect("launch", "t1", { ticketId: "t1" });
    store.enqueueEffect("launch", "t2", { ticketId: "t2" });
    store.enqueueEffect("launch", "t1", { ticketId: "t1", assignmentId: "a1" });
    const rows = store.listDueEffects(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.key).toBe("t1");
    expect(rows[0]?.generation).toBe(1);
    expect(rows[0]?.seq).toBe(1);
    expect(rows[1]?.key).toBe("t2");
    expect(rows[1]?.seq).toBe(2);
    store.close();
  });

  it("deleteEffect 按 generation 防误删（ABA）", () => {
    const store = makeStore();
    store.enqueueEffect("reply", "m1", { messageId: "m1" });
    const [row] = store.listDueEffects(0);
    store.enqueueEffect("reply", "m1", { messageId: "m1", v: 2 }); // generation → 1
    expect(store.deleteEffect("reply", "m1", row!.generation)).toBe(false); // 旧 generation 删不掉
    expect(store.listDueEffects(0).some((r) => r.key === "m1")).toBe(true);
    expect(store.deleteEffect("reply", "m1", 1)).toBe(true);
    expect(store.listDueEffects(0).some((r) => r.key === "m1")).toBe(false);
    store.close();
  });

  it("retryEffect：计数失败 attempts+1；Later 计数不增", () => {
    const store = makeStore();
    store.enqueueEffect("launch", "t1", {});
    store.retryEffect("launch", "t1", 500, "boom", true);
    store.retryEffect("launch", "t1", 900, "", false);
    const [row] = store.listDueEffects(1000);
    expect(row?.attempts).toBe(1);
    expect(row?.error).toBe("");
    expect(row?.due).toBe(900);
    store.close();
  });
});
