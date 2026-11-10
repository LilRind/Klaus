/**
 * 工具注册机制（对应书 7.5.1 ToolRegistry）
 *
 * 职责：注册/查找/描述生成/按名执行 + 统一异常包装。
 * getToolsDescription() 的输出会被拼进 Agent 提示词——
 * 它就是 LLM 眼里的"工具菜单"，格式质量直接影响调用准确率。
 *
 * 双入口分发（对齐 s02 的结构化参数路线）：
 * - executeTool(name, input)：字符串入口（ReAct 文本协议 / 存量工具）；
 * - executeToolArgs(name, args)：结构化入口（FunctionCallAgent 原生参数直达）。
 * 字符串入口遇到"实现了 executeArgs 的工具 + JSON 对象输入"时自动归一化到
 * 结构化路径执行——两条入口汇合，后续权限层只需拦在这一个汇合点。
 */

import {
  Tool,
  FunctionTool,
  tryParseJsonObject,
  type ToolFunctionOptions,
} from "./tool";
import { ToolExecutionError, ToolNotFoundError } from "../core/exceptions";
import type { PermissionChecker, PermissionRequest } from "../security/permission";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  private permissionChecker: PermissionChecker | undefined;
  /**
   * 动态工具提供器（s14 对齐）：每轮组装时调用，返回当前可用的
   * 动态工具（如已连接的 MCP 工具）。静态工具优先；提供器抛错向上传播
   * （对齐 lcc assemble_tool_pool 的命名冲突 ValueError）。
   */
  private dynamicToolProvider: (() => Tool[]) | undefined;

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 快速注册一个函数为工具 */
  registerFunction(options: ToolFunctionOptions): this {
    return this.register(new FunctionTool(options.func, options));
  }

  /**
   * 安装/卸载权限检查器（s03 对齐）。
   * 未安装时直通执行——存量行为不变；安装后所有工具调用先过三道闸门，
   * 被拒调用返回 "⛔ 权限已拒绝: 原因" observation（不抛异常，循环继续）。
   */
  setPermissionChecker(checker?: PermissionChecker): this {
    this.permissionChecker = checker;
    return this;
  }

  /** 安装动态工具提供器（s14：MCP 等连接后按轮组装） */
  setDynamicToolProvider(provider?: () => Tool[]): this {
    this.dynamicToolProvider = provider;
    return this;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  getTool(name: string): Tool | undefined {
    return this.tools.get(name) ?? this.dynamicTools().find((tool) => tool.name === name);
  }

  listTools(): Tool[] {
    return [...this.tools.values(), ...this.dynamicTools()];
  }

  private dynamicTools(): Tool[] {
    return this.dynamicToolProvider?.() ?? [];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * 对齐装配校验（决策 5）：注册表内任一工具缺 executeArgs 即抛错。
   * 对齐线（coding agent 装配）必调——新工具全部结构化，证明
   * flattenArguments 兜底在该装配下永远不会触发；教学线装配不调。
   */
  assertAllStructured(): this {
    const unstructured = this.listTools()
      .filter((tool) => typeof tool.executeArgs !== "function")
      .map((tool) => tool.name);
    if (unstructured.length > 0) {
      throw new Error(
        `对齐装配要求全部工具实现 executeArgs，以下工具仍是纯字符串契约: ${unstructured.join(", ")}`,
      );
    }
    return this;
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

  /**
   * 按名执行工具（字符串入口）；找不到抛 ToolNotFoundError，
   * 工具内部抛错统一包装为 ToolExecutionError。
   * 结构化工具收到 JSON 对象字符串时自动走 executeArgs 直通。
   */
  async executeTool(name: string, input: string): Promise<string> {
    const tool = this.mustGetTool(name);
    let args: Record<string, unknown> = { input };
    if (tool.executeArgs) {
      const parsed = tryParseJsonObject(input);
      if (parsed) {
        args = parsed;
        return await this.runTool(tool, args, () => tool.executeArgs!(parsed));
      }
    }
    return await this.runTool(tool, args, () => tool.execute(input));
  }

  /**
   * 按名执行工具（结构化入口）：模型原生 Function Calling 的 JSON 参数
   * 解析后直达工具的 executeArgs，不经过 flattenArguments 字符串压扁。
   */
  async executeToolArgs(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const tool = this.mustGetTool(name);
    if (!tool.executeArgs) {
      throw new ToolExecutionError(
        name,
        new Error("该工具未实现 executeArgs，请改用 executeTool 字符串入口"),
      );
    }
    return await this.runTool(tool, args, () => tool.executeArgs!(args));
  }

  private mustGetTool(name: string): Tool {
    const tool = this.getTool(name);
    if (!tool) throw new ToolNotFoundError(name, [...this.tools.keys()]);
    return tool;
  }

  /** 统一执行 + 异常包装（两条入口共用） */
  /** 权限闸门 + 统一执行 + 异常包装（两条入口共用） */
  private async runTool(
    tool: Tool,
    args: Record<string, unknown>,
    action: () => string | Promise<string>,
  ): Promise<string> {
    const outcome = await this.permissionChecker?.check({
      toolName: tool.name,
      args,
    } satisfies PermissionRequest);
    if (outcome && !outcome.allowed) {
      return `⛔ 权限已拒绝: ${outcome.reason ?? "未说明原因"}`;
    }
    try {
      return String(await action());
    } catch (cause) {
      if (cause instanceof ToolExecutionError) throw cause;
      throw new ToolExecutionError(tool.name, cause);
    }
  }
}
