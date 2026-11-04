/**
 * 问答助手核心（书 8.4 的 TS 版）——REPL 与 Web UI 共用的命令引擎。
 *
 * 命令集（对齐书 gradio 助手功能面）：
 * /init /load /ask /askx /note /recall /stats /report /extract /exit
 * 联动：RAG→记忆（autoSave）、auto_classify、LLM 实体抽取（可开关）。
 */

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpenAICompatLLM } from "../../src/core/llm";
import { MemoryTool } from "../../src/tools/builtin/memory-tool";
import { RAGTool } from "../../src/tools/builtin/rag-tool";
import { LLMEntityExtractor } from "../../src/memory/types/semantic";

export class QAAssistant {
  private memoryTool?: MemoryTool;
  private ragTool?: RAGTool;
  private entityExtractor?: LLMEntityExtractor;
  private userId = "default_user";
  private askedCount = 0;

  get initialized(): boolean {
    return this.memoryTool !== undefined && this.ragTool !== undefined;
  }

  get currentUser(): string {
    return this.userId;
  }

  /** 执行一行 /命令；纯文本视为 /ask。返回可直接展示的输出文本。 */
  async executeCommand(line: string): Promise<string> {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const normalized = trimmed.startsWith("/") ? trimmed : `/ask ${trimmed}`;
    const spaceIndex = normalized.indexOf(" ");
    const command = (spaceIndex === -1 ? normalized : normalized.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? "" : normalized.slice(spaceIndex + 1).trim();

    if (command !== "/init" && !this.initialized) {
      return "⚠️ 请先执行 /init <user_id> 初始化助手";
    }

    switch (command) {
      case "/init":
        return this.init(arg || "default_user");
      case "/load":
        if (!arg) return "❌ 用法: /load <文件路径>（支持 pdf/docx/md/txt/json/csv/html）";
        return this.output(
          await this.ragTool!.execute(JSON.stringify({ action: "add_document", file_path: arg })),
        );
      case "/ask":
      case "/askx": {
        if (!arg) return "❌ 用法: /ask <问题>";
        this.askedCount += 1;
        const advanced = command === "/askx";
        return this.output(
          await this.ragTool!.execute(
            JSON.stringify({
              action: "ask",
              query: arg,
              enable_mqe: advanced,
              enable_hyde: advanced,
            }),
          ),
        );
      }
      case "/note":
        if (!arg) return "❌ 用法: /note <内容>";
        return this.output(
          await this.memoryTool!.execute(
            JSON.stringify({ action: "add", content: arg, auto_classify: true, importance: 0.8 }),
          ),
        );
      case "/recall":
        return this.output(
          await this.memoryTool!.execute(
            JSON.stringify({ action: "search", query: arg || "学习", limit: 5 }),
          ),
        );
      case "/stats":
        return this.output(
          (await this.memoryTool!.execute(JSON.stringify({ action: "stats" }))) +
            "\n" +
            (await this.ragTool!.execute(JSON.stringify({ action: "stats" }))),
        );
      case "/report":
        return this.report();
      case "/extract": {
        if (!this.entityExtractor) return "ℹ️ 当前未启用 LLM 实体抽取（/init 时注入才可开关）";
        const on = ["on", "true", "1", "开"].includes(arg.toLowerCase());
        const off = ["off", "false", "0", "关"].includes(arg.toLowerCase());
        if (!on && !off) {
          return `当前 LLM 实体抽取: ${this.entityExtractor.isEnabled ? "开" : "关"}（/extract on|off 切换）`;
        }
        this.entityExtractor.setEnabled(on);
        return `✅ LLM 实体抽取已${on ? "开启（语义记忆写入走 LLM 抽取）" : "关闭（回落规则抽取器，不再调用 LLM）"}`;
      }
      case "/exit":
      case "/quit":
        return "👋 bye（Web 模式下关闭页面即可，/exit 仅 REPL 有效）";
      default:
        return `❓ 未知命令: ${command}。可用: /init /load /ask /askx /note /recall /stats /report /extract`;
    }
  }

  /** Web 上传：base64 落盘到知识库目录并直接摄取 */
  async uploadAndLoad(filename: string, contentBase64: string): Promise<string> {
    if (!this.initialized) return "⚠️ 请先执行 /init <user_id> 初始化助手";
    const safeName = filename.replace(/[\\/:*?"<>|]/g, "_");
    const uploadDir = "./knowledge_uploads";
    const filePath = join(uploadDir, safeName);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from(contentBase64, "base64"));
    return this.executeCommand(`/load ${filePath}`);
  }

  async close(): Promise<void> {
    await this.memoryTool?.memoryManager.close();
  }

  private async init(userId: string): Promise<string> {
    this.userId = userId;
    const llm = new OpenAICompatLLM();
    this.entityExtractor = new LLMEntityExtractor(llm);
    this.memoryTool = new MemoryTool({
      userId,
      memoryTypes: ["working", "episodic", "semantic"],
      llm,
      entityExtractor: this.entityExtractor,
    });
    this.ragTool = new RAGTool({
      ragNamespace: `qa_${userId}`,
      llm,
      memoryManager: this.memoryTool.memoryManager,
      autoSaveToMemory: true,
    });
    return `✅ 助手已初始化（用户: ${userId}）｜LLM 实体抽取: 开（/extract off 关闭）`;
  }

  private async report(): Promise<string> {
    const summary = await this.memoryTool!.execute(JSON.stringify({ action: "summary" }));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const reportPath = `./memory_data/learning-report-${this.userId}-${stamp}.md`;
    const report = [
      `# 学习报告（${this.userId}）`,
      "",
      `- 生成时间: ${new Date().toISOString()}`,
      `- 本次会话提问次数: ${this.askedCount}`,
      "",
      "## 记忆摘要",
      "",
      summary,
      "",
    ].join("\n");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, report, "utf-8");
    return `📄 学习报告已生成: ${reportPath}\n\n${summary}`;
  }

  private output(text: string): string {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
}
