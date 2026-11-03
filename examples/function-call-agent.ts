/** FunctionCallAgent 示例（对应书 7.4.5：原生函数调用对比文本协议） */
import "dotenv/config";
import {
  OpenAICompatLLM,
  FunctionCallAgent,
  ToolRegistry,
  CalculatorTool,
} from "../src/index";

const llm = new OpenAICompatLLM();
const registry = new ToolRegistry().register(new CalculatorTool());
const agent = new FunctionCallAgent("函数调用助手", llm, registry);

const answer = await agent.run("请帮我计算 sqrt(144) + 6*7");
console.log(`\n最终回答: ${answer}`);
