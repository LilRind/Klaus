/**
 * s01–s14 对齐批量演示（自动跑各章 README"试一下"的 prompt）
 *
 * 运行：npm run example:alignment（需要 .env 配置 LLM_API_KEY / LLM_MODEL_ID 等）
 * 分章：npm run example:alignment -- s04（s01…s14 任选，多章用逗号分隔）
 * 交互式逐条验证：npm run example:alignment:repl（推荐人工验证用 REPL）
 *
 * ⚠️ 注意：
 * - bash 会真实执行 shell 命令、文件工具会真实写盘——建议在临时测试目录运行；
 * - 破坏性命令（del/rm）与越区路径会弹出 y/N 人工审批，拒绝是安全的；
 * - 单个 Agent 实例跨 prompt 复用：工具轨迹跨轮保留（s01 会话语义）。
 */

import { ALIGNMENT_PROMPTS, buildAlignmentAgent } from "./agent-assembly";

const workspace = process.cwd();
const { agent, pumpCron, dispose } = await buildAlignmentAgent({ workspace });

const stages = (process.argv[2] ?? "all")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s !== "all");
const selected = stages.length
  ? ALIGNMENT_PROMPTS.filter(([chapter]) => stages.includes(chapter))
  : ALIGNMENT_PROMPTS;

console.log(
  `s01–s14 对齐批量演示（工作区: ${workspace}，章节: ${stages.length ? stages.join(", ") : "全部"}）`,
);
console.log("人工逐条验证请用: npm run example:alignment:repl\n");

for (const [chapter, prompt] of selected) {
  console.log(`\n========== [${chapter}] ${prompt} ==========`);
  try {
    const answer = await agent.run(prompt);
    console.log(`回答: ${answer}`);
  } catch (error) {
    console.log(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  await pumpCron();
}

await dispose();
