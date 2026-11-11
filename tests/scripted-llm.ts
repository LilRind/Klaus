import type {
  ChatLLM,
  LLMInvokeOptions,
  LLMProvider,
  ToolInvocationResult,
  ToolSchema,
} from "../src/core/llm";
import type { ChatMessage } from "../src/core/message";

/** 脚本化 LLM 桩：按队列吐出预设响应，并记录每次收到的消息（离线测试核心） */
export class ScriptedLLM implements ChatLLM {
  readonly model = "scripted-model";
  readonly provider: LLMProvider = "custom";

  readonly calls: { messages: ChatMessage[]; options?: LLMInvokeOptions }[] = [];
  readonly toolCallsList: {
    messages: ChatMessage[];
    tools: ToolSchema[];
    options?: LLMInvokeOptions & { toolChoice?: "auto" | "none" | "required" };
  }[] = [];

  private readonly responses: string[];
  private readonly toolResponses: ToolInvocationResult[];

  constructor(responses: string[], toolResponses: ToolInvocationResult[] = []) {
    this.responses = [...responses];
    this.toolResponses = [...toolResponses];
  }

  async invoke(
    messages: ChatMessage[],
    options?: LLMInvokeOptions,
  ): Promise<string> {
    this.calls.push({ messages: messages.map((m) => ({ ...m })), options });
    const response = this.responses.shift();
    if (response === undefined) {
      throw new Error("ScriptedLLM: 预设响应队列已耗尽");
    }
    return response;
  }

  async *stream(
    messages: ChatMessage[],
    options?: LLMInvokeOptions,
  ): AsyncGenerator<string> {
    yield await this.invoke(messages, options);
  }

  async invokeWithTools(
    messages: ChatMessage[],
    tools: ToolSchema[],
    options?: LLMInvokeOptions & { toolChoice?: "auto" | "none" | "required" },
  ): Promise<ToolInvocationResult> {
    this.toolCallsList.push({ messages: messages.map((m) => ({ ...m })), tools, options });
    const response = this.toolResponses.shift();
    if (response === undefined) {
      throw new Error("ScriptedLLM: 预设工具响应队列已耗尽");
    }
    return response;
  }

  get invokeCount(): number {
    return this.calls.length;
  }

  /** 追加预设工具响应（测试中途续写队列用） */
  pushToolResponse(response: ToolInvocationResult): void {
    this.toolResponses.push(response);
  }

  lastMessages(): ChatMessage[] {
    return this.calls[this.calls.length - 1]?.messages ?? [];
  }
}
