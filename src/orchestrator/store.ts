/**
 * S18 编排持久层（来源：dsh-superagent src/app/store.ts 移植 + 单写者事务）。
 *
 * node:sqlite 单库（Node 24 内置，零依赖；与 memory/storage 的 SQLiteDocumentStore
 * 同一 createRequire 用法——vite/vitest 管线会把 node:sqlite 说明符剥成裸 "sqlite"，
 * 必须走 Node CJS 加载器直取）。领域对象 JSON 序列化存列；Engine 的每个命令在
 * atomic() 单事务内完成；effect 行在事务内入队（transactional outbox），由 Effects
 * 在提交后执行。':memory:' 供测试，文件库开 WAL。
 */

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { KV, type Key } from "./kv";
import type {
  Assignment,
  Decision,
  OutboxMessage,
  Ticket,
  Trigger,
  WorkerReport,
} from "./model";

const nodeRequire = createRequire(import.meta.url);

export type SqliteDatabase = import("node:sqlite").DatabaseSync;

export const SCHEMA_VERSION = 1;

export interface EffectRow {
  kind: string;
  key: string;
  payload: string;
  seq: number;
  generation: number;
  attempts: number;
  error: string;
  due: number;
}

/**
 * 编排状态库：kv / trigger / ticket / assignment / report / decision / outbox / effect。
 * 构造即建表并写 schema 版本；更旧的版本抛错（批 2 起增加迁移与恢复）。
 */
export class OrchestrationStore {
  readonly db: SqliteDatabase;
  private seq = 0;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    this.db = new sqlite.DatabaseSync(path);
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS trigger (
        id TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ticket (
        id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL, ended INTEGER);
      CREATE TABLE IF NOT EXISTS assignment (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL,
        value TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision (
        id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS effect (
        kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        seq INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
        attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
        due INTEGER NOT NULL, PRIMARY KEY (kind, key));
      CREATE INDEX IF NOT EXISTS effect_due ON effect(due, seq);
      CREATE INDEX IF NOT EXISTS report_ticket ON report(ticket_id, seq);
    `);
    this.seq = Number(
      (this.db.prepare("SELECT IFNULL(MAX(seq), 0) AS seq FROM effect").get() as { seq: number })
        .seq,
    );
    const version = this.get(KV.store.schema);
    if (version !== undefined && version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`不支持的编排库版本 ${version}（当前实现 ${SCHEMA_VERSION}）`);
    }
    if (version !== SCHEMA_VERSION) this.set(KV.store.schema, SCHEMA_VERSION);
  }

  /** 同步单事务：fn 内任一步抛错则整体回滚（Engine 命令的唯一事务边界）。 */
  atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ---- kv ----

  get<V>(key: Key<V>): V | undefined {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as V);
  }

  set<V>(key: Key<V>, value: V): void {
    this.db
      .prepare(
        "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify(value));
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  // ---- 聚合读写（JSON 列）----

  saveTrigger(trigger: Trigger): void {
    this.db
      .prepare("INSERT OR REPLACE INTO trigger (id, value, at) VALUES (?, ?, ?)")
      .run(trigger.id, JSON.stringify(trigger), trigger.at);
  }

  getTrigger(id: string): Trigger | undefined {
    const row = this.db.prepare("SELECT value FROM trigger WHERE id = ?").get(id) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as Trigger);
  }

  saveTicket(ticket: Ticket): void {
    this.db
      .prepare("INSERT OR REPLACE INTO ticket (id, value, created_at, ended) VALUES (?, ?, ?, ?)")
      .run(ticket.id, JSON.stringify(ticket), ticket.createdAt, ticket.ended ? 1 : 0);
  }

  getTicket(id: string): Ticket | undefined {
    const row = this.db.prepare("SELECT value FROM ticket WHERE id = ?").get(id) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as Ticket);
  }

  listTickets(): Ticket[] {
    const rows = this.db
      .prepare("SELECT value FROM ticket ORDER BY created_at, id")
      .all() as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as Ticket);
  }

  saveAssignment(assignment: Assignment): void {
    this.db
      .prepare("INSERT OR REPLACE INTO assignment (id, ticket_id, value) VALUES (?, ?, ?)")
      .run(assignment.id, assignment.ticketId, JSON.stringify(assignment));
  }

  getAssignment(id: string): Assignment | undefined {
    const row = this.db.prepare("SELECT value FROM assignment WHERE id = ?").get(id) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as Assignment);
  }

  appendReport(ticketId: string, report: WorkerReport): void {
    this.db
      .prepare("INSERT INTO report (ticket_id, value, at) VALUES (?, ?, ?)")
      .run(ticketId, JSON.stringify(report), report.at);
  }

  listReports(ticketId: string): WorkerReport[] {
    const rows = this.db
      .prepare("SELECT value FROM report WHERE ticket_id = ? ORDER BY seq")
      .all(ticketId) as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as WorkerReport);
  }

  saveDecision(decision: Decision): void {
    this.db
      .prepare("INSERT OR REPLACE INTO decision (id, trigger_id, value) VALUES (?, ?, ?)")
      .run(decision.id, decision.triggerId, JSON.stringify(decision));
  }

  listDecisions(): Decision[] {
    const rows = this.db
      .prepare("SELECT value FROM decision ORDER BY rowid")
      .all() as { value: string }[];
    return rows.map((row) => JSON.parse(row.value) as Decision);
  }

  saveOutbox(message: OutboxMessage): void {
    this.db
      .prepare("INSERT OR REPLACE INTO outbox (id, ticket_id, value) VALUES (?, ?, ?)")
      .run(message.id, message.ticketId, JSON.stringify(message));
  }

  getOutbox(id: string): OutboxMessage | undefined {
    const row = this.db.prepare("SELECT value FROM outbox WHERE id = ?").get(id) as
      | { value: string }
      | undefined;
    return row === undefined ? undefined : (JSON.parse(row.value) as OutboxMessage);
  }

  listOutbox(): OutboxMessage[] {
    const rows = this.db.prepare("SELECT value FROM outbox ORDER BY id").all() as {
      value: string;
    }[];
    return rows.map((row) => JSON.parse(row.value) as OutboxMessage);
  }

  // ---- effect 队列（事务内入队 / 提交后由 Effects 执行）----

  /**
   * Upsert 一条 effect：同 (kind,key) 已在队列则更新 payload、generation+1、
   * attempts 归零，保留原 seq（队列位置不变）；新行取递增 seq。
   */
  enqueueEffect(kind: string, key: string, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO effect (kind, key, value, seq, due) VALUES (?, ?, ?, ?, 0)
         ON CONFLICT(kind, key) DO UPDATE SET
           value = excluded.value, generation = generation + 1,
           attempts = 0, error = '', due = excluded.due`,
      )
      .run(kind, key, JSON.stringify(payload), this.nextSeq());
  }

  listDueEffects(now: number): EffectRow[] {
    return this.db
      .prepare(
        "SELECT kind, key, value AS payload, seq, generation, attempts, error, due FROM effect WHERE due <= ? ORDER BY seq",
      )
      .all(now) as unknown as EffectRow[];
  }

  /** 读一条 effect 的当前 payload（deliver 合并 texts 用；行不存在返回 undefined）。 */
  getEffectPayload(kind: string, key: string): unknown {
    const row = this.db
      .prepare("SELECT value FROM effect WHERE kind = ? AND key = ?")
      .get(kind, key) as { value: string } | undefined;
    if (row === undefined) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return undefined;
    }
  }

  listEffectFailures(): EffectRow[] {
    return this.db
      .prepare(
        "SELECT kind, key, value AS payload, seq, generation, attempts, error, due FROM effect WHERE attempts > 0 ORDER BY seq",
      )
      .all() as unknown as EffectRow[];
  }

  /** 成功后删除；仅当 generation 仍等于执行时读到的值（防 ABA：执行期间被重新入队则保留新 payload）。 */
  deleteEffect(kind: string, key: string, generation: number): boolean {
    const result = this.db
      .prepare("DELETE FROM effect WHERE kind = ? AND key = ? AND generation = ?")
      .run(kind, key, generation);
    return result.changes > 0;
  }

  /** 重排：due 推迟、记录错误；countAttempts 为 true 时 attempts+1（Later 不计失败）。 */
  retryEffect(
    kind: string,
    key: string,
    due: number,
    error: string,
    countAttempts: boolean,
  ): void {
    this.db
      .prepare(
        "UPDATE effect SET due = ?, error = ?, attempts = attempts + ? WHERE kind = ? AND key = ?",
      )
      .run(due, error, countAttempts ? 1 : 0, kind, key);
  }

  close(): void {
    this.db.close();
  }
}
