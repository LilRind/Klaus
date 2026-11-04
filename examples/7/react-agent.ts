import "dotenv/config";
import { OpenAICompatLLM, ReActAgent, ToolRegistry, CalculatorTool } from "../../src/index";

const llm = new OpenAICompatLLM();
const registry = new ToolRegistry().register(new CalculatorTool());
const agent = new ReActAgent("ReAct计算助手", llm, registry, { maxSteps: 5 });

const answer = await agent.run("计算 sqrt(144) 加上 6*7，给出最终数值");
console.log(`\n最终回答: ${answer}`);
console.log(
  "执行历史:\n" + agent.currentHistory.map((line) => `  ${line}`).join("\n"),
);
