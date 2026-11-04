import "dotenv/config";
import { OpenAICompatLLM, SimpleAgent, ToolRegistry, CalculatorTool } from "../../src/index";

const llm = new OpenAICompatLLM();
const registry = new ToolRegistry().register(new CalculatorTool());
const agent = new SimpleAgent(
  "计算助手",
  llm,
  "你是一个严谨的计算助手，遇到数学计算必须使用计算器工具。",
  undefined,
  registry,
);

const answer = await agent.run("请帮我计算 (12+8)*3 再除以 5");
console.log(`\n最终回答: ${answer}`);
console.log(`历史消息数: ${agent.getHistory().length}`);
