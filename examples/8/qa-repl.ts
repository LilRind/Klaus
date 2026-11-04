/**
 * 智能文档问答助手 REPL（对应书 8.4 / code 11_Q&A_Assistant.py 的 TS 版）
 *
 * 功能面对齐书里的 gradio 助手：
 * /init 初始化（user_id）｜/load 加载 PDF/DOCX/MD 建知识库｜/ask 智能问答
 * （RAG→记忆联动默认开）｜/askx 高级检索（MQE+HyDE）｜/note 记笔记（auto_classify）
 * /recall 回顾学习历程｜/stats 统计｜/report 生成学习报告（存文件）｜/exit 退出
 * 零新依赖（readline 内置）；存储与嵌入走默认装配工厂（.env 驱动）。
 */

import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { OpenAICompatLLM } from "../../src/core/llm";
import { MemoryTool } from "../../src/tools/builtin/memory-tool";
import { RAGTool } from "../../src/tools/builtin/rag-tool";

async function main() {
  console.log("═══ 智能文档问答助手（第8章 8.4 TS 版）═══");
  console.log("命令: /init <user_id> | /load <文件路径> | /ask <问题> | /askx <问题>");
  console.log("      /note <内容> | /recall [关键词] | /stats | /report | /exit");
  console.log("提示: 先 /init 再 /load 一份 PDF/DOCX/MD，然后 /ask 提问\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let memoryTool: MemoryTool | undefined;
  let ragTool: RAGTool | undefined;
  let userId = "default_user";
  let askedCount = 0;

  const ensureInit = (): boolean => {
    if (memoryTool && ragTool) return true;
    console.log("⚠️ 请先执行 /init <user_id> 初始化助手");
    return false;
  };

  mainLoop: for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIndex = trimmed.indexOf(" ");
    const command = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();

    try {
      switch (command) {
        case "/init": {
          userId = arg || "default_user";
          const llm = new OpenAICompatLLM();
          memoryTool = new MemoryTool({
            userId,
            memoryTypes: ["working", "episodic", "semantic"],
            llm,
          });
          ragTool = new RAGTool({
            ragNamespace: `qa_repl_${userId}`,
            llm,
            memoryManager: memoryTool.memoryManager,
            autoSaveToMemory: true,
          });
          console.log(`✅ 助手已初始化（用户: ${userId}）\n`);
          break;
        }
        case "/load": {
          if (!ensureInit() || !ragTool || !arg) break;
          console.log(await ragTool.execute(JSON.stringify({ action: "add_document", file_path: arg })));
          console.log("");
          break;
        }
        case "/ask":
        case "/askx": {
          if (!ensureInit() || !ragTool || !arg) break;
          askedCount += 1;
          const advanced = command === "/askx";
          const result = await ragTool.execute(
            JSON.stringify({
              action: "ask",
              query: arg,
              enable_mqe: advanced,
              enable_hyde: advanced,
            }),
          );
          console.log(`${result}\n`);
          break;
        }
        case "/note": {
          if (!ensureInit() || !memoryTool || !arg) break;
          console.log(
            await memoryTool.execute(
              JSON.stringify({ action: "add", content: arg, auto_classify: true, importance: 0.8 }),
            ),
          );
          console.log("");
          break;
        }
        case "/recall": {
          if (!ensureInit() || !memoryTool) break;
          const query = arg || "学习";
          console.log(await memoryTool.execute(JSON.stringify({ action: "search", query, limit: 5 })));
          console.log("");
          break;
        }
        case "/stats": {
          if (!ensureInit() || !memoryTool || !ragTool) break;
          console.log(await memoryTool.execute(JSON.stringify({ action: "stats" })));
          console.log(await ragTool.execute(JSON.stringify({ action: "stats" })));
          console.log("");
          break;
        }
        case "/report": {
          if (!ensureInit() || !memoryTool) break;
          const summary = await memoryTool.execute(JSON.stringify({ action: "summary" }));
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const reportPath = `./memory_data/learning-report-${userId}-${stamp}.md`;
          const report = [
            `# 学习报告（${userId}）`,
            "",
            `- 生成时间: ${new Date().toISOString()}`,
            `- 本次会话提问次数: ${askedCount}`,
            "",
            "## 记忆摘要",
            "",
            summary,
            "",
          ].join("\n");
          await mkdir(dirname(reportPath), { recursive: true });
          await writeFile(reportPath, report, "utf-8");
          console.log(`📄 学习报告已生成: ${reportPath}\n`);
          console.log(summary + "\n");
          break;
        }
        case "/exit":
        case "/quit":
          break mainLoop;
        default:
          if (!trimmed.startsWith("/")) {
            console.log("💡 提问请用 /ask <问题>，查看全部命令直接回车看顶部提示\n");
          } else {
            console.log(`❓ 未知命令: ${command}\n`);
          }
      }
    } catch (error) {
      console.error(`❌ 命令执行失败: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  await memoryTool?.memoryManager.close();
  rl.close();
  console.log("再见！");
}

main().catch((error) => {
  console.error("启动失败:", error);
  console.error("（/init 需要 .env 配置 LLM_MODEL_ID / LLM_API_KEY / LLM_BASE_URL）");
  process.exitCode = 1;
});
