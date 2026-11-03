/**
 * 工具注册机制（对应书 7.5.1 ToolRegistry）
 *
 * 职责：注册/查找/描述生成/按名执行 + 统一异常包装。
 * getToolsDescription() 的输出会被拼进 Agent 提示词——
 * 它就是 LLM 眼里的"工具菜单"，格式质量直接影响调用准确率。
 */

import { Tool, FunctionTool, type ToolFunctionOptions } from "./tool";
import { ToolExecutionError, ToolNotFoundError } from "../core/exceptions";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 快速注册一个函数为工具 */
  registerFunction(options: ToolFunctionOptions): this {
    return this.register(new FunctionTool(options.func, options));
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  listTools(): Tool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /** 生成编号列表形式的工具菜单（拼入提示词） */
  getToolsDescription(): string {
    if (this.tools.size === 0) return "暂无可用工具";
    return [...this.tools.values()]
      .map(
        (tool, index) =>
          `${index + 1}. ${tool.name}: ${tool.description}（参数: ${tool.parametersDescription}）`,
      )
      .join("\n");
  }

  /** 按名执行工具；找不到抛 ToolNotFoundError，工具内部抛错统一包装为 ToolExecutionError */
  async executeTool(name: string, input: string): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name, [...this.tools.keys()]);
    try {
      const result = await tool.execute(input);
      return String(result);
    } catch (cause) {
      if (cause instanceof ToolExecutionError) throw cause;
      throw new ToolExecutionError(name, cause);
    }
  }
}
