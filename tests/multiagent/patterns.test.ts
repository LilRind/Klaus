import { describe, expect, it } from "vitest";
import { runParallel } from "../../src/multiagent/patterns/parallel";
import { runSequential, extractNumericValue } from "../../src/multiagent/patterns/sequential";
import { runHybrid } from "../../src/multiagent/patterns/hybrid";
import type { AgentResult, Subtask } from "../../src/multiagent/model";

const task = (id: string, deps: string[] = []): Subtask => ({
  id, description: `${id}`, dependencies: deps, produces: [], consumes: [], suggestedTools: [],
});
const result = (taskId: string, response: string): AgentResult => ({
  taskId, response, tokens: 10, success: true, numericValue: extractNumericValue(response),
});

describe("runParallel", () => {
  it("并发峰值 ≤5 且 8 任务全部返回、结果按原序", async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 8 }, (_, i) => task(`t${i}`));
    const results = await runParallel(tasks, async (sub) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return result(sub.id, `${sub.id} 完成`);
    });
    expect(peak).toBeLessThanOrEqual(5);
    expect(results.map((r) => r.taskId)).toEqual(tasks.map((t) => t.id));
  });
});

describe("runSequential", () => {
  it("previous_results 注入且 numericValue=15.3 传递", async () => {
    const seen: Array<Record<string, AgentResult> | undefined> = [];
    await runSequential([task("a"), task("b")], async (sub, context) => {
      seen.push(context.previousResults);
      return result(sub.id, sub.id === "a" ? "收入增长率为 15.3%" : "收到");
    });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]?.a?.numericValue).toBe(15.3);
  });
});

describe("runHybrid", () => {
  it("依赖完成同轮次唤醒 C 且 dependency_results 含 A/B；无轮询等待", async () => {
    const order: string[] = [];
    const results = await runHybrid(
      [task("a"), task("b"), task("c", ["a", "b"])],
      async (sub, context) => {
        order.push(`start:${sub.id}`);
        if (sub.id === "c") {
          expect(Object.keys(context.dependencyResults ?? {}).sort()).toEqual(["a", "b"]);
        }
        await Promise.resolve();
        order.push(`end:${sub.id}`);
        return result(sub.id, `${sub.id} ok`);
      },
    );
    expect(order.indexOf("start:c")).toBeGreaterThan(order.indexOf("end:b"));
    expect(order.indexOf("start:c")).toBeGreaterThan(order.indexOf("end:a"));
    expect(results).toHaveLength(3);
  });

  it("未知依赖立即报错不挂起", async () => {
    await expect(runHybrid([task("x", ["ghost"])], async (sub) => result(sub.id, "ok")))
      .rejects.toThrow(/ghost/);
  });
});
