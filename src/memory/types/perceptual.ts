/**
 * 感知记忆（对应书 8.2.5-(4) memory/types/perceptual.py）
 *
 * 多模态记忆：元数据带 modality（image/audio/text…），原始文件路径存 raw_data。
 * 书里用 CLIP/CLAP 分别编码图像/音频并按模态分集合；TS 侧没有等价的
 * 轻量多模态编码器——这里以"内容描述文本"走统一文本嵌入，模态用
 * metadata 过滤实现（结构等价，检索语义是描述文本的语义）。
 * 评分公式（书 8.2.5）：(向量 × 0.8 + 时间近因性 × 0.2) × (0.8 + 重要性 × 0.4)。
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

export interface PerceptualMemoryOptions {
  config?: MemoryConfig;
  clock?: Clock;
  documentStore: DocumentStore;
  vectorStore: VectorStore;
  embedder: EmbeddingService;
}

/** 由文件扩展名推断模态（对应书 _infer_modality） */
export function inferModality(filePath: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(extension)) {
    return "image";
  }
  if (["mp3", "wav", "m4a", "flac", "ogg"].includes(extension)) return "audio";
  if (["mp4", "mov", "avi", "mkv"].includes(extension)) return "video";
  return "file";
}

export class PerceptualMemory extends BaseMemory {
  private readonly store: DocumentStore;
  private readonly vectors: VectorStore;
  private readonly embedder: EmbeddingService;
  private collectionReady = false;

  constructor(options: PerceptualMemoryOptions) {
    super(options.config ?? new MemoryConfig(), options.clock ?? defaultClock);
    this.store = options.documentStore;
    this.vectors = options.vectorStore;
    this.embedder = options.embedder;
  }

  async add(item: MemoryItem): Promise<string> {
    if (!this.collectionReady) {
      await this.vectors.ensureCollection(this.embedder.dimension);
      this.collectionReady = true;
    }
    await this.store.upsert(item);
    const vector = await embedOne(this.embedder, item.content);
    await this.vectors.upsert([
      {
        id: item.id,
        vector,
        metadata: {
          ...item.metadata,
          memory_id: item.id,
          memory_type: "perceptual",
          content: item.content,
          importance: item.importance,
          timestamp: item.timestamp,
          modality: item.metadata.modality ?? "text",
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
    const queryVector = await embedOne(this.embedder, query);
    const filter: Record<string, string> = { memory_type: "perceptual" };
    if (options?.modality) filter.modality = options.modality;

    const hits = await this.vectors.search(queryVector, {
      limit: Math.max(limit * 5, 20),
      filter,
    });

    const results: MemorySearchResult[] = [];
    for (const hit of hits) {
      const item = this.itemFromHit(hit.id, hit.metadata);
      if (!item) continue;
      if (!this.matchesOptions(item, options)) continue;

      const recency = this.calculateRecencyScore(item.timestamp);
      const importance =
        (hit.metadata.importance as number | undefined) ?? item.importance;
      const baseRelevance = hit.score * 0.8 + recency * 0.2;
      results.push({
        item,
        memoryType: "perceptual",
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
    return this.store.list({ ...options, memoryType: "perceptual" });
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const existing = await this.store.get(id);
    if (!existing) return false;
    const updated: MemoryItem = { ...existing, ...updates };
    await this.store.update(id, updates);
    if ("content" in updates || "metadata" in updates) {
      const vector = await embedOne(this.embedder, updated.content);
      await this.vectors.upsert([
        {
          id,
          vector,
          metadata: {
            ...updated.metadata,
            memory_id: id,
            memory_type: "perceptual",
            content: updated.content,
            importance: updated.importance,
            timestamp: updated.timestamp,
            modality: updated.metadata.modality ?? "text",
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
    for (const item of await this.store.list({ memoryType: "perceptual" })) {
      await this.vectors.delete([item.id]);
    }
    await this.store.clear();
    this.collectionReady = false;
  }

  private itemFromHit(
    id: string,
    metadata: Record<string, unknown>,
  ): MemoryItem | undefined {
    if (typeof metadata.content !== "string") return undefined;
    return {
      id,
      content: metadata.content,
      memoryType: "perceptual",
      importance: (metadata.importance as number | undefined) ?? 0.5,
      timestamp:
        (metadata.timestamp as string | undefined) ?? new Date().toISOString(),
      metadata,
    };
  }

  private matchesOptions(
    item: MemoryItem,
    options: MemoryRetrieveOptions | undefined,
  ): boolean {
    if (!options) return true;
    if (options.userId && item.metadata.user_id !== options.userId) return false;
    if (
      options.minImportance !== undefined &&
      item.importance < options.minImportance
    ) {
      return false;
    }
    return true;
  }
}
