/**
 * 工具基类（对应书 7.5.1 工具基类）
 *
 * 契约刻意保持极简：字符串进、字符串出。
 * 书 7.1.2 的理念——所有外部能力统一抽象为"智能体调用工具"，
 * 不引入 Function Calling 的强类型 JSON Schema，范式对 LLM 文本协议透明。
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
}

export interface ToolFunctionOptions {
  name: string;
  description: string;
  parametersDescription?: string;
  parametersSchema?: Record<string, unknown>;
  func: (input: string) => string | Promise<string>;
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
  }

  override execute(input: string): string | Promise<string> {
    return this.func(input);
  }

  override get parametersSchema(): Record<string, unknown> | undefined {
    return this.schema;
  }
}
