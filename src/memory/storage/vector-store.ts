/**
 * 向量存储契约 + 内存实现（对应书 8.1.4 storage/qdrant_store.py 的接口面）
 *
 * 记忆系统（情景/语义/感知）和 RAG 管道都只依赖 VectorStore 接口：
 * - InMemoryVectorStore：暴力余弦扫描，测试与轻量场景用；
 * - QdrantVectorStore：真实后端（见 qdrant-store.ts），同一接口可替换。
 * 元数据随向量一起存（书里的做法：payload 里带 content/importance/timestamp，
 * 命中后直接重建 MemoryItem，不需要回表）。
 */

import { cosineSimilarity } from "../embedding";

export interface VectorRecord {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

/** 扁平等值过滤（对应书 Qdrant where 子句的用法） */
export type VectorFilter = Record<string, string | number | boolean>;

export interface VectorSearchOptions {
  limit: number;
  filter?: VectorFilter;
  scoreThreshold?: number;
}

export interface VectorHit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  /** 确保集合存在并声明向量维度（幂等） */
  ensureCollection(dimension: number): Promise<void>;
  upsert(records: VectorRecord[]): Promise<void>;
  search(queryVector: number[], options: VectorSearchOptions): Promise<VectorHit[]>;
  /** 按元数据过滤枚举全部记录（不走相似度；管理面用） */
  list(filter?: VectorFilter): Promise<VectorRecord[]>;
  getById(id: string): Promise<VectorRecord | undefined>;
  delete(ids: string[]): Promise<void>;
  count(filter?: VectorFilter): Promise<number>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

export function matchesFilter(
  metadata: Record<string, unknown>,
  filter: VectorFilter | undefined,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(
    ([key, expected]) => metadata[key] === expected,
  );
}

/** 内存向量库：余弦相似度暴力检索，语义与 Qdrant 版一致 */
export class InMemoryVectorStore implements VectorStore {
  private dimension?: number;
  private readonly records = new Map<string, VectorRecord>();

  async ensureCollection(dimension: number): Promise<void> {
    if (this.dimension !== undefined && this.dimension !== dimension) {
      throw new Error(
        `向量维度不匹配: 集合是 ${this.dimension}，请求 ${dimension}` +
          `（对应书里的坑：QDRANT_VECTOR_SIZE 必须与嵌入模型输出一致）`,
      );
    }
    this.dimension = dimension;
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    if (this.dimension !== undefined && records.length > 0) {
      for (const record of records) {
        if (record.vector.length !== this.dimension) {
          throw new Error(
            `upsert 向量维度 ${record.vector.length} != 集合维度 ${this.dimension}`,
          );
        }
      }
    }
    for (const record of records) {
      this.records.set(record.id, { ...record });
    }
  }

  async search(
    queryVector: number[],
    options: VectorSearchOptions,
  ): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const record of this.records.values()) {
      if (!matchesFilter(record.metadata, options.filter)) continue;
      const score = cosineSimilarity(queryVector, record.vector);
      if (options.scoreThreshold !== undefined && score < options.scoreThreshold) {
        continue;
      }
      hits.push({ id: record.id, score, metadata: { ...record.metadata } });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, Math.max(0, options.limit));
  }

  async getById(id: string): Promise<VectorRecord | undefined> {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  async list(filter?: VectorFilter): Promise<VectorRecord[]> {
    return [...this.records.values()]
      .filter((record) => matchesFilter(record.metadata, filter))
      .map((record) => ({ ...record }));
  }

  async delete(ids: string[]): Promise<void> {
    for (const id of ids) this.records.delete(id);
  }

  async count(filter?: VectorFilter): Promise<number> {
    let total = 0;
    for (const record of this.records.values()) {
      if (matchesFilter(record.metadata, filter)) total += 1;
    }
    return total;
  }

  async clear(): Promise<void> {
    this.records.clear();
    this.dimension = undefined;
  }
}
