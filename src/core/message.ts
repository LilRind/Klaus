/**
 * 消息系统（对应书 7.3.1 Message 类）
 *
 * 设计说明：
 * - 书里用 Python 的 Literal 限制角色取值，TS 的自然等价物是字面量联合类型——
 *   错误角色在编译期就会被拒绝，运行期再兜底校验一次（防止从 JSON 反序列化进来脏数据）。
 * - Message 是框架内部的领域对象（带时间戳、工厂方法），
 *   ChatMessage 是发给 LLM 的传输载体（纯数据），两者分离。
 */

export type MessageRole = "system" | "user" | "assistant" | "tool";

const MESSAGE_ROLES: readonly MessageRole[] = [
  "system",
  "user",
  "assistant",
  "tool",
];

/** 发送给 LLM 的消息载荷（纯数据，与 OpenAI Chat API 对齐） */
export interface ChatMessage {
  role: MessageRole;
  content: string | null;
  /** 工具消息可附带来源名，例如 calculator */
  name?: string;
  /** assistant 消息发起的原生函数调用（OpenAI Function Calling） */
  toolCalls?: ToolCallRequest[];
  /** tool 角色消息回指对应的调用 id */
  toolCallId?: string;
}

/** 模型发起的一次函数调用请求 */
export interface ToolCallRequest {
  id: string;
  type: "function";
  function: {
    name: string;
    /** JSON 字符串形式的参数（模型侧约定，需调用方解析） */
    arguments: string;
  };
}

export class Message {
  readonly content: string;
  readonly role: MessageRole;
  readonly name?: string;
  readonly timestamp: Date;

  constructor(content: string, role: MessageRole = "user", name?: string) {
    if (!MESSAGE_ROLES.includes(role)) {
      throw new Error(
        `非法消息角色: ${String(role)}，合法值: ${MESSAGE_ROLES.join(" | ")}`,
      );
    }
    this.content = content;
    this.role = role;
    this.name = name;
    this.timestamp = new Date();
  }

  static user(content: string): Message {
    return new Message(content, "user");
  }

  static assistant(content: string): Message {
    return new Message(content, "assistant");
  }

  static system(content: string): Message {
    return new Message(content, "system");
  }

  static tool(content: string, name?: string): Message {
    return new Message(content, "tool", name);
  }

  /** 转成 LLM 传输载体 */
  toChatMessage(): ChatMessage {
    return this.name === undefined
      ? { role: this.role, content: this.content }
      : { role: this.role, content: this.content, name: this.name };
  }

  toString(): string {
    return `[${this.role}] ${this.content}`;
  }
}
