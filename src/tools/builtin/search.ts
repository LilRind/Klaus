/**
 * 多源搜索工具（对应书 7.5.3 my_advanced_search.py）
 *
 * 设计与书一致：按环境变量自动启用 Tavily / SerpApi 搜索源，
 * 顺序尝试、失败降级、返回最佳结果。
 * TS 适配点：不引第三方 SDK，直接用 fetch 调 REST；
 * fetch 与 env 均可注入——单测完全离线。
 */

import { Tool } from "../tool";
import { ToolRegistry } from "../registry";
import type { EnvSource } from "../../core/llm";

export type SearchFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface AdvancedSearchToolOptions {
  env?: EnvSource;
  fetchImpl?: SearchFetch;
  maxResults?: number;
}

interface SearchSource {
  name: "tavily" | "serpapi";
  apiKey: string;
}

export class AdvancedSearchTool extends Tool {
  override get name(): string {
    return "advanced_search";
  }

  override get description(): string {
    return "智能搜索工具，整合 Tavily 和 SerpApi 多个搜索源，自动选择最佳结果";
  }

  override get parametersDescription(): string {
    return "query: 搜索关键词";
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词" },
      },
      required: ["query"],
    };
  }

  readonly searchSources: SearchSource[];

  private readonly fetchImpl: SearchFetch;
  private readonly maxResults: number;

  constructor(options: AdvancedSearchToolOptions = {}) {
    super();
    const env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.maxResults = options.maxResults ?? 3;

    this.searchSources = [];
    if (env.TAVILY_API_KEY) {
      this.searchSources.push({ name: "tavily", apiKey: env.TAVILY_API_KEY });
    }
    if (env.SERPAPI_API_KEY) {
      this.searchSources.push({ name: "serpapi", apiKey: env.SERPAPI_API_KEY });
    }
  }

  override async execute(query: string): Promise<string> {
    if (!query.trim()) return "❌ 错误：搜索查询不能为空";

    if (this.searchSources.length === 0) {
      return [
        "❌ 没有可用的搜索源，请配置以下API密钥之一：",
        "",
        "1. Tavily API: 设置环境变量 TAVILY_API_KEY",
        "   获取地址: https://tavily.com/",
        "",
        "2. SerpAPI: 设置环境变量 SERPAPI_API_KEY",
        "   获取地址: https://serpapi.com/",
        "",
        "配置后重新运行程序。",
      ].join("\n");
    }

    for (const source of this.searchSources) {
      try {
        if (source.name === "tavily") {
          const result = await this.searchWithTavily(source, query);
          if (result && !result.includes("未找到")) {
            return `📊 Tavily AI搜索结果：\n\n${result}`;
          }
        } else if (source.name === "serpapi") {
          const result = await this.searchWithSerpApi(source, query);
          if (result && !result.includes("未找到")) {
            return `🌐 SerpApi Google搜索结果：\n\n${result}`;
          }
        }
      } catch {
        continue; // 单源失败降级到下一个源（对应书的 continue）
      }
    }

    return "❌ 所有搜索源都失败了，请检查网络连接和API密钥配置";
  }

  private async searchWithTavily(source: SearchSource, query: string): Promise<string> {
    const response = await this.fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: source.apiKey,
        query,
        max_results: this.maxResults,
      }),
    });
    if (!response.ok) throw new Error(`Tavily HTTP ${response.status}`);
    const data = (await response.json()) as {
      answer?: string;
      results?: Array<{ title?: string; content?: string }>;
    };

    let result = "";
    if (data.answer) {
      result += `💡 AI直接答案：${data.answer}\n\n`;
    }
    result += "🔗 相关结果：\n";
    for (const [index, item] of (data.results ?? []).slice(0, this.maxResults).entries()) {
      result += `[${index + 1}] ${item.title ?? ""}\n`;
      result += `    ${(item.content ?? "").slice(0, 150)}...\n\n`;
    }
    return result.trim() || "未找到相关结果";
  }

  private async searchWithSerpApi(source: SearchSource, query: string): Promise<string> {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("q", query);
    url.searchParams.set("api_key", source.apiKey);
    url.searchParams.set("num", String(this.maxResults));

    const response = await this.fetchImpl(url.toString());
    if (!response.ok) throw new Error(`SerpApi HTTP ${response.status}`);
    const data = (await response.json()) as {
      organic_results?: Array<{ title?: string; snippet?: string }>;
    };

    let result = "🔗 Google搜索结果：\n";
    for (const [index, item] of (data.organic_results ?? [])
      .slice(0, this.maxResults)
      .entries()) {
      result += `[${index + 1}] ${item.title ?? ""}\n`;
      result += `    ${item.snippet ?? ""}\n\n`;
    }
    return result.trim() || "未找到相关结果";
  }
}

/** 便捷入口：创建包含高级搜索工具的注册表（对应书 create_advanced_search_registry） */
export function createAdvancedSearchRegistry(
  options: AdvancedSearchToolOptions = {},
): ToolRegistry {
  return new ToolRegistry().register(new AdvancedSearchTool(options));
}
