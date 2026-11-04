/**
 * Rerank 精排（超出书范围的增强项，用户有 qwen3.7-text-rerank 免费额度）
 *
 * 二级检索架构：向量召回（粗排，高召回率）→ Rerank 精排（交叉注意力打分）。
 * Reranker 接口可注入（测试零网络）；DashScopeReranker 走百炼原生
 * text-rerank 端点（实测形状：output.results[].index / relevance_score）。
 */

export interface Reranker {
  /** 返回与 documents 等长的相关性分数数组（0-1） */
  rerank(query: string, documents: string[]): Promise<number[]>;
}

export interface DashScopeRerankerOptions {
  model?: string;
  apiKey?: string;
  /** 默认 https://dashscope.aliyuncs.com */
  baseUrl?: string;
  timeoutMs?: number;
}

interface DashScopeRerankResponse {
  output?: {
    results?: { index?: number; relevance_score?: number }[];
  };
}

export class DashScopeReranker implements Reranker {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: DashScopeRerankerOptions = {}) {
    const env = process.env;
    this.model = options.model ?? env.RERANK_MODEL_NAME ?? "qwen3.7-text-rerank";
    this.apiKey =
      options.apiKey ??
      env.RERANK_API_KEY ??
      env.EMBED_API_KEY ??
      env.LLM_API_KEY ??
      "";
    this.baseUrl = (options.baseUrl ?? env.RERANK_BASE_URL ?? "https://dashscope.aliyuncs.com").replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (documents.length === 0) return [];
    if (!this.apiKey) {
      throw new Error("Rerank 需要 RERANK_API_KEY（或 EMBED_API_KEY / LLM_API_KEY）");
    }
    const response = await fetch(
      `${this.baseUrl}/api/v1/services/rerank/text-rerank/text-rerank`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          input: { query, documents },
          parameters: { return_documents: false, top_n: documents.length },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      },
    );
    if (!response.ok) {
      throw new Error(`DashScope rerank HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as DashScopeRerankResponse;
    const scores = new Array<number>(documents.length).fill(0);
    for (const result of payload.output?.results ?? []) {
      if (
        typeof result.index === "number" &&
        result.index >= 0 &&
        result.index < documents.length &&
        typeof result.relevance_score === "number"
      ) {
        scores[result.index] = result.relevance_score;
      }
    }
    return scores;
  }
}

/** 默认装配：显式配置 RERANK_MODEL_NAME 才启用（避免意外的 API 调用与计费） */
export function createDefaultReranker(): Reranker | undefined {
  if (!process.env.RERANK_MODEL_NAME) return undefined;
  return new DashScopeReranker();
}
