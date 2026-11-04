/**
 * 示例：MemoryTool 基础操作（对应书 8.2 code 01/02/06）
 *
 * 演示统一 JSON 入口的九个 action：
 * add → search → summary → stats → forget → consolidate → clear_all
 * 嵌入默认 TFIDF 兜底（零网络零配置）。
 */

import "dotenv/config";
import { MemoryTool } from "../src/tools/builtin/memory-tool";

async function main() {
  const tool = new MemoryTool({
    userId: "demo_user",
    memoryTypes: ["working", "episodic", "semantic", "perceptual"],
  });

  const run = async (payload: Record<string, unknown>) => {
    console.log(`\n▶ ${String(payload.action)}`);
    console.log(await tool.execute(JSON.stringify(payload)));
  };

  // 四种记忆类型各写一条（对应书 8.2.3 的使用示例）
  await run({ action: "add", content: "用户刚才问了 TypeScript 泛型的问题", memory_type: "working", importance: 0.8 });
  await run({
    action: "add",
    content: "张三完成了第一个开源项目 HelloAgents 的记忆模块",
    memory_type: "episodic",
    importance: 0.85,
    event_type: "milestone",
  });
  await run({ action: "add", content: "TypeScript 是 JavaScript 的超集，带静态类型", memory_type: "semantic", importance: 0.9 });
  await run({
    action: "add",
    content: "一张 TypeScript 代码截图，包含泛型函数定义",
    memory_type: "perceptual",
    file_path: "uploads/generics.png",
    importance: 0.7,
  });

  await run({ action: "search", query: "TypeScript 类型", limit: 3 });
  await run({ action: "summary" });
  await run({ action: "stats" });

  // 记忆固化：重要的工作记忆升级为情景记忆（书 8.2.3 consolidate）
  await run({ action: "consolidate", from_type: "working", to_type: "episodic", importance_threshold: 0.7 });
  await run({ action: "stats" });

  // 遗忘策略（书 8.2.3 forget）
  await run({ action: "add", content: "随手记的无关信息", memory_type: "working", importance: 0.1 });
  await run({ action: "forget", strategy: "importance_based", threshold: 0.2 });
  await run({ action: "stats" });
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
