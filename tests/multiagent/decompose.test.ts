import { describe, expect, it } from "vitest";
import {
  decomposeTask,
  extractJsonObject,
  validatePlan,
  validatePlanBasics,
} from "../../src/multiagent/decompose";
import type { TaskPlan } from "../../src/multiagent/model";
import { scriptedLlm } from "./test-llm";

const validPlanJson = JSON.stringify({
  complexity: 0.6,
  strategy: "parallel",
  subtasks: [
    { id: "t1", description: "调研A", dependencies: [], produces: ["a_findings"], consumes: [], suggestedTools: [] },
    { id: "t2", description: "分析B", dependencies: ["t1"], produces: [], consumes: ["a_findings"], suggestedTools: [] },
  ],
});

describe("extractJsonObject", () => {
  it("从混杂文本中提取首个平衡 JSON 对象", () => {
    expect(extractJsonObject(`前置说明 {"a":{"b":1}} 尾注`)).toEqual({ a: { b: 1 } });
  });
});

describe("validatePlanBasics", () => {
  const base = (over: Partial<TaskPlan>): TaskPlan => ({
    complexity: 0.5,
    strategy: "parallel",
    subtasks: [{ id: "t1", description: "d", dependencies: [], produces: [], consumes: [], suggestedTools: [] }],
    ...over,
  });

  it("合法计划通过", () => {
    expect(validatePlanBasics(base({}))).toEqual([]);
  });

  it("拒绝 id 重复 / 未知依赖 / 自依赖", () => {
    expect(validatePlanBasics(base({
      subtasks: [
        { id: "t1", description: "d", dependencies: [], produces: [], consumes: [], suggestedTools: [] },
        { id: "t1", description: "d2", dependencies: [], produces: [], consumes: [], suggestedTools: [] },
      ],
    }))[0]).toContain("重复");
    expect(validatePlanBasics(base({
      subtasks: [{ id: "t1", description: "d", dependencies: ["tX"], produces: [], consumes: [], suggestedTools: [] }],
    }))[0]).toContain("tX");
    expect(validatePlanBasics(base({
      subtasks: [{ id: "t1", description: "d", dependencies: ["t1"], produces: [], consumes: [], suggestedTools: [] }],
    }))[0]).toContain("自依赖");
  });
});

describe("validatePlan 全量校验（批2）", () => {
  const sub = (id: string, over: Partial<{ dependencies: string[]; consumes: string[]; produces: string[] }> = {}) => ({
    id, description: `${id}`, dependencies: over.dependencies ?? [], produces: over.produces ?? [], consumes: over.consumes ?? [], suggestedTools: [],
  });

  it("A→B→A 循环被拒绝", () => {
    const errors = validatePlan({
      complexity: 0.5,
      strategy: "parallel",
      subtasks: [sub("a", { dependencies: ["b"] }), sub("b", { dependencies: ["a"] })],
    });
    expect(errors.some((e) => e.includes("环"))).toBe(true);
  });

  it("consumes 无 producer 被拒绝并指出主题", () => {
    const errors = validatePlan({
      complexity: 0.5,
      strategy: "parallel",
      subtasks: [sub("a", { consumes: ["data_x"] })],
    });
    expect(errors.join("\n")).toContain("data_x");
  });

  it("produces 覆盖 consumes 通过", () => {
    expect(validatePlan({
      complexity: 0.5,
      strategy: "parallel",
      subtasks: [sub("a", { produces: ["data_x"] }), sub("b", { consumes: ["data_x"] })],
    })).toEqual([]);
  });
});

describe("decomposeTask", () => {
  it("正常输出 plan", async () => {
    const outcome = await decomposeTask(scriptedLlm([validPlanJson]), "对比两家公司");
    expect(outcome.kind).toBe("plan");
    if (outcome.kind === "plan") {
      expect(outcome.plan.subtasks).toHaveLength(2);
      expect(outcome.plan.subtasks[1]?.dependencies).toEqual(["t1"]);
    }
  });

  it("LLM 失败降级 llmError", async () => {
    const broken = scriptedLlm([]);
    const outcome = await decomposeTask(
      { ...broken, invoke: async () => { throw new Error("network"); } },
      "x",
    );
    expect(outcome).toMatchObject({ kind: "degraded", code: "llmError" });
  });

  it("非 JSON 降级 invalidJson", async () => {
    const outcome = await decomposeTask(scriptedLlm(["我不是 JSON"]), "x");
    expect(outcome).toMatchObject({ kind: "degraded", code: "invalidJson" });
  });

  it("未知依赖降级 invalidPlan 并带原因", async () => {
    const bad = JSON.stringify({
      complexity: 0.5,
      strategy: "parallel",
      subtasks: [{ id: "t1", description: "d", dependencies: ["ghost"], produces: [], consumes: [], suggestedTools: [] }],
    });
    const outcome = await decomposeTask(scriptedLlm([bad]), "x");
    expect(outcome).toMatchObject({ kind: "degraded", code: "invalidPlan" });
    if (outcome.kind === "degraded") expect(outcome.reason).toContain("ghost");
  });
});
