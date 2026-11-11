/**
 * 权限管线（对齐 learn-claude-code s03 的三道闸门）
 *
 * 模型决定"做什么"，权限管线决定"能不能做"：
 *   闸门 1（denyRules）：硬拒绝——永远禁止的操作，命中即拒、不询问；
 *   闸门 2（askRules）：上下文规则——命中后升级为人工审批；
 *   闸门 3（prompt）：审批交互——暂停等人，用户决定放行或拒绝；
 *   三道都没命中 → 默认放行（default-allow，对齐 s03 哲学）。
 *
 * 与 s03 的架构差异（刻意设计）：s03 把 check_permission 插在 agent loop 里，
 * 我们收口在 ToolRegistry 的双入口汇合点——FunctionCallAgent（原生函数调用）
 * 和 ReActAgent（文本协议）都经过 executeTool/executeToolArgs，插一次覆盖两条路线。
 *
 * 拒绝语义对齐 s03：被拒调用返回 "⛔ 权限已拒绝: 原因" 字符串作为 observation
 * 回喂模型（不抛异常、不中断循环），模型看得见拒绝并可改道。
 */

import { createInterface } from "node:readline/promises";
import path from "node:path";
import {
  isPathInsideWorkspace,
  resolveWorkspacePath,
} from "../tools/builtin/file-tools";

/** 一次待裁决的工具调用（结构化参数——s02 对齐的直接受益者） */
export interface PermissionRequest {
  toolName: string;
  args: Record<string, unknown>;
}

/**
 * 权限规则 = 工具名集合 + 参数谓词。
 * 命中返回原因文本（给审批展示 / 拒绝回喂），未命中返回 null。
 */
export interface PermissionRule {
  tools: string[];
  test(request: PermissionRequest): string | null;
}

export interface PermissionOutcome {
  allowed: boolean;
  /** 拒绝原因（拒绝时回喂给模型） */
  reason?: string;
}

/** 审批交互：闸门 2 命中后由它问人 */
export interface ApprovalPrompt {
  confirm(request: PermissionRequest, reason: string): Promise<boolean>;
}

export interface PermissionCheckerOptions {
  /** 闸门 1：硬拒绝规则（优先于 askRules） */
  denyRules?: PermissionRule[];
  /** 闸门 2：命中后升级为人工审批的规则 */
  askRules?: PermissionRule[];
  /** 闸门 3：审批器；askRules 命中但未配置时安全默认拒绝 */
  prompt?: ApprovalPrompt;
}

export class PermissionChecker {
  private readonly denyRules: readonly PermissionRule[];
  private readonly askRules: readonly PermissionRule[];
  private readonly prompt: ApprovalPrompt | undefined;

  constructor(options: PermissionCheckerOptions = {}) {
    this.denyRules = options.denyRules ?? [];
    this.askRules = options.askRules ?? [];
    this.prompt = options.prompt;
  }

  async check(request: PermissionRequest): Promise<PermissionOutcome> {
    for (const rule of this.denyRules) {
      if (!rule.tools.includes(request.toolName)) continue;
      const reason = rule.test(request);
      if (reason) return { allowed: false, reason };
    }
    for (const rule of this.askRules) {
      if (!rule.tools.includes(request.toolName)) continue;
      const reason = rule.test(request);
      if (reason) {
        if (!this.prompt) {
          return {
            allowed: false,
            reason: `${reason}（未配置审批器，默认拒绝）`,
          };
        }
        const allowed = await this.prompt.confirm(request, reason);
        return allowed
          ? { allowed: true }
          : { allowed: false, reason: `${reason}（用户拒绝）` };
      }
    }
    return { allowed: true };
  }
}

/**
 * 标准规则集（对齐 s03 的 PERMISSION_RULES 语义，作用于文件工具）：
 * - 硬拒绝（闸门 1）：bash 命中 DENY_LIST（rm -rf / 等永远禁止）；
 *   write_file / edit_file 目标落在 .git 目录内（我们比 s03 更严的补充）；
 * - 询问（闸门 2）：bash 破坏性命令（rm/del 词边界正则 + 危险关键字）；
 *   文件工具的路径/glob 模式越出工作区；
 * - 其余默认放行（工作区内读写直接执行，对齐 s03 的日常操作零摩擦）。
 */
export interface StandardPermissionOptions {
  workspaceRoot: string;
}

export function createStandardPermissionRules(
  options: StandardPermissionOptions,
): { denyRules: PermissionRule[]; askRules: PermissionRule[] } {
  const root = path.resolve(options.workspaceRoot);

  const denyRules: PermissionRule[] = [
    {
      tools: ["bash"],
      test(request) {
        const command = stringArg(request.args.command);
        if (!command) return null;
        for (const pattern of BASH_DENY_PATTERNS) {
          if (command.includes(pattern)) {
            return `命令命中硬拒绝列表: ${pattern}`;
          }
        }
        return null;
      },
    },
    {
      tools: ["write_file", "edit_file"],
      test(request) {
        const rawPath = stringArg(request.args.path);
        if (!rawPath) return null;
        const rel = path.relative(root, resolveWorkspacePath(root, rawPath));
        if (rel.split(/[\\/]/).includes(".git")) {
          return `禁止写入 .git 目录: ${rawPath}`;
        }
        return null;
      },
    },
  ];

  const askRules: PermissionRule[] = [
    {
      tools: ["bash"],
      test(request) {
        const command = stringArg(request.args.command);
        if (!command) return null;
        if (
          containsDestructiveCommand(command) ||
          BASH_ASK_KEYWORDS.some((keyword) => command.includes(keyword))
        ) {
          return `潜在破坏性命令: ${command.slice(0, 80)}`;
        }
        return null;
      },
    },
    {
      tools: ["read_file", "write_file", "edit_file", "glob"],
      test(request) {
        const rawPath = stringArg(request.args.path);
        if (rawPath !== null) {
          const target = resolveWorkspacePath(root, rawPath);
          if (!isPathInsideWorkspace(root, target)) {
            return `访问工作目录之外的路径: ${rawPath}`;
          }
          return null;
        }
        const pattern = stringArg(request.args.pattern);
        if (pattern !== null) {
          const normalized = pattern.replace(/\\/g, "/");
          if (
            path.isAbsolute(normalized) ||
            normalized.split("/").includes("..")
          ) {
            return `glob 模式越出工作区: ${pattern}`;
          }
        }
        return null;
      },
    },
  ];

  return { denyRules, askRules };
}

/** bash 闸门 1：永远禁止的命令模式（对齐 s03 DENY_LIST） */
export const BASH_DENY_PATTERNS = [
  "rm -rf /",
  "sudo",
  "shutdown",
  "reboot",
  "mkfs",
  "dd if=",
  "> /dev/sda",
] as const;

/** bash 闸门 2 的关键字（对齐 s03：rm 前缀 / 重定向到系统目录 / 危险权限） */
const BASH_ASK_KEYWORDS = ["rm ", "> /etc/", "chmod 777"] as const;

/**
 * 破坏性命令词边界匹配（对齐 s03 的 DESTRUCTIVE_COMMAND_WORD）：
 * `del test.txt` 命中；`echo del test.txt`、变量名里的 model/delimiter 不命中。
 */
const DESTRUCTIVE_COMMAND_WORD =
  /(?:^|[;&|()\n])\s*(?:rm|del)(?=\s|$|[;&|()])/i;

export function containsDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE_COMMAND_WORD.test(command);
}

/**
 * 装包类命令识别（可选闸门 2 规则用）：npm/yarn/pnpm/pip/pipx/python -m pip
 * 的 install/add/ci。默认不启用（default-allow，对齐 s03）；需要"装包也要
 * y/N 审批"时由装配层按 PACKAGE_INSTALL_POLICY=ask 加入 askRules。
 */
const PACKAGE_INSTALL_PATTERN =
  /(?:^|[;&|]\s*)(?:npm\s+(?:install|i|add|ci)|yarn\s+(?:add|install)|pnpm\s+(?:add|install)|pipx?\s+install|python[\d.]*(?:\s+-m\s+pip)?\s+install)\b(?!\s+(?:--help|-h)(?:\s|$))/i;

export function isPackageInstallCommand(command: string): boolean {
  return PACKAGE_INSTALL_PATTERN.test(command);
}

/** 装包命令 → 闸门 2（人工审批）的规则；命中返回原因，未命中 null */
export function createPackageInstallAskRule(): PermissionRule {
  return {
    tools: ["bash"],
    test(request) {
      const command = stringArg(request.args.command);
      if (command && isPackageInstallCommand(command)) {
        return `安装软件包（PACKAGE_INSTALL_POLICY=ask）: ${command.slice(0, 80)}`;
      }
      return null;
    },
  };
}

/** 便捷装配：标准规则 + 指定审批器 */
export function createStandardPermissionChecker(
  options: StandardPermissionOptions & { prompt?: ApprovalPrompt },
): PermissionChecker {
  const { denyRules, askRules } = createStandardPermissionRules(options);
  return new PermissionChecker({ denyRules, askRules, prompt: options.prompt });
}

/** 控制台审批器：y/N 交互（对齐 s03 的 ask_user） */
export class ConsoleApprovalPrompt implements ApprovalPrompt {
  async confirm(request: PermissionRequest, reason: string): Promise<boolean> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      console.log(`\n⚠️  [权限] ${reason}`);
      console.log(`   工具: ${request.toolName}(${summarizeArgs(request.args)})`);
      const answer = (await rl.question("   允许执行? [y/N] ")).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    } finally {
      rl.close();
    }
  }
}

/** 测试桩：总是放行（记录收到的审批请求） */
export class AutoAllowPrompt implements ApprovalPrompt {
  readonly requests: { request: PermissionRequest; reason: string }[] = [];

  async confirm(request: PermissionRequest, reason: string): Promise<boolean> {
    this.requests.push({ request, reason });
    return true;
  }
}

/** 测试桩：总是拒绝（记录收到的审批请求） */
export class AutoDenyPrompt implements ApprovalPrompt {
  readonly requests: { request: PermissionRequest; reason: string }[] = [];

  async confirm(request: PermissionRequest, reason: string): Promise<boolean> {
    this.requests.push({ request, reason });
    return false;
  }
}

// ---------- 内部辅助 ----------

function stringArg(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

/** 审批展示用参数摘要：长文本只显示长度，避免刷屏泄露内容 */
function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.length > 80) {
      parts.push(`${key}: <${value.length} chars>`);
    } else {
      parts.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  const summary = parts.join(", ");
  return summary.length > 160 ? `${summary.slice(0, 160)}...` : summary;
}
