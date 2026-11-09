/**
 * 工具基类（对应书 7.5.1 工具基类）
 *
 * 契约双轨（对齐 learn-claude-code s02 的结构化参数路线）：
 * - execute(input)：字符串进、字符串出，ReAct 文本协议与存量工具的原始契约；
 * - executeArgs(args)：可选的结构化入口，参数直达工具、零展平损耗，
 *   FunctionCallAgent 检测到它存在时走 executeToolArgs 直通。
 * 工具至少实现 execute；新工具建议同时提供 parametersSchema + executeArgs。
 */

export abstract class Tool {
  /** 全局唯一的工具名（LLM 通过它指名调用） */
  abstract get name(): string;

  /** 写给 LLM 看的能力描述 */
  abstract get description(): string;

  /** 参数格式说明（提示词里展示，帮 LLM 生成正确输入） */
  abstract get parametersDescription(): string;

  /**
   * 原生函数调用用的 JSON Schema（可选）。
   * 纯文本协议工具可以不提供；FunctionCallAgent 会自动合成兜底 Schema。
   */
  get parametersSchema(): Record<string, unknown> | undefined {
    return undefined;
  }

  /** 执行工具，输入输出均为字符串；抛错由 ToolRegistry 统一包装 */
  abstract execute(input: string): string | Promise<string>;

  /**
   * 结构化参数入口（可选）：模型原生 Function Calling 的 JSON 参数
   * 解析后直达这里，不经过 flattenArguments 的字符串压扁。
   * 实现它的工具必须同时提供 parametersSchema。
   */
  executeArgs?(args: Record<string, unknown>): string | Promise<string>;
}

export interface ToolFunctionOptions {
  name: string;
  description: string;
  parametersDescription?: string;
  parametersSchema?: Record<string, unknown>;
  func: (input: string) => string | Promise<string>;
  /** 可选的结构化执行函数；提供后 FunctionTool 即支持 executeArgs 直通 */
  argsFunc?: (args: Record<string, unknown>) => string | Promise<string>;
}

/** 把普通函数快速包装成 Tool（对应书里的 register_function 便利路径） */
export class FunctionTool extends Tool {
  readonly name: string;
  readonly description: string;
  readonly parametersDescription: string;

  private readonly schema: Record<string, unknown> | undefined;

  constructor(
    private readonly func: (input: string) => string | Promise<string>,
    options: ToolFunctionOptions,
  ) {
    super();
    this.name = options.name;
    this.description = options.description;
    this.parametersDescription = options.parametersDescription ?? "input: 工具输入字符串";
    this.schema = options.parametersSchema;
    this.func = func;
    // 仅在提供 argsFunc 时定义 executeArgs（注册表以方法存在性判定结构化能力）
    if (options.argsFunc) {
      this.executeArgs = (args) => options.argsFunc!(args);
    }
  }

  override execute(input: string): string | Promise<string> {
    return this.func(input);
  }

  override get parametersSchema(): Record<string, unknown> | undefined {
    return this.schema;
  }

  override executeArgs?: (
    args: Record<string, unknown>,
  ) => string | Promise<string>;
}

/**
 * 解析模型返回的 JSON 参数为普通对象；非法 JSON / 非对象抛错
 * （由调用方转为错误 observation 回喂模型）。
 */
export function parseJsonObjectArguments(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`工具参数必须是合法 JSON 对象，收到: ${raw.slice(0, 100)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`工具参数必须是 JSON 对象，收到: ${raw.slice(0, 100)}`);
  }
  return parsed as Record<string, unknown>;
}

/** 尽力解析 JSON 对象；输入不是 JSON 对象时返回 null（不抛错） */
export function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return parseJsonObjectArguments(trimmed);
  } catch {
    return null;
  }
}
