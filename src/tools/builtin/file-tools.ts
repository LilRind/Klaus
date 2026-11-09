/**
 * 文件工具四件套（对齐 learn-claude-code s02 的 read/write/edit/glob）
 *
 * 与 s02 的对应关系：
 * - 结构化参数直达：四个工具全部实现 executeArgs，path/content/old_text 等
 *   以独立字段传递，不再经过字符串协议的转义与展平；
 * - edit 只替换第一处精确匹配（对应 s02 的 replace(..., 1)）；
 * - glob 支持 ** 跨目录递归，结果排序去重、200 条封顶并提示收窄。
 *
 * 安全模型（与 s02/s03 的差异是刻意的设计）：
 * - 工具默认带工作区硬围栏（allowOutsideWorkspace=false），
 *   单独 new 出来使用时不裸奔——能力自包含，深度防御；
 * - 装配权限层时（s03 对齐）可放开围栏，把"越区要不要问用户"
 *   交给 PermissionChecker 的规则统一裁决。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Tool, tryParseJsonObject } from "../tool";

export interface FileToolOptions {
  /** 工作区根目录（相对路径基于它解析），默认 process.cwd() */
  workspace?: string;
  /** 允许访问工作区之外的路径，默认 false；交给权限层裁决时可放开 */
  allowOutsideWorkspace?: boolean;
}

/** glob 结果上限（对齐 s02 的 200 条封顶） */
const MAX_GLOB_RESULTS = 200;

/** 相对路径基于工作区解析；绝对路径保持原样（是否越区由围栏/权限层判断） */
export function resolveWorkspacePath(
  workspaceRoot: string,
  rawPath: string,
): string {
  const target = rawPath.trim();
  return path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(workspaceRoot, target);
}

/** 判断目标路径是否落在工作区内（权限规则与工具围栏共用同一判定） */
export function isPathInsideWorkspace(
  workspaceRoot: string,
  target: string,
): boolean {
  const rel = path.relative(path.resolve(workspaceRoot), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 文件工具公共基类：工作区围栏 + 路径解析 */
export abstract class FileToolBase extends Tool {
  readonly workspaceRoot: string;

  protected readonly allowOutside: boolean;

  constructor(options: FileToolOptions = {}) {
    super();
    this.workspaceRoot = path.resolve(options.workspace ?? process.cwd());
    this.allowOutside = options.allowOutsideWorkspace ?? false;
  }

  /** 某个路径参数是否越出工作区（权限规则与测试用） */
  isOutsideWorkspace(rawPath: string): boolean {
    const target = resolveWorkspacePath(this.workspaceRoot, rawPath);
    return !isPathInsideWorkspace(this.workspaceRoot, target);
  }

  /** 解析并执行围栏检查；越区且未放开时抛错（由 executeArgs 捕获转 ❌ 文本） */
  protected resolveTarget(rawPath: string): string {
    const target = resolveWorkspacePath(this.workspaceRoot, rawPath);
    if (!this.allowOutside && !isPathInsideWorkspace(this.workspaceRoot, target)) {
      throw new Error(
        `路径越出工作区: ${rawPath}（工作区: ${this.workspaceRoot}）`,
      );
    }
    return target;
  }

  /** 字符串入口（ReAct 文本协议）：JSON 对象直通结构化入口，否则按工具各自的裸字符串语义 */
  protected parseInputArgs(input: string): Record<string, unknown> | null {
    return tryParseJsonObject(input);
  }

  protected invalidJsonHint(): string {
    return "❌ 字符串输入必须是合法 JSON 对象，例如 {\"path\": \"a.txt\"}";
  }
}

/** 读取文本文件（UTF-8），可限制返回行数（对齐 s02 run_read） */
export class ReadFileTool extends FileToolBase {
  override get name(): string {
    return "read_file";
  }

  override get description(): string {
    return "读取文本文件内容（UTF-8），可用 limit 限制返回行数";
  }

  override get parametersDescription(): string {
    return 'JSON: {"path": "src/a.ts", "limit": 20}，或直接传文件路径字符串';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对工作区或绝对路径）" },
        limit: { type: "integer", description: "最多返回的行数", minimum: 1 },
      },
      required: ["path"],
    };
  }

  override async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    const args = this.parseInputArgs(trimmed);
    if (!args && trimmed.startsWith("{")) return this.invalidJsonHint();
    return this.executeArgs(args ?? { path: trimmed });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    try {
      const rawPath = requireString(args.path, "path");
      if (!rawPath) return `❌ ${missingField("path", "字符串")}`;
      const target = this.resolveTarget(rawPath);
      const text = await fs.readFile(target, "utf8");
      const lines = toLines(text);
      const limit = requirePositiveInt(args.limit);
      if (limit !== undefined && limit < lines.length) {
        return [...lines.slice(0, limit), `... (${lines.length - limit} more lines)`].join("\n");
      }
      return lines.join("\n");
    } catch (error) {
      return `❌ ${errorMessage(error)}`;
    }
  }
}

/** 写入文本文件，自动创建父目录（对齐 s02 run_write） */
export class WriteFileTool extends FileToolBase {
  override get name(): string {
    return "write_file";
  }

  override get description(): string {
    return "写入文本文件（UTF-8），父目录不存在时自动创建";
  }

  override get parametersDescription(): string {
    return 'JSON: {"path": "notes/a.md", "content": "正文内容"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径" },
        content: { type: "string", description: "要写入的完整内容" },
      },
      required: ["path", "content"],
    };
  }

  override async execute(input: string): Promise<string> {
    // content 无法用裸字符串表达（无法区分路径与内容），字符串入口只接受 JSON
    const args = this.parseInputArgs(input);
    if (!args) {
      return input.trim().startsWith("{")
        ? this.invalidJsonHint()
        : `❌ write_file 需要 JSON 参数，例如 ${'{"path": "a.txt", "content": "..."}'}`;
    }
    return this.executeArgs(args);
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    try {
      const rawPath = requireString(args.path, "path");
      if (!rawPath) return `❌ ${missingField("path", "字符串")}`;
      if (typeof args.content !== "string") {
        return `❌ ${missingField("content", "字符串")}`;
      }
      const target = this.resolveTarget(rawPath);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content, "utf8");
      return `Wrote ${Buffer.byteLength(args.content, "utf8")} bytes to ${rawPath}`;
    } catch (error) {
      return `❌ ${errorMessage(error)}`;
    }
  }
}

/** 精确文本替换，只替换第一处匹配（对齐 s02 run_edit 的 replace(..., 1)） */
export class EditFileTool extends FileToolBase {
  override get name(): string {
    return "edit_file";
  }

  override get description(): string {
    return "精确替换文件中的一段文本，只替换第一处匹配";
  }

  override get parametersDescription(): string {
    return 'JSON: {"path": "a.ts", "old_text": "旧文本", "new_text": "新文本"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径" },
        old_text: { type: "string", description: "要替换的原文（必须精确匹配）" },
        new_text: { type: "string", description: "替换后的新文本" },
      },
      required: ["path", "old_text", "new_text"],
    };
  }

  override async execute(input: string): Promise<string> {
    const args = this.parseInputArgs(input);
    if (!args) {
      return input.trim().startsWith("{")
        ? this.invalidJsonHint()
        : `❌ edit_file 需要 JSON 参数（path/old_text/new_text）`;
    }
    return this.executeArgs(args);
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    try {
      const rawPath = requireString(args.path, "path");
      if (!rawPath) return `❌ ${missingField("path", "字符串")}`;
      if (typeof args.old_text !== "string" || args.old_text.length === 0) {
        return `❌ ${missingField("old_text", "非空字符串")}`;
      }
      if (typeof args.new_text !== "string") {
        return `❌ ${missingField("new_text", "字符串")}`;
      }
      if (args.old_text === args.new_text) {
        return "❌ new_text 与 old_text 相同，无需替换";
      }
      const target = this.resolveTarget(rawPath);
      const text = await fs.readFile(target, "utf8");
      if (!text.includes(args.old_text)) {
        return `❌ 未找到要替换的文本: ${rawPath}`;
      }
      // String.replace 传字符串参数只替换第一处，天然对应 s02 的 replace(..., 1)
      await fs.writeFile(target, text.replace(args.old_text, args.new_text), "utf8");
      return `Edited ${rawPath}`;
    } catch (error) {
      return `❌ ${errorMessage(error)}`;
    }
  }
}

/** glob 模式查找文件，** 跨目录递归（对齐 s02 run_glob） */
export class GlobTool extends FileToolBase {
  override get name(): string {
    return "glob";
  }

  override get description(): string {
    return "按 glob 模式查找文件，** 匹配任意层级目录，* 匹配单层，结果最多 200 条";
  }

  override get parametersDescription(): string {
    return 'JSON: {"pattern": "**/*.ts"}，或直接传模式字符串';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        pattern: { type: "string", description: "glob 模式，** 跨目录递归" },
      },
      required: ["pattern"],
    };
  }

  override async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    const args = this.parseInputArgs(trimmed);
    if (!args && trimmed.startsWith("{")) return this.invalidJsonHint();
    return this.executeArgs(args ?? { pattern: trimmed });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    try {
      const pattern = requireString(args.pattern, "pattern");
      if (!pattern) return `❌ ${missingField("pattern", "字符串")}`;
      const normalized = pattern.replace(/\\/g, "/");
      if (
        !this.isPatternInsideWorkspace(normalized)
      ) {
        throw new Error(
          `glob 模式越出工作区: ${pattern}（工作区: ${this.workspaceRoot}）`,
        );
      }
      const regex = globPatternToRegExp(normalized);
      const entries = await walk(this.workspaceRoot);
      const matches = entries
        .filter((rel) => regex.test(rel))
        .sort((a, b) => a.localeCompare(b));
      if (matches.length === 0) return "(no matches)";
      const shown = matches.slice(0, MAX_GLOB_RESULTS);
      if (matches.length > MAX_GLOB_RESULTS) {
        shown.push(
          `... (${matches.length - MAX_GLOB_RESULTS} more matches omitted; narrow the pattern)`,
        );
      }
      return shown.join("\n");
    } catch (error) {
      return `❌ ${errorMessage(error)}`;
    }
  }

  /** 模式层面的越区判断：绝对路径或含 .. 段即视为越出（未放开围栏时拒绝） */
  private isPatternInsideWorkspace(normalizedPattern: string): boolean {
    if (path.isAbsolute(normalizedPattern)) return this.allowOutside;
    if (normalizedPattern.split("/").includes("..")) return this.allowOutside;
    return true;
  }
}

/** glob 模式 → 相对路径正则：双星跨目录、单星单层、? 单字符（导出供测试） */
export function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "^";
  let i = 0;
  while (i < normalized.length) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        let j = i + 2;
        while (normalized[j] === "*") j += 1;
        if (normalized[j] === "/") {
          source += "(?:[^/]+/)*";
          i = j + 1;
        } else {
          source += "[\\s\\S]*";
          i = j;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
    } else if (char === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`${source}$`);
}

/** 递归收集工作区内所有文件与目录的相对路径（posix 分隔符；跳过符号链接防循环） */
async function walk(root: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const rel = path.relative(root, path.join(dir, entry.name)).replace(/\\/g, "/");
      entries.push(rel);
      if (entry.isDirectory()) await visit(path.join(dir, entry.name));
    }
  };
  await visit(root);
  return entries;
}

// ---------- 参数校验辅助 ----------

function requireString(value: unknown, field: string): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return value.trim();
}

function requirePositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const num = typeof value === "number" ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

function missingField(field: string, type: string): string {
  return `缺少或非法的必填参数 ${field}（需要${type}）`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 模拟 Python splitlines：去掉末尾换行产生的空行 */
function toLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
