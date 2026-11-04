/**
 * 示例：RAG 完整管道（对应书 8.3 code 04/05/07/10）
 *
 * Markdown 文档 → 结构感知分块 → TFIDF 向量化 → 入库 → 检索
 * → （可选）MQE/HyDE 扩展检索 → LLM 智能问答。
 * 检索部分离线可跑；ask/MQE/HyDE 需要 .env 里的 LLM API。
 */

import "dotenv/config";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RAGPipeline } from "../../src/memory/rag/pipeline";
import { InMemoryVectorStore } from "../../src/memory/storage/vector-store";
import { createEmbeddingService } from "../../src/memory/embedding";
import { chunkText } from "../../src/memory/rag/document";

const KNOWLEDGE = [
  "# HelloAgents 记忆系统",
  "",
  "工作记忆容量有限，默认 50 条，TTL 默认 60 分钟，纯内存存储。",
  "",
  "情景记忆采用 SQLite 与 Qdrant 混合存储：SQLite 负责结构化字段，Qdrant 负责语义向量检索。",
  "",
  "# RAG 检索增强",
  "",
  "RAG 管道分五层七步：文档解析、分块、向量化、存储、检索、上下文构建、生成。",
  "高级检索策略包括 MQE 多查询扩展与 HyDE 假设文档。",
].join("\n");

async function main() {
  // ── 1. 分块可视化（书 8.3.4 智能分块）──
  console.log("══ 1. Markdown 结构感知分块 ══");
  for (const chunk of chunkText(KNOWLEDGE, { chunkTokens: 48, overlapTokens: 16 })) {
    console.log(
      `  [${chunk.headingPath ?? "(无标题)"}] ${chunk.content.slice(0, 40).replace(/\n/g, " ")}…`,
    );
  }

  // ── 2. 文件摄取（对应书 MarkItDown 载入，TS 版支持 md/txt/json/csv/html）──
  console.log("\n══ 2. 文件摄取 ══");
  const dir = await mkdtemp(join(tmpdir(), "rag-demo-"));
  const filePath = join(dir, "memory-knowledge.md");
  await writeFile(filePath, KNOWLEDGE, "utf-8");

  const pipeline = new RAGPipeline({
    vectorStore: new InMemoryVectorStore(),
    // 走工厂：未配 EMBED_* 降级 TFIDF 并提醒；配了云端则自动升级（示例与 .env 联动）
    embedder: createEmbeddingService(),
    ragNamespace: "demo",
  });
  const ingested = await pipeline.ingest({ filePath });
  console.log(`摄取 ${ingested.source}: ${ingested.chunkCount} 个分块`);

  // ── 3. 语义检索（离线）──
  console.log("\n══ 3. 语义检索 ══");
  for (const hit of await pipeline.search("工作记忆的容量限制", { topK: 2 })) {
    console.log(
      `  (${hit.score.toFixed(3)}) [${hit.source}] ${hit.content.slice(0, 50).replace(/\n/g, " ")}…`,
    );
  }

  // ── 4. LLM 智能问答（需要 .env 的 LLM API）──
  console.log("\n══ 4. 智能问答（LLM）══");
  try {
    const answer = await pipeline.ask("HelloAgents 的工作记忆有什么特点？", { topK: 3 });
    console.log(answer.answer);
    console.log(`  📚 来源: ${answer.sources.map((hit) => hit.source).join(", ")}`);
  } catch (error) {
    console.log(
      `  （未配置 LLM API 或调用失败，跳过：${error instanceof Error ? error.message : error}）`,
    );
  }

  // ── 5. MQE + HyDE 扩展检索（需要 LLM）──
  console.log("\n══ 5. MQE + HyDE 扩展检索（LLM）══");
  try {
    const hits = await pipeline.search("记忆组件", {
      topK: 2,
      enableMqe: true,
      mqeExpansions: 2,
      enableHyde: true,
    });
    console.log(`  扩展检索命中 ${hits.length} 条`);
  } catch (error) {
    console.log(
      `  （未配置 LLM API 或调用失败，跳过：${error instanceof Error ? error.message : error}）`,
    );
  }
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
