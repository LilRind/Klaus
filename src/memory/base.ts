/**
 * 记忆系统基础层（对应书 8.1.4 memory/base.py）
 *
 * 三件事：
 * - MemoryItem：标准化记忆项（内容 + 类型 + 重要性 + 元数据），
 *   所有记忆类型、存储后端、工具层交换的都是这个结构；
 * - MemoryConfig：集中管理容量/TTL/存储路径等行为参数（沿用 core/config.ts 的理念）；
 * - BaseMemory：记忆类型基类，规定 add/retrieve 双方法契约。
 */

import { randomUUID } from "node:crypto";

/** 四种记忆类型（对应书 8.2.5） */
export type MemoryType = "working" | "episodic" | "semantic" | "perceptual";

export const MEMORY_TYPES: readonly MemoryType[] = [
  "working",
  "episodic",
  "semantic",
  "perceptual",
];

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

/** 可注入时钟（测试里把 TTL/时间衰减变成确定性的关键） */
export type Clock = () => Date;

export const defaultClock: Clock = () => new Date();

/** 标准化记忆项（对应书里的 MemoryItem dataclass） */
export interface MemoryItem {
  /** 全局唯一 ID（uuid，展示时截前 8 位） */
  id: string;
  content: string;
  memoryType: MemoryType;
  /** 重要性 0.0-1.0，参与检索权重与遗忘策略 */
  importance: number;
 /** ISO 时间戳 */
  timestamp: string;
  /** 任意附加信息（session_id / modality / event_type…） */
  metadata: Record<string, unknown>;
}

export interface CreateMemoryItemInput {
  content: string;
  memoryType: MemoryType;
  importance?: number;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  id?: string;
}

export function createMemoryItem(input: CreateMemoryItemInput): MemoryItem {
  if (input.content.trim().length === 0) {
    throw new Error("记忆内容不能为空");
  }
  const importance = input.importance ?? 0.5;
  if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
    throw new Error(`importance 必须在 [0, 1]，收到: ${String(importance)}`);
  }
  return {
    id: input.id ?? randomUUID(),
    content: input.content,
    memoryType: input.memoryType,
    importance,
    timestamp: input.timestamp ?? new Date().toISOString(),
    metadata: input.metadata ?? {},
  };
}

/** 记忆系统配置（对应书 MemoryConfig；存储注入参数见各后端构造函数） */
export interface MemoryConfigOptions {
  /** 工作记忆容量上限，默认 50 */
  workingMemoryCapacity?: number;
  /** 工作记忆 TTL（分钟），默认 60 */
  workingMemoryTtlMinutes?: number;
  /** SQLite 数据库路径，默认 ./memory_data/memory.db */
  databasePath?: string;
  /** Qdrant 服务地址（未配置时记忆类型必须注入存储实现） */
  qdrantUrl?: string;
  qdrantApiKey?: string;
  qdrantCollection?: string;
  /** Neo4j 连接信息 */
  neo4jUri?: string;
  neo4jUsername?: string;
  neo4jPassword?: string;
  /**
   * 嵌入服务类型：tfidf | dashscope | openai | ollama 等字符串。
   * 不设默认值——undefined 时工厂回落到 EMBED_MODEL_TYPE 环境变量，
   * 否则会盖掉用户在 .env 里的云端配置（配置优先级：显式 config > 环境变量）。
   */
  embedModelType?: string;
  embedModelName?: string;
  embedApiKey?: string;
  embedBaseUrl?: string;
}

export class MemoryConfig {
  readonly workingMemoryCapacity: number;
  readonly workingMemoryTtlMinutes: number;
  readonly databasePath: string;
  readonly qdrantUrl?: string;
  readonly qdrantApiKey?: string;
  readonly qdrantCollection: string;
  readonly neo4jUri?: string;
  readonly neo4jUsername?: string;
  readonly neo4jPassword?: string;
  readonly embedModelType: string | undefined;
  readonly embedModelName?: string;
  readonly embedApiKey?: string;
  readonly embedBaseUrl?: string;

  constructor(options: MemoryConfigOptions = {}) {
    this.workingMemoryCapacity = positiveInt(
      options.workingMemoryCapacity,
      50,
      "workingMemoryCapacity",
    );
    this.workingMemoryTtlMinutes = positiveInt(
      options.workingMemoryTtlMinutes,
      60,
      "workingMemoryTtlMinutes",
    );
    this.databasePath = options.databasePath ?? "./memory_data/memory.db";
    this.qdrantUrl = options.qdrantUrl;
    this.qdrantApiKey = options.qdrantApiKey;
    this.qdrantCollection = options.qdrantCollection ?? "hello_agents_vectors";
    this.neo4jUri = options.neo4jUri;
    this.neo4jUsername = options.neo4jUsername;
    this.neo4jPassword = options.neo4jPassword;
    this.embedModelType = options.embedModelType;
    this.embedModelName = options.embedModelName;
    this.embedApiKey = options.embedApiKey;
    this.embedBaseUrl = options.embedBaseUrl;
  }
}

/** 检索结果：记忆项 + 来源类型 + 相关性得分（跨类型合并排序用） */
export interface MemorySearchResult {
  item: MemoryItem;
  memoryType: MemoryType;
  score: number;
}

/** 记忆类型基类契约：统一 add / retrieve + 管理操作（对应书 BaseMemory） */
export abstract class BaseMemory {
  constructor(
    protected readonly config: MemoryConfig,
    protected readonly clock: Clock = defaultClock,
  ) {}

  abstract add(item: MemoryItem): Promise<string>;

  abstract retrieve(
    query: string,
    limit?: number,
    options?: MemoryRetrieveOptions,
  ): Promise<MemorySearchResult[]>;

  /** 管理面：按 ID 取 / 全量列表（forget/stats/consolidate 需要） */
  abstract get(id: string): Promise<MemoryItem | undefined>;
  abstract list(options?: MemoryListOptions): Promise<MemoryItem[]>;

  abstract update(
    id: string,
    updates: Partial<Pick<MemoryItem, "content" | "importance" | "metadata">>,
  ): Promise<boolean>;

  abstract remove(id: string): Promise<boolean>;
  abstract clear(): Promise<void>;

  /** 时间近因性：指数衰减，24h 内保持高分（对应书 _calculate_recency_score） */
  protected calculateRecencyScore(timestamp: string): number {
    const memoryTime = Date.parse(timestamp);
    if (Number.isNaN(memoryTime)) return 0.5;
    const ageHours = (this.clock().getTime() - memoryTime) / 3_600_000;
    const recency = Math.exp((-0.1 * ageHours) / 24);
    return Math.max(0.1, recency);
  }

  /** 重要性权重 [0.8, 1.2]：避免重要性压过相似度本身（对应书 8.2.5 公式） */
  protected importanceWeight(importance: number): number {
    return 0.8 + importance * 0.4;
  }
}

/** retrieve 附加条件（情景/感知的结构化过滤） */
export interface MemoryRetrieveOptions {
  userId?: string;
  sessionId?: string;
  minImportance?: number;
  /** 感知记忆：目标模态 */
  modality?: string;
}

/** list 过滤条件 */
export interface MemoryListOptions {
  memoryType?: MemoryType;
  userId?: string;
  sessionId?: string;
  minImportance?: number;
  /** ISO 时间下界 */
  since?: string;
  /** ISO 时间上界 */
  until?: string;
  modality?: string;
}

function positiveInt(
  value: number | undefined,
  fallback: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} 必须是正整数，收到: ${String(value)}`);
  }
  return value;
}
