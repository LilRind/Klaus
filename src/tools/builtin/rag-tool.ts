/**
 * RAG 工具（对应书 8.3.4 tools/builtin/rag_tool.py）
 *
 * RAG 能力的统一入口（"用户层"）：add_document / search / ask / stats / clear。
 * 与 MemoryTool 同构——JSON 进字符串出，注册进 ToolRegistry 即被
 * SimpleAgent/FunctionCallAgent 调用。
 */

import { Tool } from "../tool";
import { createEmbeddingService, type EmbeddingService } from "../../memory/embedding";
import type { MemoryConfig } from "../../memory/base";
import { RAGPipeline, type RAGSearchHit } from "../../memory/rag/pipeline";
import type { ChatLLM } from "../../core/llm";
import type { VectorStore } from "../../memory/storage/vector-store";
import { createDefaultVectorStore } from "../../memory/storage/factories";

export interface RAGToolOptions {
  knowledgeBasePath?: string;
  ragNamespace?: string;
  collectionName?: string;
  config?: MemoryConfig;
  embedder?: EmbeddingService;
  vectorStore?: VectorStore;
  llm?: ChatLLM;
  chunkTokens?: number;
  overlapTokens?: number;
}

interface RAGActionPayload {
  action?: string;
  [key: string]: unknown;
}

export class RAGTool extends Tool {
  readonly name = "rag";
  readonly description =
    "RAG 知识库工具 - 添加文档、语义检索与智能问答（支持 add_document/search/ask/stats/clear）";
  readonly parametersDescription =
    'JSON 对象: {"action": "add_document|search|ask|stats|clear", ...参数}';

  override get parametersSchema(): Record<string, unknown> | undefined {
    return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add_document", "search", "ask", "stats", "clear"],
        description: "要执行的 RAG 操作",
      },
      text: { type: "string", description: "add_document: 知识文本" },
      file_path: { type: "string", description: "add_document: 文档路径" },
      title: { type: "string", description: "add_document: 知识标题" },
      query: { type: "string", description: "search/ask: 查询问题" },
      top_k: { type: "number", description: "search/ask: 返回条数" },
    },
      required: ["action"],
    };
  }

  readonly pipeline: RAGPipeline;
  readonly knowledgeBasePath: string;
  readonly collectionName: string;

  constructor(options: RAGToolOptions = {}) {
    super();
    this.knowledgeBasePath = options.knowledgeBasePath ?? "./knowledge_base";
    this.collectionName =
      options.collectionName ?? "rag_knowledge_base";
    const embedder = options.embedder ?? createEmbeddingService({ config: options.config });
    const vectorStore =
      options.vectorStore ??
      createDefaultVectorStore({ collection: this.collectionName });
    this.pipeline = new RAGPipeline({
      vectorStore,
      embedder,
      llm: options.llm,
      ragNamespace: options.ragNamespace ?? "default",
      chunkTokens: options.chunkTokens,
      overlapTokens: options.overlapTokens,
    });
  }

  async execute(input: string): Promise<string> {
    let payload: RAGActionPayload;
    try {
      payload = JSON.parse(input) as RAGActionPayload;
    } catch {
      return '❌ 参数必须是合法 JSON 对象，例如 {"action": "search", "query": "..."}';
    }

    try {
      switch (payload.action) {
        case "add_document":
          return await this.addDocument(payload);
        case "search":
          return await this.search(payload);
        case "ask":
          return await this.ask(payload);
        case "stats":
          return await this.stats();
        case "clear":
          await this.pipeline.clear();
          return `🗑️ 已清空 RAG 知识库（namespace: ${this.pipeline.ragNamespace}）`;
        default:
          return `❌ 未知操作: ${String(payload.action)}，支持 add_document/search/ask/stats/clear`;
      }
    } catch (error) {
      return `❌ RAG 操作失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async addDocument(payload: RAGActionPayload): Promise<string> {
    const text = stringField(payload.text);
    const filePath = stringField(payload.file_path) ?? stringField(payload.path);
    if (!text && !filePath) {
      return "❌ add_document 需要 text 或 file_path 参数";
    }
    const result = await this.pipeline.ingest({
      text,
      filePath,
      source: stringField(payload.title) ?? stringField(payload.source),
    });
    return `✅ 文档已入库: ${result.source}（${result.chunkCount} 个分块）`;
  }

  private async search(payload: RAGActionPayload): Promise<string> {
    const query = stringField(payload.query);
    if (!query) return "❌ search 需要 query 参数";
    const hits = await this.pipeline.search(query, {
      topK: numberField(payload.top_k) ?? 5,
      enableMqe: Boolean(payload.enable_mqe),
      enableHyde: Boolean(payload.enable_hyde),
      scoreThreshold: numberField(payload.score_threshold),
    });
    if (hits.length === 0) return "🔍 知识库中未找到相关内容";
    return (
      `🔍 找到 ${hits.length} 条相关内容：\n` +
      hits.map((hit, index) => renderHit(index + 1, hit)).join("\n")
    );
  }

  private async ask(payload: RAGActionPayload): Promise<string> {
    const query = stringField(payload.query);
    if (!query) return "❌ ask 需要 query 参数";
    const result = await this.pipeline.ask(query, {
      topK: numberField(payload.top_k) ?? 5,
      enableMqe: Boolean(payload.enable_mqe),
      enableHyde: Boolean(payload.enable_hyde),
    });
    const sources = result.sources
      .map(
        (hit, index) =>
          `[${index + 1}] ${hit.source}${hit.headingPath ? ` > ${hit.headingPath}` : ""} (相关度 ${hit.score.toFixed(3)})`,
      )
      .join("\n");
    return (
      result.answer +
      (result.sources.length ? `\n\n📚 引用来源:\n${sources}` : "\n\n📚（知识库无相关内容，以上为模型直答）")
    );
  }

  private async stats(): Promise<string> {
    const stats = await this.pipeline.stats();
    return (
      `📊 RAG 知识库统计\n  命名空间: ${stats.namespace}\n  集合: ${this.collectionName}\n  分块数: ${stats.chunks}`
    );
  }
}

function renderHit(index: number, hit: RAGSearchHit): string {
  const heading = hit.headingPath ? ` > ${hit.headingPath}` : "";
  const preview =
    hit.content.length > 120 ? `${hit.content.slice(0, 120)}…` : hit.content;
  return `${index}. (相关度 ${hit.score.toFixed(3)}) [${hit.source}${heading}]\n   ${preview}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
