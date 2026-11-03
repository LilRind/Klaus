/**
 * SimpleAgent（对应书 7.4.1 MySimpleAgent）
 *
 * 对话 + 可选工具调用的最小 Agent。
 * 工具协议用文本标记：[TOOL_CALL:tool_name:parameters]
 * 多轮循环：invoke → 解析标记 → 执行工具 → 结果回插对话 → 再 invoke，
 * 直到模型不再发起调用或达到 maxToolIterations（此时强制收尾一次直接回答）。
 */

import { Agent } from "../core/agent";
import type { ChatLLM } from "../core/llm";
import { AgentConfig } from "../core/config";
import { Message, type ChatMessage } from "../core/message";
import type { ToolRegistry } from "../tools/registry";

const TOOL_CALL_PATTERN = /\[TOOL_CALL:([^:\]]+):([^\]]*)\]/g;

export interface ParsedToolCall {
  toolName: string;
  parameters: string;
  original: string;
}

export class SimpleAgent extends Agent {
  protected toolRegistry?: ToolRegistry;

  protected toolCallingEnabled: boolean;

  constructor(
    name: string,
    llm: ChatLLM,
    systemPrompt?: string,
    config?: AgentConfig,
    toolRegistry?: ToolRegistry,
    enableToolCalling = true,
  ) {
    super(name, llm, systemPrompt, config);
    this.toolRegistry = toolRegistry;
    this.toolCallingEnabled =
      enableToolCalling && toolRegistry !== undefined && toolRegistry.size > 0;
  }

  override async run(
    input: string,
    maxToolIterations: number = this.config.maxToolIterations,
  ): Promise<string> {
    const conversation = this.buildMessages(input);
    // 没有可用工具：退化为纯对话（对应书里 enable_tool_calling=False 分支）
    if (!this.toolCallingEnabled || !this.toolRegistry) {
      const response = await this.llm.invoke(conversation);
      this.addMessage(Message.user(input));
      this.addMessage(Message.assistant(response));
      return response;
    }

    let response = "";
    for (let iteration = 0; iteration < maxToolIterations; iteration++) {
      response = await this.llm.invoke(conversation);
      const toolCalls = parseToolCalls(response);
      if (toolCalls.length === 0) {
        this.recordHistory(input, response);
        return response;
      }

      conversation.push({ role: "assistant", content: response });
      for (const call of toolCalls) {
        const result = await this.executeToolCall(call);
        conversation.push({
          role: "user",
          content: `🔧 工具 ${call.toolName} 执行结果:\n${result}`,
        });
      }
    }

    // 达到最大轮数：强制收尾，禁止继续调用工具
    conversation.push({
      role: "user",
      content: "请根据以上工具执行结果，直接给出最终回答，不要再调用任何工具。",
    });
    response = await this.llm.invoke(conversation);
    this.recordHistory(input, response);
    return response;
  }

  get toolRegistryValue(): ToolRegistry | undefined {
    return this.toolRegistry;
  }

  hasTools(): boolean {
    return this.toolCallingEnabled;
  }

  /**
   * 流式对话（对应书 stream_run：与工具循环无关的纯流式问答，
   * 系统提示词仍带工具菜单，但文本协议下流式中途无法执行工具）
   */
  async *streamRun(input: string): AsyncGenerator<string> {
    const conversation = this.buildMessages(input);
    let fullResponse = "";
    for await (const chunk of this.llm.stream(conversation)) {
      fullResponse += chunk;
      yield chunk;
    }
    this.addMessage(Message.user(input));
    this.addMessage(Message.assistant(fullResponse));
  }

  addTool(registry: ToolRegistry): void {
    this.toolRegistry = registry;
    this.toolCallingEnabled = registry.size > 0;
  }

  /** 移除工具（对应书 remove_tool）：注册表同步更新，空了则关闭工具调用 */
  removeTool(toolName: string): boolean {
    const removed = this.toolRegistry?.unregister(toolName) ?? false;
    this.toolCallingEnabled = (this.toolRegistry?.size ?? 0) > 0;
    return removed;
  }

  /** 列出当前可用工具（对应书 list_tools） */
  listTools(): string[] {
    return this.toolRegistry?.listTools().map((tool) => tool.name) ?? [];
  }

  private async executeToolCall(call: ParsedToolCall): Promise<string> {
    if (!this.toolRegistry) return "❌ 错误: 未配置工具注册表";
    try {
      return await this.toolRegistry.executeTool(call.toolName, call.parameters);
    } catch (error) {
      return `❌ 工具调用失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private recordHistory(input: string, response: string): void {
    this.addMessage(Message.user(input));
    this.addMessage(Message.assistant(response));
  }

  /** 构建带工具菜单与调用协议的系统提示词 */
  protected override buildMessages(input: string): ChatMessage[] {
    const messages = super.buildMessages(input);
    const systemMessage = messages[0];
    if (systemMessage && this.toolCallingEnabled && this.toolRegistry) {
      systemMessage.content = this.enhancedSystemPrompt();
    }
    return messages;
  }

  private enhancedSystemPrompt(): string {
    const toolsDescription = this.toolRegistry?.getToolsDescription() ?? "";
    if (!toolsDescription || toolsDescription === "暂无可用工具") {
      return this.systemPrompt;
    }
    return [
      this.systemPrompt,
      "",
      "## 可用工具",
      "你可以使用以下工具来帮助回答问题：",
      toolsDescription,
      "",
      "## 工具调用格式",
      "当需要使用工具时，请使用以下格式：",
      "`[TOOL_CALL:{tool_name}:{parameters}]`",
      "例如：`[TOOL_CALL:calculator:2+3*4]`",
      "工具调用结果会自动插入到对话中；不需要工具时直接回答。",
    ].join("\n");
  }
}

/** 解析文本中的全部工具调用标记（对应书 _parse_tool_calls） */
export function parseToolCalls(text: string): ParsedToolCall[] {
  return [...text.matchAll(TOOL_CALL_PATTERN)].map((match) => {
    const toolName = (match[1] ?? "").trim();
    const parameters = (match[2] ?? "").trim();
    return {
      toolName,
      parameters,
      original: match[0],
    };
  });
}
