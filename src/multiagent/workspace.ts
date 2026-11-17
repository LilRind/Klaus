/**
 * s18 Workspace（来源：SN activities/p2p.go WorkspaceAppend/List）。
 * 本地化：进程内 Store + 跨主题全局 Seq + SinceSeq 增量读 + 1MB 上限；
 * run 结束随内存清理（SN 为 Redis List + 48h TTL——偏差已记录 design.md）。
 */

import { DEFAULTS, type WorkspaceEntry } from "./model";

export interface WorkspaceOptions {
  now?: () => string;
  /** journal 接入点：每次成功 append 回调（orchestrator 落 events.jsonl）。 */
  onAppend?: (entry: WorkspaceEntry) => void;
  entryByteLimit?: number;
}

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export class WorkspaceStore {
  private seq = 0;
  private readonly topics = new Map<string, WorkspaceEntry[]>();

  constructor(private readonly options: WorkspaceOptions = {}) {}

  append(topic: string, entry: unknown): WorkspaceEntry {
    if (typeof topic !== "string" || topic.trim() === "") {
      throw new WorkspaceError("Workspace topic 不能为空");
    }
    const limit = this.options.entryByteLimit ?? DEFAULTS.entryByteLimit;
    const serialized = JSON.stringify(entry) ?? "null";
    const bytes = Buffer.byteLength(serialized, "utf-8");
    if (bytes > limit) {
      throw new WorkspaceError(`entry 超过 1MB 上限（${bytes} 字节），写入被拒绝且不消耗 seq`);
    }
    this.seq += 1;
    const record: WorkspaceEntry = {
      seq: this.seq,
      topic,
      entry,
      at: (this.options.now ?? (() => new Date().toISOString()))(),
    };
    this.topics.set(topic, [...(this.topics.get(topic) ?? []), record]);
    this.options.onAppend?.(record);
    return record;
  }

  /** 增量读取：仅返回 seq > sinceSeq 的条目（limit 默认 200，取最近的）。 */
  list(topic: string, sinceSeq = 0, limit = DEFAULTS.listLimit): WorkspaceEntry[] {
    const entries = this.topics.get(topic) ?? [];
    const fresh = entries.filter((item) => item.seq > sinceSeq);
    return fresh.slice(Math.max(0, fresh.length - limit));
  }

  latestSeq(): number {
    return this.seq;
  }
}
