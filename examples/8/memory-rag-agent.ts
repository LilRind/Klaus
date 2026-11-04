/**
 * 示例：Agent 工具集成（对应书 8.1.4 快速体验 + code 08/11）
 *
 * SimpleAgent + ToolRegistry + MemoryTool + RAGTool：
 * Agent 通过 [TOOL_CALL:...] 文本协议自主调用记忆与 RAG 工具。
 * 需要 .env 里的 LLM API（对话与工具决策由 LLM 驱动）。
 */

import "dotenv/config";
import { OpenAICompatLLM, SimpleAgent, ToolRegistry } from "../../src/index";
import { MemoryTool } from "../../src/tools/builtin/memory-tool";
import { RAGTool } from "../../src/tools/builtin/rag-tool";

async function main() {
  const llm = new OpenAICompatLLM();

  const memoryTool = new MemoryTool({
    userId: "agent_demo_user",
    memoryTypes: ["working", "episodic", "semantic"],
  });
  const ragTool = new RAGTool({ ragNamespace: "agent_demo" });

  // 预置一点知识，让 RAG 有东西可查
  await ragTool.execute(
    JSON.stringify({
      action: "add_document",
      text: "HelloAgents 是 Datawhale 的开源智能体教程。第八章主题是记忆与检索：记忆系统含工作/情景/语义/感知四种类型，RAG 系统支持 MQE 与 HyDE 扩展检索。",
      title: "教程简介",
    }),
  );

  const toolRegistry = new ToolRegistry();
  toolRegistry.register(memoryTool);
  toolRegistry.register(ragTool);

  const agent = new SimpleAgent(
    "智能助手",
    llm,
    "你是一个有记忆和知识检索能力的 AI 助手。" +
      "用户告诉你重要信息时，调用 memory 工具记住它；" +
      "回答教程相关问题时，优先调用 rag 工具检索知识库。",
    undefined,
    toolRegistry,
  );

  console.log("══ 第一轮：记住用户信息 ══");
  console.log(await agent.run("你好！我叫张三，是一名 TypeScript 开发者，请记住我。"));

  console.log("\n══ 第二轮：检索教程知识 ══");
  console.log(await agent.run("HelloAgents 第八章讲了什么？"));

  console.log("\n══ 第三轮：验证跨轮记忆 ══");
  console.log(await agent.run("你还记得我是做什么的吗？"));

  console.log("\n══ 记忆统计 ══");
  console.log(await memoryTool.execute(JSON.stringify({ action: "stats" })));
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  console.error("（本示例需要 .env 配置 LLM_MODEL_ID / LLM_API_KEY / LLM_BASE_URL）");
  process.exitCode = 1;
});
