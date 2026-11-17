import { describe, expect, it } from "vitest";
import { resolveMode, routePlan } from "../../src/multiagent/router";
import type { Subtask, TaskPlan } from "../../src/multiagent/model";

const task = (id: string, over: Partial<Subtask> = {}): Subtask => ({
  id, description: `${id} 描述`, dependencies: [], produces: [], consumes: [], suggestedTools: [], ...over,
});
const plan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
  complexity: 0.6, strategy: "parallel", subtasks: [task("t1"), task("t2")], ...over,
});

describe("resolveMode 早路由", () => {
  it("mode=swarm 跳过分解", () => {
    expect(resolveMode("swarm")).toMatchObject({ line: "swarm", skipDecompose: true });
  });
  it("mode=simple 直通且跳过分解", () => {
    expect(resolveMode("simple")).toMatchObject({ line: "simple", skipDecompose: true });
  });
  it("mode=dag 直通但不跳过分解（DAG 仍需计划）", () => {
    expect(resolveMode("dag")).toMatchObject({ line: "dag", skipDecompose: false });
  });
  it("auto 不早路由", () => {
    expect(resolveMode("auto")).toBeUndefined();
    expect(resolveMode(undefined)).toBeUndefined();
  });
});

describe("routePlan 二分支", () => {
  it("isSimple 三条件齐备走 simple", () => {
    expect(routePlan({ complexity: 0.29, strategy: "parallel", subtasks: [] }).line).toBe("simple");
    expect(routePlan({ complexity: 0.2, strategy: "parallel", subtasks: [task("only")] }).line).toBe("simple");
  });

  it("阈值边界：complexity=0.3 不再 simple", () => {
    expect(routePlan({ complexity: 0.3, strategy: "parallel", subtasks: [task("only")] }).line).toBe("dag");
  });

  it("单子任务带工具 → dag", () => {
    expect(routePlan({ complexity: 0.1, strategy: "parallel", subtasks: [task("s", { suggestedTools: ["web_search"] })] }).line).toBe("dag");
  });

  it("回归：6 子任务且含依赖仍走 DAG-hybrid（不进 swarm）", () => {
    const six = plan({
      subtasks: [
        task("a"), task("b"), task("c"), task("d"),
        task("e", { dependencies: ["a", "b"] }),
        task("f", { dependencies: ["c", "d", "e"] }),
      ],
    });
    const decision = routePlan(six);
    expect(decision).toMatchObject({ line: "dag", dagStrategy: "hybrid" });
  });

  it("无依赖默认 parallel；strategy=sequential 被尊重", () => {
    expect(routePlan(plan())).toMatchObject({ line: "dag", dagStrategy: "parallel" });
    expect(routePlan(plan({ strategy: "sequential" }))).toMatchObject({ dagStrategy: "sequential" });
  });
});
