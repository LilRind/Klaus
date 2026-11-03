/**
 * 30 秒体验（对标书 7.1.3 / 作者 quickstart.py 的 TS 等价物）：
 *   基础对话 → 计算器工具调用 → 查看历史
 */
import "dotenv/config";
import {
  OpenAICompatLLM,
  SimpleAgent,
  ToolRegistry,
  CalculatorTool,
} from "../src/index";

// 加载环境变量后创建 LLM 实例 - 框架自动检测 provider
const llm = new OpenAICompatLLM();
console.log(`provider: ${llm.provider} | model: ${llm.model}`);

// 创建 SimpleAgent（先不带工具，纯对话）
const agent = new SimpleAgent("AI助手", llm, "你是一个有用的AI助手");

const intro = await agent.run("你好！请介绍一下自己");
console.log(`\n${intro}\n`);

// 添加工具功能：计算器
agent.addTool(new ToolRegistry().register(new CalculatorTool()));

const answer = await agent.run("请帮我计算 2 + 3 * 4");
console.log(`\n${answer}`);

// 查看对话历史
console.log(`\n历史消息数: ${agent.getHistory().length}`);
