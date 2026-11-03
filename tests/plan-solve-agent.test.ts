import { describe, expect, it } from "vitest";
import {
  PlanAndSolveAgent,
  Planner,
  Executor,
  parsePlan,
} from "../src/agents/plan-solve-agent";
import { ScriptedLLM } from "./scripted-llm";

describe("parsePlan 计划解析", () => {
  it("解析 ```python 围栏中的 JSON 列表", () => {
    const output = '规划如下：\n```python\n["步骤1", "步骤2", "求总和"]\n```';
    expect(parsePlan(output)).toEqual(["步骤1", "步骤2", "求总和"]);
  });

  it("解析裸数组与单引号 Python 列表", () => {
    expect(parsePlan('["a", "b"]')).toEqual(["a", "b"]);
    expect(parsePlan("['a', 'b']")).toEqual(["a", "b"]);
  });

  it("非法输出抛错；空列表是合法解析结果（交由 Agent 优雅终止）", () => {
    expect(() => parsePlan("我觉得应该分三步走")).toThrow(/不是合法的步骤列表/);
    expect(parsePlan("[]")).toEqual([]);
  });
});

describe("Planner / Executor 分离（对应书第四章结构）", () => {
  it("Planner 解析失败返回空数组而不是抛错", async () => {
    const llm = new ScriptedLLM(["我想想怎么分步"]);
    const planner = new Planner(llm);
    await expect(planner.plan("任务")).resolves.toEqual([]);
    expect(llm.invokeCount).toBe(1);
  });

  it("Executor 逐步执行并累积历史", async () => {
    const llm = new ScriptedLLM(["结果A", "结果B"]);
    const executor = new Executor(llm);
    const final = await executor.execute("问题", ["步骤A", "步骤B"]);

    expect(final).toBe("结果B");
    expect(executor.lastHistoryLines).toHaveLength(2);
    expect(executor.lastHistoryLines[0]).toContain("结果A");
    // 第二步能看到第一步的历史
    expect(llm.calls[1]?.messages[0]?.content).toContain("结果A");
  });
});

describe("PlanAndSolveAgent", () => {
  it("规划 → 逐步执行 → 最后一步结果作为最终答案", async () => {
    const llm = new ScriptedLLM([
      '```python\n["计算周一数量", "计算总数"]\n```',
      "15",
      "60",
    ]);
    const agent = new PlanAndSolveAgent("规划助手", llm);
    const result = await agent.run("水果店问题");

    expect(result).toBe("60");
    expect(agent.lastPlan).toEqual(["计算周一数量", "计算总数"]);
    expect(llm.invokeCount).toBe(3);
    // 第二步执行器能看到完整计划 + 第一步历史 + 当前步骤
    const stepPrompt = llm.calls[2]?.messages[0]?.content ?? "";
    expect(stepPrompt).toContain("1. 计算周一数量");
    expect(stepPrompt).toContain("步骤 1: 计算周一数量\n结果: 15");
    expect(stepPrompt).toContain("# 当前步骤:\n计算总数");
    expect(agent.getHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("支持自定义 planner/executor 提示词（书中的数学专用模板）", async () => {
    const llm = new ScriptedLLM(['["加法步骤"]', "42"]);
    const agent = new PlanAndSolveAgent("数学助手", llm, {
      customPrompts: {
        planner: "数学规划:{question}",
        executor: "只算当前步骤:{current_step}",
      },
    });
    await agent.run("数学题");

    expect(llm.calls[0]?.messages[0]?.content).toBe("数学规划:数学题");
    expect(llm.calls[1]?.messages[0]?.content).toBe("只算当前步骤:加法步骤");
  });

  it("规划解析失败优雅终止，不进入执行阶段（对应书第四章）", async () => {
    const llm = new ScriptedLLM(["我想想怎么分步"]);
    const agent = new PlanAndSolveAgent("a", llm);
    const result = await agent.run("任务");

    expect(result).toContain("无法生成有效的行动计划");
    expect(llm.invokeCount).toBe(1);
    expect(agent.lastPlan).toEqual([]);
  });
});
