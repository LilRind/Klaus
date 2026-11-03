import { describe, expect, it } from "vitest";
import {
  ReActAgent,
  parseReActOutput,
  parseAction,
  parseFinishInput,
} from "../src/agents/react-agent";
import { ToolRegistry } from "../src/tools/registry";
import { CalculatorTool } from "../src/tools/builtin/calculator";
import { ScriptedLLM } from "./scripted-llm";

function calculatorRegistry(): ToolRegistry {
  return new ToolRegistry().register(new CalculatorTool());
}

describe("ReAct 输出解析", () => {
  it("提取 Thought 和 Action", () => {
    const output = parseReActOutput(
      "Thought: 需要计算\nAction: calculator[6*7]",
    );
    expect(output.thought).toBe("需要计算");
    expect(output.action).toBe("calculator[6*7]");
  });

  it("解析 Finish 与工具动作（含嵌套括号）", () => {
    expect(parseFinishInput("Finish[答案是 42]")).toBe("答案是 42");
    expect(parseAction("calculator[6*7]")).toEqual({
      toolName: "calculator",
      toolInput: "6*7",
    });
    expect(parseAction("calculator[(1+2)*3]")).toEqual({
      toolName: "calculator",
      toolInput: "(1+2)*3",
    });
    expect(parseAction("calculator")).toEqual({
      toolName: "calculator",
      toolInput: "",
    });
  });

  it("剥掉模型包裹的 Markdown 反引号", () => {
    expect(parseReActOutput("Thought: x\nAction: `calculator[6*7]`").action).toBe(
      "calculator[6*7]",
    );
    expect(parseAction("`calculator[(1+2)*3]`")).toEqual({
      toolName: "calculator",
      toolInput: "(1+2)*3",
    });
    expect(parseFinishInput("`Finish[42]`")).toBe("42");
  });
});

describe("ReActAgent", () => {
  it("第一步就 Finish：直接返回括号内答案", async () => {
    const llm = new ScriptedLLM([
      "Thought: 我已经知道答案\nAction: Finish[答案是 42]",
    ]);
    const agent = new ReActAgent("r", llm, calculatorRegistry());
    const answer = await agent.run("6*7 等于几");

    expect(answer).toBe("答案是 42");
    expect(llm.invokeCount).toBe(1);
    expect(agent.currentHistory).toEqual([]);
    expect(agent.getHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
    // 提示词包含工具菜单与当前任务
    const prompt = llm.calls[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("1. calculator:");
    expect(prompt).toContain("**Question:** 6*7 等于几");
  });

  it("完整循环：工具调用 → Observation 回填 → Finish", async () => {
    const llm = new ScriptedLLM([
      "Thought: 需要计算\nAction: calculator[6*7]",
      "Thought: 拿到结果\nAction: Finish[42]",
    ]);
    const agent = new ReActAgent("r", llm, calculatorRegistry());
    const answer = await agent.run("6*7 等于几");

    expect(answer).toBe("42");
    expect(llm.invokeCount).toBe(2);
    expect(agent.currentHistory).toEqual([
      "Action: calculator[6*7]",
      "Observation: 42",
    ]);
    // 第二步提示词的执行历史区块包含第一步的观察
    expect(llm.calls[1]?.messages[0]?.content).toContain("Observation: 42");
  });

  it("工具不存在/格式错误：错误作为 Observation 继续循环", async () => {
    const llm = new ScriptedLLM([
      "Thought: 调个不存在的\nAction: ghost[1]",
      "Thought: 换成计算器但没带参数\nAction: calculator",
      "Thought: 直接回答\nAction: Finish[1+1=2]",
    ]);
    const agent = new ReActAgent("r", llm, calculatorRegistry());
    const answer = await agent.run("1+1");

    expect(answer).toBe("1+1=2");
    expect(agent.currentHistory.join("\n")).toContain("未找到工具 'ghost'");
    expect(agent.currentHistory.join("\n")).toContain("计算表达式不能为空");
  });

  it("Action 被反引号包裹：解析容错后一轮命中工具", async () => {
    const llm = new ScriptedLLM([
      "Thought: 需要计算\nAction: `calculator[sqrt(144)+6*7]`",
      "Thought: 拿到结果\nAction: Finish[54]",
    ]);
    const agent = new ReActAgent("r", llm, calculatorRegistry());
    const answer = await agent.run("sqrt(144)+6*7");

    expect(answer).toBe("54");
    expect(agent.currentHistory).toEqual([
      "Action: calculator[sqrt(144)+6*7]",
      "Observation: 54",
    ]);
  });

  it("达到 maxSteps 仍未 Finish：返回兜底文案", async () => {
    const llm = new ScriptedLLM([
      "Thought: 继续\nAction: calculator[1+1]",
      "Thought: 继续\nAction: calculator[1+1]",
      "Thought: 继续\nAction: calculator[1+1]",
    ]);
    const agent = new ReActAgent("r", llm, calculatorRegistry(), { maxSteps: 3 });
    const answer = await agent.run("无限循环测试");

    expect(answer).toBe("抱歉，我无法在限定步数内完成这个任务。");
    expect(llm.invokeCount).toBe(3);
    expect(agent.getHistory().at(-1)?.content).toContain("无法在限定步数内");
  });
});
