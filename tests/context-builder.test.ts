import { describe, expect, it } from "vitest";
import { ContextBuilder, countTokens, truncateToTokens, calculateRelevance } from "../src/context/builder";
import { ContextConfig } from "../src/context/types";
import type { ContextMemorySource, ContextRagSource } from "../src/context/types";
import { Message } from "../src/core/message";

function fakeMemory(items: Array<{ content: string; importance: number; ageHours: number; score: number }>): ContextMemorySource {
  return {
    async searchMemories({ limit }) {
      return items.slice(0, limit ?? 10).map((item, index) => ({
        item: {
          id: `m${index}`,
          content: item.content,
          importance: item.importance,
          timestamp: new Date(Date.now() - item.ageHours * 3_600_000).toISOString(),
        },
        memoryType: "working",
        score: item.score,
      }));
    },
  };
}

const fakeRag: ContextRagSource = {
  async search(query, options) {
    return [{ content: `${query} 的知识条目`, source: "kb.md", score: 0.8 }].slice(
      0,
      options?.topK ?? 5,
    );
  },
};

describe("ContextConfig", () => {
  it("默认值对齐书 9.3.2", () => {
    const config = new ContextConfig();
    expect(config.maxTokens).toBe(4000);
    expect(config.reserveRatio).toBe(0.15);
    expect(config.minRelevance).toBe(0.2);
    expect(config.enableCompression).toBe(true);
  });

  it("非法参数直接拒绝", () => {
    expect(() => new ContextConfig({ maxTokens: 0 })).toThrow();
    expect(() => new ContextConfig({ reserveRatio: 1 })).toThrow();
  });
});

describe("token 估算与截断", () => {
  it("CJK 1 字 1 token，ASCII 1 词 1 token", () => {
    expect(countTokens("上下文工程")).toBe(5);
    expect(countTokens("hello world foo")).toBe(3);
    expect(countTokens("GSSC 流水线")).toBe(1 + 3);
  });

  it("truncateToTokens 按预算截断", () => {
    expect(truncateToTokens("一二三四五", 3)).toBe("一二三");
    expect(truncateToTokens("one two three", 2)).toBe("one two");
    expect(truncateToTokens("abc", 0)).toBe("");
  });

  it("关键词重叠相关性", () => {
    expect(calculateRelevance("TypeScript 上下文工程", "上下文工程")).toBe(1);
    expect(calculateRelevance("今天天气不错", "上下文工程")).toBe(0);
  });
});

describe("ContextBuilder GSSC", () => {
  it("gather：记忆 + RAG + 历史 + 额外 packet 全部收集", async () => {
    const builder = new ContextBuilder({
      memorySource: fakeMemory([
        { content: "记忆A", importance: 0.8, ageHours: 1, score: 0.9 },
      ]),
      ragSource: fakeRag,
    });
    const built = await builder.build({
      query: "知识",
      history: [Message.user("hello"), Message.assistant("hi")],
      extraPackets: [{ content: "额外笔记", type: "note", priority: 0.7 }],
    });
    expect(built.context).toContain("## 对话历史");
    expect(built.context).toContain("## 相关记忆");
    expect(built.context).toContain("## 知识检索");
    expect(built.context).toContain("## 项目笔记");
  });

  it("select：低分记忆被 minRelevance 过滤", async () => {
    const builder = new ContextBuilder({
      memorySource: fakeMemory([
        { content: "无关记忆", importance: 0.1, ageHours: 500, score: 0.05 },
      ]),
      config: { minRelevance: 0.5 },
    });
    const built = await builder.build({ query: "无关查询词xyz" });
    expect(built.context).not.toContain("无关记忆");
  });

  it("select：历史消息不受 minRelevance 门槛", async () => {
    const builder = new ContextBuilder({
      memorySource: fakeMemory([]),
      config: { minRelevance: 0.9 },
    });
    const built = await builder.build({
      query: "完全无关xyz",
      history: [Message.user("早期对话内容")],
    });
    expect(built.context).toContain("早期对话内容");
  });

  it("compress：超预算触发压缩并标记 compressed", async () => {
    const builder = new ContextBuilder({
      memorySource: fakeMemory([
        { content: "很长".repeat(500), importance: 0.9, ageHours: 1, score: 0.9 },
      ]),
      config: { maxTokens: 120, minRelevance: 0 },
    });
    const built = await builder.build({ query: "记忆" });
    expect(built.compressed).toBe(true);
    expect(built.tokenCount).toBeLessThanOrEqual(200);
  });

  it("记忆源抛错时降级不阻断", async () => {
    const broken: ContextMemorySource = {
      async searchMemories() {
        throw new Error("嵌入服务不可用");
      },
    };
    const builder = new ContextBuilder({ memorySource: broken });
    const built = await builder.build({ query: "任意" });
    expect(built.context).toContain("暂无相关记忆");
  });
});
