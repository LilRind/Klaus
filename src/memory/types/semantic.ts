/**
 * 语义记忆（对应书 8.2.5-(3) memory/types/semantic.py）
 *
 * 双库混合：VectorStore 语义相似检索 + GraphStore 知识图谱关系推理，
 * 混合排序公式（书 8.2.5）：(向量 × 0.7 + 图 × 0.3) × (0.8 + 重要性 × 0.4)。
 * 实体抽取：书里用 spaCy（zh/en 模型），那是 Python 生态——TS 侧用
 * 确定性规则抽取器等价替代（引号术语/中文专名/英文大写词/共现关系），
 * 并以 EntityExtractor 接口暴露，随时可换成 LLM 抽取。
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
import type { GraphStore } from "../storage/graph-store";
import type { VectorStore } from "../storage/vector-store";

// ---------------------------------------------------------------------------
// 实体与关系抽取（spaCy 的确定性替身）
// ---------------------------------------------------------------------------

export interface ExtractedEntity {
  name: string;
  type: string;
}

export interface ExtractedRelation {
  sourceName: string;
  targetName: string;
  relation: string;
}

export interface EntityExtractor {
  extract(content: string): {
    entities: ExtractedEntity[];
    relations: ExtractedRelation[];
  };
}

/** 规则抽取器：中文术语 + 英文专名 + 句内共现 RELATED_TO */
export class RuleBasedEntityExtractor implements EntityExtractor {
  extract(content: string): {
    entities: ExtractedEntity[];
    relations: ExtractedRelation[];
  } {
    const entities = extractEntities(content);
    const relations: ExtractedRelation[] = [];

    // 同一句子内共现的实体对建立 RELATED_TO（书里 _extract_relations 的简化）
    const sentences = content
      .split(/[。！？；!?.]+/)
      .filter((sentence) => sentence.trim().length > 0);
    for (const sentence of sentences) {
      const present = entities.filter((entity) =>
        sentence.toLowerCase().includes(entity.name.toLowerCase()),
      );
      for (let i = 0; i < present.length; i++) {
        for (let j = i + 1; j < present.length; j++) {
          const source = present[i];
          const target = present[j];
          if (!source || !target) continue;
          relations.push({
            sourceName: source.name,
            targetName: target.name,
            relation: "RELATED_TO",
          });
        }
      }
    }
    return { entities, relations };
  }
}

/** 实体识别规则：引号术语 > 中文书名号 > 英文连续大写词 */
function extractEntities(content: string): ExtractedEntity[] {
  const found = new Map<string, ExtractedEntity>();

  const add = (name: string | undefined, type: string) => {
    if (name === undefined) return;
    const trimmed = name.trim();
    if (trimmed.length < 2 || trimmed.length > 32) return;
    if (!found.has(trimmed)) found.set(trimmed, { name: trimmed, type });
  };

  // 引号内术语（中英文引号）
  for (const match of content.matchAll(/[“"『]([^”"』]{2,32})[”"』]/g)) {
    add(match[1], "TERM");
  }
  // 中文书名号
  for (const match of content.matchAll(/《([^》]{2,32})》/g)) {
    add(match[1], "WORK");
  }
  // 英文大写开头的词序列（Python / TypeScript / HelloAgents…）
  for (const match of content.matchAll(/\b[A-Z][A-Za-z0-9+#.-]{1,31}\b/g)) {
    add(match[0], "CONCEPT");
  }
  // 中文"叫做/称为/是"引出的术语
  for (const match of content.matchAll(/(?:叫做|称为|是)([\u4e00-\u9fff]{2,8})/g)) {
    add(match[1], "TERM");
  }

  return [...found.values()];
}

// ---------------------------------------------------------------------------
// 语义记忆
// ---------------------------------------------------------------------------

export interface SemanticMemoryOptions {
  config?: MemoryConfig;
  clock?: Clock;
  vectorStore: VectorStore;
  graphStore: GraphStore;
  embedder: EmbeddingService;
  extractor?: EntityExtractor;
}

export class SemanticMemory extends BaseMemory {
  private readonly vectors: VectorStore;
  private readonly graph: GraphStore;
  private readonly embedder: EmbeddingService;
  private readonly extractor: EntityExtractor;
  private collectionReady = false;

  constructor(options: SemanticMemoryOptions) {
    super(options.config ?? new MemoryConfig(), options.clock ?? defaultClock);
    this.vectors = options.vectorStore;
    this.graph = options.graphStore;
    this.embedder = options.embedder;
    this.extractor = options.extractor ?? new RuleBasedEntityExtractor();
  }

  async add(item: MemoryItem): Promise<string> {
    if (!this.collectionReady) {
      await this.vectors.ensureCollection(this.embedder.dimension);
      this.collectionReady = true;
    }
    const embedding = await embedOne(this.embedder, item.content);
    const { entities, relations } = this.extractor.extract(item.content);

    // 图谱写入：实体挂 memoryIds，关系带来源
    for (const entity of entities) {
      await this.graph.addEntity({
        name: entity.name,
        type: entity.type,
        memoryIds: [item.id],
      });
    }
    for (const relation of relations) {
      await this.graph.addRelation({
        sourceName: relation.sourceName,
        targetName: relation.targetName,
        relation: relation.relation,
        memoryId: item.id,
      });
    }

    // 向量写入：payload 带实体清单，命中后可重建记忆项
    await this.vectors.upsert([
      {
        id: item.id,
        vector: embedding,
        metadata: {
          ...item.metadata,
          memory_id: item.id,
          memory_type: "semantic",
          content: item.content,
          importance: item.importance,
          timestamp: item.timestamp,
          entities: entities.map((entity) => entity.name),
          entity_count: entities.length,
          relation_count: relations.length,
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
    // 1) 向量检索（扩大候选池）
    const queryVector = await embedOne(this.embedder, query);
    const vectorHits = await this.vectors.search(queryVector, {
      limit: limit * 2,
      filter: { memory_type: "semantic" },
    });

    // 2) 图检索：查询实体 → 关联记忆 ID → 从向量库取记录
    const { entities: queryEntities } = this.extractor.extract(query);
    const queryEntityNames = new Set(queryEntities.map((entity) => entity.name));
    const graphMemoryIds = queryEntityNames.size
      ? await this.graph.getMemoryIdsForEntities([...queryEntityNames])
      : [];

    const graphRecords = new Map<string, Record<string, unknown>>();
    for (const memoryId of graphMemoryIds) {
      if (vectorHits.some((hit) => hit.id === memoryId)) continue;
      const record = await this.vectors.getById(memoryId);
      if (record?.metadata.memory_type === "semantic") {
        graphRecords.set(memoryId, record.metadata);
      }
    }

    // 3) 合并评分（书 _combine_and_rank_results）
    const combined = new Map<
      string,
      {
        metadata: Record<string, unknown>;
        vectorScore: number;
        graphScore: number;
      }
    >();
    for (const hit of vectorHits) {
      combined.set(hit.id, {
        metadata: hit.metadata,
        vectorScore: hit.score,
        graphScore: 0,
      });
    }
    for (const [memoryId, metadata] of graphRecords) {
      combined.set(memoryId, { metadata, vectorScore: 0, graphScore: 0 });
    }

    // 图得分：查询实体与记忆实体的重合率
    for (const entry of combined.values()) {
      const memoryEntities = new Set(
        (entry.metadata.entities as string[] | undefined) ?? [],
      );
      if (queryEntityNames.size === 0 || memoryEntities.size === 0) continue;
      let overlap = 0;
      for (const name of queryEntityNames) {
        if (memoryEntities.has(name)) overlap += 1;
      }
      entry.graphScore = overlap / queryEntityNames.size;
    }

    const results: MemorySearchResult[] = [];
    for (const [memoryId, entry] of combined) {
      const item = this.itemFromMetadata(memoryId, entry.metadata);
      if (!item) continue;
      if (!this.matchesOptions(item, options)) continue;

      const baseRelevance = entry.vectorScore * 0.7 + entry.graphScore * 0.3;
      const importance =
        (entry.metadata.importance as number | undefined) ?? item.importance;
      results.push({
        item,
        memoryType: "semantic",
        score: baseRelevance * this.importanceWeight(importance),
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  async get(id: string): Promise<MemoryItem | undefined> {
    const record = await this.vectors.getById(id);
    return record ? this.itemFromMetadata(id, record.metadata) : undefined;
  }

  async list(options?: MemoryListOptions): Promise<MemoryItem[]> {
    // 语义记忆以向量库为唯一事实源（payload 含全部字段）——含无实体的记忆
    const records = await this.vectors.list({ memory_type: "semantic" });
    return records
      .map((record) => this.itemFromMetadata(record.id, record.metadata))
      .filter((item): item is MemoryItem => item !== undefined)
      .filter((item) => this.matchesList(item, options))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    const updated: MemoryItem = { ...existing, ...updates };
    // 重新走 add 全流程（重嵌入 + 重建图谱关联），等价覆盖
    await this.remove(id);
    await this.add(updated);
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.get(id);
    if (!existing) return false;
    await this.vectors.delete([id]);
    // 级联清理图谱引用（实体数组元素 + 来源关系），否则留下悬挂 memoryIds
    await this.graph.removeMemoryAssociations(id);
    return true;
  }

  async clear(): Promise<void> {
    for (const item of await this.list()) {
      await this.vectors.delete([item.id]);
    }
    await this.graph.clear();
    this.collectionReady = false;
  }

  private itemFromMetadata(
    id: string,
    metadata: Record<string, unknown>,
  ): MemoryItem | undefined {
    if (typeof metadata.content !== "string") return undefined;
    return {
      id,
      content: metadata.content,
      memoryType: "semantic",
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

  private matchesList(
    item: MemoryItem,
    options: MemoryListOptions | undefined,
  ): boolean {
    if (!this.matchesOptions(item, options)) return false;
    if (options?.memoryType && options.memoryType !== "semantic") return false;
    if (options?.sessionId && item.metadata.session_id !== options.sessionId) {
      return false;
    }
    if (options?.since && item.timestamp < options.since) return false;
    if (options?.until && item.timestamp > options.until) return false;
    return true;
  }
}
