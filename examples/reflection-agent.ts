/** ReflectionAgent 示例（对应书 7.4.3 test_reflection_agent.py） */
import "dotenv/config";
import { AgentConfig, OpenAICompatLLM, ReflectionAgent } from "../src/index";

// glm-5.3 是思考型模型：写长文前会生成大量隐藏推理，非流式调用容易超过 60s。
// 这里用 extraBody 关闭思考模式换取速度（智谱专有参数，框架层只做透传）。
const llm = new OpenAICompatLLM({
  extraBody: { thinking: { type: "disabled" } },
});

// 注释掉：暂时不考虑这个example
// 默认通用提示词：生成 → 反思 → 修改循环
// const generalAgent = new ReflectionAgent("我的反思助手", llm, {
//   config: new AgentConfig({ verbose: true }),
//   maxRounds: 2,
// });
// const result = await generalAgent.run("写一篇关于人工智能发展历程的简短文章");
// console.log(`最终结果: ${result}\n`);
// console.log(`反思反馈: ${generalAgent.lastFeedback}`);
// console.log(
//   `轨迹记录: ${generalAgent.memory.records
//     .map((r) => r.type)
//     .join(" → ")}`,
// );

// 自定义代码生成提示词（对标书中的 code_prompts）
const codeAgent = new ReflectionAgent("我的代码生成助手", llm, {
  config: new AgentConfig({ verbose: true }),
  maxRounds: 1,
  customPrompts: {
    initial: "你是TypeScript专家，请编写函数：{task}",
    reflect: "请审查代码的算法效率:\n任务:{task}\n代码:{content}",
    refine: "请根据反馈优化代码:\n任务:{task}\n反馈:{feedback}",
  },
});
const code = await codeAgent.run("实现一个防抖函数 debounce");
console.log(`\n代码结果:\n${code}`);
