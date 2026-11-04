/** 配置自检：只验证 .env 检测结果，不发起任何 API 请求 */
import "dotenv/config";
import { OpenAICompatLLM } from "../../src/index";

try {
  const llm = new OpenAICompatLLM();
  console.log(`✅ 配置有效`);
  console.log(`   provider: ${llm.provider}`);
  console.log(`   model:    ${llm.model}`);
  console.log(`   baseUrl:  ${llm.baseUrl}`);
} catch (error) {
  console.error(`❌ 配置有误: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
