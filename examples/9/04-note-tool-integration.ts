/**
 * 示例 04：NoteTool 高级集成（对应书 9.4.4 code 04，需要 .env 配置 LLM）
 *
 * 笔记 → ContextPacket → ContextBuilder：长期项目追踪演示。
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import { ContextBuilder, NoteTool, OpenAICompatLLM, SimpleAgent } from "../../src";

async function main() {
  const workspace = "./project_notes_demo";
  await fs.rm(workspace, { recursive: true, force: true });
  const note = new NoteTool({ workspace });
  const builder = new ContextBuilder();
  const agent = new SimpleAgent(
    "ProjectAssistant",
    new OpenAICompatLLM(),
    "你是项目助手，基于历史笔记上下文回答项目进度问题。",
  );

  // 第一次交互：记录项目状态
  await note.execute(JSON.stringify({
    action: "create",
    title: "第一阶段进展",
    content: "完成了 ContextBuilder 的 GSSC 四阶段实现，测试覆盖打分与压缩。",
    type: "task",
    status: "completed",
    tags: ["phase1"],
  }));

  // 第二次交互：把相关笔记注入上下文再提问
  const question = "我们项目现在进展如何？下一步该做什么？";
  const records = await note.searchRecords(question, 3);
  const built = await builder.build({
    query: question,
    extraPackets: note.toPackets(records),
  });
  console.log(`👤 ${question}`);
  console.log(`（注入 ${records.length} 条相关笔记，${built.tokenCount} tokens）`);
  const answer = await agent.run(`[项目笔记上下文]\n${built.context}\n\n[问题] ${question}`);
  console.log(`🤖 ${answer}`);

  console.log(`\n▶ 笔记摘要\n${await note.execute(JSON.stringify({ action: "summary" }))}`);
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
