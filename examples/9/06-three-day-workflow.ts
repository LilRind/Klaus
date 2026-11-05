/**
 * 示例 06：完整三天工作流演示（对应书 9.6 code 06，需要 .env 配置 LLM）
 *
 * 第一天：探索代码库 → 第二天：分析代码质量 → 第三天：规划重构任务
 * → 一周后：检查进度。验证跨会话连贯性（笔记 + 记忆 + 上下文构建）。
 */

import "dotenv/config";
import path from "node:path";
import { CodebaseMaintainer } from "./codebase-maintainer";

async function main() {
  const maintainer = new CodebaseMaintainer({
    project: "demo_project",
    codebasePath: path.resolve(import.meta.dirname, "assets", "codebase"),
  });

  console.log("========== 第一天：探索代码库 ==========");
  console.log(await maintainer.explore());

  console.log("\n========== 第二天：分析代码质量 ==========");
  console.log(await maintainer.analyze());

  console.log("\n========== 第三天：规划重构任务 ==========");
  await maintainer.createNote({
    title: "重构计划（手动补充）",
    content: [
      "## 任务清单",
      "- [ ] data_processor: 补齐 TODO 的异常处理",
      "- [ ] api_client: 增加超时与重试",
      "- [ ] utils: 消除重复的校验逻辑",
      "",
      "## 时间安排",
      "- 本周完成 data_processor",
      "- 下周完成 api_client 与 utils",
    ].join("\n"),
    type: "decision",
    tags: ["refactor", "plan"],
    priority: 0.9,
  });
  console.log(await maintainer.planNextSteps());

  console.log("\n========== 一周后：检查进度 ==========");
  const stats = await maintainer.getStats();
  console.log("笔记统计:", JSON.stringify(stats.notes, null, 2));
  console.log(await maintainer.generateReport());

  await maintainer.close();
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
