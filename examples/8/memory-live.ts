/**
 * 示例：真实后端联机验证（第八章最终形态）
 *
 * 前置：.env 配置 QDRANT_URL / NEO4J_URI（本地 Docker 或云服务）。
 * 验证链路：默认装配工厂 → Qdrant + Neo4j + SQLite 三库真实落盘：
 * 1. 四种记忆写入与检索（向量进 Qdrant，图谱进 Neo4j，元数据进 SQLite）
 * 2. 语义记忆的实体图谱（Neo4j 里的实体与关系可查）
 * 3. RAG 知识库（独立集合）摄取与检索
 * 未配置时自动退回进程内实现，本示例退化为离线演示。
 */

import "dotenv/config";
import {
  MemoryManager,
  RAGPipeline,
  createEmbeddingService,
} from "../../src/index";
import {
  createDefaultDocumentStore,
  createDefaultGraphStore,
  createDefaultVectorStore,
} from "../../src/memory/storage/factories";

async function main() {
  const embedder = createEmbeddingService();
  const vectorStore = createDefaultVectorStore();
  const graphStore = createDefaultGraphStore();
  const documentStore = createDefaultDocumentStore();

  console.log("══ 后端装配 ══");
  console.log(`  向量库: ${vectorStore.constructor.name}`);
  console.log(`  图库:   ${graphStore.constructor.name}`);
  console.log(`  文档库: ${documentStore.constructor.name}`);
  const live = vectorStore.constructor.name === "QdrantVectorStore";
  if (!live) console.log("  ⚠️ 未检测到 QDRANT_URL，运行在进程内模式（离线）");

  const manager = new MemoryManager({
    userId: "live_user",
    enablePerceptual: true,
    embedder,
    vectorStore,
    graphStore,
    documentStore,
  });

  console.log("\n══ 1. 清场 + 四种记忆写入 ══");
  await manager.clearAll();
  await manager.addMemory({ content: "张三正在学习 TypeScript 泛型", memoryType: "working", importance: 0.8 });
  await manager.addMemory({
    content: "张三完成了 HelloAgents 第八章的复刻",
    memoryType: "episodic",
    importance: 0.9,
    metadata: { event_type: "milestone" },
  });
  await manager.addMemory({
    content: "《HelloAgents》教程介绍了“记忆系统”与 RAG 检索增强",
    memoryType: "semantic",
    importance: 0.9,
  });
  await manager.addMemory({
    content: "一张 TypeScript 泛型代码截图",
    memoryType: "perceptual",
    importance: 0.7,
    metadata: { modality: "image" },
  });
  const stats = await manager.getStats();
  console.log(`  总计 ${stats.total} 条: working=${stats.byType.working} episodic=${stats.byType.episodic} semantic=${stats.byType.semantic} perceptual=${stats.byType.perceptual}`);

  console.log("\n══ 2. 跨类型语义检索 ══");
  for (const hit of await manager.searchMemories({ query: "TypeScript 泛型", limit: 3 })) {
    console.log(`  [${hit.memoryType}] ${hit.score.toFixed(3)} → ${hit.item.content.slice(0, 30)}…`);
  }

  console.log("\n══ 3. 三库落盘核验 ══");
  console.log(`  Qdrant episodic 向量: ${await vectorStore.count({ memory_type: "episodic" })} 条`);
  console.log(`  Qdrant semantic 向量: ${await vectorStore.count({ memory_type: "semantic" })} 条`);
  console.log(`  Qdrant perceptual 向量: ${await vectorStore.count({ memory_type: "perceptual" })} 条`);
  const entities = await graphStore.listEntities(10);
  console.log(`  Neo4j 图谱实体: ${entities.length} 个（${entities.map((e) => e.name).join(", ")}）`);
  console.log(`  SQLite 记忆行: ${await documentStore.count()} 条`);

  console.log("\n══ 4. RAG 知识库（独立集合 rag_knowledge_base）══");
  const ragVectorStore = createDefaultVectorStore({ collection: "rag_knowledge_base" });
  const rag = new RAGPipeline({
    vectorStore: ragVectorStore,
    embedder,
    ragNamespace: "live",
  });
  await rag.clear();
  await rag.ingest({
    text: [
      "# 第八章要点",
      "记忆系统分四种类型：工作记忆（TTL 60 分钟）、情景记忆（SQLite+Qdrant）、语义记忆（Qdrant+Neo4j）、感知记忆（多模态）。",
      "RAG 管道支持 MQE 多查询扩展与 HyDE 假设文档检索。",
    ].join("\n"),
    source: "第八章小结",
  });
  for (const hit of await rag.search("语义记忆用什么数据库", { topK: 2 })) {
    console.log(`  (${hit.score.toFixed(3)}) [${hit.source}] ${hit.content.slice(0, 40)}…`);
  }
  console.log(`  集合分块数: ${(await rag.stats()).chunks}`);

  await manager.close();
  await ragVectorStore.close?.();
  await graphStore.close?.();
  console.log("\n✅ 真实后端联机验证完成");
}

main().catch((error) => {
  console.error("❌ 联机验证失败:", error);
  process.exitCode = 1;
});
