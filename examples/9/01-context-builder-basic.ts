/**
 * 示例 01：ContextBuilder 基础用法（对应书 9.3 code 01）
 *
 * 演示 GSSC 流水线：写入记忆 → build → 查看分组结构与 token 预算。
 * 记忆默认仅 working（SQLite + TFIDF 级检索），无需 Qdrant。
 */

import "dotenv/config";
import { ContextBuilder, ContextConfig, MemoryConfig, MemoryManager, Message } from "../../src";

async function main() {
  const memory = new MemoryManager({
    userId: "context_demo",
    enableWorking: true,
    enableEpisodic: false,
    enableSemantic: false,
    enablePerceptual: false,
    config: new MemoryConfig({ embedModelType: "tfidf", databasePath: "./memory_data/ch9_demo.db" }),
  });
  await memory.clearAll();

  // 准备一些记忆（对应书 9.3.4 完整使用示例）
  await memory.addMemory({ content: "用户正在学习 TypeScript 的上下文工程", importance: 0.8 });
  await memory.addMemory({ content: "ContextBuilder 的 GSSC 流水线分为 Gather/Select/Structure/Compress 四阶段", importance: 0.9 });
  await memory.addMemory({ content: "今天天气晴朗", importance: 0.1 });

  const builder = new ContextBuilder({
    memorySource: memory,
    config: new ContextConfig({ maxTokens: 500, reserveRatio: 0.2 }),
  });

  // 1. 带历史的构建
  const history = [
    Message.user("GSSC 是什么？"),
    Message.assistant("GSSC 是 Gather-Select-Structure-Compress 四阶段流水线。"),
  ];
  const built = await builder.build({ query: "上下文工程怎么构建上下文", history });
  console.log("=== 构建结果 ===");
  console.log(built.context);
  console.log(`\ntoken 估算: ${built.tokenCount}，压缩: ${built.compressed}`);
  console.log(`入选 packet: ${built.usedPackets.map((p) => p.type).join(", ")}`);

  // 2. 预算极小时的压缩演示
  const tiny = new ContextBuilder({
    memorySource: memory,
    config: new ContextConfig({ maxTokens: 120 }),
  });
  const compressed = await tiny.build({ query: "GSSC", history });
  console.log("\n=== 小预算压缩 ===");
  console.log(compressed.context.slice(0, 400));
  console.log(`token: ${compressed.tokenCount}，压缩: ${compressed.compressed}`);

  await memory.close();
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
