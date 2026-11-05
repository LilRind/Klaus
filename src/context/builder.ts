/**
 * ContextBuilder - 上下文构建器（对应书 9.3.3 GSSC 流水线）
 *
 * Gather:   从记忆源 / RAG 源 / 对话历史收集候选 ContextPacket
 * Select:   相关性 × 时近性 × 优先级加权打分，minRelevance 过滤 + token 预算贪心裁剪
 * Structure:按 memory / retrieved / history 分组渲染结构化文本
 * Compress: 超预算时按 packet 逐段截断，保最近对话、砍久远低分内容
 *
 * 与书的行为差异（详见《第9章剩余事项.md》）：
 * - 注入的是 MemoryManager/RAGPipeline 等类型安全源，而非 Tool 实例
 * - token 估算：CJK 1 字 ≈ 1 token，ASCII 1 词 ≈ 1 token（与第8章分块口径一致）
 */

import {
  ContextConfig,
  type BuiltContext,
  type ContextConfigOptions,
  type ContextMemorySource,
  type ContextPacket,
  type ContextRagSource,
} from "./types";
import type { Message } from "../core/message";

export interface ContextBuilderOptions {
  memorySource?: ContextMemorySource;
  ragSource?: ContextRagSource;
  config?: ContextConfigOptions | ContextConfig;
  /** 时近性衰减半衰期（天），默认 3 */
  recencyHalfLifeDays?: number;
  /** 打分权重（对应书 select 阶段），默认 0.6/0.3/0.1 */
  weights?: { relevance?: number; recency?: number; priority?: number };
}

export interface BuildContextInput {
  /** 当前用户查询（相关性打分基准） */
  query: string;
  /** 对话历史（最近优先，超出 maxHistoryMessages 截断） */
  history?: Message[];
  /** 额外候选 packet（如 NoteTool 检索结果，书 9.4.4 的集成路径） */
  extraPackets?: ContextPacket[];
  /** 额外已占用预算（如调用方已知 system prompt 长度） */
  reservedTokens?: number;
}

export class ContextBuilder {
  readonly config: ContextConfig;

  private readonly memorySource?: ContextMemorySource;
  private readonly ragSource?: ContextRagSource;
  private readonly halfLifeDays: number;
  private readonly weights: {
    relevance: number;
    recency: number;
    priority: number;
  };

  constructor(options: ContextBuilderOptions = {}) {
    this.config =
      options.config instanceof ContextConfig
        ? options.config
        : new ContextConfig(options.config);
    this.memorySource = options.memorySource;
    this.ragSource = options.ragSource;
    this.halfLifeDays = options.recencyHalfLifeDays ?? 3;
    const relevanceWeight = options.weights?.relevance ?? 0.6;
    const recencyWeight = options.weights?.recency ?? 0.3;
    const priorityWeight = options.weights?.priority ?? 0.1;
    const total = relevanceWeight + recencyWeight + priorityWeight;
    this.weights = {
      relevance: relevanceWeight / total,
      recency: recencyWeight / total,
      priority: priorityWeight / total,
    };
  }

  /** 构建上下文（GSSC 主入口，对应书 build_context） */
  async build(input: BuildContextInput): Promise<BuiltContext> {
    const packets = await this.gather(input);
    const budget = Math.max(
      100,
      Math.floor(this.config.maxTokens * (1 - this.config.reserveRatio)) -
        (input.reservedTokens ?? 0),
    );
    const selected = this.select(packets, budget);
    let text = this.structure(selected);
    let tokenCount = countTokens(text);
    let compressed = false;

    if (tokenCount > budget && this.config.enableCompression) {
      const result = this.compress(selected, budget);
      text = this.structure(result.packets);
      tokenCount = countTokens(text);
      compressed = true;
    }

    return { context: text, usedPackets: selected, tokenCount, compressed };
  }

  // ---------- Gather ----------

  /** 收集全部候选 packet（记忆 + RAG + 历史 + 调用方额外注入） */
  protected async gather(input: BuildContextInput): Promise<ContextPacket[]> {
    const packets: ContextPacket[] = [];

    if (this.memorySource) {
      try {
        const results = await this.memorySource.searchMemories({
          query: input.query,
          limit: this.config.maxMemoryItems,
        });
        for (const result of results) {
          packets.push({
            content: result.item.content,
            type: "memory",
            priority: clamp01(result.item.importance),
            timestamp: result.item.timestamp,
            relevance: clamp01(result.score),
            source: `memory:${result.memoryType}`,
            metadata: { id: result.item.id },
          });
        }
      } catch {
        // 记忆源不可用（如嵌入服务未配置）不阻断上下文构建，对应书容错
      }
    }

    if (this.ragSource) {
      try {
        const hits = await this.ragSource.search(input.query, {
          topK: this.config.maxRagItems,
        });
        for (const hit of hits) {
          packets.push({
            content: hit.content,
            type: "retrieved",
            priority: 0.5,
            relevance: clamp01(hit.score),
            source: `rag:${hit.source}`,
          });
        }
      } catch {
        // RAG 源不可用时降级为"无检索结果"
      }
    }

    const history = (input.history ?? []).slice(
      -this.config.maxHistoryMessages,
    );
    for (const message of history) {
      packets.push({
        content: `[${message.role}] ${message.content}`,
        type: "history",
        // 对话历史是"刚发生"的上下文：最高时近性 + 固定优先级
        priority: message.role === "user" ? 0.8 : 0.6,
        timestamp: message.timestamp.toISOString(),
        relevance: calculateRelevance(message.content, input.query),
      });
    }

    packets.push(...(input.extraPackets ?? []));
    return packets;
  }

  // ---------- Select ----------

  /** 打分 + 过滤 + 预算贪心（对应书 _select） */
  protected select(packets: ContextPacket[], budget: number): ContextPacket[] {
    const scored = packets
      .map((packet) => ({ packet, score: this.score(packet) }))
      // 历史消息保序（对话连贯性 > 分数），其余按分数降序
      .sort((a, b) => {
        if (a.packet.type === "history" && b.packet.type === "history") return 0;
        if (a.packet.type === "history") return -1;
        if (b.packet.type === "history") return 1;
        return b.score - a.score;
      });

    const minRelevance = this.config.minRelevance;
    const selected: ContextPacket[] = [];
    let used = 0;
    for (const { packet, score } of scored) {
      // 历史不受 minRelevance 门槛（否则早期对话会被误丢）
      if (packet.type !== "history" && score < minRelevance) continue;
      const cost = countTokens(packet.content);
      if (used + cost > budget && selected.length > 0) continue;
      selected.push({ ...packet, metadata: { ...packet.metadata, score } });
      used += cost;
    }
    return selected;
  }

  /** 相关性×时近性×优先性加权（对应书 9.3.3 打分公式） */
  protected score(packet: ContextPacket): number {
    const relevance = packet.relevance !== undefined ? packet.relevance : 0.5;
    return (
      this.weights.relevance * relevance +
      this.weights.recency * this.recency(packet.timestamp) +
      this.weights.priority * clamp01(packet.priority)
    );
  }

  /** 指数时近性衰减：半衰期内得分高，长期记忆按天衰减 */
  protected recency(timestamp?: string): number {
    if (!timestamp) return 0.5;
    const time = Date.parse(timestamp);
    if (Number.isNaN(time)) return 0.5;
    const ageDays = (Date.now() - time) / 86_400_000;
    return clamp01(Math.exp((-Math.LN2 * ageDays) / this.halfLifeDays));
  }

  // ---------- Structure ----------

  /** 分组渲染（对应书 _structure：history/memory/note/retrieved 四段式） */
  protected structure(packets: ContextPacket[]): string {
    const sections: string[] = [];
    const history = packets.filter((p) => p.type === "history");
    const memory = packets.filter((p) => p.type === "memory");
    const notes = packets.filter((p) => p.type === "note");
    const retrieved = packets.filter((p) => p.type === "retrieved");
    const custom = packets.filter((p) => p.type === "custom");

    if (history.length > 0) {
      sections.push(
        "## 对话历史\n" + history.map((p) => `- ${p.content}`).join("\n"),
      );
    }
    if (memory.length > 0) {
      sections.push(
        "## 相关记忆\n" +
          memory
            .map((p) => `- (${p.source ?? "memory"}) ${p.content}`)
            .join("\n"),
      );
    }
    if (notes.length > 0) {
      sections.push("## 项目笔记\n" + notes.map((p) => `- ${p.content}`).join("\n"));
    }
    if (retrieved.length > 0) {
      sections.push(
        "## 知识检索\n" +
          retrieved
            .map((p) => `- (来源: ${p.source ?? "rag"}) ${p.content}`)
            .join("\n"),
      );
    }
    if (custom.length > 0) {
      sections.push(
        "## 补充上下文\n" + custom.map((p) => `- ${p.content}`).join("\n"),
      );
    }

    if (sections.length === 0) {
      return "## 可用上下文\n（暂无相关记忆或历史，请直接基于当前问题回答）";
    }
    return sections.join("\n\n");
  }

  // ---------- Compress ----------

  /**
   * 压缩（对应书 _compress）：保留 packet 条目但逐段截断内容——
   * 牺牲顺序：retrieved → memory → note → custom → history（对话历史最后砍）。
   */
  protected compress(
    packets: ContextPacket[],
    budget: number,
  ): { packets: ContextPacket[] } {
    const sacrificeOrder: Record<string, number> = {
      retrieved: 0,
      memory: 1,
      note: 2,
      custom: 3,
      history: 4,
    };
    const ordered = [...packets].sort(
      (a, b) => (sacrificeOrder[a.type] ?? 0) - (sacrificeOrder[b.type] ?? 0),
    );
    const total = ordered.reduce((sum, p) => sum + countTokens(p.content), 0);
    let overflow = total - budget;

    for (const packet of ordered) {
      if (overflow <= 0) break;
      const cost = countTokens(packet.content);
      if (cost <= overflow) {
        overflow -= cost;
        packet.content = "（已省略：低优先级上下文）";
      } else {
        const keep = Math.max(0, cost - overflow);
        packet.content = `${truncateToTokens(packet.content, keep)}…（截断）`;
        overflow = 0;
      }
    }
    return { packets };
  }
}

// ---------- 工具函数 ----------

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * token 估算：CJK 字符 1 字 ≈ 1 token，ASCII 连续字母数字串 1 词 ≈ 1 token。
 * 与第8章 RAG 分块口径一致（书用 Python 侧近似，差异已记录）。
 */
export function countTokens(text: string): number {
  const cjk =
    text.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g)?.length ?? 0;
  const words = text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
  return cjk + words;
}

/** 按估算 token 数截断（字符粒度，宁少勿多） */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  let tokens = 0;
  const chars: string[] = [];
  const cjkPattern = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  const wordPattern = /[A-Za-z0-9]/;
  let inWord = false;
  for (const char of text) {
    if (cjkPattern.test(char)) {
      tokens += 1;
      inWord = false;
    } else if (wordPattern.test(char)) {
      if (!inWord) {
        tokens += 1;
        inWord = true;
      }
    } else {
      inWord = false;
    }
    if (tokens > maxTokens) break;
    chars.push(char);
  }
  return chars.join("").replace(/\s+$/, "");
}

/**
 * 关键词重叠相关性（0-1）：查询词在内容中的命中率。
 * 书里同样是非嵌入的关键词近似；语义级相关性由记忆源的 score 提供。
 */
export function calculateRelevance(content: string, query: string): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 0;
  const contentTerms = new Set(tokenize(content));
  let hits = 0;
  for (const term of queryTerms) {
    if (contentTerms.has(term)) hits += 1;
  }
  return hits / queryTerms.length;
}

/** 分词：ASCII 词 + CJK 单字（与 token 估算同口径） */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  for (const word of text.match(/[A-Za-z0-9]+/g) ?? []) {
    terms.push(word.toLowerCase());
  }
  for (const char of text.match(/[\u4e00-\u9fff]/g) ?? []) {
    terms.push(char);
  }
  return terms;
}
