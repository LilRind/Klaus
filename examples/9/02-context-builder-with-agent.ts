/**
 * 示例 02：ContextBuilder 与 SimpleAgent 集成（对应书 9.3 code 02）
 *
 * 自动上下文管理：每轮对话前先用 ContextBuilder 组装相关记忆，
 * 拼进用户问题再交给 Agent（需要 .env 配置 LLM）。
 */

import "dotenv/config";
import { ContextBuilder, MemoryConfig, MemoryManager, Message, OpenAICompatLLM, SimpleAgent } from "../../src";

async function main() {
  const llm = new OpenAICompatLLM();
  const memory = new MemoryManager({
    userId: "context_agent_demo",
    enableWorking: true,
    enableEpisodic: false,
    enableSemantic: false,
    enablePerceptual: false,
    config: new MemoryConfig({ embedModelType: "tfidf", databasePath: "./memory_data/ch9_agent.db" }),
  });
  const builder = new ContextBuilder({ memorySource: memory });
  const agent = new SimpleAgent("ContextAwareAgent", llm, "你是带有长期记忆的助手，回答要利用提供的上下文。");

  // 第一轮：记住用户偏好
  await memory.addMemory({ content: "用户偏好 TypeScript，示例要能离线运行", importance: 0.8 });
  const history: Message[] = [];

  for (const question of [
    "我是用什么语言写项目的？有哪些偏好？",
    "基于我的偏好，给我一个学习上下文工程的建议",
  ]) {
    const built = await builder.build({ query: question, history });
    console.log(`\n👤 ${question}`);
    console.log(`（注入上下文 ${built.tokenCount} tokens，包含 ${built.usedPackets.length} 个 packet）`);
    const answer = await agent.run(`[参考上下文]\n${built.context}\n\n[问题] ${question}`);
    console.log(`🤖 ${answer}`);
    history.push(Message.user(question), Message.assistant(answer));
  }

  await memory.close();
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
