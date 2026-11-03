/**
 * 配置管理（对应书 7.3.2 Config 类）
 *
 * 集中管理循环上限、超时等行为参数，Agent 子类不再各自散落魔法数字。
 */

export interface AgentConfigOptions {
  /** ReActAgent 等循环型 Agent 的最大推理步数，默认 5 */
  maxSteps?: number;
  /** SimpleAgent 单轮 run 内最大工具调用轮数，默认 3 */
  maxToolIterations?: number;
  /** 请求超时（毫秒），默认 60000 */
  timeoutMs?: number;
  /** 默认采样温度，不传则用服务端默认 */
  temperature?: number;
  /** 是否打印执行过程日志，默认 false */
  verbose?: boolean;
}

export class AgentConfig {
  readonly maxSteps: number;
  readonly maxToolIterations: number;
  readonly timeoutMs: number;
  readonly temperature?: number;
  readonly verbose: boolean;

  constructor(options: AgentConfigOptions = {}) {
    this.maxSteps = requirePositiveInt(options.maxSteps, 5, "maxSteps");
    this.maxToolIterations = requirePositiveInt(
      options.maxToolIterations,
      3,
      "maxToolIterations",
    );
    this.timeoutMs = requirePositiveInt(options.timeoutMs, 60_000, "timeoutMs");
    this.temperature = options.temperature;
    this.verbose = options.verbose ?? false;
  }

  static default(): AgentConfig {
    return new AgentConfig();
  }
}

function requirePositiveInt(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数，收到: ${String(value)}`);
  }
  return value;
}
