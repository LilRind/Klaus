/**
 * CodebaseMaintainer - 代码库维护助手（对应书 9.6 / 仓库版 codebase_maintainer.py）
 *
 * 完整的长程智能体实现，整合四大组件：
 *   ContextBuilder - 上下文管理（GSSC）
 *   NoteTool       - 结构化笔记（跨会话状态）
 *   TerminalTool   - 即时文件系统访问
 *   MemoryTool     - 对话记忆（默认仅 working，零外部依赖）
 *
 * 主线为仓库版 Agentic 实现：FunctionCallAgent + 工具自选，
 * 不预定义工作流，由 LLM 自主决定用哪些工具探索代码库。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  OpenAICompatLLM,
  FunctionCallAgent,
  MemoryTool,
  ContextBuilder,
  ContextConfig,
  NoteTool,
  TerminalTool,
  ToolRegistry,
} from "../../src";
import type { NoteType, NoteStatus, ChatLLM } from "../../src";
import type { MemoryManagerOptions } from "../../src/memory/manager";

export interface CodebaseMaintainerOptions {
  project: string;
  codebasePath: string;
  /** LLM 注入口（默认读 .env 创建 OpenAICompatLLM；测试注入 ScriptedLLM） */
  llm?: ChatLLM;
  /** 记忆类型（默认仅 working，避免 Qdrant 依赖；可扩四类） */
  memoryTypes?: ("working" | "episodic" | "semantic" | "perceptual")[];
  /** MemoryTool 透传配置（测试注入内存桩存储用） */
  memoryOptions?: Omit<MemoryManagerOptions, "userId" | "enableWorking" | "enableEpisodic" | "enableSemantic" | "enablePerceptual">;
}

export class CodebaseMaintainer {
  readonly project: string;
  readonly sessionId: string;

  readonly llm: ChatLLM;
  readonly memoryTool: MemoryTool;
  readonly noteTool: NoteTool;
  readonly terminalTool: TerminalTool;
  readonly contextBuilder: ContextBuilder;
  readonly agent: FunctionCallAgent;

  constructor(options: CodebaseMaintainerOptions) {
    this.project = options.project;
    this.sessionId = `session_${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15)}`;

    this.llm = options.llm ?? new OpenAICompatLLM();
    this.memoryTool = new MemoryTool({
      userId: options.project,
      memoryTypes: options.memoryTypes ?? ["working"],
      ...options.memoryOptions,
    });
    this.noteTool = new NoteTool({ workspace: `./${options.project}_notes` });
    this.terminalTool = new TerminalTool({
      workspace: options.codebasePath,
      timeout: 60_000,
    });

    // ContextBuilder 直接注入 MemoryManager（类型安全源，对应书 9.6.2 架构）
    this.contextBuilder = new ContextBuilder({
      memorySource: this.memoryTool.memoryManager,
      config: new ContextConfig({
        maxTokens: 4000,
        reserveRatio: 0.15,
        minRelevance: 0.2,
        enableCompression: true,
      }),
    });

    const registry = new ToolRegistry()
      .register(this.terminalTool)
      .register(this.noteTool)
      .register(this.memoryTool);

    this.agent = new FunctionCallAgent("CodebaseMaintainer", this.llm, registry, {
      systemPrompt: this.buildBaseSystemPrompt(),
      maxToolIterations: 10,
    });
  }

  /** 单入口：Agentic 自主用工具（对应仓库版 run） */
  async run(input: string): Promise<string> {
    const relevantNotes = await this.noteTool.searchRecords(input, 3);
    const notePackets = this.noteTool.toPackets(relevantNotes);
    const built = await this.contextBuilder.build({
      query: input,
      history: [],
      extraPackets: notePackets,
    });
    const prompt = [
      "以下是本次任务相关的历史上下文，供参考（不需要复述）：",
      built.context,
      "",
      "当前任务：",
      input,
    ].join("\n");
    return this.agent.run(prompt);
  }

  // ---------- 便利方法（对应仓库版 explore/analyze/plan_next_steps/...） ----------

  explore(target = "."): Promise<string> {
    return this.run(`请探索代码库（目标: ${target}）：先用 terminal 的 ls/tree 了解结构，再挑 1-2 个关键文件用 cat/head 阅读，最后用 note 记录你对代码库结构的理解（类型 insight）。`);
  }

  analyze(focus = ""): Promise<string> {
    return this.run(`请分析代码质量${focus ? `，重点关注 ${focus}` : ""}：用 terminal 的 grep 查找 TODO/FIXME 和潜在问题，把发现的问题用 note 记录（类型 blocker），最后总结整体质量。`);
  }

  planNextSteps(): Promise<string> {
    return this.run("请根据已有笔记回顾项目进度，规划下一步重构任务，并创建详细的重构计划笔记（类型 decision，含任务清单）。");
  }

  async createNote(input: {
    title: string;
    content: string;
    type?: NoteType;
    status?: NoteStatus;
    tags?: string[];
    priority?: number;
  }): Promise<string> {
    return this.noteTool.execute(JSON.stringify({ action: "create", ...input }));
  }

  async getStats(): Promise<{
    notes: Awaited<ReturnType<NoteTool["getStats"]>>;
    summary: string;
  }> {
    const notes = await this.noteTool.getStats();
    const summary = await this.memoryTool.execute(
      JSON.stringify({ action: "summary" }),
    );
    return { notes, summary };
  }

  async generateReport(saveToFile = true): Promise<string> {
    const report = await this.noteTool.generateReport();
    if (saveToFile) {
      const dir = path.join(this.noteTool.workspace, "reports");
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `report_${Date.now()}.md`);
      await fs.writeFile(file, report, "utf8");
      return `📄 报告已生成: ${file}（${report.length} 字符）`;
    }
    return report;
  }

  async close(): Promise<void> {
    await this.memoryTool.memoryManager.close();
  }

  private buildBaseSystemPrompt(): string {
    return [
      `你是"${this.project}"项目的代码库维护助手（长程智能体）。`,
      "",
      "## 可用工具与使用策略",
      "- terminal: 白名单命令探索代码库（ls/tree 看结构 → grep 搜模式 → cat/head 读文件）",
      "- note: 结构化笔记，记录任务状态/阻塞点/决策/行动项（type: task|insight|blocker|decision|action）",
      "- memory: 对话记忆的存取（重要结论用 add 记住，可用 search 回忆）",
      "",
      "## 工作准则",
      "1. 优先自己动手用工具获取事实，再下结论",
      "2. 每次发现重要信息（结构理解/问题/决策）都应记录为 note，跨会话才不丢",
      "3. blocker 类型笔记要写清问题描述与位置；完成的事项把 status 更新为 completed",
      "4. 回答简洁、基于工具输出的证据",
    ].join("\n");
  }
}

