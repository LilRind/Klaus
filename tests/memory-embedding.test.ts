import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FallbackEmbedding,
  TFIDFEmbedding,
  createEmbeddingService,
  cosineSimilarity,
  embedOne,
  resetEmbeddingWarnings,
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

describe("嵌入降级提醒（云端不可用时必须明确告知用户）", () => {
  beforeEach(() => {
    resetEmbeddingWarnings();
  });

  it("未配置 EMBED_*：返回 TFIDF 并警告一次（去重，不刷屏）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createEmbeddingService({ env: {} })).toBeInstanceOf(TFIDFEmbedding);
    expect(createEmbeddingService({ env: {} })).toBeInstanceOf(TFIDFEmbedding);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("TFIDF");
    expect(String(warn.mock.calls[0]?.[0])).toContain("不是云端语义嵌入");
    warn.mockRestore();
  });

  it("显式 EMBED_MODEL_TYPE=tfidf 是主动选择，不警告", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      createEmbeddingService({ env: { EMBED_MODEL_TYPE: "tfidf" } }),
    ).toBeInstanceOf(TFIDFEmbedding);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("配了云端类型但缺 key：降级并提醒缺失项（不再抛错崩溃）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      createEmbeddingService({ env: { EMBED_MODEL_TYPE: "dashscope" } }),
    ).toBeInstanceOf(TFIDFEmbedding);
    expect(String(warn.mock.calls[0]?.[0])).toContain("EMBED_API_KEY");
    warn.mockRestore();
  });

  it("配置完整：返回 FallbackEmbedding 包装云端实现（构造不联网）", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = createEmbeddingService({
      env: { EMBED_MODEL_TYPE: "dashscope", EMBED_API_KEY: "sk-test" },
    });
    expect(service).toBeInstanceOf(FallbackEmbedding);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("FallbackEmbedding 运行时降级与恢复：转换时提醒、平稳期静默", async () => {
    resetEmbeddingWarnings();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = true;
    const primary: EmbeddingService = {
      dimension: 4,
      embed: async (texts: string[]) => {
        if (fail) throw new Error("network down");
        return texts.map(() => [1, 0, 0, 0]);
      },
    };
    const service = new FallbackEmbedding(primary);

    // 首次失败 → 降级警告 + TFIDF 兜底（维度对齐 4）
    const degraded = await service.embed(["文本"]);
    expect(degraded[0]).toHaveLength(4);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("已自动切换 TFIDF");

    // 持续失败 → 不重复警告
    await service.embed(["文本"]);
    expect(warn).toHaveBeenCalledTimes(1);

    // 云端恢复 → 恢复提示 + 主服务向量
    fail = false;
    const recovered = await service.embed(["文本"]);
    expect(recovered[0]).toEqual([1, 0, 0, 0]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1]?.[0])).toContain("已恢复");
    warn.mockRestore();
  });
});
