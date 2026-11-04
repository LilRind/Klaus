import { describe, expect, it, vi } from "vitest";
import { createMemoryItem, type Clock } from "../src/memory/base";
import { TFIDFEmbedding, type EmbeddingService } from "../src/memory/embedding";
import {
  InMemoryDocumentStore,
  InMemoryGraphStore,
  InMemoryVectorStore,
} from "../src/index";
import { WorkingMemory } from "../src/memory/types/working";
import { EpisodicMemory } from "../src/memory/types/episodic";
import {
  LLMEntityExtractor,
  RuleBasedEntityExtractor,
  SemanticMemory,
} from "../src/memory/types/semantic";
import { ScriptedLLM } from "./scripted-llm";
import {
  PerceptualMemory,
  inferModality,
} from "../src/memory/types/perceptual";

/** 可编程时钟：构造确定性 TTL/时间衰减测试 */
function fakeClock(startMs: number): { clock: Clock; advance: (ms: number) => void } {
  let current = startMs;
  return {
    clock: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** 把指定文本映射到固定向量的桩嵌入服务 */
class MapEmbedder implements EmbeddingService {
  readonly dimension = 2;
  constructor(private readonly mapping: Record<string, number[]>) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.mapping[text] ?? [0.5, 0.5]);
  }
}

function buildStores() {
  return {
    documentStore: new InMemoryDocumentStore(),
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    embedder: new TFIDFEmbedding(),
  };
}

describe("WorkingMemory（书 8.2.5-(1)）", () => {
  it("TTL 过期自动清理", async () => {
    const { clock, advance } = fakeClock(Date.UTC(2026, 0, 1));
    const memory = new WorkingMemory({ ttlMinutes: 60, clock });
    await memory.add(
      createMemoryItem({
        content: "临时任务上下文",
        memoryType: "working",
        timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      }),
    );
    expect(await memory.list()).toHaveLength(1);
    advance(61 * 60_000);
    expect(await memory.list()).toHaveLength(0);
  });

  it("容量超限淘汰重要性最低的记忆", async () => {
    const memory = new WorkingMemory({ maxCapacity: 3 });
    const base = { memoryType: "working" as const };
    await memory.add(createMemoryItem({ ...base, content: "低价值信息", importance: 0.1 }));
    await memory.add(createMemoryItem({ ...base, content: "中等价值信息", importance: 0.5 }));
    await memory.add(createMemoryItem({ ...base, content: "高价值信息", importance: 0.9 }));
    await memory.add(createMemoryItem({ ...base, content: "新进来的一条", importance: 0.6 }));

    const contents = (await memory.list()).map((item) => item.content);
    expect(contents).not.toContain("低价值信息");
    expect(contents).toContain("新进来的一条");
    expect(contents).toHaveLength(3);
  });

  it("检索按相关性排序，且重要性带来加权", async () => {
    const memory = new WorkingMemory();
    const base = { memoryType: "working" as const };
    await memory.add(createMemoryItem({ ...base, content: "Python 函数式编程笔记", importance: 0.5 }));
    await memory.add(createMemoryItem({ ...base, content: "Python 装饰器很重要", importance: 0.95 }));
    await memory.add(createMemoryItem({ ...base, content: "今天午饭吃面", importance: 0.5 }));

    const results = await memory.retrieve("Python 装饰器", 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.item.content).toContain("装饰器");
    expect(results.every((result) => result.score > 0)).toBe(true);
  });
});

describe("EpisodicMemory（书 8.2.5-(2)）", () => {
  it("写入双库（文档+向量），检索命中相关事件，更新重嵌入", async () => {
    const stores = buildStores();
    const memory = new EpisodicMemory(stores);
    const event = createMemoryItem({
      content: "张三完成了第一个 Python 项目",
      memoryType: "episodic",
      importance: 0.8,
      metadata: { session_id: "s1", event_type: "milestone" },
    });
    await memory.add(event);

    expect(await stores.documentStore.get(event.id)).toBeDefined();
    expect(await stores.vectorStore.getById(event.id)).toBeDefined();

    const results = await memory.retrieve("Python 项目里程碑", 5);
    expect(results[0]?.item.content).toContain("Python");

    await memory.update(event.id, { content: "张三完成了第一个 TypeScript 项目" });
    const updated = await memory.retrieve("TypeScript 项目", 5);
    expect(updated[0]?.item.content).toContain("TypeScript");

    expect(await memory.remove(event.id)).toBe(true);
    expect(await stores.vectorStore.getById(event.id)).toBeUndefined();
    expect(await stores.documentStore.get(event.id)).toBeUndefined();
  });
});

describe("SemanticMemory（书 8.2.5-(3)）", () => {
  it("规则实体抽取：引号/书名号/英文专名 + 共现关系", async () => {
    const extractor = new RuleBasedEntityExtractor();
    const { entities, relations } = await extractor.extract(
      "《HelloAgents》讲了“记忆系统”与 RAG 检索",
    );
    const names = entities.map((entity) => entity.name);
    expect(names).toContain("HelloAgents");
    expect(names).toContain("记忆系统");
    expect(names).toContain("RAG");
    expect(relations.length).toBeGreaterThan(0);
  });

  it("向量 + 图谱混合检索：图路径能找回向量未命中的记忆", async () => {
    // 查询向量与两条记忆都近乎正交——纯向量检索失效，逼出图检索路径
    const embedder = new MapEmbedder({
      "Python 是解释型语言": [1, 0],
      "今天天气不错": [0, 1],
    });
    const vectorStore = new InMemoryVectorStore();
    const graphStore = new InMemoryGraphStore();
    const memory = new SemanticMemory({ vectorStore, graphStore, embedder });

    await memory.add(
      createMemoryItem({
        content: "Python 是解释型语言",
        memoryType: "semantic",
        importance: 0.9,
      }),
    );
    await memory.add(
      createMemoryItem({
        content: "今天天气不错",
        memoryType: "semantic",
        importance: 0.5,
      }),
    );

    // 查询实体 Python → 图检索关联到第一条记忆
    const results = await memory.retrieve("Python 相关知识", 5);
    expect(results.some((result) => result.item.content.includes("Python"))).toBe(true);
  });

  it("list() 包含无实体记忆", async () => {
    const stores = buildStores();
    const memory = new SemanticMemory(stores);
    await memory.add(
      createMemoryItem({ content: "一条没有任何实体的普通记忆", memoryType: "semantic" }),
    );
    expect(await memory.list()).toHaveLength(1);
  });

  it("LLM 实体抽取：JSON 输出解析 + 围栏容忍 + 降级规则器", async () => {
    // ① 正常 JSON（带 markdown 围栏）→ 使用 LLM 结果
    const good = new ScriptedLLM([
      '```json\n{"entities":[{"name":"张三","type":"PERSON"},{"name":"记忆系统","type":"CONCEPT"}],"relations":[{"source":"张三","target":"记忆系统","relation":"研究"}]}\n```',
    ]);
    const extractor = new LLMEntityExtractor(good);
    const result = await extractor.extract("任意文本");
    expect(result.entities.map((e) => e.name)).toEqual(["张三", "记忆系统"]);
    expect(result.relations[0]?.relation).toBe("研究");

    // ② 非 JSON 输出 → 解析失败抛错 → 降级规则器 + 提醒
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = new ScriptedLLM(["抱歉我无法完成这个任务"]);
    const fallback = new RuleBasedEntityExtractor();
    const degraded = new LLMEntityExtractor(bad, fallback);
    const result2 = await degraded.extract("《HelloAgents》介绍了 RAG 检索");
    expect(result2.entities.some((e) => e.name === "HelloAgents")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("实体抽取降级");
    warn.mockRestore();
  });

  it("LLM 实体抽取运行时开关：关闭后回落规则器且不再调用 LLM", async () => {
    const llm = new ScriptedLLM([]);
    const extractor = new LLMEntityExtractor(llm);
    extractor.setEnabled(false);
    const result = await extractor.extract("《HelloAgents》介绍了 RAG 检索");
    // ScriptedLLM 队列为空：若仍调用 LLM 会抛"队列已耗尽"
    expect(llm.invokeCount).toBe(0);
    expect(result.entities.some((e) => e.name === "HelloAgents")).toBe(true);
    extractor.setEnabled(true);
    expect(extractor.isEnabled).toBe(true);
  });
});

describe("PerceptualMemory（书 8.2.5-(4)）", () => {
  it("模态推断与模态过滤检索", async () => {
    expect(inferModality("a/b/photo.png")).toBe("image");
    expect(inferModality("song.mp3")).toBe("audio");
    expect(inferModality("doc.pdf")).toBe("file");

    const stores = buildStores();
    const memory = new PerceptualMemory(stores);
    await memory.add(
      createMemoryItem({
        content: "一张 Python 代码截图",
        memoryType: "perceptual",
        metadata: { modality: "image" },
      }),
    );
    await memory.add(
      createMemoryItem({
        content: "一段 Python 讲解录音",
        memoryType: "perceptual",
        metadata: { modality: "audio" },
      }),
    );

    const images = await memory.retrieve("Python", 5, { modality: "image" });
    expect(images).toHaveLength(1);
    expect(images[0]?.item.metadata.modality).toBe("image");
  });
});
