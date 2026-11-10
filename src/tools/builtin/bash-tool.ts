/**
 * Bash 工具（对齐 learn-claude-code s03 的 run_bash）
 *
 * 关键设计：工具内【没有】危险命令黑名单——s03 的演进正是把 s01/s02 时代
 * run_bash 内部的黑名单前移到权限管线（闸门 1 硬拒 / 闸门 2 破坏性规则 /
 * 闸门 3 人工审核）。工具只负责"执行"这一件事，策略统一收口在 PermissionChecker。
 *
 * ⚠️ 单独使用（不装权限层）时没有任何防护——装配方必须像 examples 演示那样
 * 同时安装 createStandardPermissionChecker；文件工具默认硬围栏，bash 不适用
 * 围栏概念（命令是任意文本），这是它必须依赖权限层的根本原因。
 *
 * 执行语义对齐 s03：shell=True（Windows 走 cmd.exe）、cwd=工作区、
 * 120s 超时、输出截断 50000 字符、stdout+stderr 合并、空输出占位。
 *
 * s11 对齐：可选挂载 BackgroundManager 后，模型显式传
 * run_in_background=true 的调用走后台路径——立即返回占位结果，
 * 命令完成后再由 collectNotifications 以 <task_notification> 注入。
 * 路由发生在 executeArgs 内部，即权限闸门（ToolRegistry 汇合点）之后——
 * 被权限拒绝的命令不会进入后台（对齐 lcc execute_tool 的顺序）。
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Tool, tryParseJsonObject } from "../tool";
import type { BackgroundManager } from "../../background/background-manager";

const execAsync = promisify(exec);

export interface BashToolOptions {
  /** 命令工作目录，默认 process.cwd() */
  cwd?: string;
  /** 单命令超时毫秒，默认 120_000（对齐 s03） */
  timeoutMs?: number;
  /** 输出截断字符数，默认 50_000（对齐 s03） */
  maxOutputChars?: number;
  /** s11：挂载后支持 run_in_background=true 后台执行 */
  backgroundManager?: BackgroundManager;
}

export class BashTool extends Tool {
  override get name(): string {
    return "bash";
  }

  override get description(): string {
    return "执行 shell 命令（Windows 上为 cmd.exe 语法）";
  }

  override get parametersDescription(): string {
    return 'JSON: {"command": "dir"}，或直接传命令字符串';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令（cmd.exe 语法）" },
        run_in_background: {
          type: "boolean",
          description: "慢命令显式后台执行：立即返回 bg_id，结果稍后以通知注入",
        },
      },
      required: ["command"],
    };
  }

  readonly workingDir: string;
  private readonly timeoutMs: number;
  private readonly maxOutputChars: number;
  private readonly backgroundManager: BackgroundManager | undefined;

  constructor(options: BashToolOptions = {}) {
    super();
    this.workingDir = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxOutputChars = options.maxOutputChars ?? 50_000;
    this.backgroundManager = options.backgroundManager;
  }

  override async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    const args = tryParseJsonObject(trimmed);
    if (!args && trimmed.startsWith("{")) {
      return '❌ 参数必须是合法 JSON 对象，例如 {"command": "dir"}';
    }
    return this.executeArgs(args ?? { command: trimmed });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return "❌ 缺少必填参数 command（字符串）";
    if (/[\r\n]/.test(command)) {
      return "❌ command 不能包含换行符（一次一条命令）";
    }

    // s11：显式后台请求（仅布尔 true；缺省/字符串均同步，对齐 should_run_background）
    if (args.run_in_background === true && this.backgroundManager) {
      try {
        const taskId = await this.backgroundManager.start(command);
        return `[Background task ${taskId} started] The result will be collected on a later turn.`;
      } catch (error) {
        return `Error: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.workingDir,
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });
      const out = `${stdout}${stderr}`.trim();
      if (!out) return "(no output)";
      return out.length > this.maxOutputChars
        ? out.slice(0, this.maxOutputChars)
        : out;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        killed?: boolean;
        code?: string;
        stdout?: string;
        stderr?: string;
      };
      if (err.killed || /TIMED?OUT/i.test(String(err.message))) {
        return `Error: Timeout (${Math.round(this.timeoutMs / 1000)}s)`;
      }
      // 命令自身失败（非零退出码等）：stdout/stderr 也可能是有效信息，对齐 s03 回喂
      const partial = [err.stdout, err.stderr].filter(Boolean).join("").trim();
      if (partial) {
        return partial.length > this.maxOutputChars
          ? partial.slice(0, this.maxOutputChars)
          : partial;
      }
      return `Error: ${err.message}`;
    }
  }
}
