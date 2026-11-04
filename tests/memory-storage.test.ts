import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InMemoryDocumentStore,
  SQLiteDocumentStore,
} from "../src/memory/storage/document-store";
import { InMemoryGraphStore } from "../src/memory/storage/graph-store";
import { InMemoryVectorStore } from "../src/memory/storage/vector-store";
import { createMemoryItem } from "../src/memory/base";
import { TFIDFEmbedding } from "../src/memory/embedding";

const tmpDbs: SQLiteDocumentStore[] = [];

afterEach(async () => {
  for (const db of tmpDbs.splice(0)) await db.close();
});

describe("InMemoryVectorStore", () => {
  it("余弦检索排序 + 过滤 + 阈值", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(2);
    const embedder = new TFIDFEmbedding(2);
    void embedder;
    await store.upsert([
      { id: "a", vector: [1, 0], metadata: { memory_type: "episodic" } },
      { id: "b", vector: [0.9, 0.1], metadata: { memory_type: "semantic" } },
      { id: "c", vector: [0, 1], metadata: { memory_type: "episodic" } },
    ]);

    const hits = await store.search([1, 0], { limit: 2, filter: { memory_type: "episodic" } });
    // a 得分 1.0、c 得分 0，均通过 episodic 过滤，按分数排序
    expect(hits.map((hit) => hit.id)).toEqual(["a", "c"]);

    const all = await store.search([1, 0], { limit: 3 });
    expect(all[0]?.id).toBe("a");
    expect(all.map((hit) => hit.id)).toContain("b");

    // b 与查询的余弦相似度 ≈ 0.994，阈值需卡在 a 的 1.0 与之之间
    const strict = await store.search([1, 0], { limit: 3, scoreThreshold: 0.999 });
    expect(strict.map((hit) => hit.id)).toEqual(["a"]);
  });

  it("维度声明后不一致会报错（对应 QDRANT_VECTOR_SIZE 的坑）", async () => {
    const store = new InMemoryVectorStore();
    await store.ensureCollection(384);
    await expect(store.ensureCollection(1024)).rejects.toThrow(/维度不匹配/);
  });

  it("list/count/delete/clear", async () => {
    const store = new InMemoryVectorStore();
    await store.upsert([
      { id: "a", vector: [1], metadata: { memory_type: "rag_chunk", ns: "x" } },
      { id: "b", vector: [1], metadata: { memory_type: "episodic", ns: "y" } },
    ]);
    expect(await store.count({ memory_type: "rag_chunk" })).toBe(1);
    expect((await store.list({ memory_type: "rag_chunk" })).map((r) => r.id)).toEqual(["a"]);
    await store.delete(["a"]);
    expect(await store.count()).toBe(1);
    await store.clear();
    expect(await store.count()).toBe(0);
  });
});

describe("DocumentStore（InMemory 与 SQLite 行为一致）", () => {
  it.each([
    { name: "InMemory", build: () => new InMemoryDocumentStore() },
    { name: "SQLite", build: () => {
      const store = new SQLiteDocumentStore(join(tmpdir(), `memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
      tmpDbs.push(store);
      return store;
    } },
  ])("$name：CRUD + 结构化过滤", async ({ build }) => {
    const store = build();
    await store.init();
    const item = createMemoryItem({
      content: "用户完成了第一个项目",
      memoryType: "episodic",
      importance: 0.8,
      timestamp: "2026-01-01T00:00:00.000Z",
      metadata: { session_id: "s1", user_id: "u1", event_type: "milestone" },
    });
    await store.upsert(item);
    expect((await store.get(item.id))?.content).toBe(item.content);

    await store.update(item.id, { importance: 0.9 });
    expect((await store.get(item.id))?.importance).toBeCloseTo(0.9);

    expect(await store.count({ sessionId: "s1" })).toBe(1);
    expect(await store.count({ sessionId: "s2" })).toBe(0);
    expect(await store.count({ minImportance: 0.95 })).toBe(0);
    expect(await store.count({ since: "2026-01-02" })).toBe(0);

    expect(await store.delete(item.id)).toBe(true);
    expect(await store.get(item.id)).toBeUndefined();
  });

  it("SQLite 重开同一文件数据仍在（持久化语义）", async () => {
    const path = join(tmpdir(), `memory-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const first = new SQLiteDocumentStore(path);
    tmpDbs.push(first);
    await first.init();
    const item = createMemoryItem({ content: "跨会话记忆", memoryType: "semantic" });
    await first.upsert(item);
    await first.close();

    const second = new SQLiteDocumentStore(path);
    tmpDbs.push(second);
    await second.init();
    expect((await second.get(item.id))?.content).toBe("跨会话记忆");
  });
});

describe("InMemoryGraphStore", () => {
  it("实体合并 memoryIds + 关系一跳扩张", async () => {
    const graph = new InMemoryGraphStore();
    await graph.addEntity({ name: "Python", type: "CONCEPT", memoryIds: ["m1"] });
    await graph.addEntity({ name: "Python", type: "CONCEPT", memoryIds: ["m2"] });
    await graph.addEntity({ name: "TypeScript", type: "CONCEPT", memoryIds: ["m3"] });
    await graph.addRelation({
      sourceName: "Python",
      targetName: "TypeScript",
      relation: "RELATED_TO",
    });

    expect((await graph.getEntity("Python"))?.memoryIds).toEqual(["m1", "m2"]);
    const memoryIds = await graph.getMemoryIdsForEntities(["Python"]);
    expect(memoryIds).toEqual(expect.arrayContaining(["m1", "m2", "m3"]));
    expect(await graph.getRelationsForEntities(["Python"])).toHaveLength(1);
  });

  it("removeMemoryAssociations 级联清理：数组引用 + 来源关系 + 空实体", async () => {
    const graph = new InMemoryGraphStore();
    await graph.addEntity({ name: "Qdrant", type: "CONCEPT", memoryIds: ["m1", "m2"] });
    await graph.addEntity({ name: "SQLite", type: "CONCEPT", memoryIds: ["m2"] });
    await graph.addRelation({
      sourceName: "Qdrant",
      targetName: "SQLite",
      relation: "RELATED_TO",
      memoryId: "m2",
    });

    await graph.removeMemoryAssociations("m2");

    expect((await graph.getEntity("Qdrant"))?.memoryIds).toEqual(["m1"]);
    // SQLite 只被 m2 引用 → 清零后被剪除
    expect(await graph.getEntity("SQLite")).toBeUndefined();
    expect(await graph.getRelationsForEntities(["Qdrant"])).toHaveLength(0);
  });
});
