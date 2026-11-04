import "dotenv/config";
import { OpenAICompatLLM } from "../../src/index";

const llm = new OpenAICompatLLM();
console.log(`检测到 provider: ${llm.provider}, model: ${llm.model}`);

const response = await llm.invoke([
  { role: "user", content: "你好，请用一句话介绍一下你自己。" },
]);
console.log(`模型回复: ${response}`);
