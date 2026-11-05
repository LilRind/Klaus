/**
 * 终端工具（对应书 9.5 tools/builtin/terminal_tool.py）
 *
 * "即时文件系统访问"：不预先索引整个代码库，让 Agent 像人一样按需
 * ls → grep → cat 地探索。安全机制对齐书：
 *   1. 命令白名单（只读命令，无 rm/mv/写操作）
 *   2. 工作目录限制（路径解析后必须落在 workspace 内，防 `..` 逃逸）
 *   3. 超时（默认 30s）与输出截断（默认 10MB）
 *
 * 与书的差异：白名单命令映射为 Node fs 内置实现（跨平台，Windows 上
 * 无需 bash 也能跑 ls/grep/awk），不真实 spawn shell——详见《第9章剩余事项.md》。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Tool } from "../tool";

export interface TerminalToolOptions {
  /** 允许访问的工作目录（默认 process.cwd()） */
  workspace?: string;
  /** 单命令超时毫秒（默认 30_000） */
  timeout?: number;
  /** 输出截断阈值字节（默认 10MB，对齐书 10485760） */
  maxOutputBytes?: number;
}

const ALLOWED_COMMANDS = [
  "pwd",
  "ls",
  "dir",
  "cd",
  "cat",
  "head",
  "tail",
  "grep",
  "find",
  "wc",
  "tree",
  "stat",
  "du",
  "sort",
  "uniq",
  "cut",
  "awk",
] as const;

export class TerminalTool extends Tool {
  readonly name = "terminal";
  readonly description =
    "终端工具 - 通过白名单命令即时探索文件系统（pwd/ls/cd/cat/head/tail/grep/find/wc/tree/stat/du/sort/uniq/cut/awk）";
  readonly parametersDescription =
    'JSON 对象 {"command": "ls -la src"} 或纯命令字符串 "cat README.md"';

  override get parametersSchema(): Record<string, unknown> | undefined {
    return {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的白名单命令" },
      },
      required: ["command"],
    };
  }

  readonly workspaceRoot: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;

  /** 会话内当前目录（cd 状态，对应书 _handle_cd） */
  private cwd = "";

  constructor(options: TerminalToolOptions = {}) {
    super();
    this.workspaceRoot = path.resolve(options.workspace ?? process.cwd());
    this.cwd = this.workspaceRoot;
    this.timeoutMs = options.timeout ?? 30_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 10 * 1024 * 1024;
  }

  async execute(input: string): Promise<string> {
    const command = parseCommandInput(input);
    if (!command.trim()) return "❌ 命令为空";

    const parts = tokenizeCommand(command);
    const name = parts[0]?.toLowerCase();
    if (!name || !(ALLOWED_COMMANDS as readonly string[]).includes(name)) {
      return `❌ 不允许的命令: ${name ?? "(空)"}\n允许的命令: ${ALLOWED_COMMANDS.join(", ")}`;
    }

    const started = Date.now();
    try {
      const output = await this.dispatch(name, parts.slice(1));
      const elapsed = Date.now() - started;
      if (elapsed > this.timeoutMs) {
        return `❌ 命令执行超时（超过 ${this.timeoutMs}ms）`;
      }
      return this.truncateOutput(output);
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /** 当前会话目录（测试用） */
  get currentDirectory(): string {
    return this.cwd;
  }

  // ---------- 分发 ----------

  private async dispatch(name: string, args: string[]): Promise<string> {
    switch (name) {
      case "pwd":
        return this.relativeToWorkspace(this.cwd);
      case "ls":
      case "dir":
        return this.ls(args);
      case "cd":
        return this.cd(args);
      case "cat":
        return this.cat(args);
      case "head":
        return this.headTail(args, "head");
      case "tail":
        return this.headTail(args, "tail");
      case "grep":
        return this.grep(args);
      case "find":
        return this.find(args);
      case "wc":
        return this.wc(args);
      case "tree":
        return this.tree(args);
      case "stat":
        return this.stat(args);
      case "du":
        return this.du(args);
      case "sort":
        return this.sortLines(args);
      case "uniq":
        return this.uniqLines(args);
      case "cut":
        return this.cut(args);
      case "awk":
        return this.awk(args);
      default:
        throw new Error(`不支持的命令: ${name}`);
    }
  }

  // ---------- 路径安全（对应书工作目录限制 + 逃逸保护） ----------

  private resolveInsideWorkspace(target: string): string {
    const candidate = path.resolve(this.cwd, target);
    const rel = path.relative(this.workspaceRoot, candidate);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `禁止访问工作目录之外的路径: ${target}（工作目录: ${this.workspaceRoot}）`,
      );
    }
    return candidate;
  }

  private relativeToWorkspace(absolute: string): string {
    const rel = path.relative(this.workspaceRoot, absolute);
    return rel === "" ? "." : rel.split(path.sep).join("/");
  }

  private async mustExist(target: string): Promise<string> {
    const resolved = this.resolveInsideWorkspace(target);
    await fs.access(resolved);
    return resolved;
  }

  // ---------- 命令实现 ----------

  private async ls(args: string[]): Promise<string> {
    const long = args.some((a) => a.startsWith("-") && a.includes("l"));
    const target = args.find((a) => !a.startsWith("-")) ?? ".";
    const dir = await this.mustExist(target);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const names = entries
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    if (names.length === 0) return "（空目录）";
    if (!long) return names.join("\n");
    const lines: string[] = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const stat = await fs.stat(path.join(dir, entry.name));
      const kind = entry.isDirectory() ? "d" : "-";
      lines.push(
        `${kind} ${String(stat.size).padStart(10)}  ${stat
          .mtime.toISOString()
          .slice(0, 16)}  ${entry.name}`,
      );
    }
    return lines.join("\n");
  }

  private async cd(args: string[]): Promise<string> {
    const target = args[0] ?? ".";
    if (args[0] === undefined) {
      this.cwd = this.workspaceRoot;
    } else {
      this.cwd = this.resolveInsideWorkspace(args[0]);
    }
    await fs.access(this.cwd);
    return `当前目录: ${this.relativeToWorkspace(this.cwd)}`;
  }

  private async cat(args: string[]): Promise<string> {
    const files = args.filter((a) => !a.startsWith("-"));
    if (files.length === 0) throw new Error("cat 需要至少一个文件参数");
    const contents: string[] = [];
    for (const file of files) {
      const resolved = await this.mustExist(file);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) throw new Error(`${file} 是目录，不是文件`);
      if (files.length > 1) contents.push(`==> ${file} <==`);
      contents.push(await fs.readFile(resolved, "utf8"));
    }
    return contents.join("\n").replace(/\n+$/, "\n");
  }

  private async headTail(args: string[], mode: "head" | "tail"): Promise<string> {
    let count = 10;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-n") {
        const value = Number(args[i + 1]);
        if (Number.isInteger(value) && value > 0) {
          count = value;
          i += 1;
        }
      } else if (/^-\d+$/.test(arg)) {
        count = Math.abs(Number(arg));
      } else if (!arg.startsWith("-")) {
        positional.push(arg);
      }
    }
    const file = positional[0];
    if (!file) throw new Error(`${mode} 需要文件参数`);
    const resolved = await this.mustExist(file);
    const text = await fs.readFile(resolved, "utf8");
    const lines = text.split(/\r?\n/).filter((line, idx, arr) => line !== "" || idx < arr.length - 1);
    const picked = mode === "head" ? lines.slice(0, count) : lines.slice(-count);
    return picked.join("\n");
  }

  private async grep(args: string[]): Promise<string> {
    let ignoreCase = false;
    let showNumber = false;
    let recursive = false;
    let includeGlob: string | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "--include") {
        includeGlob = args[i + 1];
        i += 1;
      } else if (arg.startsWith("--include=")) {
        includeGlob = arg.slice("--include=".length);
      } else if (arg === "-i" || arg === "-in" || arg === "-ni") {
        ignoreCase = true;
        showNumber = true;
      } else if (arg === "-n") showNumber = true;
      else if (arg === "-r" || arg === "-R") recursive = true;
      else if (/^-[inr]+$/.test(arg)) {
        // 支持 -rn/-nr/-in 组合
        if (arg.includes("i")) ignoreCase = true;
        if (arg.includes("n")) showNumber = true;
        if (arg.includes("r")) recursive = true;
      } else if (arg.startsWith("-")) {
        throw new Error(`grep 不支持参数: ${arg}（本实现仅支持 -i/-n/-r 及 --include=GLOB）`);
      } else positional.push(arg);
    }
    const pattern = positional.shift();
    if (!pattern) throw new Error("grep 需要 pattern 参数");
    const includeRegex = includeGlob ? globToRegExp(includeGlob) : undefined;
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, ignoreCase ? "i" : "");
    } catch {
      throw new Error(`非法正则: ${pattern}`);
    }
    const targets = positional.length > 0 ? positional : ["."];
    const results: string[] = [];
    for (const target of targets) {
      const resolved = await this.mustExist(target);
      const stat = await fs.stat(resolved);
      if (stat.isDirectory()) {
        if (!recursive) {
          results.push(`grep: ${target}: 是目录（需要 -r 递归）`);
          continue;
        }
        const files = await listFilesRecursive(resolved);
        const multi = targets.length > 1 || files.length > 1;
        for (const file of files) {
          if (includeRegex && !includeRegex.test(path.basename(file))) continue;
          await grepFile(file, regex, showNumber, multi, results);
        }
      } else {
        if (includeRegex && !includeRegex.test(path.basename(resolved))) {
          continue;
        }
        await grepFile(resolved, regex, showNumber, targets.length > 1, results);
      }
    }
    return results.length > 0 ? results.join("\n") : "（无匹配行）";
  }

  private async find(args: string[]): Promise<string> {
    let namePattern: string | undefined;
    let typeFilter: "f" | "d" | undefined;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-name") {
        namePattern = args[i + 1];
        i += 1;
      } else if (arg === "-type") {
        const value = args[i + 1];
        if (value === "f" || value === "d") typeFilter = value;
        i += 1;
      } else if (!arg.startsWith("-")) {
        positional.push(arg);
      }
    }
    const root = await this.mustExist(positional[0] ?? ".");
    const stat = await fs.stat(root);
    const matches: string[] = [];
    const regex = namePattern ? globToRegExp(namePattern) : undefined;
    const visit = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const isDir = entry.isDirectory();
        if (
          !(typeFilter === "f" && isDir) &&
          !(typeFilter === "d" && !isDir) &&
          (!regex || regex.test(entry.name))
        ) {
          matches.push(this.relativeToWorkspace(full));
        }
        // -type 过滤只影响输出，不影响递归遍历
        if (isDir) await visit(full);
      }
    };
    if (stat.isDirectory()) {
      await visit(root);
    } else if (!regex || regex.test(path.basename(root))) {
      matches.push(this.relativeToWorkspace(root));
    }
    return matches.length > 0 ? matches.join("\n") : "（无匹配）";
  }

  private async wc(args: string[]): Promise<string> {
    const flags = args.filter((a) => a.startsWith("-")).join("");
    const file = args.find((a) => !a.startsWith("-"));
    if (!file) throw new Error("wc 需要文件参数");
    const resolved = await this.mustExist(file);
    const text = await fs.readFile(resolved, "utf8");
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const chars = text.length;
    if (flags.includes("l")) return String(lines);
    if (flags.includes("w")) return String(words);
    if (flags.includes("c") || flags.includes("m")) return String(chars);
    return `${lines} ${words} ${chars} ${file}`;
  }

  private async tree(args: string[]): Promise<string> {
    let depth = 3;
    const positional: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-L") {
        const value = Number(args[i + 1]);
        if (Number.isInteger(value) && value > 0) {
          depth = value;
          i += 1;
        }
      } else if (!arg.startsWith("-")) positional.push(arg);
    }
    const root = await this.mustExist(positional[0] ?? ".");
    const lines: string[] = [this.relativeToWorkspace(root)];
    const walk = async (dir: string, level: number, prefix: string) => {
      if (level > depth) return;
      const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
        (a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        },
      );
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const isLast = i === entries.length - 1;
        const branch = isLast ? "└── " : "├── ";
        lines.push(`${prefix}${branch}${entry.name}${entry.isDirectory() ? "/" : ""}`);
        if (entry.isDirectory()) {
          await walk(path.join(dir, entry.name), level + 1, prefix + (isLast ? "    " : "│   "));
        }
      }
    };
    await walk(root, 1, "");
    return lines.join("\n");
  }

  private async stat(args: string[]): Promise<string> {
    const file = args.find((a) => !a.startsWith("-"));
    if (!file) throw new Error("stat 需要路径参数");
    const resolved = await this.mustExist(file);
    const info = await fs.stat(resolved);
    return [
      `文件: ${this.relativeToWorkspace(resolved)}`,
      `大小: ${info.size} 字节`,
      `类型: ${info.isDirectory() ? "目录" : "文件"}`,
      `修改时间: ${info.mtime.toISOString()}`,
      `权限: ${(info.mode & 0o777).toString(8)}`,
    ].join("\n");
  }

  private async du(args: string[]): Promise<string> {
    const file = args.find((a) => !a.startsWith("-")) ?? ".";
    const resolved = await this.mustExist(file);
    const sizeOf = async (target: string): Promise<number> => {
      const info = await fs.stat(target);
      if (!info.isDirectory()) return info.size;
      let total = 0;
      for (const entry of await fs.readdir(target)) {
        total += await sizeOf(path.join(target, entry));
      }
      return total;
    };
    const bytes = await sizeOf(resolved);
    const kb = bytes / 1024;
    return `${kb.toFixed(1)}K\t${this.relativeToWorkspace(resolved)}`;
  }

  private async sortLines(args: string[]): Promise<string> {
    const reverse = args.some((a) => /^-\w*r/.test(a));
    const numeric = args.some((a) => /^-\w*n/.test(a));
    const file = args.find((a) => !a.startsWith("-"));
    const text = await this.readInput(file);
    const lines = text.split(/\r?\n/).filter((line) => line !== "");
    lines.sort((a, b) => {
      const result = numeric
        ? Number(a) - Number(b) || a.localeCompare(b)
        : a.localeCompare(b);
      return reverse ? -result : result;
    });
    return lines.join("\n");
  }

  private async uniqLines(args: string[]): Promise<string> {
    const count = args.some((a) => /^-\w*c/.test(a));
    const file = args.find((a) => !a.startsWith("-"));
    const text = await this.readInput(file);
    const lines = text.split(/\r?\n/).filter((line) => line !== "");
    const output: string[] = [];
    let previous: string | undefined;
    let runs = 0;
    const flush = () => {
      if (previous === undefined) return;
      output.push(count ? `${runs} ${previous}` : previous);
    };
    for (const line of lines) {
      if (line === previous) {
        runs += 1;
      } else {
        flush();
        previous = line;
        runs = 1;
      }
    }
    flush();
    return output.join("\n");
  }

  private async cut(args: string[]): Promise<string> {
    let delimiter = "\t";
    let fields: number[] = [1];
    let file: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "-d") {
        delimiter = args[i + 1] ?? "\t";
        i += 1;
      } else if (arg.startsWith("-d")) {
        delimiter = arg.slice(2);
      } else if (arg === "-f") {
        fields = parseFieldList(args[i + 1]);
        i += 1;
      } else if (arg.startsWith("-f")) {
        fields = parseFieldList(arg.slice(2));
      } else if (!arg.startsWith("-")) {
        file = arg;
      }
    }
    const text = await this.readInput(file);
    return text
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) =>
        line
          .split(delimiter)
          .filter((_, index) => fields.includes(index + 1))
          .join(delimiter),
      )
      .join("\n");
  }

  /** awk 子集：awk '{print $N}' [file]（$0 = 整行，支持 $1,$3 逗号拼接） */
  private async awk(args: string[]): Promise<string> {
    const script = args.find((arg) => arg.includes("print"));
    if (!script) {
      throw new Error("本实现仅支持 awk '{print $N}' 子集");
    }
    const match = script.match(/\{\s*print\s+([^}]+)\s*\}/);
    if (!match?.[1]) {
      throw new Error("本实现仅支持 awk '{print $N}' 子集");
    }
    const fieldsSpec = match[1]
      .split(",")
      .map((token) => token.trim())
      .map((token) => {
        const field = token.match(/^\$(\d+)$/);
        if (!field) throw new Error(`不支持的 awk 表达式: ${token}`);
        return Number(field[1]);
      });
    const file = args.find((arg) => arg !== script && !arg.startsWith("-"));
    const text = await this.readInput(file);
    const whitespace = /\s+/;
    return text
      .split(/\r?\n/)
      .filter((line) => line !== "")
      .map((line) => {
        const cells = line.split(whitespace);
        return fieldsSpec
          .map((field) => (field === 0 ? line : cells[field - 1] ?? ""))
          .join(" ");
      })
      .join("\n");
  }

  // ---------- 共用 ----------

  private async readInput(file?: string): Promise<string> {
    if (!file) throw new Error("缺少文件参数（stdin 管道不在白名单实现范围内）");
    const resolved = await this.mustExist(file);
    return fs.readFile(resolved, "utf8");
  }

  private truncateOutput(output: string): string {
    const bytes = Buffer.byteLength(output, "utf8");
    if (bytes <= this.maxOutputBytes) return output;
    const sliced = Buffer.from(output, "utf8").subarray(0, this.maxOutputBytes);
    return `${sliced.toString("utf8")}\n⚠️ 输出被截断（超过 ${this.maxOutputBytes} 字节）`;
  }
}

/** glob（*.py / ?.txt）→ 正则（find/grep 共用） */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${source}$`);
}

// ---------- 模块级辅助 ----------

function parseCommandInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { command?: unknown };
    return typeof parsed.command === "string" ? parsed.command : trimmed;
  } catch {
    return trimmed;
  }
}

/** 分词：空白分隔，支持成对引号包裹含空格参数 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push(full);
    }
  };
  await visit(root);
  return files;
}

async function grepFile(
  file: string,
  regex: RegExp,
  showNumber: boolean,
  showFilename: boolean,
  results: string[],
): Promise<void> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return; // 二进制/无权限文件跳过，对应 grep 静默跳过
  }
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (regex.test(line)) {
      const prefix = [showFilename ? file : undefined, showNumber ? i + 1 : undefined]
        .filter(Boolean)
        .join(":");
      results.push(prefix ? `${prefix}:${line}` : line);
    }
  }
}

function parseFieldList(value: string | undefined): number[] {
  if (!value) return [1];
  const fields: number[] = [];
  for (const part of value.split(",")) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      for (let i = start; i <= end; i++) fields.push(i);
    } else {
      const num = Number(part);
      if (Number.isInteger(num) && num > 0) fields.push(num);
    }
  }
  return fields.length > 0 ? fields : [1];
}
