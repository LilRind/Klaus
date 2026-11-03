/**
 * Agent 抽象基类（对应书 7.3.3 Agent ABC）
 *
 * 只管三件事：身份（name/systemPrompt）、依赖（llm）、跨轮状态（history）。
 * run() 留给子类实现——SimpleAgent、ReActAgent 等范式的差异全部体现在 run 里。
 */

import type { ChatLLM } from "./llm";
import { AgentConfig } from "./config";
import { Message, type ChatMessage, type MessageRole } from "./message";

export abstract class Agent {
  readonly name: string;
  readonly systemPrompt: string;
  readonly config: AgentConfig;

  protected readonly history: Message[] = [];

  constructor(
    name: string,
    protected readonly llm: ChatLLM,
    systemPrompt?: string,
    config?: AgentConfig,
  ) {
    this.name = name;
    this.systemPrompt = systemPrompt ?? "你是一个有用的AI助手。";
    this.config = config ?? AgentConfig.default();
  }

  /** 执行一次任务，返回最终答案 */
  abstract run(input: string): Promise<string>;

  /** 组装完整对话：system + 历史 + 当前输入 */
  protected buildMessages(input: string): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
    ];
    for (const message of this.history) {
      messages.push(message.toChatMessage());
    }
    messages.push({ role: "user", content: input });
    return messages;
  }

  /** 记录一条历史消息（持久化跨轮对话状态） */
  protected addMessage(
    contentOrMessage: string | Message,
    role: MessageRole = "user",
  ): Message {
    const message =
      contentOrMessage instanceof Message
        ? contentOrMessage
        : new Message(contentOrMessage, role);
    this.history.push(message);
    return message;
  }

  getHistory(): readonly Message[] {
    return this.history;
  }

  clearHistory(): void {
    this.history.length = 0;
  }
}
