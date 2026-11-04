/**
 * RAG 管道（对应书 8.3.4/8.3.5 memory/rag/pipeline.py）
 *
 * "五层七步"：文档 → 分块 → 向量化 → 存储 → 检索（可扩展 MQE/HyDE）
 * → 上下文构建 → LLM 增强生成。扩展检索是书 8.3.5 的"扩展-检索-合并"
 * 三步流程：多查询并行召回 + 按 memory_id 去重 + 分数排序。
 * LLM 与存储全部可注入——离线测试用 ScriptedLLM + InMemoryVectorStore。
 */

import { randomUUID } from "node:crypto";
import type { ChatLLM } from "../../core/llm";
import type { ChatMessage } from "../../core/message";
import { OpenAICompatLLM } from "../../core/llm";
import { embedOne, type EmbeddingService } from "../embedding";
import type { VectorStore } from "../storage/vector-store";
import { chunkText, loadDocument, type DocumentChunk } from "./document";
import type { Reranker } from "./rerank";

export interface RAGChunkMetadata extends Record<string, unknown> {
  memory_type: "rag_chunk";
  is_rag_data: true;
  data_source: "rag_pipeline";
  rag_namespace: string;
  content: string;
  source: string;
  heading_path: string | null;
  chunk_index: number;
  total_chunks: number;
  chunk_id: string;
}

export interface RAGPipelineOptions {
  vectorStore: VectorStore;
  embedder: EmbeddingService;
  /** 问答与查询扩展用的 LLM；不传则懒创建（读 .env） */
  llm?: ChatLLM;
  /** Rerank 精排器（可选）；启用后 search 的 enableRerank 生效 */
  reranker?: Reranker;
  ragNamespace?: string;
  chunkTokens?: number;
  overlapTokens?: number;
}

export interface IngestInput {
  text?: string;
  filePath?: string;
  /** 知识条目标题（纯文本知识时建议提供） */
  source?: string;
}

export interface IngestResult {
  source: string;
  chunkCount: number;
  chunkIds: string[];
}

export interface RAGSearchHit {
  chunkId: string;
  score: number;
  content: string;
  source: string;
  headingPath: string | null;
  metadata: RAGChunkMetadata;
}

export interface RAGSearchOptions {
  topK?: number;
  scoreThreshold?: number;
  /** MQE 多查询扩展（书 _prompt_mqe）：LLM 生成 N 个改写查询 */
  enableMqe?: boolean;
  mqeExpansions?: number;
  /** HyDE 假设文档（书 _prompt_hyde）：先写假设答案再检索 */
  enableHyde?: boolean;
  /** 候选池倍率（默认 4，对应书 candidate_pool_multiplier） */
  candidatePoolMultiplier?: number;
  /** Rerank 精排（可选）：召回 pool 后交叉打分重排，取 topK */
  enableRerank?: boolean;
}

export interface RAGAnswer {
  answer: string;
  sources: RAGSearchHit[];
}

export class RAGPipeline {
  readonly ragNamespace: string;

  private readonly vectors: VectorStore;
  private readonly embedder: EmbeddingService;
  private readonly lazyLlm?: ChatLLM;
  private llmInstance?: ChatLLM;
  private readonly chunkTokens: number;
  private readonly overlapTokens: number;
  private readonly reranker?: Reranker;

  constructor(options: RAGPipelineOptions) {
    this.ragNamespace = options.ragNamespace ?? "default";
    this.vectors = options.vectorStore;
    this.embedder = options.embedder;
    this.lazyLlm = options.llm;
    this.reranker = options.reranker;
    this.chunkTokens = options.chunkTokens ?? 1000;
    this.overlapTokens = options.overlapTokens ?? 200;
  }

  /** 摄取：文本/文件 → 分块 → 向量化 → 入库 */
  async ingest(input: IngestInput): Promise<IngestResult> {
    let text: string;
    let source: string;
    if (input.filePath) {
      text = await loadDocument(input.filePath);
      source = input.source ?? input.filePath;
    } else if (input.text) {
      text = input.text;
      source = input.source ?? "inline_text";
    } else {
      throw new Error("ingest 需要 text 或 filePath 之一");
    }

    const chunks = chunkText(text, {
      chunkTokens: this.chunkTokens,
      overlapTokens: this.overlapTokens,
    });
    if (chunks.length === 0) {
      return { source, chunkCount: 0, chunkIds: [] };
    }

    const vectors: number[][] = [];
    for (const chunk of chunks) {
      vectors.push(await embedOne(this.embedder, chunk.content));
    }
    await this.vectors.ensureCollection(vectors[0]?.length ?? 0);

    const chunkIds: string[] = [];
    const records = chunks.map((chunk, index) => {
      const chunkId = randomUUID();
      chunkIds.push(chunkId);
      return {
        id: chunkId,
        vector: vectors[index] ?? [],
        metadata: {
          memory_type: "rag_chunk",
          is_rag_data: true,
          data_source: "rag_pipeline",
          rag_namespace: this.ragNamespace,
          content: chunk.content,
          source,
          heading_path: chunk.headingPath,
          chunk_index: index,
          total_chunks: chunks.length,
          chunk_id: chunkId,
        } satisfies RAGChunkMetadata,
      };
    });
    await this.vectors.upsert(records);
    return { source, chunkCount: chunks.length, chunkIds };
  }

  /** 检索：默认向量检索；可开 MQE/HyDE 扩展（书 search_vectors_expanded） */
  async search(query: string, options: RAGSearchOptions = {}): Promise<RAGSearchHit[]> {
    const topK = options.topK ?? 5;
    if (query.trim().length === 0) return [];

    // —— 查询扩展 ——
    const expansions: string[] = [query];
    if (options.enableMqe) {
      const variants = await this.generateMqe(query, options.mqeExpansions ?? 2);
      expansions.push(...variants);
    }
    if (options.enableHyde) {
      const hypothesis = await this.generateHyde(query);
      if (hypothesis) expansions.push(hypothesis);
    }
    const unique = [...new Set(expansions.filter((text) => text.trim().length > 0))];

    // —— 候选池分配（书：pool = max(topK × multiplier, 20)）——
    const pool = Math.max(topK * (options.candidatePoolMultiplier ?? 4), 20);
    const per = Math.max(1, Math.floor(pool / Math.max(1, unique.length)));

    const filter = {
      memory_type: "rag_chunk",
      is_rag_data: true,
      data_source: "rag_pipeline",
      rag_namespace: this.ragNamespace,
    };

    // —— 多查询召回 + memory_id 去重取最高分（书 agg 逻辑）——
    const aggregated = new Map<string, RAGSearchHit>();
    for (const expansion of unique) {
      const queryVector = await embedOne(this.embedder, expansion);
      const hits = await this.vectors.search(queryVector, {
        limit: per,
        scoreThreshold: options.scoreThreshold,
        filter,
      });
      for (const hit of hits) {
        const metadata = hit.metadata as RAGChunkMetadata;
        const existing = aggregated.get(hit.id);
        if (!existing || hit.score > existing.score) {
          aggregated.set(hit.id, {
            chunkId: hit.id,
            score: hit.score,
            content: metadata.content,
            source: metadata.source,
            headingPath: metadata.heading_path,
            metadata,
          });
        }
      }
    }

    const ranked = [...aggregated.values()].sort((a, b) => b.score - a.score);
    if (!options.enableRerank || !this.reranker) return ranked.slice(0, topK);

    // 二级检索：向量召回扩池 → rerank 精排 → topK
    const rerankPool = ranked.slice(0, Math.max(topK * 3, 10));
    try {
      const scores = await this.reranker.rerank(query, rerankPool.map((hit) => hit.content));
      const reranked = rerankPool
        .map((hit, index) => ({ hit, score: scores[index] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      return reranked.map(({ hit, score }) => ({ ...hit, score }));
    } catch (error) {
      // 降级提醒原则：rerank 失败回退向量序，明确告知
      console.warn(
        `⚠️ [Rerank 降级] 精排调用失败（${error instanceof Error ? error.message : String(error)}），本次沿用向量召回排序`,
      );
      return rerankPool.slice(0, topK);
    }
  }

  /** 智能问答：检索 → 上下文构建 → LLM 生成（书 8.4 问答核心） */
  async ask(query: string, options: RAGSearchOptions = {}): Promise<RAGAnswer> {
    const hits = await this.search(query, { topK: options.topK ?? 5, ...options });
    const llm = await this.getLlm();

    if (hits.length === 0) {
      const answer = await llm.invoke([
        {
          role: "system",
          content:
            "你是知识库问答助手。知识库中未检索到相关内容时，明确告知用户，不要编造。",
        },
        { role: "user", content: query },
      ]);
      return { answer, sources: [] };
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "你是知识库问答助手。仅依据下方【参考资料】回答问题；" +
          "资料不足以回答时明确说明。回答末尾列出引用来源编号。",
      },
      {
        role: "user",
        content:
          `【参考资料】\n${hits
            .map(
              (hit, index) =>
                `[${index + 1}] (来源: ${hit.source}${hit.headingPath ? ` > ${hit.headingPath}` : ""})\n${hit.content}`,
            )
            .join("\n\n")}\n\n【问题】${query}`,
      },
    ];
    const answer = await llm.invoke(messages);
    return { answer, sources: hits };
  }

  async stats(): Promise<{ namespace: string; chunks: number }> {
    const chunks = await this.vectors.count({
      memory_type: "rag_chunk",
      is_rag_data: true,
      data_source: "rag_pipeline",
      rag_namespace: this.ragNamespace,
    });
    return { namespace: this.ragNamespace, chunks };
  }

  async clear(): Promise<void> {
    // 先列出再按 ID 删（Qdrant 生产端可用 delete-by-filter 优化）
    const all = await this.vectors.list({
      memory_type: "rag_chunk",
      rag_namespace: this.ragNamespace,
    });
    await this.vectors.delete(all.map((hit) => hit.id));
  }

  /** MQE 多查询扩展（书 _prompt_mqe） */
  private async generateMqe(query: string, expansions: number): Promise<string[]> {
    const llm = await this.getLlm();
    const response = await llm.invoke([
      {
        role: "system",
        content:
          `把用户问题改写为 ${expansions} 个语义相同但用词不同的检索查询，` +
          "每行一个，不要编号，不要解释。",
      },
      { role: "user", content: query },
    ]);
    return response
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(0, expansions);
  }

  /** HyDE 假设文档（书 _prompt_hyde） */
  private async generateHyde(query: string): Promise<string | undefined> {
    const llm = await this.getLlm();
    const response = await llm.invoke([
      {
        role: "system",
        content:
          "根据用户问题，先写一段可能的答案性段落，用于向量检索的查询文档（不要分析过程）。",
      },
      {
        role: "user",
        content: `问题：${query}\n请直接写一段中等长度、客观、包含关键术语的段落。`,
      },
    ]);
    const text = response.trim();
    return text.length > 0 ? text : undefined;
  }

  private async getLlm(): Promise<ChatLLM> {
    this.llmInstance ??= this.lazyLlm ?? new OpenAICompatLLM();
    return this.llmInstance;
  }

}
