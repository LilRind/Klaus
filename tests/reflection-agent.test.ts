import { describe, expect, it } from "vitest";
import {
  ReflectionAgent,
  DEFAULT_REFLECTION_PROMPTS,
  isNoImprovementNeeded,
} from "../src/agents/reflection-agent";
import { Memory } from "../src/core/memory";
import { ScriptedLLM } from "./scripted-llm";

describe("Memory 记忆模块（对应书第四章模块 1）", () => {
  it("记录 execution/reflection 交替轨迹并渲染", () => {
    const memory = new Memory();
    memory.addRecord("execution", "初稿");
    memory.addRecord("reflection", "缺少结论");
    memory.addRecord("execution", "修订稿");

    expect(memory.getLastExecution()).toBe("修订稿");
    expect(memory.getExecutions()).toEqual(["初稿", "修订稿"]);
    expect(memory.getTrajectory()).toContain("--- 上一轮尝试 ---\n初稿");
    expect(memory.getTrajectory()).toContain("--- 反思反馈 ---\n缺少结论");
    expect(memory.getTrajectory()).toContain("修订稿");
  });

  it("getLastExecution 在无执行记录时返回 undefined", () => {
    const memory = new Memory();
    memory.addRecord("reflection", "只有反思");
    expect(memory.getLastExecution()).toBeUndefined();
  });
});

describe("isNoImprovementNeeded 停止条件", () => {
  it("中英文都能识别", () => {
    expect(isNoImprovementNeeded("回答无需改进")).toBe(true);
    expect(isNoImprovementNeeded("No need for improvement.")).toBe(true);
    expect(isNoImprovementNeeded("建议增加数据支撑")).toBe(false);
  });
});

describe("ReflectionAgent", () => {
  it("提示词三件套支持部分覆盖，默认 3 轮（对应书 max_iterations）", () => {
    const llm = new ScriptedLLM([]);
    const agent = new ReflectionAgent("a", llm, {
      customPrompts: { reflect: "审查代码:{task}" },
    });
    expect(agent.prompts.reflect).toBe("审查代码:{task}");
    expect(agent.prompts.initial).toBe(DEFAULT_REFLECTION_PROMPTS.initial);
    expect(agent.prompts.refine).toBe(DEFAULT_REFLECTION_PROMPTS.refine);
    expect(agent.maxRounds).toBe(3);
  });

  it("初始生成 → 反思 → 修改 → 再反思收敛，轨迹记入 Memory", async () => {
    const llm = new ScriptedLLM([
      "初稿",
      "缺少结论段落",
      "修订稿",
      "无需改进",
    ]);
    const agent = new ReflectionAgent("反思助手", llm);
    const result = await agent.run("写一篇短文");

    expect(result).toBe("修订稿");
    expect(llm.invokeCount).toBe(4);
    // Memory 轨迹：execution / reflection / execution / reflection 交替
    expect(agent.memory.records.map((r) => r.type)).toEqual([
      "execution",
      "reflection",
      "execution",
      "reflection",
    ]);
    expect(agent.memory.getLastExecution()).toBe("修订稿");
    // 反思提示词取自 memory 的最近执行
    expect(llm.calls[1]?.messages[0]?.content).toContain("初稿");
    // 修改提示词带上一轮回答与反馈
    const refinePrompt = llm.calls[2]?.messages[0]?.content ?? "";
    expect(refinePrompt).toContain("初稿");
    expect(refinePrompt).toContain("缺少结论段落");
    expect(agent.getHistory().map((m) => m.content)).toEqual([
      "写一篇短文",
      "修订稿",
    ]);
  });

  it("反思认为无需改进时立即收敛，不进入修改", async () => {
    const llm = new ScriptedLLM(["初稿", "no need for improvement"]);
    const agent = new ReflectionAgent("a", llm, { maxRounds: 3 });
    const result = await agent.run("任务");

    expect(result).toBe("初稿");
    expect(llm.invokeCount).toBe(2);
    expect(agent.memory.records.map((r) => r.type)).toEqual([
      "execution",
      "reflection",
    ]);
  });

  it("达到最大轮数后返回 memory 里最近一次执行", async () => {
    const llm = new ScriptedLLM([
      "初稿",
      "问题1", "修订1",
      "问题2", "修订2",
    ]);
    const agent = new ReflectionAgent("a", llm, { maxRounds: 2 });
    const result = await agent.run("任务");

    expect(result).toBe("修订2");
    expect(llm.invokeCount).toBe(5); // 初始 + 2×(反思+修改)
    expect(agent.memory.getExecutions()).toEqual(["初稿", "修订1", "修订2"]);
  });

  it("每次 run 重置轨迹：memory 始终描述当前任务", async () => {
    const llm = new ScriptedLLM([
      "第一轮初稿", "无需改进",
      "第二轮初稿", "无需改进",
    ]);
    const agent = new ReflectionAgent("a", llm);
    await agent.run("任务一");
    await agent.run("任务二");

    expect(agent.memory.records).toHaveLength(2); // 只有任务二的轨迹
    expect(agent.memory.getLastExecution()).toBe("第二轮初稿");
    expect(agent.getHistory()).toHaveLength(4); // 跨轮对话历史保留
  });
});
