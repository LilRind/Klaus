/**
 * 异常体系（对应书 7.3 框架接口的 exceptions.py）
 *
 * 统一继承 AgentError，调用方可以只 catch 一个基类；
 * 子类携带结构化上下文（toolName / cause），日志好打、测试好断言。
 */

export class AgentError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** LLM 配置缺失/非法（缺 API Key、缺模型名等） */
export class LLMConfigurationError extends AgentError {}

/** LLM 调用失败（网络、超时、上游返回错误） */
export class LLMInvocationError extends AgentError {}

/** 按名字找不到已注册的工具 */
export class ToolNotFoundError extends AgentError {
  constructor(
    readonly toolName: string,
    readonly availableTools: readonly string[] = [],
  ) {
    super(
      availableTools.length > 0
        ? `未找到工具 '${toolName}'，可用工具: ${availableTools.join(", ")}`
        : `未找到工具 '${toolName}'，请先注册后再调用`,
    );
  }
}

/** 工具执行抛出异常（包装原始 cause，不吞栈） */
export class ToolExecutionError extends AgentError {
  constructor(readonly toolName: string, cause: unknown) {
    super(`工具 '${toolName}' 执行失败: ${errorMessage(cause)}`, { cause });
  }
}

/** Agent 循环超过最大步数仍未 Finish */
export class MaxStepsExceededError extends AgentError {}

/** 记忆整理失败的分类错误：调用方按 code 精确分支，不必正则匹配消息 */
export type MemoryConsolidationErrorCode =
  | "TOO_LARGE" // 目录超过单次整理输入上限（LCC：跳过整理，一字不动）
  | "EMPTY" // LLM 返回空数组（整体替换会清库，替换前拒绝）
  | "DUPLICATE" // LLM 返回重复 slug（同名覆盖丢记忆，替换前拒绝）
  | "INVALID_OUTPUT"; // 输出不是合法 JSON 数组 / 含非法记录

export class MemoryConsolidationError extends AgentError {
  constructor(
    readonly code: MemoryConsolidationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
