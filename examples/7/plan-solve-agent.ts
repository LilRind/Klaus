/** PlanAndSolveAgent 示例（对应书 7.4.4 test_plan_solve_agent.py 的水果店问题） */
import "dotenv/config";
import { OpenAICompatLLM, PlanAndSolveAgent } from "../../src/index";

const llm = new OpenAICompatLLM();
const agent = new PlanAndSolveAgent("我的规划执行助手", llm);

const question =
  "一个水果店周一卖出了15个苹果。周二卖出的苹果数量是周一的两倍。周三卖出的数量比周二少了5个。请问这三天总共卖出了多少个苹果？";

const result = await agent.run(question);
console.log(`\n最终结果: ${result}`);
console.log(`执行计划: ${agent.lastPlan.join(" → ")}`);
console.log(`对话历史: ${agent.getHistory().length} 条消息`);
