/**
 * 示例：四种记忆类型深度解析（对应书 8.2 code 03/09）
 *
 * 工作记忆：容量/TTL/混合词法检索
 * 情景记忆：SQLite 文档 + 向量双库
 * 语义记忆：向量 + 知识图谱混合检索（实体抽取）
 * 感知记忆：模态推断与过滤
 * 全部使用可注入的内存桩 + TFIDF 嵌入——离线可跑。
 */

import "dotenv/config";
import {
  InMemoryDocumentStore,
  InMemoryGraphStore,
  InMemoryVectorStore,
  MemoryManager,
  createEmbeddingService,
  createMemoryItem,
} from "../../src/index";
import { WorkingMemory } from "../../src/memory/types/working";
import { RuleBasedEntityExtractor } from "../../src/memory/types/semantic";
import { inferModality } from "../../src/memory/types/perceptual";

async function main() {
  const embedder = createEmbeddingService();
  const vectorStore = new InMemoryVectorStore();
  const graphStore = new InMemoryGraphStore();
  const documentStore = new InMemoryDocumentStore();

  // ── 1. 工作记忆：容量 5 + TTL 60 分钟（书 8.2.5-(1)）──
  console.log("══ 1. 工作记忆 ══");
  const working = new WorkingMemory({ maxCapacity: 5, ttlMinutes: 60 });
  for (let i = 0; i < 7; i++) {
    await working.add(
      createMemoryItem({
        content: `工作记忆条目 ${i + 1}`,
        memoryType: "working",
        importance: i / 10,
      }),
    );
  }
  console.log(`容量 5，写入 7 条 → 现存 ${(await working.list()).length} 条（重要性最低的被淘汰）`);
  const hits = await working.retrieve("条目 6", 3);
  console.log(`检索"条目 6" → ${hits.map((hit) => hit.item.content).join(" | ")}`);

  // ── 2. 情景记忆：双库写入 + 时间线（书 8.2.5-(2)）──
  console.log("\n══ 2. 情景记忆 ══");
  const manager = new MemoryManager({
    userId: "types_demo",
    embedder,
    vectorStore,
    graphStore,
    documentStore,
    enablePerceptual: true,
  });
  await manager.addMemory({
    content: "张三完成了第一个 TypeScript 项目",
    memoryType: "episodic",
    importance: 0.8,
    metadata: { event_type: "milestone" },
  });
  console.log(
    `情景记忆入库 → SQLite ${await documentStore.count({ memoryType: "episodic" })} 条, ` +
      `向量库 ${await vectorStore.count({ memory_type: "episodic" })} 条`,
  );

  // ── 3. 语义记忆：实体抽取 → 图谱（书 8.2.5-(3)）──
  console.log("\n══ 3. 语义记忆 ══");
  const extractor = new RuleBasedEntityExtractor();
  const sample = "《HelloAgents》教程介绍了“记忆系统”与 RAG 检索增强";
  const { entities, relations } = extractor.extract(sample);
  console.log(`实体: ${entities.map((entity) => `${entity.name}(${entity.type})`).join(", ")}`);
  console.log(
    `关系: ${relations.map((relation) => `${relation.sourceName} —${relation.relation}→ ${relation.targetName}`).join("; ")}`,
  );
  await manager.addMemory({ content: sample, memoryType: "semantic", importance: 0.9 });
  const graphEntities = await graphStore.listEntities();
  console.log(
    `图谱实体数: ${graphEntities.length}（${graphEntities.map((entity) => entity.name).slice(0, 5).join(", ")}…）`,
  );

  // ── 4. 感知记忆：模态推断（书 8.2.5-(4)）──
  console.log("\n══ 4. 感知记忆 ══");
  for (const file of ["photo.png", "song.mp3", "notes.txt", "paper.pdf"]) {
    console.log(`  ${file} → ${inferModality(file)}`);
  }
  await manager.addMemory({
    content: "一张 TypeScript 泛型代码截图",
    memoryType: "perceptual",
    metadata: { modality: "image", raw_data: "uploads/generics.png" },
  });
  const images = await manager.searchMemories({
    query: "代码截图",
    memoryTypes: ["perceptual"],
    modality: "image",
  });
  console.log(`模态过滤检索 image → ${images.length} 条: ${images[0]?.item.content ?? "-"}`);
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
