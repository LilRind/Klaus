/**
 * task 工具（对齐 learn-claude-code s06 Subagent）
 *
 * 给子任务一段独立上下文：调用 task 时同步运行一个使用全新 history 的
 * 嵌套 FunctionCallAgent，循环结束后只有它的最终文本进入父对话——
 * 中间的工具调用与结果不进入父上下文（隔离的是消息，不是进程或文件系统：
 * 父子共享同一工作区，写文件和命令互相可见）。
 *
 * 边界（对齐 s06 的决策表）：
 * - 对话：每次调用创建全新 agent（fresh history），不复制父对话；
 * - 执行：同一进程与工作区；
 * - 返回值：只返回最终文本（子轨迹不进父消息列表）；
 * - 委派深度：子工具集剔除 task——单层委派由构造保证；
 * - 工具策略：共享同一 PermissionChecker 与 HookRegistry（权限/hooks 一致）。
 */

import { Tool, tryParseJsonObject } from "../tool";
import { ToolRegistry } from "../registry";
import { FunctionCallAgent } from "../../agents/function-call-agent";
import type { ChatLLM } from "../../core/llm";
import { AgentConfig } from "../../core/config";
import type { PermissionChecker } from "../../security/permission";
import type { HookRegistry } from "../../hooks/hook-registry";

export const SUBAGENT_MAX_TURNS = 30;

export interface TaskToolOptions {
  /** 子 agent 使用的 LLM（通常与父相同） */
  llm: ChatLLM;
  /** 基础工具集（其中的 task 会被剔除——单层委派） */
  tools: Tool[];
  /** 共享权限闸门（父子同一实例，安全策略一致） */
  permissionChecker?: PermissionChecker;
  /** 共享 hook 注册表 */
  hooks?: HookRegistry;
  /** 子 agent system prompt */
  systemPrompt?: string;
  /** 子 agent 轮数上限，默认 30（对齐 s06） */
  maxTurns?: number;
}

const DEFAULT_SUB_SYSTEM =
  "You are a focused subagent. Complete the assigned subtask using tools, " +
  "then reply with a concise final answer. You cannot spawn further subagents.";

/** 工厂：对齐装配里与文件/bash 工具并排注册 */
export function createTaskTool(options: TaskToolOptions): TaskTool {
  return new TaskTool(options);
}

export class TaskTool extends Tool {
  override get name(): string {
    return "task";
  }

  override get description(): string {
    return "Run a subagent with fresh conversation context and return its final text";
  }

  override get parametersDescription(): string {
    return 'JSON: {"prompt": "明确的子任务描述"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "子任务描述（子 agent 只能看到这段话，看不到父对话）",
        },
      },
      required: ["prompt"],
    };
  }

  private readonly subRegistry: ToolRegistry;
  private readonly maxTurns: number;

  constructor(private readonly options: TaskToolOptions) {
    super();
    // 子注册表：同基础工具集但剔除 task（单层委派由构造保证）
    this.subRegistry = new ToolRegistry();
    for (const tool of options.tools) {
      if (tool.name === "task") continue;
      this.subRegistry.register(tool);
    }
    if (options.permissionChecker) {
      this.subRegistry.setPermissionChecker(options.permissionChecker);
    }
    this.maxTurns = options.maxTurns ?? SUBAGENT_MAX_TURNS;
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input);
    const prompt =
      args && typeof args.prompt === "string" ? args.prompt : input;
    return this.executeArgs({ prompt });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const prompt = args.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return "❌ task 需要非空 prompt 字段";
    }
    console.log(`[Subagent started] ${prompt.slice(0, 80)}`);
    try {
      // 每次调用创建全新 agent——fresh history（对齐 s06 run_subagent）；
      // verbose + [sub] 前缀对齐 lcc：子的工具调用以 "[sub] ..." 输出，
      // 与父的 🔧 轮次区分（共享 hooks 的 [HOOK] 行仍无前缀——与 lcc 一致）
      const subAgent = new FunctionCallAgent("subagent", this.options.llm, this.subRegistry, {
        systemPrompt: this.options.systemPrompt ?? DEFAULT_SUB_SYSTEM,
        maxToolIterations: this.maxTurns,
        hooks: this.options.hooks,
        config: new AgentConfig({ verbose: true }),
        tracePrefix: "[sub] ",
      });
      const answer = await subAgent.run(prompt);
      console.log("[Subagent done]");
      return answer;
    } catch (error) {
      return `❌ 子 agent 执行失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
