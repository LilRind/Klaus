import { describe, expect, it } from "vitest";
import {
  AdvancedSearchTool,
  createAdvancedSearchRegistry,
} from "../src/tools/builtin/search";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AdvancedSearchTool 多源搜索（对应书 7.5.3）", () => {
  it("未配置任何 Key：返回配置指引而不是抛错", async () => {
    const tool = new AdvancedSearchTool({ env: {} });
    const result = await tool.execute("机器学习算法");
    expect(result).toContain("没有可用的搜索源");
    expect(result).toContain("TAVILY_API_KEY");
    expect(result).toContain("SERPAPI_API_KEY");
  });

  it("空查询直接拒绝", async () => {
    const tool = new AdvancedSearchTool({ env: { TAVILY_API_KEY: "t-key" } });
    await expect(tool.execute("   ")).resolves.toContain("搜索查询不能为空");
  });

  it("Tavily 命中：AI 答案 + 编号结果", async () => {
    const requests: unknown[] = [];
    const tool = new AdvancedSearchTool({
      env: { TAVILY_API_KEY: "t-key" },
      fetchImpl: async (url, init) => {
        requests.push({ url, body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          answer: "Python 是一种解释型语言",
          results: [
            { title: "Python 历史", content: "1991 年由 Guido 发布" },
            { title: "Python 特性", content: "简洁优雅" },
          ],
        });
      },
    });

    const result = await tool.execute("Python编程语言的历史");

    expect(result).toContain("📊 Tavily AI搜索结果");
    expect(result).toContain("💡 AI直接答案：Python 是一种解释型语言");
    expect(result).toContain("[1] Python 历史");
    expect(requests[0]).toMatchObject({
      url: "https://api.tavily.com/search",
      body: { api_key: "t-key", query: "Python编程语言的历史", max_results: 3 },
    });
  });

  it("Tavily 失败自动降级 SerpApi", async () => {
    const calls: string[] = [];
    const tool = new AdvancedSearchTool({
      env: { TAVILY_API_KEY: "t-key", SERPAPI_API_KEY: "s-key" },
      fetchImpl: async (url) => {
        calls.push(url);
        if (url.includes("tavily")) return jsonResponse({}, 500);
        return jsonResponse({
          organic_results: [{ title: "AI 进展", snippet: "大模型持续进化" }],
        });
      },
    });

    const result = await tool.execute("人工智能的最新发展");

    expect(calls).toHaveLength(2);
    expect(result).toContain("🌐 SerpApi Google搜索结果");
    expect(result).toContain("[1] AI 进展");
  });

  it("全部搜索源失败：返回失败汇总", async () => {
    const tool = new AdvancedSearchTool({
      env: { TAVILY_API_KEY: "t", SERPAPI_API_KEY: "s" },
      fetchImpl: async () => jsonResponse({}, 502),
    });
    await expect(tool.execute("查询")).resolves.toContain("所有搜索源都失败了");
  });

  it("注册表集成：工具菜单与执行链路", async () => {
    const registry = createAdvancedSearchRegistry({ env: {} });
    expect(registry.getToolsDescription()).toContain("advanced_search");
    await expect(registry.executeTool("advanced_search", "x")).resolves.toContain(
      "没有可用的搜索源",
    );
  });
});
