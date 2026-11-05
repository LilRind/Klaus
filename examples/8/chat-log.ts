/**
 * 聊天逐字日志（超出书范围的工程增强，参考书 8.2.3 的 session 格式）
 *
 * 双格式：
 * - JSONL（默认开，审计留痕）：一行一次命令执行（append-only、崩溃安全）
 * - Markdown 转录（默认关，/transcript on 开启）：👤用户发言 + 🤖助手回答的可读版
 *   均在 memory_data/chat-logs/<user>-YYYY-MM-DD.{jsonl,md}
 * 与 episodic 精要记忆互补——这里存"逐字原文"，记忆系统存"提炼后的知识"。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ChatLogEntry {
  ts: string;
  user: string;
  session: string;
  command: string;
  arg: string;
  output: string;
  durationMs: number;
  ok: boolean;
}

export interface ChatLogSummary {
  totalCommands: number;
  commandCounts: Record<string, number>;
  askCount: number;
  totalMs: number;
  avgAskMs: number;
  timeline: { ts: string; command: string; arg: string }[];
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export class ChatLog {
  private enabled = true;
  private markdownEnabled = false;
  private dirReady = false;
  /** 已写过文件头的 md 文件（避免重复写头） */
  private readonly mdHeaders = new Set<string>();

  constructor(private readonly dir = "./memory_data/chat-logs") {}

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setMarkdownEnabled(enabled: boolean): void {
    this.markdownEnabled = enabled;
  }

  get isMarkdownEnabled(): boolean {
    return this.markdownEnabled;
  }

  private filePath(user: string, date = todayStamp()): string {
    const safeUser = user.replace(/[\\/:*?"<>|]/g, "_");
    return join(this.dir, `${safeUser}-${date}.jsonl`);
  }

  async append(entry: ChatLogEntry): Promise<void> {
    if (!this.enabled) return;
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await appendFile(this.filePath(entry.user), JSON.stringify(entry) + "\n", "utf-8");
  }

  /**
   * Markdown 转录（默认关）：每次命令一个可读块——👤用户输入 + 🤖助手回答。
   * 首次写入时补文件头（用户/日期/会话）。
   */
  async appendMarkdown(entry: ChatLogEntry): Promise<void> {
    if (!this.enabled || !this.markdownEnabled) return;
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    const path = this.filePath(entry.user).replace(/\.jsonl$/, ".md");
    const header = this.mdHeaders.has(path)
      ? ""
      : `# 聊天逐字转录（用户: ${entry.user} · ${entry.ts.slice(0, 10)}）\n\n> 会话: ${entry.session} · 由 /transcript on 开启\n\n`;
    this.mdHeaders.add(path);
    // 人读转录用本地时间（jsonl 保留 ISO/UTC 机器格式）
    const local = new Date(entry.ts);
    const pad = (n: number) => String(n).padStart(2, "0");
    const time = `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())}`;
    const duration = entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs}ms`;
    const block = [
      header,
      `### ${time} 👤 用户${entry.command === "/ask" || entry.command === "/askx" ? "" : `（${entry.command}）`}`,
      "",
      entry.arg || entry.command,
      "",
      `### ${time} 🤖 助手（${duration}${entry.ok ? "" : " · 失败"}）`,
      "",
      entry.output.trimEnd(),
      "",
    ].join("\n");
    await appendFile(path, block, "utf-8");
  }

  async readDay(user: string, date = todayStamp()): Promise<ChatLogEntry[]> {
    try {
      const raw = await readFile(this.filePath(user, date), "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as ChatLogEntry);
    } catch {
      return [];
    }
  }

  /** 当日复盘统计：命令分布、提问次数与耗时、最近时间线 */
  async summarize(user: string, date = todayStamp()): Promise<ChatLogSummary> {
    const entries = await this.readDay(user, date);
    const commandCounts: Record<string, number> = {};
    let askCount = 0;
    let askTotalMs = 0;
    let totalMs = 0;
    for (const entry of entries) {
      commandCounts[entry.command] = (commandCounts[entry.command] ?? 0) + 1;
      totalMs += entry.durationMs;
      if (entry.command === "/ask" || entry.command === "/askx") {
        askCount += 1;
        askTotalMs += entry.durationMs;
      }
    }
    return {
      totalCommands: entries.length,
      commandCounts,
      askCount,
      totalMs,
      avgAskMs: askCount === 0 ? 0 : Math.round(askTotalMs / askCount),
      timeline: entries.slice(-10).map((entry) => ({
        ts: entry.ts.slice(11, 19),
        command: entry.command,
        arg: entry.arg.slice(0, 40),
      })),
    };
  }
}
