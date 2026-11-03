import { describe, expect, it } from "vitest";
import { SimpleAgent, parseToolCalls } from "../src/agents/simple-agent";
import { ToolRegistry } from "../src/tools/registry";
import { CalculatorTool } from "../src/tools/builtin/calculator";
import { ScriptedLLM } from "./scripted-llm";

function calculatorRegistry(): ToolRegistry {
  return new ToolRegistry().register(new CalculatorTool());
}

describe("parseToolCalls", () => {
  it("解析多个调用并保留原文", () => {
    const calls = parseToolCalls(
      "先 [TOOL_CALL:calculator:1+1] 再 [TOOL_CALL:calculator: 2+2 ] 完成",
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ toolName: "calculator", parameters: "1+1" });
    expect(calls[1]?.parameters).toBe("2+2");
    expect(calls[0]?.original).toBe("[TOOL_CALL:calculator:1+1]");
  });

  it("无标记返回空数组", () => {
    expect(parseToolCalls("普通回答")).toEqual([]);
  });
});

describe("SimpleAgent", () => {
  it("未配置工具时退化为纯对话", async () => {
    const llm = new ScriptedLLM(["你好！我是纯对话助手。"]);
    const agent = new SimpleAgent("助手", llm);
    const answer = await agent.run("介绍一下自己");

    expect(answer).toBe("你好！我是纯对话助手。");
    expect(llm.invokeCount).toBe(1);
    expect(llm.calls[0]?.messages[0]).toEqual({
      role: "system",
      content: "你是一个有用的AI助手。",
    });
    expect(agent.getHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("工具调用轮：执行计算器并把结果回插对话", async () => {
    const llm = new ScriptedLLM([
      "让我算一下 [TOOL_CALL:calculator:2+3*4]",
      "计算结果是 14。",
    ]);
    const agent = new SimpleAgent(
      "计算助手",
      llm,
      "你是计算助手",
      undefined,
      calculatorRegistry(),
    );
    const answer = await agent.run("2+3*4 等于几");

    expect(answer).toBe("计算结果是 14。");
    expect(llm.invokeCount).toBe(2);
    // 第一次调用的系统提示词带工具协议
    expect(llm.calls[0]?.messages[0]?.content).toContain("[TOOL_CALL:{tool_name}:{parameters}]");
    // 第二次调用能看到工具结果
    const toolResultMessage = llm.calls[1]?.messages.at(-1);
    expect(toolResultMessage?.role).toBe("user");
    expect(toolResultMessage?.content).toContain("工具 calculator 执行结果");
    expect(toolResultMessage?.content).toContain("14");
  });

  it("一次响应中的多个工具调用全部执行", async () => {
    const llm = new ScriptedLLM([
      "[TOOL_CALL:calculator:1+1] 和 [TOOL_CALL:calculator:2+2]",
      "分别是 2 和 4。",
    ]);
    const agent = new SimpleAgent("a", llm, undefined, undefined, calculatorRegistry());
    const answer = await agent.run("算两个数");

    expect(answer).toBe("分别是 2 和 4。");
    const toolMessages = llm.calls[1]?.messages.filter(
      (m) => m.content?.includes("执行结果") ?? false,
    );
    expect(toolMessages).toHaveLength(2);
  });

  it("达到最大轮数后强制收尾（禁止再调工具）", async () => {
    const llm = new ScriptedLLM([
      "[TOOL_CALL:calculator:1+1]",
      "[TOOL_CALL:calculator:2+2]",
      "根据以上结果，答案分别是 2 和 4。",
    ]);
    const agent = new SimpleAgent("a", llm, undefined, undefined, calculatorRegistry());
    const answer = await agent.run("算两个数", 2);

    expect(answer).toBe("根据以上结果，答案分别是 2 和 4。");
    expect(llm.invokeCount).toBe(3); // 2 轮工具 + 1 次强制收尾
    expect(llm.lastMessages().at(-1)?.content).toContain("不要再调用任何工具");
  });

  it("调用不存在的工具时错误作为观察结果回插，循环继续", async () => {
    const llm = new ScriptedLLM([
      "[TOOL_CALL:ghost:x]",
      "抱歉，这个工具不可用。",
    ]);
    const agent = new SimpleAgent("a", llm, undefined, undefined, calculatorRegistry());
    const answer = await agent.run("调用幽灵工具");

    expect(answer).toBe("抱歉，这个工具不可用。");
    expect(llm.calls[1]?.messages.at(-1)?.content).toContain("未找到工具 'ghost'");
  });

  it("流式响应：逐块产出并记录完整历史（对应书测试3）", async () => {
    const llm = new ScriptedLLM(["这是", "一段", "流式回答"]);
    // ScriptedLLM.stream 会整块吐出；这里验证契约：收集块 + 历史落盘
    const agent = new SimpleAgent("流式助手", llm, undefined, undefined, calculatorRegistry());
    const chunks: string[] = [];
    for await (const chunk of agent.streamRun("讲个故事")) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(agent.getHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
    // 流式调用的消息组与 run 一致：系统提示词带工具菜单
    expect(llm.calls[0]?.messages[0]?.content).toContain("[TOOL_CALL:");
  });

  it("动态工具管理：addTool/listTools/hasTools/removeTool（对应书测试4）", async () => {
    const llm = new ScriptedLLM(["好的。"]);
    const agent = new SimpleAgent("动态助手", llm);
    expect(agent.hasTools()).toBe(false);
    expect(agent.listTools()).toEqual([]);

    const registry = calculatorRegistry();
    registry.registerFunction({
      name: "greet",
      description: "打招呼",
      func: (name) => `你好, ${name}`,
    });
    agent.addTool(registry);

    expect(agent.hasTools()).toBe(true);
    expect(agent.listTools()).toEqual(["calculator", "greet"]);

    expect(agent.removeTool("greet")).toBe(true);
    expect(agent.removeTool("ghost")).toBe(false);
    expect(agent.listTools()).toEqual(["calculator"]);

    // 移空后自动关闭工具调用，退化为纯对话（系统提示词不再带工具协议）
    agent.removeTool("calculator");
    expect(agent.hasTools()).toBe(false);
    await agent.run("你好");
    expect(llm.calls[0]?.messages[0]?.content).not.toContain("[TOOL_CALL:");
  });
});
