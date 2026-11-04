import { describe, expect, it } from "vitest";
import {
  TFIDFEmbedding,
  cosineSimilarity,
  embedOne,
  tokenizeForEmbedding,
  type EmbeddingService,
} from "../src/memory/embedding";

describe("TFIDFEmbedding（书 embedding.py 的兜底层）", () => {
  it("分词：拉丁词整体小写 + CJK 单字与二元组", () => {
    const tokens = tokenizeForEmbedding("Hello 世界");
    expect(tokens).toContain("hello");
    expect(tokens).toContain("世");
    expect(tokens).toContain("界");
    expect(tokens).toContain("世界");
  });

  it("固定维度、L2 归一化、确定性", async () => {
    const embedder = new TFIDFEmbedding(64);
    const [a] = await embedder.embed(["Python 是解释型语言"]);
    const [b] = await embedder.embed(["Python 是解释型语言"]);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).toHaveLength(64);
    expect(b).toEqual(a);
    const norm = Math.sqrt(a!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("同主题文本的相似度高于无关文本", async () => {
    const embedder = new TFIDFEmbedding(256);
    const [python] = await embedder.embed(["Python 编程语言入门"]);
    const [pythonAgain] = await embedder.embed(["Python 语言程序设计"]);
    const [cooking] = await embedder.embed(["红烧肉的做法"]);
    expect(python).toBeDefined();
    expect(pythonAgain).toBeDefined();
    expect(cooking).toBeDefined();
    expect(cosineSimilarity(python!, pythonAgain!)).toBeGreaterThan(
      cosineSimilarity(python!, cooking!),
    );
  });

  it("embedQuery 不污染语料统计", () => {
    const embedder = new TFIDFEmbedding(64);
    embedder.embedQuery("随便查一下");
    expect(embedder.stats().corpusSize).toBe(0);
    embedder.embedQuery("再查一次");
    expect(embedder.stats().corpusSize).toBe(0);
  });

  it("embedOne 对空返回抛错", async () => {
    const empty: EmbeddingService = {
      dimension: 1,
      embed: async () => [[]],
    };
    await expect(embedOne(empty, "text")).rejects.toThrow(/空向量/);
  });
});
