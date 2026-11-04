/**
 * 示例：记忆 CRUD 生命周期验证（写入→读取→更新→再读→删除→再读）
 *
 * 用"计数差值"断言（操作前后的 Qdrant/SQLite 计数变化），
 * 不 clearAll、不影响库中已有数据——可以反复跑、随时跑。
 * 每一步同时验证三个库的一致性：
 * - episodic：SQLite 行数 + Qdrant 向量数 + 语义检索命中
 * - semantic：Qdrant 向量 + Neo4j 图谱实体（删除需级联清理）
 * 任何一步 ❌ 即以非零退出码结束（可当冒烟测试用）。
 */

import "dotenv/config";
import { MemoryManager, createEmbeddingService } from "../../src/index";
import {
  createDefaultDocumentStore,
  createDefaultGraphStore,
  createDefaultVectorStore,
} from "../../src/memory/storage/factories";

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
  const mark = condition ? "✅" : "❌";
  failures += condition ? 0 : 1;
  console.log(`  ${mark} ${label}${detail === undefined ? "" : `（${detail}）`}`);
}

async function main() {
  const vectorStore = createDefaultVectorStore();
  const graphStore = createDefaultGraphStore();
  const documentStore = createDefaultDocumentStore();
  console.log(
    `后端: ${vectorStore.constructor.name} / ${graphStore.constructor.name} / ${documentStore.constructor.name}\n`,
  );

  const manager = new MemoryManager({
    userId: "crud_verify_user",
    enablePerceptual: true,
    embedder: createEmbeddingService(),
    vectorStore,
    graphStore,
    documentStore,
  });

  // ── 基线计数（差值断言的参照）──
  const baseVector = await vectorStore.count({ memory_type: "episodic" });
  const baseRows = await documentStore.count({ memoryType: "episodic" });
  const baseSemantic = await vectorStore.count({ memory_type: "semantic" });

  // ══ ① 写入 ══
  console.log("① 写入 episodic 记忆");
  const id = await manager.addMemory({
    content: "张三学会了 Qdrant 向量数据库的增删改查",
    memoryType: "episodic",
    importance: 0.9,
  });
  check(
    "Qdrant 向量 +1",
    (await vectorStore.count({ memory_type: "episodic" })) === baseVector + 1,
  );
  check(
    "SQLite 行数 +1",
    (await documentStore.count({ memoryType: "episodic" })) === baseRows + 1,
  );

  // ══ ② 读取（定点读 + 语义读两条路径）══
  console.log("\n② 读取（list 定点 + search 语义）");
  const byList = (await manager.listMemories({ memoryTypes: ["episodic"] })).find(
    (item) => item.id === id,
  );
  check("list 按 ID 命中", byList !== undefined);
  const bySearch = (
    await manager.searchMemories({
      query: "Qdrant 数据库",
      memoryTypes: ["episodic"],
      limit: 10,
    })
  ).find((result) => result.item.id === id);
  check(
    "search 语义命中",
    bySearch !== undefined,
    bySearch ? `得分 ${bySearch.score.toFixed(3)}` : undefined,
  );

  // ══ ③ 更新后再读取 ══
  console.log("\n③ 更新内容后再次读取");
  await manager.updateMemory(id, {
    content: "张三学会了 Neo4j 图数据库的增删改查",
    importance: 0.95,
  });
  const afterUpdate = (
    await manager.listMemories({ memoryTypes: ["episodic"] })
  ).find((item) => item.id === id);
  check("读到新内容", afterUpdate?.content.includes("Neo4j") === true);
  check(
    "旧内容已替换",
    (await manager.listMemories({ memoryTypes: ["episodic"] })).every(
      (item) => !item.content.includes("Qdrant 向量数据库"),
    ),
  );
  check(
    "新内容可被语义检索",
    (
      await manager.searchMemories({
        query: "Neo4j 图数据库",
        memoryTypes: ["episodic"],
        limit: 10,
      })
    ).some((result) => result.item.id === id),
  );
  check(
    "更新不产生重复向量（upsert 语义）",
    (await vectorStore.count({ memory_type: "episodic" })) === baseVector + 1,
  );

  // ══ ④ 删除后再读取 ══
  console.log("\n④ 删除后再次读取");
  await manager.removeMemory(id);
  check(
    "list 已查无此 ID",
    (await manager.listMemories({ memoryTypes: ["episodic"] })).every(
      (item) => item.id !== id,
    ),
  );
  check(
    "search 已无法命中",
    !(
      await manager.searchMemories({
        query: "Neo4j 增删改查",
        memoryTypes: ["episodic"],
        limit: 10,
      })
    ).some((result) => result.item.id === id),
  );
  check(
    "Qdrant 向量同步删除",
    (await vectorStore.count({ memory_type: "episodic" })) === baseVector,
  );
  check(
    "SQLite 行同步删除",
    (await documentStore.count({ memoryType: "episodic" })) === baseRows,
  );

  // ══ ⑤ semantic 的图谱级联清理 ══
  console.log("\n⑤ semantic 写入/删除的 Neo4j 图谱联动");
  const semanticId = await manager.addMemory({
    content: "《CRUD 验证指南》介绍了“生命周期测试”方法",
    memoryType: "semantic",
    importance: 0.9,
  });
  check(
    "图谱出现新实体",
    (await graphStore.listEntities()).some(
      (entity) => entity.name === "CRUD 验证指南",
    ),
  );
  await manager.removeMemory(semanticId);
  check(
    "向量同步删除",
    (await vectorStore.count({ memory_type: "semantic" })) === baseSemantic,
  );
  const danglingEntities = (await graphStore.listEntities()).filter((entity) =>
    entity.memoryIds.includes(semanticId),
  );
  check(
    "图谱无悬挂引用（实体已清理）",
    danglingEntities.length === 0,
    danglingEntities.length
      ? `残留: ${danglingEntities.map((e) => e.name).join(", ")}`
      : undefined,
  );

  await manager.close();
  await graphStore.close?.();
  await documentStore.close?.();
  console.log(
    failures === 0
      ? "\n✅ CRUD 生命周期验证全部通过"
      : `\n❌ ${failures} 项验证失败`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error("验证脚本执行失败:", error);
  process.exitCode = 1;
});
