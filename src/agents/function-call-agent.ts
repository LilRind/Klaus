/**
 * FunctionCallAgent（对应书 7.4.5）
 *
 * 用 OpenAI 原生 Function Calling 替代文本协议：
 * 模型返回结构化 tool_calls（JSON 参数），不再靠正则解析模型输出，
 * 鲁棒性显著优于 [TOOL_CALL:...] 文本协议（书里的核心论点）。
 * 前提：LLM 实现必须支持 invokeWithTools。
 */

import { Agent } from "../core/agent";
import type { ChatLLM, ToolSchema } from "../core/llm";
import type { ToolCallRequest } from "../core/message";
import { AgentError } from "../core/exceptions";
import { AgentConfig } from "../core/config";
import { Message } from "../core/message";
import { parseJsonObjectArguments } from "../tools/tool";
import type { ToolRegistry } from "../tools/registry";

export interface FunctionCallAgentOptions {
  systemPrompt?: string;
  config?: AgentConfig;
  maxToolIterations?: number;
}

export class FunctionCallAgent extends Agent {
  readonly toolRegistry: ToolRegistry;
  readonly maxToolIterations: number;

  constructor(
    name: string,
    llm: ChatLLM,
    toolRegistry: ToolRegistry,
    options: FunctionCallAgentOptions = {},
  ) {
    super(name, llm, options.systemPrompt, options.config);
    if (typeof llm.invokeWithTools !== "function") {
      throw new AgentError(
        "FunctionCallAgent 需要支持 invokeWithTools 的 LLM 实现（如 OpenAICompatLLM）",
      );
    }
    this.toolRegistry = toolRegistry;
    this.maxToolIterations = options.maxToolIterations ?? this.config.maxToolIterations;
  }

  override async run(input: string): Promise<string> {
    // s01 对齐：输入先入 history，循环中的工具轨迹实时回写——
    // 下一次 run 的 conversation 自动携带上一轮的调用与结果，
    // 模型看得到之前"跑过什么命令、看到什么输出"（会话级全轨迹语义）
    this.addMessage(Message.user(input));
    const conversation = this.buildConversation();
    const tools = this.buildToolSchemas();

    let response = "";
    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      const result = await this.llm.invokeWithTools?.(conversation, tools);
      if (!result) break;

      if (result.toolCalls.length === 0) {
        response = result.content ?? "";
        this.addMessage(Message.assistant(response));
        return response;
      }

      // 轨迹双写：conversation 驱动本轮循环，history 持久到下一轮。
      // assistant 消息原样回填（带 toolCalls），tool 结果按 toolCallId 回指
      conversation.push({
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      });
      this.addMessage(
        new Message(result.content ?? "", "assistant", undefined, {
          toolCalls: result.toolCalls,
        }),
      );
      for (const call of result.toolCalls) {
        const output = await this.executeFunctionCall(call);
        conversation.push({
          role: "tool",
          content: output,
          toolCallId: call.id,
          name: call.function.name,
        });
        this.addMessage(
          new Message(output, "tool", call.function.name, {
            toolCallId: call.id,
          }),
        );
      }
    }

    // 达到最大轮数：强制收尾（文本模式，禁止再调工具）。
    // nudge 只进本轮 conversation、不入 history——持久化会让下一轮
    // 的模型看到"别再调工具"而不敢使用工具，污染后续任务
    conversation.push({
      role: "user",
      content: "请根据以上工具执行结果，直接给出最终回答，不要再调用任何工具。",
    });
    response = await this.llm.invoke(conversation);
    this.addMessage(Message.assistant(response));
    return response;
  }

  /**
   * 由注册表构建 OpenAI 工具 Schema（对应书 _build_tool_schemas）：
   * 工具自带 JSON Schema 优先；纯文本协议工具合成 {input: string} 兜底。
   */
  buildToolSchemas(): ToolSchema[] {
    return this.toolRegistry.listTools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters:
          tool.parametersSchema ?? {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: tool.parametersDescription,
              },
            },
            required: ["input"],
          },
      },
    }));
  }

  private async executeFunctionCall(call: ToolCallRequest): Promise<string> {
    try {
      // 结构化工具：模型 JSON 参数直达 executeArgs，零展平损耗（s02 对齐）
      const tool = this.toolRegistry.getTool(call.function.name);
      if (tool?.executeArgs) {
        const args = parseJsonObjectArguments(call.function.arguments);
        return await this.toolRegistry.executeToolArgs(call.function.name, args);
      }
      // 字符串契约工具：保持展平兜底（存量工具兼容）
      const input = flattenArguments(call.function.arguments);
      return await this.toolRegistry.executeTool(call.function.name, input);
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

/**
 * 参数展平（对应书 _parse_function_call_arguments）：
 * 字符串协议工具吃一个字符串——JSON 参数里的单一字符串值直接取出，
 * 多参数对象序列化回字符串。
 */
export function flattenArguments(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return argumentsJson; // 模型输出非法 JSON 时按原字符串传给工具
  }

  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const values = Object.values(parsed);
    if (values.length === 1 && typeof values[0] === "string") {
      return values[0];
    }
    const named = parsed as Record<string, unknown>;
    for (const key of ["expression", "query", "input", "text"]) {
      if (typeof named[key] === "string") return named[key] as string;
    }
    return JSON.stringify(parsed);
  }
  return JSON.stringify(parsed);
}
