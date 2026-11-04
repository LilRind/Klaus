/**
 * Qdrant 向量存储真实后端（对应书 8.1.4 storage/qdrant_store.py）
 *
 * 与 InMemoryVectorStore 实现同一 VectorStore 接口——记忆系统与 RAG
 * 管道的代码零改动即可切换到真实数据库。
 * 设计要点（对应书里的用法）：
 * - 记忆元数据全部放 payload（content/importance/timestamp/entities…），
 *   命中后直接重建 MemoryItem，不回表；
 * - 扁平等值过滤（memory_type/rag_namespace…）翻译为 Qdrant match 条件；
 * - 点 ID 直接复用记忆的 UUID。
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import type {
  VectorFilter,
  VectorHit,
  VectorRecord,
  VectorSearchOptions,
  VectorStore,
} from "./vector-store";

export interface QdrantStoreOptions {
  url: string;
  apiKey?: string;
  collection: string;
  /** HTTP 超时毫秒（默认 30000） */
  timeoutMs?: number;
  /** 测试可注入客户端 */
  client?: QdrantClient;
}

/** 扁平过滤器 → Qdrant must match 条件 */
function toQdrantFilter(filter: VectorFilter | undefined) {
  if (!filter) return undefined;
  const entries = Object.entries(filter);
  if (entries.length === 0) return undefined;
  return {
    must: entries.map(([key, value]) => ({ key, match: { value } })),
  };
}

export class QdrantVectorStore implements VectorStore {
  readonly collection: string;

  private readonly client: QdrantClient;
  private dimension?: number;

  constructor(options: QdrantStoreOptions) {
    this.collection = options.collection;
    this.client =
      options.client ??
      new QdrantClient({
        url: options.url,
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 30_000,
      });
  }

  async ensureCollection(dimension: number): Promise<void> {
    this.dimension = dimension;
    const { exists } = await this.client.collectionExists(this.collection);
    if (!exists) {
      await this.client.createCollection(this.collection, {
        vectors: { size: dimension, distance: "Cosine" },
      });
    }
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.client.upsert(this.collection, {
      wait: true,
      points: records.map((record) => ({
        id: record.id,
        vector: record.vector,
        payload: record.metadata,
      })),
    });
  }

  async search(
    queryVector: number[],
    options: VectorSearchOptions,
  ): Promise<VectorHit[]> {
    // 1.20+ 客户端：query() 统一接口，最近邻检索直接传向量数组；
    // 集合尚未创建（首次写入前的清场/统计）按空结果处理
    const response = await this.guardCollectionMissing(async () =>
      this.client.query(this.collection, {
        query: queryVector,
        limit: options.limit,
        filter: toQdrantFilter(options.filter),
        score_threshold: options.scoreThreshold,
        with_payload: true,
      }),
    );
    return (response?.points ?? []).map((point) => ({
      id: String(point.id),
      score: point.score ?? 0,
      metadata: (point.payload ?? {}) as Record<string, unknown>,
    }));
  }

  async list(filter?: VectorFilter): Promise<VectorRecord[]> {
    const records: VectorRecord[] = [];
    // 分页游标：ExtendedPointId（数字或 UUID 字符串），按不透明值透传
    let offset: unknown;
    do {
      const page = await this.guardCollectionMissing(() =>
        this.client.scroll(this.collection, {
          limit: 100,
          offset: offset as never,
          filter: toQdrantFilter(filter),
          with_payload: true,
          with_vector: false,
        }),
      );
      if (!page) break;
      for (const point of page.points) {
        records.push({
          id: String(point.id),
          vector: [],
          metadata: (point.payload ?? {}) as Record<string, unknown>,
        });
      }
      offset = page.next_page_offset;
    } while (offset !== undefined && offset !== null);
    return records;
  }

  async getById(id: string): Promise<VectorRecord | undefined> {
    const points = await this.guardCollectionMissing(() =>
      this.client.retrieve(this.collection, {
        ids: [id],
        with_payload: true,
        with_vector: true,
      }),
    );
    if (!points) return undefined;
    const point = points[0];
    if (!point) return undefined;
    return {
      id: String(point.id),
      vector: (point.vector as number[]) ?? [],
      metadata: (point.payload ?? {}) as Record<string, unknown>,
    };
  }

  async delete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.client.delete(this.collection, {
      wait: true,
      points: ids,
    });
  }

  async count(filter?: VectorFilter): Promise<number> {
    const result = await this.guardCollectionMissing(() =>
      this.client.count(this.collection, {
        filter: toQdrantFilter(filter),
        exact: true,
      }),
    );
    return result?.count ?? 0;
  }

  async clear(): Promise<void> {
    await this.guardCollectionMissing(() =>
      this.client.deleteCollection(this.collection),
    );
    this.dimension = undefined;
  }

  /** REST 客户端无长连接，close 为空操作（与 InMemory 行为对齐） */
  async close(): Promise<void> {}

  /** 集合不存在（404）时按空结果处理——与 InMemory 版的"未 ensure 即空"语义对齐 */
  private async guardCollectionMissing<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      if (isCollectionMissing(error)) return undefined;
      throw error;
    }
  }
}

function isCollectionMissing(error: unknown): boolean {
  const status = (error as { status?: number }).status;
  if (status === 404) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("doesn't exist") || message.includes("not found");
}
