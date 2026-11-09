import { describe, expect, it } from "vitest";
import {
  FunctionCallAgent,
  flattenArguments,
} from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { FunctionTool } from "../src/tools/tool";
import { CalculatorTool } from "../src/tools/builtin/calculator";
import { AgentError } from "../src/core/exceptions";
import { Message } from "../src/core/message";
import { toOpenAIMessages, type ChatLLM, type ToolInvocationResult } from "../src/core/llm";
import { ScriptedLLM } from "./scripted-llm";

function calculatorRegistry(): ToolRegistry {
  return new ToolRegistry().register(new CalculatorTool());
}

function toolCall(id: string, name: string, args: string): ToolInvocationResult {
  return {
    content: null,
    toolCalls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

describe("flattenArguments 参数展平", () => {
  it("单一字符串值 / 常见命名参数直接取出", () => {
    expect(flattenArguments('{"expression":"6*7"}')).toBe("6*7");
    expect(flattenArguments('{"query":"AI 新闻","limit":3}')).toBe("AI 新闻");
    expect(flattenArguments('"raw"')).toBe("raw");
  });

  it("多参数对象序列化回字符串，非法 JSON 原样透传", () => {
    expect(flattenArguments('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
    expect(flattenArguments("不是 JSON")).toBe("不是 JSON");
  });
});

describe("FunctionCallAgent", () => {
  it("LLM 不支持 invokeWithTools 时构造即失败", () => {
    const plain = { model: "m", provider: "custom" } as unknown as ChatLLM;
    expect(
      () => new FunctionCallAgent("a", plain, calculatorRegistry()),
    ).toThrow(AgentError);
  });

  it("buildToolSchemas：自带 Schema 透传，无 Schema 合成 {input} 兜底", () => {
    const llm = new ScriptedLLM([]);
    const registry = new ToolRegistry()
      .register(new CalculatorTool())
      .registerFunction({
        name: "echo",
        description: "回声",
        parametersDescription: "text: 任意文本",
        func: (input) => input,
      });
    const agent = new FunctionCallAgent("a", llm, registry);
    const schemas = agent.buildToolSchemas();

    const calc = schemas.find((s) => s.function.name === "calculator");
    expect(calc?.function.parameters).toMatchObject({ required: ["expression"] });
    const echo = schemas.find((s) => s.function.name === "echo");
    expect(echo?.function.parameters).toMatchObject({
      required: ["input"],
    });
  });

  it("原生函数调用闭环：tool_calls → 执行 → toolCallId 回指 → 最终回答", async () => {
    const llm = new ScriptedLLM(["最终回答：42"], [
      toolCall("call_1", "calculator", '{"expression":"6*7"}'),
      { content: "42", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, calculatorRegistry());
    const answer = await agent.run("6*7 等于几");

    expect(answer).toBe("42");
    expect(llm.toolCallsList).toHaveLength(2);
    // 传给模型的工具 Schema 正确
    expect(llm.toolCallsList[0]?.tools[0]?.function.name).toBe("calculator");
    // 第二轮消息里：assistant 带 toolCalls，tool 消息按 id 回指并携带结果
    const messages = llm.toolCallsList[1]?.messages ?? [];
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.toolCalls?.[0]?.id).toBe("call_1");
    const toolMessage = messages.find((m) => m.role === "tool");
    expect(toolMessage?.toolCallId).toBe("call_1");
    expect(toolMessage?.content).toBe("42");
    // s01 对齐后 history 保留完整轨迹：user → assistant(toolCalls) → tool → assistant
    expect(agent.getHistory().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(agent.getHistory()[1]?.toolCalls?.[0]?.id).toBe("call_1");
    expect(agent.getHistory()[2]?.toolCallId).toBe("call_1");
  });

  it("调用不存在的工具：错误回填为 tool 消息，循环继续", async () => {
    const llm = new ScriptedLLM(["换个思路回答 42"], [
      toolCall("call_x", "ghost", "{}"),
      { content: "42", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, calculatorRegistry());
    const answer = await agent.run("测试");

    expect(answer).toBe("42");
    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("未找到工具 'ghost'，可用工具: calculator");
  });

  it("达到最大轮数：强制文本收尾，不再发起函数调用", async () => {
    const llm = new ScriptedLLM(["根据结果回答：2"], [
      toolCall("c1", "calculator", '{"expression":"1+1"}'),
      toolCall("c2", "calculator", '{"expression":"1+1"}'),
    ]);
    const agent = new FunctionCallAgent("fc", llm, calculatorRegistry(), {
      maxToolIterations: 2,
    });
    const answer = await agent.run("算 1+1");

    expect(answer).toBe("根据结果回答：2");
    expect(llm.toolCallsList).toHaveLength(2);
    expect(llm.invokeCount).toBe(1); // 一次强制收尾
    expect(llm.lastMessages().at(-1)?.content).toContain("不要再调用任何工具");
  });
});

describe("FunctionCallAgent 跨轮工具轨迹持久化（s01 对齐）", () => {
  it("第二次 run 的对话携带第一次的工具调用与结果", async () => {
    const llm = new ScriptedLLM(["接着算 84", "84"], [
      toolCall("call_1", "calculator", '{"expression":"6*7"}'),
      { content: "42", toolCalls: [] },
      { content: "84", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, calculatorRegistry());
    await agent.run("6*7 等于几");
    await agent.run("再乘 2 呢");

    // 第二次 run 的第 1 次调用里，应包含第一次 run 留下的 tool 结果 "42"
    const secondRunMessages = llm.toolCallsList[2]?.messages ?? [];
    expect(secondRunMessages[0]?.role).toBe("system");
    expect(secondRunMessages.map((m) => m.role)).toContain("tool");
    const priorTool = secondRunMessages.find((m) => m.role === "tool");
    expect(priorTool?.content).toBe("42");
    expect(priorTool?.toolCallId).toBe("call_1");
    // 上一轮的 assistant(toolCalls) 轨迹也在
    const priorAssistant = secondRunMessages.find(
      (m) => m.role === "assistant" && m.toolCalls?.length,
    );
    expect(priorAssistant?.toolCalls?.[0]?.function.name).toBe("calculator");
  });

  it("强制收尾的 nudge 不写入 history（不污染下一轮）", async () => {
    const llm = new ScriptedLLM(["根据结果回答：2"], [
      toolCall("c1", "calculator", '{"expression":"1+1"}'),
    ]);
    const agent = new FunctionCallAgent("fc", llm, calculatorRegistry(), {
      maxToolIterations: 1,
    });
    await agent.run("算 1+1");

    const historyText = agent
      .getHistory()
      .map((m) => m.content)
      .join("\n");
    expect(historyText).not.toContain("不要再调用任何工具");
    // 轨迹仍在：user → assistant(toolCalls) → tool → assistant(final)
    expect(agent.getHistory().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("Message 元数据映射到 ChatMessage（toolCalls / toolCallId）", () => {
    const assistant = new Message("", "assistant", undefined, {
      toolCalls: [
        { id: "c9", type: "function", function: { name: "bash", arguments: "{}" } },
      ],
    });
    expect(assistant.toChatMessage().toolCalls?.[0]?.id).toBe("c9");

    const tool = new Message("done", "tool", "bash", { toolCallId: "c9" });
    const mapped = tool.toChatMessage();
    expect(mapped.role).toBe("tool");
    expect(mapped.toolCallId).toBe("c9");
    expect(mapped.name).toBe("bash");
  });

  it("toOpenAIMessages 映射 assistant.tool_calls 与 role:tool 变体", () => {
    const mapped = toOpenAIMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "c1", type: "function", function: { name: "bash", arguments: '{"command":"dir"}' } },
        ],
      },
      { role: "tool", content: "out", toolCallId: "c1", name: "bash" },
    ]);
    expect(mapped).toHaveLength(4);
    const assistant = mapped[2] as { tool_calls?: { id: string }[] };
    expect(assistant.tool_calls?.[0]?.id).toBe("c1");
    const tool = mapped[3] as { tool_call_id?: string };
    expect(tool.tool_call_id).toBe("c1");
  });
});
