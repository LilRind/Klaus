/**
 * 智能文档问答助手 REPL（书 8.4 gradio 助手的终端版）
 * 命令引擎在 qa-assistant.ts（与 Web UI 共享）。
 */

import { createInterface } from "node:readline/promises";
import { QAAssistant } from "./qa-assistant";

async function main() {
  console.log("═══ 智能文档问答助手（第8章 8.4 TS 版）═══");
  console.log("命令: /init <user_id> | /load <文件> | /ask <问题> | /askx <问题>(MQE+HyDE)");
  console.log("      /note <内容> | /recall [词] | /stats | /report | 开关类(extract/record/log/transcript)裸命令即切换 | /exit");
  console.log("提示: 纯文本直接回车 = /ask 提问\n");

  const assistant = new QAAssistant();
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  for await (const line of rl) {
    if (line.trim() === "/exit" || line.trim() === "/quit") break;
    const output = await assistant.executeCommand(line);
    if (output) console.log(`${output}\n`);
  }

  await assistant.close();
  rl.close();
  console.log("再见！");
}

main().catch((error) => {
  console.error("启动失败:", error);
  console.error("（/init 需要 .env 配置 LLM_MODEL_ID / LLM_API_KEY / LLM_BASE_URL）");
  process.exitCode = 1;
});
