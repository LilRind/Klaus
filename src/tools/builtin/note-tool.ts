/**
 * 笔记工具（对应书 9.4 tools/builtin/note_tool.py）
 *
 * 结构化笔记 = 长程智能体的"外部大脑"：任务状态、阻塞点、决策都以
 * Markdown + YAML frontmatter 落盘（人可读、可 git、可手改）。
 * "统一入口，分发处理"：execute 收 JSON 字符串，按 action 分发——与
 * MemoryTool 同构，注册进 ToolRegistry 即可被 LLM 调用。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { Tool } from "../tool";
import type { ContextPacket } from "../../context/types";

/** 笔记类型（对应书 note_type） */
export const NOTE_TYPES = [
  "task",
  "insight",
  "blocker",
  "decision",
  "action",
  "general",
] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

/** 笔记状态（summary 按此统计，对应书 status） */
export const NOTE_STATUSES = [
  "todo",
  "in_progress",
  "completed",
  "blocked",
] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

/** frontmatter 元数据 + 正文（对应书 _parse_markdown 的返回结构） */
export interface NoteRecord {
  id: string;
  title: string;
  type: NoteType;
  status: NoteStatus;
  tags: string[];
  priority: number;
  created: string;
  updated: string;
  content: string;
}

export interface NoteToolOptions {
  /** 笔记工作区根目录，默认 ./notes */
  workspace?: string;
  /** 相对时间基准（测试注入用） */
  now?: () => Date;
}

interface NoteActionPayload {
  action?: string;
  note_id?: string;
  title?: string;
  content?: string;
  type?: string;
  status?: string;
  tags?: unknown;
  priority?: unknown;
  query?: string;
  limit?: unknown;
  [key: string]: unknown;
}

export class NoteTool extends Tool {
  readonly name = "note";
  readonly description =
    "结构化笔记工具 - 记录和检索任务状态、阻塞点、决策与行动项（支持 create/read/update/list/search/delete/summary）";
  readonly parametersDescription =
    'JSON 对象: {"action": "create|read|update|list|search|delete|summary", ...参数}';

  override get parametersSchema(): Record<string, unknown> | undefined {
    return {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "create",
            "read",
            "update",
            "list",
            "search",
            "delete",
            "summary",
          ],
          description: "要执行的笔记操作",
        },
        note_id: { type: "string", description: "read/update/delete: 笔记 ID" },
        title: { type: "string", description: "create: 笔记标题" },
        content: { type: "string", description: "create/update: 正文（Markdown）" },
        type: {
          type: "string",
          enum: [...NOTE_TYPES],
          description: "create: 笔记类型",
        },
        status: {
          type: "string",
          enum: [...NOTE_STATUSES],
          description: "create/update: 笔记状态",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "create/update: 标签",
        },
        priority: { type: "number", description: "create/update: 优先级 0-1" },
        query: { type: "string", description: "search: 搜索关键词" },
      },
      required: ["action"],
    };
  }

  readonly workspace: string;

  private readonly now: () => Date;

  constructor(options: NoteToolOptions = {}) {
    super();
    this.workspace = options.workspace ?? "./notes";
    this.now = options.now ?? (() => new Date());
  }

  async execute(input: string): Promise<string> {
    let payload: NoteActionPayload;
    try {
      payload = JSON.parse(input) as NoteActionPayload;
    } catch {
      return '❌ 参数必须是合法 JSON 对象，例如 {"action": "create", "title": "...", "content": "..."}';
    }

    try {
      switch (payload.action) {
        case "create":
          return await this.createNote(payload);
        case "read":
          return await this.readNote(payload);
        case "update":
          return await this.updateNote(payload);
        case "list":
          return await this.listNotes(payload);
        case "search":
          return await this.searchNotes(payload);
        case "delete":
          return await this.deleteNote(payload);
        case "summary":
          return await this.summary();
        default:
          return `❌ 未知操作: ${String(payload.action)}，支持 create/read/update/list/search/delete/summary`;
      }
    } catch (error) {
      return `❌ 笔记操作失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  // ---------- 七个 action（对应书 9.4.3 核心操作） ----------

  private async createNote(payload: NoteActionPayload): Promise<string> {
    const title = payload.title?.trim();
    if (!title) return "❌ create 需要 title 参数";
    const content = payload.content ?? "";
    const record: NoteRecord = {
      id: this.generateId(),
      title,
      type: parseEnum(payload.type, NOTE_TYPES, "general"),
      status: parseEnum(payload.status, NOTE_STATUSES, "todo"),
      tags: parseTags(payload.tags),
      priority: clamp01Number(payload.priority, 0.5),
      created: this.now().toISOString(),
      updated: this.now().toISOString(),
      content,
    };
    await this.writeNote(record);
    return `📝 笔记已创建 (ID: ${record.id})\n标题: ${record.title}\n类型: ${record.type} | 状态: ${record.status}`;
  }

  private async readNote(payload: NoteActionPayload): Promise<string> {
    const id = requireId(payload);
    const record = await this.loadNote(id);
    return renderNote(record);
  }

  private async updateNote(payload: NoteActionPayload): Promise<string> {
    const id = requireId(payload);
    const record = await this.loadNote(id);
    if (payload.title !== undefined) {
      const title = String(payload.title).trim();
      if (title) record.title = title;
    }
    if (payload.content !== undefined) record.content = String(payload.content);
    if (payload.type !== undefined) {
      record.type = parseEnum(payload.type, NOTE_TYPES, record.type);
    }
    if (payload.status !== undefined) {
      record.status = parseEnum(payload.status, NOTE_STATUSES, record.status);
    }
    if (payload.tags !== undefined) record.tags = parseTags(payload.tags);
    if (payload.priority !== undefined) {
      record.priority = clamp01Number(payload.priority, record.priority);
    }
    record.updated = this.now().toISOString();
    await this.writeNote(record);
    return `✅ 笔记已更新 (ID: ${record.id})，状态: ${record.status}`;
  }

  private async listNotes(payload: NoteActionPayload): Promise<string> {
    const records = await this.loadAll();
    const type = payload.type ? String(payload.type) : undefined;
    const status = payload.status ? String(payload.status) : undefined;
    const filtered = records.filter(
      (record) =>
        (!type || record.type === type) && (!status || record.status === status),
    );
    if (filtered.length === 0) return "📭 暂无笔记";
    return (
      `📋 共 ${filtered.length} 条笔记：\n` +
      filtered.map((r, i) => listLine(i + 1, r)).join("\n")
    );
  }

  private async searchNotes(payload: NoteActionPayload): Promise<string> {
    const query = payload.query?.trim();
    if (!query) return "❌ search 需要 query 参数";
    const limit = parsePositiveInt(payload.limit) ?? 5;
    const records = await this.loadAll();
    const terms = queryTerms(query);
    const scored = records
      .map((record) => ({ record, score: searchScore(record, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    if (scored.length === 0) return `🔍 未找到与 "${query}" 相关的笔记`;
    return (
      `🔍 找到 ${scored.length} 条相关笔记：\n` +
      scored.map((entry, i) => listLine(i + 1, entry.record, entry.score)).join("\n")
    );
  }

  private async deleteNote(payload: NoteActionPayload): Promise<string> {
    const id = requireId(payload);
    const file = this.notePath(id);
    try {
      await fs.access(file);
    } catch {
      return `❌ 笔记不存在: ${id}`;
    }
    await fs.unlink(file);
    return `🗑️ 笔记已删除 (ID: ${id})`;
  }

  private async summary(): Promise<string> {
    const records = await this.loadAll();
    if (records.length === 0) return "📭 暂无笔记";
    const byStatus = countBy(records, (r) => r.status);
    const byType = countBy(records, (r) => r.type);
    const blockers = records.filter((r) => r.type === "blocker" && r.status !== "completed");
    const lines = [
      `📊 笔记摘要（共 ${records.length} 条）`,
      `状态分布: ${Object.entries(byStatus).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      `类型分布: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    ];
    if (blockers.length > 0) {
      lines.push(
        `⚠️ 未解决的阻塞点 ${blockers.length} 个：`,
        ...blockers.map((r) => `  • [${r.id}] ${r.title}`),
      );
    }
    const recent = [...records]
      .sort((a, b) => b.updated.localeCompare(a.updated))
      .slice(0, 3);
    lines.push(
      "最近更新：",
      ...recent.map((r) => `  • [${r.id}] ${r.title} (${r.status})`),
    );
    return lines.join("\n");
  }

  // ---------- 与 ContextBuilder 集成（对应书 9.4.4） ----------

  /** 程序内类型安全检索（不走 JSON 协议），供调用方转 ContextPacket */
  async searchRecords(query: string, limit = 3): Promise<NoteRecord[]> {
    const records = await this.loadAll();
    const terms = queryTerms(query);
    return records
      .map((record) => ({ record, score: searchScore(record, terms) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.record);
  }

 /** 笔记 → ContextPacket（书 9.4.4 _notes_to_packets 的等价物） */
  toPackets(records: NoteRecord[]): ContextPacket[] {
    return records.map((record) => ({
      content: `[${record.type}/${record.status}] ${record.title}：${record.content}`,
      type: "note" as const,
      priority: record.priority,
      timestamp: record.updated,
      relevance: undefined,
      source: `note:${record.id}`,
      metadata: { id: record.id },
    }));
  }

  async getStats(): Promise<{
    total: number;
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  }> {
    const records = await this.loadAll();
    return {
      total: records.length,
      byStatus: countBy(records, (r) => r.status),
      byType: countBy(records, (r) => r.type),
    };
  }

  async generateReport(): Promise<string> {
    const records = [...(await this.loadAll())].sort((a, b) =>
      b.updated.localeCompare(a.updated),
    );
    const lines = [
      `# 项目笔记报告`,
      "",
      `生成时间: ${this.now().toISOString()}`,
      `笔记总数: ${records.length}`,
      "",
    ];
    for (const record of records) {
      lines.push(
        `## ${record.title}（${record.type} / ${record.status}）`,
        "",
        record.content || "（无正文）",
        "",
      );
    }
    return lines.join("\n");
  }

  // ---------- 存储层 ----------

  private notesDir(): string {
    return path.join(this.workspace, "notes");
  }

  private notePath(id: string): string {
    if (!/^[\w-]+$/.test(id)) throw new Error(`非法笔记 ID: ${id}`);
    return path.join(this.notesDir(), `${id}.md`);
  }

  private generateId(): string {
    const stamp = this.now();
    const pad = (n: number) => String(n).padStart(2, "0");
    const rand = Math.random().toString(36).slice(2, 6);
    return `note_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(
      stamp.getDate(),
    )}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(
      stamp.getSeconds(),
    )}_${rand}`;
  }

  private async writeNote(record: NoteRecord): Promise<void> {
    await fs.mkdir(this.notesDir(), { recursive: true });
    await fs.writeFile(this.notePath(record.id), serializeNote(record), "utf8");
  }

  private async loadNote(id: string): Promise<NoteRecord> {
    try {
      const raw = await fs.readFile(this.notePath(id), "utf8");
      return deserializeNote(raw, id);
    } catch {
      throw new Error(`笔记不存在: ${id}`);
    }
  }

  private async loadAll(): Promise<NoteRecord[]> {
    try {
      const files = await fs.readdir(this.notesDir());
      const records = await Promise.all(
        files
          .filter((file) => file.endsWith(".md"))
          .map(async (file) => {
            const raw = await fs.readFile(
              path.join(this.notesDir(), file),
              "utf8",
            );
            return deserializeNote(raw, file.replace(/\.md$/, ""));
          }),
      );
      return records.sort((a, b) => b.updated.localeCompare(a.updated));
    } catch {
      return [];
    }
  }
}

// ---------- Markdown + frontmatter 序列化（手写，不引依赖） ----------

function serializeNote(record: NoteRecord): string {
  const single = (value: string) =>
    value.includes("\n") ? JSON.stringify(value) : value;
  return [
    "---",
    `id: ${record.id}`,
    `title: ${single(record.title.replace(/\n/g, " "))}`,
    `type: ${record.type}`,
    `status: ${record.status}`,
    `tags: [${record.tags.join(", ")}]`,
    `priority: ${record.priority}`,
    `created: ${record.created}`,
    `updated: ${record.updated}`,
    "---",
    "",
    `# ${record.title}`,
    "",
    record.content,
    "",
  ].join("\n");
}

export function deserializeNote(raw: string, fallbackId: string): NoteRecord {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta: Record<string, string> = {};
  if (match?.[1]) {
    for (const line of match[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (kv?.[1] && kv[2] !== undefined) meta[kv[1]] = kv[2].trim();
    }
  }
  const body = match ? raw.slice(match[0].length) : raw;
  const content = body
    .replace(/^#\s+.*\r?\n/, "")
    .replace(/^\s+|\s+$/g, "");

  const now = new Date().toISOString();
  return {
    id: meta.id ?? fallbackId,
    title: unquote(meta.title ?? "未命名笔记"),
    type: parseEnum(meta.type, NOTE_TYPES, "general"),
    status: parseEnum(meta.status, NOTE_STATUSES, "todo"),
    tags: parseTags(meta.tags),
    priority: meta.priority ? clamp01String(meta.priority, 0.5) : 0.5,
    created: meta.created ?? now,
    updated: meta.updated ?? now,
    content,
  };
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// ---------- 小工具 ----------

function requireId(payload: NoteActionPayload): string {
  const id = payload.note_id ?? payload.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("需要 note_id 参数");
  }
  return id;
}

function parseEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  return fallback;
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((tag): tag is string => typeof tag === "string");
  }
  if (typeof value === "string") {
    const inner = value.replace(/^\[|\]$/g, "").trim();
    if (!inner) return [];
    return inner.split(",").map((tag) => unquote(tag.trim())).filter(Boolean);
  }
  return [];
}

function clamp01Number(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function clamp01String(value: string, fallback: number): number {
  return clamp01Number(Number(value), fallback);
}

function parsePositiveInt(value: unknown): number | undefined {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

/** 查询分词：空白分隔 + CJK 单字展开（中文查询没有空格，整句关键词会失配） */
function queryTerms(query: string): string[] {
  const terms: string[] = [];
  for (const chunk of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const cjk = chunk.match(/[\u4e00-\u9fff]/g);
    if (cjk && cjk.length > 0) {
      for (const char of chunk) {
        if (/[\u4e00-\u9fff]/.test(char)) terms.push(char);
      }
      const ascii = chunk.match(/[a-z0-9]+/g);
      if (ascii) terms.push(...ascii);
    } else {
      terms.push(chunk);
    }
  }
  return [...new Set(terms)];
}

function countBy(
  records: NoteRecord[],
  key: (record: NoteRecord) => string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const record of records) {
    const k = key(record);
    result[k] = (result[k] ?? 0) + 1;
  }
  return result;
}

/** 搜索打分：标题命中 ×3 > 标签命中 ×2 > 正文命中 ×1 */
function searchScore(record: NoteRecord, terms: string[]): number {
  if (terms.length === 0) return 0;
  const title = record.title.toLowerCase();
  const content = record.content.toLowerCase();
  const tags = record.tags.map((tag) => tag.toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    if (tags.some((tag) => tag.includes(term))) score += 2;
    if (content.includes(term)) score += 1;
  }
  return score;
}

function listLine(
  index: number,
  record: NoteRecord,
  score?: number,
): string {
  const suffix = score !== undefined ? `, 匹配分 ${score}` : "";
  return `${index}. [${record.id}] ${record.title}（${record.type}/${record.status}${suffix}）`;
}

function renderNote(record: NoteRecord): string {
  return [
    `📄 笔记 ${record.id}`,
    `标题: ${record.title}`,
    `类型: ${record.type} | 状态: ${record.status} | 优先级: ${record.priority}`,
    `标签: ${record.tags.length ? record.tags.join(", ") : "无"}`,
    `创建: ${record.created} | 更新: ${record.updated}`,
    "",
    record.content || "（无正文）",
  ].join("\n");
}
