/**
 * Agent 执行轨迹日志（s01–s03 对齐的工程增强，为 s04 hooks 铺路）
 *
 * 双格式（约定对齐 examples/8/chat-log.ts 的聊天留痕）：
 * - JSONL（默认开，审计/复现）：一行一个事件，append-only、崩溃安全，
 *   参数与输出存完整原文——事后可精确复现"模型当时看到什么"；
 * - Markdown 转录（默认开，检查用）：时间 + 图标的可读块，长文本截断。
 * 均写入 <dir>/<agent>-YYYY-MM-DD.{jsonl,md}（默认 ./logs/agent-trace/）。
 *
 * 与 console verbose 轨迹解耦：verbose 是"当下看得见"，traceLog 是
 * "事后查得到"；两者可独立开关。事件模型即 s04 hooks 的雏形——
 * run_start/tool_call/tool_result/loop_end 对应 UserPromptSubmit/
 * PreToolUse/PostToolUse/Stop 四个挂点。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type TraceEventType =
  | "run_start" // 用户输入进入循环
  | "tool_call" // 模型发起一次工具调用（PreToolUse 位置）
  | "tool_result" // 工具结果回喂（含 ⛔ 权限拒绝——拒绝也是 observation）
  | "loop_end" // 模型未再调用工具，循环自然结束
  | "forced_final" // 达到最大轮数，强制文本收尾
  | "run_end"; // 最终回答返回

/** JSONL 一行事件（ts/session 由 AgentTraceLog 统一补齐） */
export interface TraceEvent {
  ts: string;
  session: string;
  type: TraceEventType;
  iteration?: number;
  input?: string;
  toolCallId?: string;
  toolName?: string;
  args?: string;
  output?: string;
  toolCallCount?: number;
  rounds?: number;
  answer?: string;
  durationMs?: number;
}

/** md 转录里长文本的截断上限 */
const MD_TEXT_LIMIT = 400;

export class AgentTraceLog {
  private readonly markdown: boolean;
  private dirReady = false;
  private mdHeaders = new Set<string>();
  private warned = false;

  /** 会话标识：一个 Agent 实例共享一个 session（跨 run 可关联） */
  readonly session: string;

  constructor(
    readonly agentName: string,
    private readonly dir = "./logs/agent-trace",
    options: { markdown?: boolean } = {},
  ) {
    this.markdown = options.markdown ?? true;
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    this.session = `${agentName}_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  }

  /** 追加事件：JSONL 完整原文 + md 可读块；写日志失败不中断 agent（fail-open） */
  async emit(event: Omit<TraceEvent, "ts" | "session">): Promise<void> {
    try {
      const full: TraceEvent = {
        ...event,
        ts: new Date().toISOString(),
        session: this.session,
      };
      await this.appendJsonl(full);
      if (this.markdown) await this.appendMarkdownBlock(full);
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn(
          `⚠️ [trace] 轨迹日志写入失败（后续失败静默）: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** 读取某 agent 某日的 JSONL 事件（测试/复盘用） */
  async readDay(date = todayStamp()): Promise<TraceEvent[]> {
    try {
      const raw = await readFile(this.fileBase(date) + ".jsonl", "utf-8");
      return raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as TraceEvent);
    } catch {
      return [];
    }
  }

  private fileBase(date: string): string {
    const safeName = this.agentName.replace(/[\\/:*?"<>|]/g, "_");
    return join(this.dir, `${safeName}-${date}`);
  }

  private async appendJsonl(event: TraceEvent): Promise<void> {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await appendFile(
      this.fileBase(todayStamp()) + ".jsonl",
      JSON.stringify(event) + "\n",
      "utf-8",
    );
  }

  private async appendMarkdownBlock(event: TraceEvent): Promise<void> {
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    const path = this.fileBase(todayStamp()) + ".md";
    const header = this.mdHeaders.has(path)
      ? ""
      : `# 执行轨迹（agent: ${this.agentName} · ${todayStamp()}）\n\n> session: ${this.session} · 完整原文见同名 .jsonl\n\n`;
    this.mdHeaders.add(path);
    await appendFile(path, header + renderMarkdown(event), "utf-8");
  }
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

function localTime(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function clip(text: string): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > MD_TEXT_LIMIT
    ? `${flattened.slice(0, MD_TEXT_LIMIT)}...`
    : flattened;
}

function renderMarkdown(event: TraceEvent): string {
  const time = localTime(event.ts);
  const lines: string[] = [];
  switch (event.type) {
    case "run_start":
      lines.push(`## ${time} 👤 输入`, "", clip(event.input ?? ""), "");
      break;
    case "tool_call":
      lines.push(
        `### ${time} 🔧 第 ${event.iteration ?? "?"} 轮 · 调用 ${event.toolName}`,
        "",
        `- 参数: ${clip(event.args ?? "")}`,
        "",
      );
      break;
    case "tool_result":
      lines.push(
        `- 结果${event.durationMs !== undefined ? `（${event.durationMs}ms）` : ""}: ${clip(event.output ?? "")}`,
        "",
      );
      break;
    case "loop_end":
      lines.push(
        `## ${time} ✔ 循环结束（共 ${event.rounds ?? "?"} 轮模型调用）`,
        "",
      );
      break;
    case "forced_final":
      lines.push(`## ${time} ⏹ 达到最大轮数，强制文本收尾`, "");
      break;
    case "run_end":
      lines.push(
        `## ${time} 📝 最终回答（${event.durationMs ?? 0}ms）`,
        "",
        clip(event.answer ?? ""),
        "",
      );
      break;
  }
  return lines.join("\n");
}
