/**
 * 工作记忆（对应书 8.2.5-(1) memory/types/working.py）
 *
 * 特点：纯内存 + 容量上限（默认 50）+ TTL 自动清理（默认 60 分钟）；
 * 检索是组合词法策略：TF-IDF 词项权重 × 0.7 + 关键词匹配 × 0.3，
 * 再乘时间衰减与重要性权重。不落盘——重启即忘，正是工作记忆的定位。
 */

import {
  BaseMemory,
  MemoryConfig,
  type Clock,
  type MemoryItem,
  type MemoryListOptions,
  type MemoryRetrieveOptions,
  type MemorySearchResult,
  defaultClock,
} from "../base";
import { TFIDFEmbedding, cosineSimilarity, tokenizeForEmbedding } from "../embedding";

export interface WorkingMemoryOptions {
  config?: MemoryConfig;
  clock?: Clock;
  /** 测试可注入独立的容量/TTL，不必绕道 MemoryConfig */
  maxCapacity?: number;
  ttlMinutes?: number;
}

export class WorkingMemory extends BaseMemory {
  private readonly maxCapacity: number;
  private readonly ttlMs: number;
  private readonly memories: MemoryItem[] = [];
  /** add 时的词法向量缓存（retrieve 用 embedQuery 与之做余弦） */
  private readonly vectors = new Map<string, number[]>();
  private readonly lexical = new TFIDFEmbedding();

  constructor(options: WorkingMemoryOptions = {}) {
    super(options.config ?? new MemoryConfig(), options.clock ?? defaultClock);
    this.maxCapacity =
      options.maxCapacity ?? this.config.workingMemoryCapacity;
    this.ttlMs =
      (options.ttlMinutes ?? this.config.workingMemoryTtlMinutes) * 60_000;
  }

  async add(item: MemoryItem): Promise<string> {
    this.expireOldMemories();
    while (this.memories.length >= this.maxCapacity) {
      this.removeLowestPriorityMemory();
    }
    this.memories.push(item);
    // 文档模式向量化（计入语料，IDF 随语料生长）
    const [vector] = await this.lexical.embed([item.content]);
    if (vector) this.vectors.set(item.id, vector);
    return item.id;
  }

  async retrieve(
    query: string,
    limit = 5,
    options?: MemoryRetrieveOptions,
  ): Promise<MemorySearchResult[]> {
    this.expireOldMemories();

    // TF-IDF 查询向量（查询模式：不污染语料）
    const queryTokens = tokenizeForEmbedding(query);
    if (queryTokens.length === 0) return [];
    const queryVector = this.lexical.embedQuery(query);

    const scored: MemorySearchResult[] = [];
    for (const memory of this.memories) {
      if (!this.matchesOptions(memory, options)) continue;
      const memoryVector = this.vectors.get(memory.id);
      const vectorScore = memoryVector
        ? cosineSimilarity(queryVector, memoryVector)
        : 0;
      const keywordScore = this.keywordScore(query, memory.content);
      const baseRelevance =
        vectorScore > 0 ? vectorScore * 0.7 + keywordScore * 0.3 : keywordScore;
      const timeDecay = this.calculateRecencyScore(memory.timestamp);
      const importanceWeight = this.importanceWeight(memory.importance);
      const finalScore = baseRelevance * timeDecay * importanceWeight;
      if (finalScore > 0) {
        scored.push({ item: memory, memoryType: "working", score: finalScore });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    this.expireOldMemories();
    return this.memories.find((memory) => memory.id === id);
  }

  async list(options?: MemoryListOptions): Promise<MemoryItem[]> {
    this.expireOldMemories();
    return this.memories
      .filter((memory) => this.matchesList(memory, options))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index === -1) return false;
    const existing = this.memories[index];
    if (!existing) return false;
    this.memories[index] = { ...existing, ...cleanUpdates(updates) };
    if ("content" in updates) {
      const [vector] = await this.lexical.embed([updates.content ?? ""]);
      if (vector) this.vectors.set(id, vector);
    }
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const index = this.memories.findIndex((memory) => memory.id === id);
    if (index === -1) return false;
    this.memories.splice(index, 1);
    this.vectors.delete(id);
    return true;
  }

  async clear(): Promise<void> {
    this.memories.length = 0;
    this.vectors.clear();
  }

  /** TTL 过期清理（对应书 _expire_old_memories） */
  private expireOldMemories(): void {
    const deadline = this.clock().getTime() - this.ttlMs;
    for (let i = this.memories.length - 1; i >= 0; i--) {
      const memory = this.memories[i];
      if (!memory) continue;
      const time = Date.parse(memory.timestamp);
      if (!Number.isNaN(time) && time < deadline) this.memories.splice(i, 1);
    }
  }

  /** 容量超限时淘汰：重要性最低，平局取最旧（对应书 _remove_lowest_priority_memory） */
  private removeLowestPriorityMemory(): void {
    if (this.memories.length === 0) return;
    let victimIndex = 0;
    for (let i = 1; i < this.memories.length; i++) {
      const current = this.memories[i];
      const victim = this.memories[victimIndex];
      if (!current || !victim) continue;
      // 主标准是重要性；重要性相同才比时间（淘汰更旧的）
      if (current.importance < victim.importance) {
        victimIndex = i;
      } else if (
        current.importance === victim.importance &&
        current.timestamp < victim.timestamp
      ) {
        victimIndex = i;
      }
    }
    this.memories.splice(victimIndex, 1);
  }

  /** 关键词覆盖率：查询词项在记忆内容中命中的比例（对应书 _calculate_keyword_score） */
  private keywordScore(query: string, content: string): number {
    const queryTokens = new Set(tokenizeForEmbedding(query));
    if (queryTokens.size === 0) return 0;
    const contentTokens = new Set(tokenizeForEmbedding(content));
    let hits = 0;
    for (const token of queryTokens) {
      if (contentTokens.has(token)) hits += 1;
    }
    return hits / queryTokens.size;
  }

  private matchesOptions(
    memory: MemoryItem,
    options: MemoryRetrieveOptions | undefined,
  ): boolean {
    if (!options) return true;
    if (options.userId && memory.metadata.user_id !== options.userId) return false;
    if (options.sessionId && memory.metadata.session_id !== options.sessionId) {
      return false;
    }
    if (
      options.minImportance !== undefined &&
      memory.importance < options.minImportance
    ) {
      return false;
    }
    return true;
  }

  private matchesList(
    memory: MemoryItem,
    options: MemoryListOptions | undefined,
  ): boolean {
    if (!this.matchesOptions(memory, options)) return false;
    if (options?.memoryType && options.memoryType !== "working") return false;
    if (options?.since && memory.timestamp < options.since) return false;
    if (options?.until && memory.timestamp > options.until) return false;
    if (options?.modality && memory.metadata.modality !== options.modality) {
      return false;
    }
    return true;
  }
}

function cleanUpdates(
  updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
): Partial<Pick<MemoryItem, "content" | "importance" | "metadata">> {
  const result: Partial<MemoryItem> = {};
  if ("content" in updates) result.content = updates.content;
  if ("importance" in updates) result.importance = updates.importance;
  if ("metadata" in updates) result.metadata = updates.metadata;
  return result;
}
