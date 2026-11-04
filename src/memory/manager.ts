/**
 * 记忆管理器（对应书 8.2.4 memory/manager.py）
 *
 * 统一调度四种记忆类型：add/search/update/remove/forget/consolidate/stats。
 * MemoryTool 只做参数解析与格式化，业务逻辑全部在这里——
 * 这是书里"关注点分离"的关键一层。
 * 存储组件可注入：测试传内存桩零网络，生产走 Qdrant/Neo4j/SQLite 默认装配。
 */

import {
  MEMORY_TYPES,
  MemoryConfig,
  createMemoryItem,
  isMemoryType,
  type Clock,
  type MemoryItem,
  type MemoryListOptions,
  type MemorySearchResult,
  type MemoryType,
  defaultClock,
} from "./base";
import { createEmbeddingService, type EmbeddingService } from "./embedding";
import type { DocumentStore } from "./storage/document-store";
import type { GraphStore } from "./storage/graph-store";
import type { VectorStore } from "./storage/vector-store";
import {
  createDefaultDocumentStore,
  createDefaultGraphStore,
  createDefaultVectorStore,
} from "./storage/factories";
import { EpisodicMemory } from "./types/episodic";
import { PerceptualMemory } from "./types/perceptual";
import { SemanticMemory } from "./types/semantic";
import type { EntityExtractor } from "./types/semantic";
import { WorkingMemory } from "./types/working";

export interface MemoryManagerOptions {
  userId?: string;
  enableWorking?: boolean;
  enableEpisodic?: boolean;
  enableSemantic?: boolean;
  enablePerceptual?: boolean;
  config?: MemoryConfig;
  clock?: Clock;
  embedder?: EmbeddingService;
  vectorStore?: VectorStore;
  graphStore?: GraphStore;
  documentStore?: DocumentStore;
  /** 语义记忆的实体抽取器（默认规则器；可注入 LLMEntityExtractor 并随时开关） */
  entityExtractor?: EntityExtractor;
}

export interface AddMemoryInput {
  content: string;
  memoryType?: MemoryType | string;
  importance?: number;
  /** 显式指定时间戳（默认当前时间；time_based 遗忘测试/回灌数据用） */
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchMemoriesInput {
  query: string;
  limit?: number;
  /** 不传 = 查全部启用类型 */
  memoryTypes?: MemoryType[];
  minImportance?: number;
  userId?: string;
  sessionId?: string;
  modality?: string;
}

export type ForgetStrategy = "importance_based" | "time_based" | "capacity_based";

export interface ForgetOptions {
  strategy: ForgetStrategy;
  /** importance_based：删除重要性低于该值的记忆（默认 0.2） */
  threshold?: number;
  /** time_based：删除超过该天数的记忆（默认 30） */
  maxAgeDays?: number;
  /** capacity_based：每类记忆超过该数量时删除最不重要的（默认 50） */
  maxCount?: number;
  /** 限定作用的记忆类型，不传 = 全部启用类型 */
  memoryTypes?: MemoryType[];
}

export interface MemoryStats {
  userId: string;
  total: number;
  byType: Record<MemoryType, number>;
}

export interface ConsolidateOptions {
  fromType?: MemoryType | string;
  toType?: MemoryType | string;
  /** 只有重要性 ≥ 该值的记忆会被提升（默认 0.7） */
  importanceThreshold?: number;
}

export class MemoryManager {
  readonly userId: string;
  readonly config: MemoryConfig;

  private readonly memories = new Map<MemoryType, WorkingMemory | EpisodicMemory | SemanticMemory | PerceptualMemory>();
  private readonly clock: Clock;
  private readonly embedder: EmbeddingService;
  private readonly vectorStore: VectorStore;
  private readonly graphStore: GraphStore;
  private readonly documentStore: DocumentStore;
  private readonly ownedStores: boolean;

  constructor(options: MemoryManagerOptions = {}) {
    this.userId = options.userId ?? "default_user";
    this.config = options.config ?? new MemoryConfig();
    this.clock = options.clock ?? defaultClock;

    const enableWorking = options.enableWorking ?? true;
    const enableEpisodic = options.enableEpisodic ?? true;
    const enableSemantic = options.enableSemantic ?? true;
    const enablePerceptual = options.enablePerceptual ?? false;

    this.embedder = options.embedder ?? createEmbeddingService({ config: this.config });
    // 默认装配工厂：.env 配了 Qdrant/Neo4j 就连真实库，否则进程内兜底
    this.vectorStore = options.vectorStore ?? createDefaultVectorStore({ config: this.config });
    this.graphStore = options.graphStore ?? createDefaultGraphStore({ config: this.config });
    this.documentStore = options.documentStore ?? createDefaultDocumentStore({ config: this.config });
    this.ownedStores = !options.vectorStore && !options.documentStore;

    if (enableWorking) {
      this.memories.set(
        "working",
        new WorkingMemory({ config: this.config, clock: this.clock }),
      );
    }
    if (enableEpisodic) {
      this.memories.set(
        "episodic",
        new EpisodicMemory({
          config: this.config,
          clock: this.clock,
          documentStore: this.documentStore,
          vectorStore: this.vectorStore,
          embedder: this.embedder,
        }),
      );
    }
    if (enableSemantic) {
      this.memories.set(
        "semantic",
        new SemanticMemory({
          config: this.config,
          clock: this.clock,
          vectorStore: this.vectorStore,
          graphStore: this.graphStore,
          embedder: this.embedder,
          extractor: options.entityExtractor,
        }),
      );
    }
    if (enablePerceptual) {
      this.memories.set(
        "perceptual",
        new PerceptualMemory({
          config: this.config,
          clock: this.clock,
          documentStore: this.documentStore,
          vectorStore: this.vectorStore,
          embedder: this.embedder,
        }),
      );
    }
  }

  get enabledTypes(): MemoryType[] {
    return MEMORY_TYPES.filter((type) => this.memories.has(type));
  }

  isEnabled(type: MemoryType): boolean {
    return this.memories.has(type);
  }

  /** 统一写入入口（对应书 add_memory） */
  async addMemory(input: AddMemoryInput): Promise<string> {
    const memoryType = resolveMemoryType(input.memoryType ?? "working");
    const module = this.requireModule(memoryType);
    const item = createMemoryItem({
      content: input.content,
      memoryType,
      importance: input.importance,
      timestamp: input.timestamp,
      metadata: {
        ...input.metadata,
        user_id: (input.metadata?.user_id as string | undefined) ?? this.userId,
      },
    });
    return module.add(item);
  }

  /** 跨类型搜索：逐类型检索 → 按得分合并排序（对应书 search_memories） */
  async searchMemories(input: SearchMemoriesInput): Promise<MemorySearchResult[]> {
    const limit = input.limit ?? 5;
    const types = input.memoryTypes?.length
      ? input.memoryTypes
      : this.enabledTypes;

    const merged: MemorySearchResult[] = [];
    const seen = new Set<string>();
    for (const type of types) {
      const module = this.memories.get(type);
      if (!module) continue;
      const results = await module.retrieve(input.query, limit, {
        userId: input.userId,
        sessionId: input.sessionId,
        minImportance: input.minImportance,
        modality: input.modality,
      });
      for (const result of results) {
        if (seen.has(result.item.id)) continue;
        seen.add(result.item.id);
        merged.push(result);
      }
    }
    merged.sort((a, b) => b.score - a.score);
    return merged.slice(0, limit);
  }

  async updateMemory(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean> {
    const module = await this.findOwner(id);
    return module ? module.update(id, updates) : false;
  }

  async removeMemory(id: string): Promise<boolean> {
    const module = await this.findOwner(id);
    return module ? module.remove(id) : false;
  }

  /** 遗忘策略三连（对应书 forget：importance/time/capacity_based） */
  async forgetMemories(options: ForgetOptions): Promise<number> {
    const types = options.memoryTypes?.length
      ? options.memoryTypes
      : this.enabledTypes;
    let removed = 0;

    for (const type of types) {
      const module = this.memories.get(type);
      if (!module) continue;

      if (options.strategy === "importance_based") {
        const threshold = options.threshold ?? 0.2;
        for (const item of await module.list()) {
          if (item.importance < threshold && (await module.remove(item.id))) {
            removed += 1;
          }
        }
      } else if (options.strategy === "time_based") {
        const maxAgeDays = options.maxAgeDays ?? 30;
        const deadline = this.clock().getTime() - maxAgeDays * 86_400_000;
        for (const item of await module.list()) {
          const time = Date.parse(item.timestamp);
          if (!Number.isNaN(time) && time < deadline && (await module.remove(item.id))) {
            removed += 1;
          }
        }
      } else {
        const maxCount = options.maxCount ?? this.config.workingMemoryCapacity;
        const items = (await module.list()).sort(
          (a, b) => b.importance - a.importance,
        );
        for (const item of items.slice(maxCount)) {
          if (await module.remove(item.id)) removed += 1;
        }
      }
    }
    return removed;
  }

  /**
   * 记忆固化（对应书 consolidate_memories）：
   * 重要性达标的记忆从源类型"移动"到目标类型（短期→长期提升）。
   */
  async consolidateMemories(options: ConsolidateOptions = {}): Promise<number> {
    const fromType = resolveMemoryType(options.fromType ?? "working");
    const toType = resolveMemoryType(options.toType ?? "episodic");
    const threshold = options.importanceThreshold ?? 0.7;
    const source = this.requireModule(fromType);
    const target = this.requireModule(toType);

    let count = 0;
    for (const item of await source.list({ memoryType: fromType })) {
      if (item.importance < threshold) continue;
      // 先删后加：共享向量库时避免 target.add 的新记录被 source.remove 误删
      await source.remove(item.id);
      await target.add({
        ...item,
        memoryType: toType,
        metadata: {
          ...item.metadata,
          consolidated_from: fromType,
          consolidated_at: this.clock().toISOString(),
        },
      });
      count += 1;
    }
    return count;
  }

  async getStats(): Promise<MemoryStats> {
    const byType = {
      working: 0,
      episodic: 0,
      semantic: 0,
      perceptual: 0,
    } as Record<MemoryType, number>;
    let total = 0;
    for (const [type, module] of this.memories) {
      const count = (await module.list({ memoryType: type })).length;
      byType[type] = count;
      total += count;
    }
    return { userId: this.userId, total, byType };
  }

  /** 文本摘要：逐类型列出最近记忆（对应书 _get_summary 的渲染） */
  async getSummary(limitPerType = 3): Promise<string> {
    const stats = await this.getStats();
    const lines: string[] = [
      `用户 ${this.userId} 的记忆摘要（共 ${stats.total} 条）`,
    ];
    for (const type of this.enabledTypes) {
      const module = this.memories.get(type)!;
      const items = (await module.list({ memoryType: type }))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
        .slice(0, limitPerType);
      lines.push(
        `\n[${type}] ${stats.byType[type]} 条` +
          (items.length
            ? items
                .map(
                  (item) =>
                    `\n  • (${item.importance.toFixed(1)}) ${truncate(item.content, 60)}`,
                )
                .join("")
            : "\n  （空）"),
      );
    }
    return lines.join("\n");
  }

  async clearAll(): Promise<void> {
    for (const module of this.memories.values()) {
      await module.clear();
    }
  }

  async listMemories(
    options?: MemoryListOptions & { memoryTypes?: MemoryType[] },
  ): Promise<MemoryItem[]> {
    const types = options?.memoryTypes?.length
      ? options.memoryTypes
      : this.enabledTypes;
    const items: MemoryItem[] = [];
    for (const type of types) {
      const module = this.memories.get(type);
      if (!module) continue;
      items.push(...(await module.list({ ...options, memoryType: type })));
    }
    return items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  /** 释放底层连接（向量库/图库/SQLite） */
  async close(): Promise<void> {
    if (!this.ownedStores) return;
    await this.vectorStore.close?.();
    await this.graphStore.close?.();
    await this.documentStore.close?.();
  }

  private async findOwner(id: string) {
    for (const module of this.memories.values()) {
      if (await module.get(id)) return module;
    }
    return undefined;
  }

  private requireModule(type: MemoryType) {
    const module = this.memories.get(type);
    if (!module) {
      throw new Error(
        `记忆类型 ${type} 未启用，启用类型: ${this.enabledTypes.join(", ")}`,
      );
    }
    return module;
  }
}

function resolveMemoryType(value: MemoryType | string): MemoryType {
  if (isMemoryType(value)) return value;
  throw new Error(
    `未知记忆类型: ${String(value)}，合法值: ${MEMORY_TYPES.join(" | ")}`,
  );
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
