/**
 * 情景记忆（对应书 8.2.5-(2) memory/types/episodic.py）
 *
 * 混合存储：DocumentStore（SQLite，结构化字段与时间范围过滤）
 * + VectorStore（Qdrant，语义检索），按 memory_id 关联。
 * 评分公式（书 8.2.5）：(向量相似度 × 0.8 + 时间近因性 × 0.2) × (0.8 + 重要性 × 0.4)。
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
import { embedOne, type EmbeddingService } from "../embedding";
import type { DocumentStore } from "../storage/document-store";
import type { VectorStore } from "../storage/vector-store";

export interface EpisodicMemoryOptions {
  config?: MemoryConfig;
  clock?: Clock;
  documentStore: DocumentStore;
  vectorStore: VectorStore;
  embedder: EmbeddingService;
}

export class EpisodicMemory extends BaseMemory {
  private readonly store: DocumentStore;
  private readonly vectors: VectorStore;
  private readonly embedder: EmbeddingService;

  constructor(options: EpisodicMemoryOptions) {
    super(options.config ?? new MemoryConfig(), options.clock ?? defaultClock);
    this.store = options.documentStore;
    this.vectors = options.vectorStore;
    this.embedder = options.embedder;
  }

  async add(item: MemoryItem): Promise<string> {
    await this.store.upsert(item);
    const vector = await embedOne(this.embedder, item.content);
    await this.vectors.upsert([
      {
        id: item.id,
        vector,
        metadata: {
          ...item.metadata,
          memory_id: item.id,
          memory_type: "episodic",
          content: item.content,
          importance: item.importance,
          timestamp: item.timestamp,
        },
      },
    ]);
    return item.id;
  }

  async retrieve(
    query: string,
    limit = 5,
    options?: MemoryRetrieveOptions,
  ): Promise<MemorySearchResult[]> {
    // 1) 语义向量检索（扩大候选池，供结构化条件精筛）
    const queryVector = await embedOne(this.embedder, query);
    const hits = await this.vectors.search(queryVector, {
      limit: limit * 5,
      filter: { memory_type: "episodic" },
    });

    // 2) 综合评分（书里的公式）+ 结构化过滤
    const results: MemorySearchResult[] = [];
    for (const hit of hits) {
      const item = this.itemFromHit(hit.id, hit.metadata);
      if (!item) continue;
      if (!this.matchesOptions(item, options)) continue;

      const recency = this.calculateRecencyScore(item.timestamp);
      const importance = hit.metadata.importance as number | undefined ?? item.importance;
      const baseRelevance = hit.score * 0.8 + recency * 0.2;
      results.push({
        item,
        memoryType: "episodic",
        score: baseRelevance * this.importanceWeight(importance),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    return this.store.get(id);
  }

  async list(options?: MemoryListOptions): Promise<MemoryItem[]> {
    return this.store.list({ ...options, memoryType: "episodic" });
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const existing = await this.store.get(id);
    if (!existing) return false;
    const updated: MemoryItem = { ...existing, ...cleanUpdates(updates) };
    await this.store.update(id, updates);
    // 内容变化需要重新向量化（元数据里带内容与重要性）
    if ("content" in updates) {
      const vector = await embedOne(this.embedder, updated.content);
      await this.vectors.upsert([
        {
          id,
          vector,
          metadata: {
            ...updated.metadata,
            memory_id: id,
            memory_type: "episodic",
            content: updated.content,
            importance: updated.importance,
            timestamp: updated.timestamp,
          },
        },
      ]);
    }
    return true;
  }

  async remove(id: string): Promise<boolean> {
    await this.vectors.delete([id]);
    return this.store.delete(id);
  }

  async clear(): Promise<void> {
    for (const item of await this.store.list({ memoryType: "episodic" })) {
      await this.vectors.delete([item.id]);
    }
    await this.store.clear();
  }

  private itemFromHit(
    id: string,
    metadata: Record<string, unknown>,
  ): MemoryItem | undefined {
    if (typeof metadata.content !== "string") return undefined;
    return {
      id,
      content: metadata.content,
      memoryType: "episodic",
      importance: metadata.importance as number | undefined ?? 0.5,
      timestamp: metadata.timestamp as string | undefined ?? new Date().toISOString(),
      metadata,
    };
  }

  private matchesOptions(
    item: MemoryItem,
    options: MemoryRetrieveOptions | undefined,
  ): boolean {
    if (!options) return true;
    if (options.userId && item.metadata.user_id !== options.userId) return false;
    if (options.sessionId && item.metadata.session_id !== options.sessionId) {
      return false;
    }
    if (
      options.minImportance !== undefined &&
      item.importance < options.minImportance
    ) {
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
