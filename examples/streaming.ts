/**
 * 流式输出示例（对应书 7.2 的 my_main.py：验证自定义 provider + think 流式输出）
 * 展示两个层级：LLM 裸流式 / SimpleAgent.streamRun
 */
import "dotenv/config";
import { OpenAICompatLLM, SimpleAgent, ToolRegistry, CalculatorTool } from "../src/index";

const llm = new OpenAICompatLLM();
console.log(`provider: ${llm.provider} | model: ${llm.model}\n`);

// 1. LLM 裸流式（对应书的 llm.think）
console.log("── LLM 流式 ──");
process.stdout.write("回复: ");
for await (const chunk of llm.stream([
  { role: "user", content: "用两句话介绍一下你自己。" },
])) {
  process.stdout.write(chunk);
}
console.log("\n");

// 2. Agent 级流式
console.log("── SimpleAgent.streamRun ──");
const agent = new SimpleAgent(
  "流式助手",
  llm,
  "你是一个简洁的助手",
  undefined,
  new ToolRegistry().register(new CalculatorTool()),
);
process.stdout.write("回复: ");
for await (const chunk of agent.streamRun("一句话解释什么是防抖")) {
  process.stdout.write(chunk);
}
console.log(`\n\n历史消息数: ${agent.getHistory().length}`);
