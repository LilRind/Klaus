/** S18 Effects：先存后做 / 退避 / Later / dirty-bit drain（dsh + clowder 不变量）。 */
import { describe, expect, it } from "vitest";
import { OrchestrationStore } from "../../src/orchestrator/store";
import { Effects, Later } from "../../src/orchestrator/effects";

const makeEffects = () => {
  const store = new OrchestrationStore(":memory:");
  let clock = 1_000;
  const effects = new Effects(store, () => clock);
  return {
    store,
    effects,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
};

describe("Effects", () => {
  it("成功执行后删除行", async () => {
    const { store, effects } = makeEffects();
    const seen: string[] = [];
    effects.handle("reply", (payload) => {
      seen.push(payload.messageId);
    });
    store.enqueueEffect("reply", "m1", { messageId: "m1" });
    await effects.drain();
    expect(seen).toEqual(["m1"]);
    expect(effects.pending()).toBe(false);
  });

  it("按 seq 顺序执行（同 Ticket 消息保序）", async () => {
    const { store, effects } = makeEffects();
    const order: string[] = [];
    effects.handle("reply", (payload) => {
      order.push(payload.messageId);
    });
    store.enqueueEffect("reply", "m1", { messageId: "m1" });
    store.enqueueEffect("reply", "m2", { messageId: "m2" });
    store.enqueueEffect("reply", "m3", { messageId: "m3" });
    await effects.drain();
    expect(order).toEqual(["m1", "m2", "m3"]);
  });

  it("失败：attempts+1、记录错误、指数退避后可重试成功", async () => {
    const { store, effects, advance, now } = makeEffects();
    let calls = 0;
    effects.handle("reply", () => {
      calls += 1;
      if (calls === 1) throw new Error("sink down");
    });
    store.enqueueEffect("reply", "m1", { messageId: "m1" });
    await effects.drain();
    expect(calls).toBe(1);
    // due 已被推后：用"包含未来"的查询检查重排结果
    let [row] = store.listDueEffects(Number.MAX_SAFE_INTEGER);
    expect(row?.attempts).toBe(1);
    expect(row?.error).toBe("sink down");
    advance((row?.due ?? 0) - now());
    await effects.drain();
    expect(calls).toBe(2);
    expect(store.listDueEffects(now())).toHaveLength(0);
  });

  it("Later：不计失败、attempts 不增、退避更短", async () => {
    const { store, effects, advance, now } = makeEffects();
    let calls = 0;
    effects.handle("launch", () => {
      calls += 1;
      if (calls <= 2) throw new Later("槽满");
    });
    store.enqueueEffect("launch", "t1", {});
    await effects.drain();
    const [afterFirst] = store.listDueEffects(Number.MAX_SAFE_INTEGER);
    expect(afterFirst?.attempts).toBe(0);
    expect(afterFirst?.error).toBe("");
    advance(2_000);
    await effects.drain();
    const [afterSecond] = store.listDueEffects(Number.MAX_SAFE_INTEGER);
    expect(afterSecond?.attempts).toBe(0);
    advance(2_000);
    await effects.drain();
    expect(calls).toBe(3);
    expect(store.listDueEffects(Number.MAX_SAFE_INTEGER)).toHaveLength(0);
  });

  it("concurrent kind：同批行并发执行（不互相等待）", async () => {
    const { store, effects } = makeEffects();
    const order: string[] = [];
    effects.handle(
      "launch",
      async (payload) => {
        const id = (payload as { ticketId: string }).ticketId;
        order.push(`start:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push(`end:${id}`);
      },
      { concurrent: true },
    );
    store.enqueueEffect("launch", "t1", { ticketId: "t1" });
    store.enqueueEffect("launch", "t2", { ticketId: "t2" });
    await effects.drain();
    expect(order[0]).toMatch(/^start:/);
    expect(order[1]).toMatch(/^start:/); // 两个 start 都先于任一 end
    expect(order.filter((item) => item.startsWith("start:"))).toHaveLength(2);
  });

  it("generation 防 ABA：执行期间重新入队则成功后不删新 payload", async () => {
    const { store, effects } = makeEffects();
    let merged = false;
    effects.handle("reply", (payload) => {
      if (!merged) {
        merged = true; // 只在首次执行时重新入队（模拟执行中合并新消息）
        store.enqueueEffect("reply", "m1", { messageId: "m1", v: 2 });
      }
    });
    store.enqueueEffect("reply", "m1", { messageId: "m1" });
    await effects.drain();
    // 首次执行时 generation 0→1：旧 generation 删除失败，新 payload 由下一轮消费
    // （同一次 drain 的重查逻辑保证不堆积），最终队列清空
    expect(effects.pending("reply", "m1")).toBe(false);
  });

  it("执行中派生的新行被同一次 drain 消费（不堆积）", async () => {
    const { store, effects } = makeEffects();
    const seen: string[] = [];
    effects.handle("reply", async (payload) => {
      seen.push(payload.messageId);
      if (payload.messageId === "m1") {
        // m1 执行中派生 m2（launch 成功派生 reply 的同款场景）
        store.enqueueEffect("reply", "m2", { messageId: "m2" });
      }
    });
    store.enqueueEffect("reply", "m1", { messageId: "m1" });
    await effects.drain();
    expect(seen).toEqual(["m1", "m2"]);
    expect(effects.pending()).toBe(false);
  });

  it("重复注册 handler 抛错", () => {
    const { effects } = makeEffects();
    effects.handle("reply", () => {});
    expect(() => effects.handle("reply", () => {})).toThrow(/已有 handler/);
  });
});
