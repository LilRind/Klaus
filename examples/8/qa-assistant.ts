/**
 * 问答助手核心（书 8.4 的 TS 版）——REPL 与 Web UI 共用的命令引擎。
 *
 * 命令集（对齐书 gradio 助手功能面）：
 * /init /load /ask /askx /note /recall /stats /report /extract /record /log /exit
 * 联动：RAG→记忆（autoSave）、auto_classify、LLM 实体抽取（可开关）。
 * 逐字聊天日志（jsonl append-only）默认开启，/log off 关闭。
 */

import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { OpenAICompatLLM } from "../../src/core/llm";
import { MemoryTool } from "../../src/tools/builtin/memory-tool";
import { RAGTool } from "../../src/tools/builtin/rag-tool";
import { LLMEntityExtractor } from "../../src/memory/types/semantic";
import { ChatLog, type ChatLogEntry } from "./chat-log";

export class QAAssistant {
  private memoryTool?: MemoryTool;
  private ragTool?: RAGTool;
  private entityExtractor?: LLMEntityExtractor;
  private userId = "default_user";
  private askedCount = 0;
  private qaRecordEnabled = true;
  private readonly chatLog = new ChatLog();
  private readonly session = `session_${formatStamp(new Date())}`;

  get initialized(): boolean {
    return this.memoryTool !== undefined && this.ragTool !== undefined;
  }

  get currentUser(): string {
    return this.userId;
  }

  /** 执行一行 /命令；纯文本视为 /ask。逐字记入 jsonl 审计日志后返回输出。 */
  async executeCommand(line: string): Promise<string> {
    const trimmed = line.trim();
    if (!trimmed) return "";
    const normalized = trimmed.startsWith("/") ? trimmed : `/ask ${trimmed}`;
    const spaceIndex = normalized.indexOf(" ");
    const command = (spaceIndex === -1 ? normalized : normalized.slice(0, spaceIndex)).toLowerCase();
    const arg = spaceIndex === -1 ? "" : normalized.slice(spaceIndex + 1).trim();

    const startedAt = Date.now();
    let output: string;
    try {
      output = await this.dispatch(command, arg);
    } catch (error) {
      output = `❌ 命令执行失败: ${error instanceof Error ? error.message : String(error)}`;
    }
    // 审计日志：jsonl 留痕默认开（/log off 关）；md 可读转录默认关（/transcript on 开）
    const entry: ChatLogEntry = {
      ts: new Date().toISOString(),
      user: this.userId,
      session: this.session,
      command,
      arg,
      output,
      durationMs: Date.now() - startedAt,
      ok: !output.startsWith("❌"),
    };
    await this.chatLog.append(entry);
    await this.chatLog.appendMarkdown(entry);
    return output;
  }

  private async dispatch(command: string, arg: string): Promise<string> {
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
        const answer = await this.ragTool!.execute(
            JSON.stringify({
              action: "ask",
              query: arg,
              enable_mqe: advanced,
              enable_hyde: advanced,
            }),
        );
        // 学习历程记录（书 8.4）：问答对存为情景记忆，让 /recall 能找回"我问过什么"
        let recordNote = "";
        if (this.qaRecordEnabled && !answer.startsWith("❌")) {
          const answerBody = (answer.split("\n📚")[0] ?? answer).trim();
          await this.memoryTool!.execute(
            JSON.stringify({
              action: "add",
              content:
                `用户提问：${arg}\n助手回答：${answerBody.slice(0, 300)}${answerBody.length > 300 ? "…" : ""}`,
              memory_type: "episodic",
              importance: 0.75,
              event_type: "qa_exchange",
            }),
          );
          recordNote = "\n📝 学习历程已记录（/recall 可找回，/record off 关闭）";
        }
        return this.output(answer + recordNote);
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
        // 裸命令 = 切换（Web 按钮直接可用）；显式 on|off 指定目标态
        let on = ["on", "true", "1", "开"].includes(arg.toLowerCase());
        const off = ["off", "false", "0", "关"].includes(arg.toLowerCase());
        if (!on && !off) on = !this.entityExtractor.isEnabled;
        this.entityExtractor.setEnabled(on);
        return `✅ LLM 实体抽取已${on ? "开启（语义记忆写入走 LLM 抽取）" : "关闭（回落规则抽取器，不再调用 LLM）"}`;
      }
      case "/record": {
        let on = ["on", "true", "1", "开"].includes(arg.toLowerCase());
        const off = ["off", "false", "0", "关"].includes(arg.toLowerCase());
        if (!on && !off) on = !this.qaRecordEnabled;
        this.qaRecordEnabled = on;
        return `✅ 问答历程记录已${on ? "开启（每次 /ask 存一条情景记忆）" : "关闭（不再记录问答对）"}`;
      }
      case "/log": {
        let on = ["on", "true", "1", "开"].includes(arg.toLowerCase());
        const off = ["off", "false", "0", "关"].includes(arg.toLowerCase());
        if (!on && !off) on = !this.chatLog.isEnabled;
        this.chatLog.setEnabled(on);
        return `✅ 逐字聊天日志已${on ? "开启（每次命令 append 到 memory_data/chat-logs/*.jsonl）" : "关闭（本次命令之后不再记录）"}`;
      }
      case "/transcript": {
        let on = ["on", "true", "1", "开"].includes(arg.toLowerCase());
        const off = ["off", "false", "0", "关"].includes(arg.toLowerCase());
        if (!on && !off) on = !this.chatLog.isMarkdownEnabled;
        this.chatLog.setMarkdownEnabled(on);
        return `✅ md 转录已${on ? "开启（逐条写入 memory_data/chat-logs/*.md，含用户与助手发言）" : "关闭"}`;
      }
      case "/exit":
      case "/quit":
        return "👋 bye（Web 模式下关闭页面即可，/exit 仅 REPL 有效）";
      default:
        return `❓ 未知命令: ${command}。可用: /init /load /ask /askx /note /recall /stats /report /extract /record /log /transcript`;
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
    // 复盘统计：从当日逐字日志汇总（命令分布 / 提问耗时 / 时间线）
    const chat = await this.chatLog.summarize(this.userId);
    const chatSection =
      chat.totalCommands === 0
        ? ""
        : [
            "## 当日会话统计（来自逐字日志）",
            "",
            `- 命令总数: ${chat.totalCommands}（提问 ${chat.askCount} 次，平均耗时 ${(chat.avgAskMs / 1000).toFixed(1)}s）`,
            `- 命令分布: ${Object.entries(chat.commandCounts).map(([cmd, n]) => `${cmd}×${n}`).join("、")}`,
            "",
            "### 最近时间线",
            "",
            ...chat.timeline.map((item) => `- ${item.ts} ${item.command} ${item.arg}`),
            "",
          ].join("\n");
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
      chatSection,
    ].join("\n");
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, report, "utf-8");
    return `📄 学习报告已生成: ${reportPath}\n\n${summary}\n\n${chatSection}`.trimEnd();
  }

  private output(text: string): string {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
