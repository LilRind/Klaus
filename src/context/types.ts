/**
 * 上下文工程类型定义（对应书 9.3.2 核心数据结构）
 *
 * ContextPacket 是上下文的原子单元：所有上下文源（记忆/RAG/对话历史/笔记）
 * 都先转成 packet，再进入 GSSC 流水线统一打分、组装、压缩。
 */

export type ContextSourceType =
  | "memory"
  | "history"
  | "retrieved"
  | "note"
  | "custom";

export interface ContextPacket {
  /** packet 内容（进入提示词的文本） */
  content: string;
  /** 来源类型，决定 structure 阶段的分组 */
  type: ContextSourceType;
  /** 基础优先级 0-1（对应书 priority；score 的加权项之一） */
  priority: number;
  /** 时间戳（时近性打分用；无则视为"现在"） */
  timestamp?: string;
  /** 与当前查询的相关性（gather/调用方预估；select 阶段会复用） */
  relevance?: number;
  /** 来源标注（如 memory:working、note:note_xxx） */
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextConfigOptions {
  /** 上下文 token 预算上限（对应书 max_tokens，默认 4000） */
  maxTokens?: number;
  /** 给模型回答预留的预算比例（默认 0.15，对应书 reserve_ratio） */
  reserveRatio?: number;
  /** 相关性低于该值的 packet 被丢弃（默认 0.2，对应书 min_relevance） */
  minRelevance?: number;
  /** 超预算时是否启用压缩（默认 true） */
  enableCompression?: boolean;
  /** gather 阶段最多取多少条记忆候选（默认 10） */
  maxMemoryItems?: number;
  /** gather 阶段 RAG 检索 topK（默认 5） */
  maxRagItems?: number;
  /** 纳入的最近对话轮数（默认 8 条消息） */
  maxHistoryMessages?: number;
}

export class ContextConfig {
  readonly maxTokens: number;
  readonly reserveRatio: number;
  readonly minRelevance: number;
  readonly enableCompression: boolean;
  readonly maxMemoryItems: number;
  readonly maxRagItems: number;
  readonly maxHistoryMessages: number;

  constructor(options: ContextConfigOptions = {}) {
    this.maxTokens = options.maxTokens ?? 4000;
    this.reserveRatio = options.reserveRatio ?? 0.15;
    this.minRelevance = options.minRelevance ?? 0.2;
    this.enableCompression = options.enableCompression ?? true;
    this.maxMemoryItems = options.maxMemoryItems ?? 10;
    this.maxRagItems = options.maxRagItems ?? 5;
    this.maxHistoryMessages = options.maxHistoryMessages ?? 8;

    if (this.maxTokens <= 0) throw new Error("maxTokens 必须为正数");
    if (this.reserveRatio < 0 || this.reserveRatio >= 1) {
      throw new Error("reserveRatio 必须在 [0, 1) 区间");
    }
  }
}

/** build() 的返回：结构化上下文文本 + 实际入选的 packet（调试/测试用） */
export interface BuiltContext {
  /** 拼装完成的上下文文本（可直接放入 system prompt 或用户消息前缀） */
  context: string;
  /** select 阶段实际入选（可能被 compress 截断）的 packet，按最终顺序 */
  usedPackets: ContextPacket[];
  /** 估算 token 数（含压缩后） */
  tokenCount: number;
  /** 是否发生了压缩/截断 */
  compressed: boolean;
}

/**
 * 上下文记忆源契约：MemoryManager 天然满足（直接依赖，对应书 9.3 里
 * 持有 memory_tool 的角色——TS 版程序内调用走类型安全接口，不走 Tool 的
 * JSON 字符串协议）。
 */
export interface ContextMemorySource {
  searchMemories(input: {
    query: string;
    limit?: number;
  }): Promise<
    Array<{
      item: { id: string; content: string; importance: number; timestamp: string };
      memoryType: string;
      score: number;
    }>
  >;
}

/** 上下文 RAG 源契约：RAGPipeline.search 天然满足 */
export interface ContextRagSource {
  search(
    query: string,
    options?: { topK?: number },
  ): Promise<Array<{ content: string; source: string; score: number }>>;
}
