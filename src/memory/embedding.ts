/**
 * 统一嵌入服务（对应书 8.1.4 memory/embedding.py）
 *
 * 记忆系统和 RAG 系统共用一层嵌入表示。与书的三级方案对应：
 * - OpenAICompatEmbedding：云端嵌入（DashScope compatible-mode / OpenAI / SiliconFlow…），
 *   对应书里的 DashScopeEmbedding——通义 text-embedding-v3 就是 OpenAI 兼容端点；
 * - TFIDFEmbedding：轻量级兜底，零网络零模型下载，对应书里的 TFIDFEmbedding。
 *   书里还有本地 sentence-transformers 一档，那是 Python 生态的模型推理，
 *   TS 侧等价物是 Ollama 的 /v1/embeddings（走 OpenAICompatEmbedding 即可）。
 */

import OpenAI from "openai";
import type { MemoryConfig } from "./base";

/** 嵌入服务契约：批量文本 → 等长向量 */
export interface EmbeddingService {
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** 环境变量来源（测试可注入，不直接耦合 process.env，沿用 llm.ts 的手法） */
export type EmbeddingEnvSource = Record<string, string | undefined>;

// ---------------------------------------------------------------------------
// 降级提醒（约定：任何使用本地 TFIDF 兜底的地方都必须明确告知用户）
// ---------------------------------------------------------------------------

const warnedReasons = new Set<string>();

/**
 * 嵌入降级警告（同一原因只提醒一次，console.warn 走 stderr 不污染结果输出）。
 * TFIDF 是词法嵌入（词项权重统计），不是云端语义嵌入——检索质量有本质差距，
 * 用户有权第一时间知道"当前不是云端 RAG Embedding"。
 */
export function warnEmbeddingDegraded(reason: string, detail?: string): void {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  const message =
    `⚠️ [Embedding 降级] ${reason}` +
    (detail ? `（${detail}）` : "") +
    " —— 当前使用本地 TFIDF 词法嵌入，不是云端语义嵌入，记忆/RAG 检索质量会下降。" +
    "在 .env 配置 EMBED_MODEL_TYPE / EMBED_API_KEY / EMBED_BASE_URL 可启用云端嵌入。";
  console.warn(message);
}

/** 测试用：清空警告去重状态 */
export function resetEmbeddingWarnings(): void {
  warnedReasons.clear();
}

// ---------------------------------------------------------------------------
// TFIDF 嵌入（离线兜底）
// ---------------------------------------------------------------------------

const CJK_RANGE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 分词：CJK 单字 + 相邻二元组（中文最小语义单元），拉丁词整体小写 */
export function tokenizeForEmbedding(text: string): string[] {
  const tokens: string[] = [];
  const latinBuffer: string[] = [];

  const flushLatin = () => {
    if (latinBuffer.length > 0) {
      tokens.push(latinBuffer.join(""));
      latinBuffer.length = 0;
    }
  };

  let previousCjk = "";
  for (const ch of text.toLowerCase()) {
    if (CJK_RANGE.test(ch)) {
      flushLatin();
      tokens.push(ch);
      if (previousCjk) tokens.push(previousCjk + ch);
      previousCjk = ch;
    } else if (/[a-z0-9]/.test(ch)) {
      previousCjk = "";
      latinBuffer.push(ch);
    } else {
      flushLatin();
      previousCjk = "";
    }
  }
  flushLatin();
  return tokens;
}

/** 字符串 → [0, dimension) 的稳定散列（FNV-1a 32bit） */
function hashToIndex(term: string, dimension: number): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    hash ^= term.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % dimension;
}

/**
 * TF-IDF 词法嵌入：
 * - 固定维度 + 散列技巧（hashing trick），不需要预扫全语料建词表，
 *   增量写入/查询维度恒一致；
 * - 增量维护文档频率：每次 embed 的文本都计入语料，IDF 随语料生长，
 *   权重 = (1 + ln tf) × (ln((N+1)/(df+1)) + 1)，最后 L2 归一化。
 * 它是词法相似度，不是稠密语义嵌入——定位和书里的 TFIDF 兜底一致。
 */
export class TFIDFEmbedding implements EmbeddingService {
  readonly dimension: number;

  private corpusSize = 0;
  private readonly documentFrequency = new Map<string, number>();

  constructor(dimension = 512) {
    if (!Number.isInteger(dimension) || dimension <= 0) {
      throw new Error(`dimension 必须是正整数，收到: ${String(dimension)}`);
    }
    this.dimension = dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  /**
   * 查询向量化：只编码、不把查询计入语料（否则查询越多 IDF 越漂移）。
   * 记忆类型 add 时用 embed()，retrieve 时用 embedQuery()。
   */
  embedQuery(text: string): number[] {
    const tokens = tokenizeForEmbedding(text);
    const vector = new Array<number>(this.dimension).fill(0);
    if (tokens.length === 0) return vector;

    const termFrequency = new Map<string, number>();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }
    // 查询自身不入语料，但公式分母 +1 平滑
    const n = this.corpusSize + 1;
    for (const [term, tf] of termFrequency) {
      const df = this.documentFrequency.get(term) ?? 0;
      const idf = Math.log(n / (df + 1)) + 1;
      const weight = (1 + Math.log(tf)) * idf;
      const index = hashToIndex(term, this.dimension);
      vector[index] = (vector[index] ?? 0) + weight;
    }
    return l2Normalize(vector);
  }

  /** 语料统计快照（测试/调试用） */
  stats(): { corpusSize: number; vocabulary: number } {
    return {
      corpusSize: this.corpusSize,
      vocabulary: this.documentFrequency.size,
    };
  }

  private embedOne(text: string): number[] {
    const tokens = tokenizeForEmbedding(text);
    const vector = new Array<number>(this.dimension).fill(0);
    if (tokens.length === 0) return vector;

    // 词频
    const termFrequency = new Map<string, number>();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) ?? 0) + 1);
    }

    // 当前语料 IDF（先算权重，再把本文档计入语料——保证训练一致性）
    const n = this.corpusSize + 1;
    for (const [term, tf] of termFrequency) {
      const df = this.documentFrequency.get(term) ?? 0;
      const idf = Math.log(n / (df + 1)) + 1;
      const weight = (1 + Math.log(tf)) * idf;
      const index = hashToIndex(term, this.dimension);
      vector[index] = (vector[index] ?? 0) + weight;
    }

    // 计入语料（文档级去重：同一 term 只 +1）
    this.corpusSize += 1;
    for (const term of termFrequency.keys()) {
      this.documentFrequency.set(
        term,
        (this.documentFrequency.get(term) ?? 0) + 1,
      );
    }

    return l2Normalize(vector);
  }
}

// ---------------------------------------------------------------------------
// OpenAI 兼容云端嵌入
// ---------------------------------------------------------------------------

export interface OpenAICompatEmbeddingOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** 输出维度（部分服务支持 dimensions 参数；不同模型默认维度不同） */
  dimension?: number;
  timeoutMs?: number;
  /** 复用外部 OpenAI 客户端（测试注入桩） */
  client?: Pick<OpenAI, "embeddings">;
}

/**
 * OpenAI 兼容端点嵌入（对应书 DashScopeEmbedding）。
 * DashScope 的 compatible-mode、OpenAI、SiliconFlow、Ollama /v1 都是同一协议，
 * 所以一个实现覆盖书的"云端"一档。
 */
export class OpenAICompatEmbedding implements EmbeddingService {
  readonly dimension: number;

  private readonly client: Pick<OpenAI, "embeddings">;
  private readonly model: string;
  private readonly requestDimension?: number;

  constructor(options: OpenAICompatEmbeddingOptions) {
    this.model = options.model;
    this.dimension = options.dimension ?? 1024;
    this.requestDimension = options.dimension;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        timeout: options.timeoutMs ?? 60_000,
      });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      ...(this.requestDimension ? { dimensions: this.requestDimension } : {}),
    });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

// ---------------------------------------------------------------------------
// 运行时降级链（对应书 create_embedding_model_with_fallback）
// ---------------------------------------------------------------------------

/**
 * 云端嵌入 → TFIDF 的运行时兜底：
 * - 首次失败时提醒"已降级"，之后静默兜底（不刷屏）；
 * - 云端恢复时提醒"已恢复"；
 * - TFIDF 维度对齐主服务（散列技巧支持任意维度），降级向量仍能进同一集合。
 * 注意：云端向量与 TFIDF 向量空间不同，降级前入库的文档可能召回不准——
 * 这是降级保可用的固有代价，提醒文案里已明确告知。
 */
export class FallbackEmbedding implements EmbeddingService {
  readonly dimension: number;

  private readonly fallback: TFIDFEmbedding;
  private degraded = false;

  constructor(
    private readonly primary: EmbeddingService,
    dimension?: number,
  ) {
    this.dimension = dimension ?? primary.dimension;
    this.fallback = new TFIDFEmbedding(this.dimension);
  }

  async embed(texts: string[]): Promise<number[][]> {
    try {
      const vectors = await this.primary.embed(texts);
      if (this.degraded) {
        this.degraded = false;
        console.warn("✅ [Embedding 恢复] 云端语义嵌入已恢复可用");
      }
      return vectors;
    } catch (error) {
      if (!this.degraded) {
        this.degraded = true;
        warnEmbeddingDegraded(
          "云端嵌入调用失败，已自动切换 TFIDF",
          error instanceof Error ? error.message : String(error),
        );
      }
      return this.fallback.embed(texts);
    }
  }
}

// ---------------------------------------------------------------------------
// 工厂：从配置/环境变量创建嵌入服务（对应书 create_embedding_model_with_fallback）
// ---------------------------------------------------------------------------

export interface CreateEmbeddingOptions {
  config?: MemoryConfig;
  env?: EmbeddingEnvSource;
}

/**
 * 解析顺序（对应书 .env 的 EMBED_* 配置）：
 * 显式 config > 环境变量 > TFIDF 兜底。
 * EMBED_MODEL_TYPE 取 openai-compat / dashscope / openai 等（除 tfidf 外都走兼容端点）。
 */
export function createEmbeddingService(
  options: CreateEmbeddingOptions = {},
): EmbeddingService {
  const env = options.env ?? process.env;
  const config = options.config;

  const modelType =
    config?.embedModelType ?? env.EMBED_MODEL_TYPE?.trim().toLowerCase();
  if (!modelType) {
    // 未做任何配置 = 隐式降级，必须提醒用户"当前不是云端嵌入"
    warnEmbeddingDegraded("未配置 EMBED_* 嵌入配置");
    return new TFIDFEmbedding();
  }
  if (modelType === "tfidf") {
    // 显式指定 tfidf = 主动选择词法嵌入，不打扰
    return new TFIDFEmbedding();
  }

  const model =
    config?.embedModelName ??
    env.EMBED_MODEL_NAME?.trim() ??
    defaultEmbedModel(modelType, env);
  const apiKey =
    config?.embedApiKey ?? env.EMBED_API_KEY?.trim() ?? env.LLM_API_KEY?.trim();
  const baseUrl =
    config?.embedBaseUrl ?? env.EMBED_BASE_URL?.trim() ?? defaultEmbedBaseUrl(modelType, env);
  const dimension = parseDimension(env.QDRANT_VECTOR_SIZE);

  if (!apiKey || !baseUrl) {
    // 配置不完整：降级可用 + 提醒，好过直接崩掉整个 Agent
    warnEmbeddingDegraded(
      `EMBED_MODEL_TYPE=${modelType} 但 ${!apiKey ? "缺少 EMBED_API_KEY（或 LLM_API_KEY）" : "缺少 EMBED_BASE_URL"}`,
    );
    return new TFIDFEmbedding();
  }

  return new FallbackEmbedding(
    new OpenAICompatEmbedding({ model, apiKey, baseUrl, dimension }),
  );
}

function defaultEmbedModel(modelType: string, env: EmbeddingEnvSource): string {
  if (modelType === "dashscope") {
    return env.EMBED_MODEL_NAME?.trim() || "text-embedding-v3";
  }
  if (modelType === "openai") return "text-embedding-3-small";
  if (modelType === "ollama") return "nomic-embed-text";
  return env.EMBED_MODEL_NAME?.trim() || "text-embedding-v3";
}

function defaultEmbedBaseUrl(
  modelType: string,
  env: EmbeddingEnvSource,
): string | undefined {
  if (modelType === "dashscope") {
    return (
      env.EMBED_BASE_URL?.trim() ||
      "https://dashscope.aliyuncs.com/compatible-mode/v1"
    );
  }
  if (modelType === "openai") return env.EMBED_BASE_URL?.trim() || "https://api.openai.com/v1";
  if (modelType === "ollama") return env.EMBED_BASE_URL?.trim() || "http://localhost:11434/v1";
  return env.EMBED_BASE_URL?.trim() ?? env.LLM_BASE_URL?.trim();
}

function parseDimension(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/** L2 归一化（余弦相似度检索的前置条件） */
export function l2Normalize(vector: number[]): number[] {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

/** 余弦相似度（向量已归一化时等价于点积；这里按通用公式实现） */
export function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 单文本嵌入的便利封装：空返回视为异常（向量库写入的前提） */
export async function embedOne(
  service: EmbeddingService,
  text: string,
): Promise<number[]> {
  const [vector] = await service.embed([text]);
  if (!vector || vector.length === 0) {
    throw new Error("嵌入服务返回了空向量");
  }
  return vector;
}
