/**
 * 工具链管理（对应书 7.5.4 tool_chain_manager.py）
 *
 * ToolChain：多个工具按声明顺序执行，步骤间通过"输出键"传递数据；
 * 输入模板支持 {input} / {前序输出键} 变量替换。
 * ToolChainManager：链的注册与按名执行。
 */

import type { ToolRegistry } from "./registry";
import { extractTemplateVariables } from "../core/prompt";

export interface ToolChainStep {
  toolName: string;
  inputTemplate: string;
  outputKey: string;
}

export interface ToolChainContext extends Record<string, string> {
  input: string;
}

export class ToolChain {
  readonly steps: ToolChainStep[] = [];

  constructor(
    readonly name: string,
    readonly description: string,
  ) {}

  /** 添加一步：toolName + 输入模板（支持变量）+ 输出键（供后续步骤引用） */
  addStep(toolName: string, inputTemplate: string, outputKey?: string): this {
    this.steps.push({
      toolName,
      inputTemplate,
      outputKey: outputKey ?? `step_${this.steps.length + 1}_result`,
    });
    return this;
  }

  /**
   * 执行整条链。context 会被逐步填充（调用方可借此拿到中间结果），
   * 返回最后一步的输出——与书的行为一致。
   */
  async execute(
    registry: ToolRegistry,
    initialInput: string,
    context: Record<string, string> = {},
  ): Promise<string> {
    context.input = initialInput;

    for (const [index, step] of this.steps.entries()) {
      const missing = extractTemplateVariables(step.inputTemplate).filter(
        (variable) => context[variable] === undefined,
      );
      if (missing.length > 0) {
        return `❌ 工具链执行失败:模板变量 {${missing[0]}} 未找到`;
      }

      const toolInput = fillStepTemplate(step.inputTemplate, context);
      context[step.outputKey] = await registry.executeTool(step.toolName, toolInput);
      void index;
    }

    const lastStep = this.steps[this.steps.length - 1];
    if (!lastStep) return "❌ 工具链没有任何步骤";
    return context[lastStep.outputKey] ?? "";
  }
}

export class ToolChainManager {
  private readonly chains = new Map<string, ToolChain>();

  constructor(private readonly registry: ToolRegistry) {}

  registerChain(chain: ToolChain): this {
    this.chains.set(chain.name, chain);
    return this;
  }

  async executeChain(
    chainName: string,
    input: string,
    context: Record<string, string> = {},
  ): Promise<string> {
    const chain = this.chains.get(chainName);
    if (!chain) return `❌ 工具链 '${chainName}' 不存在`;
    return chain.execute(this.registry, input, context);
  }

  listChains(): string[] {
    return [...this.chains.keys()];
  }
}

function fillStepTemplate(
  template: string,
  context: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}
