/**
 * 文档存储契约 + InMemory / SQLite 实现（对应书 storage/document_store.py）
 *
 * 书里情景/感知记忆用 SQLite 做结构化持久化（元数据、时间范围查询），
 * 向量库负责语义检索，两者按 memory_id 关联。TS 侧：
 * - SQLiteDocumentStore：Node 24 内置 node:sqlite，零原生依赖；
 * - InMemoryDocumentStore：测试与纯内存场景。
 */

import {
  createMemoryItem,
  type MemoryItem,
  type MemoryListOptions,
  type MemoryType,
} from "../base";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

// 本项目 vite/vitest 管线会把 node:sqlite 的 import 说明符剥成裸 "sqlite"，
// 无论静态还是动态导入都会解析失败；node:fs 等老牌内置模块不受影响。
// 解法：createRequire 走 Node CJS 加载器直取（require 对全部内置模块可用）。
const nodeRequire = createRequire(import.meta.url);

export interface DocumentStore {
  init(): Promise<void>;
  upsert(item: MemoryItem): Promise<void>;
  get(id: string): Promise<MemoryItem | undefined>;
  list(options?: MemoryListOptions): Promise<MemoryItem[]>;
  update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean>;
  delete(id: string): Promise<boolean>;
  count(options?: MemoryListOptions): Promise<number>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

/** 通用过滤逻辑（两个实现共享，保证行为一致） */
export function matchesListOptions(
  item: MemoryItem,
  options: MemoryListOptions | undefined,
): boolean {
  if (!options) return true;
  if (options.memoryType && item.memoryType !== options.memoryType) return false;
  if (options.userId && item.metadata.user_id !== options.userId) return false;
  if (options.sessionId && item.metadata.session_id !== options.sessionId) {
    return false;
  }
  if (options.modality && item.metadata.modality !== options.modality) return false;
  if (options.minImportance !== undefined && item.importance < options.minImportance) {
    return false;
  }
  if (options.since && item.timestamp < options.since) return false;
  if (options.until && item.timestamp > options.until) return false;
  return true;
}

export class InMemoryDocumentStore implements DocumentStore {
  private readonly items = new Map<string, MemoryItem>();

  async init(): Promise<void> {}

  async upsert(item: MemoryItem): Promise<void> {
    this.items.set(item.id, { ...item });
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const item = this.items.get(id);
    return item ? { ...item } : undefined;
  }

  async list(options?: MemoryListOptions): Promise<MemoryItem[]> {
    return [...this.items.values()]
      .filter((item) => matchesListOptions(item, options))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      .map((item) => ({ ...item }));
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const item = this.items.get(id);
    if (!item) return false;
    this.items.set(id, {
      ...item,
      ...("content" in updates ? { content: updates.content } : {}),
      ...("importance" in updates ? { importance: updates.importance } : {}),
      ...("metadata" in updates ? { metadata: updates.metadata } : {}),
    });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    return this.items.delete(id);
  }

  async count(options?: MemoryListOptions): Promise<number> {
    return (await this.list(options)).length;
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}

/** SQLite 持久化实现（node:sqlite DatabaseSync，Node 24 内置） */
export class SQLiteDocumentStore implements DocumentStore {
  private db?: import("node:sqlite").DatabaseSync;
  private ready = false;

  constructor(private readonly databasePath: string) {}

  async init(): Promise<void> {
    if (this.db) return;
    const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    // SQLite 只建文件不建目录——父目录缺失时先补（默认 ./memory_data/）
    await mkdir(dirname(this.databasePath), { recursive: true });
    this.db = new sqlite.DatabaseSync(this.databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        importance REAL NOT NULL,
        timestamp TEXT NOT NULL,
        user_id TEXT,
        metadata TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
      CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    `);
    this.ready = true;
  }

  /** 惰性初始化：Manager 构造是同步的，无法统一 await init()，各方法自保 */
  private async ensureReady(): Promise<void> {
    if (!this.ready) await this.init();
  }

  private connection(): import("node:sqlite").DatabaseSync {
    if (!this.db) throw new Error("SQLiteDocumentStore 未初始化，请先调用 init()");
    return this.db;
  }

  async upsert(item: MemoryItem): Promise<void> {
    await this.ensureReady();
    this.connection()
      .prepare(
        `INSERT INTO memories (id, content, memory_type, importance, timestamp, user_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           importance = excluded.importance,
           metadata = excluded.metadata`,
      )
      .run(
        item.id,
        item.content,
        item.memoryType,
        item.importance,
        item.timestamp,
        (item.metadata.user_id as string | undefined) ?? null,
        JSON.stringify(item.metadata),
      );
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    await this.ensureReady();
    const row = this.connection()
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as SQLiteRow | undefined;
    return row ? rowToItem(row) : undefined;
  }

  async list(options?: MemoryListOptions): Promise<MemoryItem[]> {
    await this.ensureReady();
    // SQLite 路径先做粗过滤（类型/重要性/时间），模态等元数据条件在内存里精筛
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (options?.memoryType) {
      conditions.push("memory_type = ?");
      params.push(options.memoryType);
    }
    if (options?.minImportance !== undefined) {
      conditions.push("importance >= ?");
      params.push(options.minImportance);
    }
    if (options?.since) {
      conditions.push("timestamp >= ?");
      params.push(options.since);
    }
    if (options?.until) {
      conditions.push("timestamp <= ?");
      params.push(options.until);
    }

    const sql =
      "SELECT * FROM memories" +
      (conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "") +
      " ORDER BY timestamp ASC";
    const rows = this.connection()
      .prepare(sql)
      .all(...params) as unknown as SQLiteRow[];
    return rows
      .map(rowToItem)
      .filter((item) => matchesListOptions(item, options));
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.upsert({
      ...existing,
      ...("content" in updates ? { content: updates.content } : {}),
      ...("importance" in updates ? { importance: updates.importance } : {}),
      ...("metadata" in updates ? { metadata: updates.metadata } : {}),
    });
    return true;
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureReady();
    const result = this.connection()
      .prepare("DELETE FROM memories WHERE id = ?")
      .run(id);
    return (result.changes ?? 0) > 0;
  }

  async count(options?: MemoryListOptions): Promise<number> {
    await this.ensureReady();
    return (await this.list(options)).length;
  }

  async clear(): Promise<void> {
    await this.ensureReady();
    this.connection().exec("DELETE FROM memories");
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = undefined;
    this.ready = false;
  }
}

interface SQLiteRow {
  id: string;
  content: string;
  memory_type: string;
  importance: number;
  timestamp: string;
  user_id: string | null;
  metadata: string;
}

function rowToItem(row: SQLiteRow): MemoryItem {
  return createMemoryItem({
    id: row.id,
    content: row.content,
    memoryType: row.memory_type as MemoryType,
    importance: row.importance,
    timestamp: row.timestamp,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  });
}
