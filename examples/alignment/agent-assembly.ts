/**
 * 对齐装配（demo 与 REPL 共享的唯一事实源）——按教学章节累积装配
 *
 * stage 语义（lcc"每章一个 code.py"的等价物）：`--stage s05` 装配
 * base(s01–s03) + hooks(s04) + todo(s05)，不出现 task/skills/compact/
 * memory/cron 等超纲机制。机制间依赖由累积语义天然满足：
 * 选高章自动包含低章（s06 task 依赖 s04 hooks、s12 cron 交付依赖 agent）。
 *
 * 层级表：s01–s03 base（文件四件套+bash+权限；三章差异已固化在框架层，
 * 装配层等价）→ s04 hooks → s05 todo → s06 task → s07 skills →
 * s08 compact → s09 memory → s10 任务图 → s11 后台任务 → s12 cron →
 * s13 任务板/worktree/teammate → s14 MCP → s15 integrated harness →
 * s16 workflow runtime（review-changes 样例编排）。默认最新章全量。
 */

import "dotenv/config";
import path from "node:path";
import {
  OpenAICompatLLM,
  FunctionCallAgent,
  ToolRegistry,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
  BashTool,
  AgentConfig,
  AgentTraceLog,
  ConsoleApprovalPrompt,
  PermissionChecker,
  createStandardPermissionRules,
  createPackageInstallAskRule,
  createMcpPermissionChecker,
  HookRegistry,
  logHook,
  largeOutputHook,
  contextInjectHook,
  summaryHook,
  TodoWriteTool,
  createTaskTool,
  SkillLoader,
  SkillTool,
  buildSkillSystemPrompt,
  CompactTool,
  ContextCompactor,
  listMemoryFiles,
  selectRelevantMemories,
  loadMemories,
  buildMemorySystem,
  extractMemories,
  consolidateMemories,
  TaskStore,
  createTaskTools,
  TaskWorktreeManager,
  TaskBoard,
  TeamManager,
  createTeamTools,
  BackgroundManager,
  CronScheduler,
  ScheduledTurnRunner,
  ScheduleCronTool,
  ListCronsTool,
  CancelCronTool,
  McpConnectionManager,
  ConnectMcpTool,
  LlmRecovery,
  HarnessLoop,
  AsyncEventLoop,
  WorkflowRegistry,
  WorkflowRuntime,
  LlmWorkflowAgentRunner,
  WorkflowTool,
  type ExecutionState,
  type ApprovalPrompt,
  type ChatLLM,
  type Tool,
  type ScheduledPromptJob,
} from "../../src/index";
import { Message } from "../../src/core/message";

export const MAX_ALIGNMENT_STAGE = 16;

export interface AlignmentAssemblyOptions {
  /** 工作区根目录（工具围栏放开，越区裁决权交给权限层） */
  workspace: string;
  /** 审批交互；REPL 传共享行队列的审批器，demo 默认控制台审批器 */
  prompt?: ApprovalPrompt;
  /**
   * 装配层级：接受 "s05" / "5" / "s04,s05"（取最大章）/ "all"；
   * 默认 s14 全量。lcc 语义：装配到该章为止（累积）。
   */
  stage?: string;
  /** LLM 实例（默认 OpenAICompatLLM；测试注入桩即可离线构造装配） */
  llm?: ChatLLM;
}

/** 装配特性开关（banner 与分章测试共用的事实） */
export interface AlignmentAssemblyFeatures {
  hooks: boolean; // s04+
  subagent: boolean; // s06+
  skills: boolean; // s07+
  compactor: boolean; // s08+
  memory: boolean; // s09+
  taskSystem: boolean; // s10+
  background: boolean; // s11+
  cron: boolean; // s12+
  teams: boolean; // s13+
  mcp: boolean; // s14+
  integratedHarness: boolean; // s15+
  workflow: boolean; // s16+
}

// ---------- s16：review-changes 样例 workflow（对齐 lcc SAMPLE_META / sample_workflow） ----------

const FINDINGS_SCHEMA = {
  type: "object",
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity"],
        properties: {
          title: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
        },
      },
    },
  },
} as const;

const VERDICT_SCHEMA = {
  type: "object",
  required: ["isReal", "reason"],
  properties: { isReal: { type: "boolean" }, reason: { type: "string" } },
} as const;

const REVIEW_DIMENSIONS = ["correctness", "security", "performance", "style"];

interface ReviewFinding {
  title: string;
  severity: string;
}

/**
 * lcc 样例编排的逐字移植：pipeline 让每个审查维度独立走
 * "审计 → 对抗验证"——stage 间无屏障，item 间并发。计划是代码，
 * 不是靠聊天一轮轮凑。
 */
async function reviewChangesWorkflow(
  ctx: ExecutionState,
  args: Record<string, unknown>,
): Promise<unknown> {
  ctx.phase("Review");
  const changes = typeof args.changes === "string" ? args.changes : "";
  const reviewInput = changes.trim() || "No change context was supplied.";

  const audit = async (
    _previous: unknown,
    dimension: string,
    _index: number,
  ): Promise<{ dimension: string; findings: ReviewFinding[] }> => {
    const out = (await ctx.agent(
      `Review this change context for ${dimension} issues. ` +
        "Report only issues supported by the supplied text.\n\n" +
        reviewInput,
      FINDINGS_SCHEMA,
      `audit:${dimension}`,
      "Review",
    )) as { findings: ReviewFinding[] };
    return { dimension, findings: out.findings };
  };

  const verify = async (
    previous: unknown,
    dimension: string,
    _index: number,
  ): Promise<{ dimension: string; confirmed: ReviewFinding[] }> => {
    const audited = previous as { dimension: string; findings: ReviewFinding[] };
    ctx.phase("Verify");
    const verdicts = await ctx.parallel(
      audited.findings.map(
        (finding) => () =>
          ctx.agent(
            `Adversarially verify this ${dimension} finding against the ` +
              "supplied change context.\n\n" +
              `Change context:\n${reviewInput}\n\n` +
              `Finding:\n${JSON.stringify(finding)}`,
            VERDICT_SCHEMA,
            `verify:${dimension}:${finding.title}`,
            "Verify",
          ),
      ),
    );
    const confirmed = audited.findings.filter((_finding, i) => {
      const verdict = verdicts[i] as { isReal?: boolean } | undefined;
      return verdict?.isReal === true;
    });
    return { dimension, confirmed };
  };

  const results = await ctx.pipeline(REVIEW_DIMENSIONS, audit, verify);
  const severityRank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const confirmed = results
    .flatMap((result) => {
      const { dimension, confirmed: items } = result as {
        dimension: string;
        confirmed: ReviewFinding[];
      };
      return items.map((finding) => ({ dimension, ...finding }));
    })
    .sort(
      (a, b) =>
        (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3),
    );
  ctx.log(`confirmed ${confirmed.length} real finding(s)`);
  return { confirmed };
}

export interface AlignmentAssembly {
  agent: FunctionCallAgent;
  workspace: string;
  memoryDir: string;
 /** 装配层级（1–14；s01–s03 等价，返回其中最大语义 3 也合法） */
  stage: number;
  /** 本次装配注册的全部工具名（banner / 测试断言用） */
  toolNames: readonly string[];
  features: AlignmentAssemblyFeatures;
  /** 每轮 prompt 之间调用：轮询到期 cron + 空闲交付（<s12 时 no-op） */
  pumpCron: () => Promise<void>;
  /** s15：用户轮/事件轮的互斥入口（异步轮权限切换）；<s15 时 undefined */
  harnessLoop?: HarnessLoop;
  /** s15：自动唤醒轮询循环（start/stop 生命周期）；<s15 时 undefined */
  asyncEventLoop?: AsyncEventLoop;
  /** s14+：MCP 连接管理器（测试观测点） */
  mcp?: McpConnectionManager;
  /** s16+：workflow runtime（测试观测点：注册表与样例编排） */
  workflow?: WorkflowRuntime;
  /** s09+：system prompt 构建器（测试观测点） */
  buildSystemPrompt?: (input: string) => Promise<string>;
  /** 收尾：清理后台进程树（<s11 时 no-op；durable cron 保留） */
  dispose: () => Promise<void>;
}

/**
 * 解析装配层级："s05" / "5" / "s04,s05"（取最大章）/ "all" → 数字；
 * 缺省 → 14。非法值抛错并带用法提示。
 */
export function parseAlignmentStage(stage?: string): number {
  const raw = stage?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "all") return MAX_ALIGNMENT_STAGE;
  const levels: number[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (!token) continue;
    const match = /^s(\d{1,2})$|^(\d{1,2})$/.exec(token);
    const value = match ? Number(match[1] ?? match[2]) : Number.NaN;
    if (!Number.isInteger(value) || value < 1 || value > MAX_ALIGNMENT_STAGE) {
    const maxName = `s${String(MAX_ALIGNMENT_STAGE).padStart(2, "0")}`;
    throw new Error(
      `非法装配层级: '${token}'（用法: --stage s05 或 s04,s05 或 5；范围 s01–${maxName}，缺省 all）`,
    );
    }
    levels.push(value);
  }
  return levels.length > 0 ? Math.max(...levels) : MAX_ALIGNMENT_STAGE;
}

export async function buildAlignmentAgent(
  options: AlignmentAssemblyOptions,
): Promise<AlignmentAssembly> {
  const level = parseAlignmentStage(options.stage);
  const workspace = path.resolve(options.workspace);
  const llm = options.llm ?? new OpenAICompatLLM();
  const traceLog = new AgentTraceLog("alignment-agent");
  const has = (n: number): boolean => level >= n;

  // ---------- 权限（s03 标准；s14 再包 MCP 宿主策略） ----------
  const standardRules = createStandardPermissionRules({ workspaceRoot: workspace });
  const approvalPrompt = options.prompt ?? new ConsoleApprovalPrompt();
  // 装包策略（默认 allow 自动安装；.env 设 PACKAGE_INSTALL_POLICY=ask → 装包弹 y/N 审批）
  const askRules =
    (process.env.PACKAGE_INSTALL_POLICY ?? "allow").trim().toLowerCase() === "ask"
      ? [...standardRules.askRules, createPackageInstallAskRule()]
      : standardRules.askRules;
  let permissionChecker: PermissionChecker = new PermissionChecker({
    denyRules: standardRules.denyRules,
    askRules,
    prompt: approvalPrompt,
  });

  // ---------- s07：技能目录（目录进 system，全文走 load_skill） ----------
  let skillLoader: SkillLoader | undefined;
  let skillTool: SkillTool | undefined;
  if (has(7)) {
    skillLoader = await new SkillLoader(path.join(workspace, "skills")).scan();
    skillTool = new SkillTool(skillLoader);
  }

  // ---------- s08：上下文压缩器 ----------
  const compactor = has(8)
    ? new ContextCompactor(llm, {
        transcriptDir: path.join(workspace, ".transcripts"),
        toolResultsDir: path.join(workspace, ".task_outputs", "tool-results"),
      })
    : undefined;

  // s09：持久记忆目录（builder/提取回调在 agent 选项处按层装配）
  const memoryDir = path.join(workspace, ".memory");

  // ---------- s10/s13：任务图 + 任务板/worktree/teammate ----------
  const taskStore = has(10)
    ? new TaskStore({ directory: path.join(workspace, ".tasks"), workspaceRoot: workspace })
    : undefined;
  const worktreeManager =
    has(13) && taskStore
      ? new TaskWorktreeManager({ workspaceRoot: workspace, taskStore })
      : undefined;
  const taskBoard =
    has(13) && taskStore && worktreeManager
      ? new TaskBoard({ store: taskStore, worktrees: worktreeManager })
      : undefined;
  const teamManager =
    has(13) && taskBoard
      ? new TeamManager({
          llm,
          board: taskBoard,
          workspaceRoot: workspace,
          permissionChecker,
        })
      : undefined;

  // ---------- s11：后台任务（bash 的 run_in_background 能力） ----------
  const background = has(11) ? new BackgroundManager({ cwd: workspace }) : undefined;

  // ---------- s12：cron 调度器（durable 任务落盘，重启恢复） ----------
  const cronScheduler = has(12)
    ? new CronScheduler({ statePath: path.join(workspace, ".scheduled_tasks.json") })
    : undefined;
  if (cronScheduler) {
    const loadResult = await cronScheduler.loadDurableJobs();
    if (loadResult.errors.length > 0) {
      console.warn(`[cron] 恢复告警: ${loadResult.errors.join("; ")}`);
    }
  }

  // ---------- s14：MCP 宿主策略（标准规则之上叠加，未配置外部工具默认 confirm） ----------
  let mcpManager: McpConnectionManager | undefined;
  if (has(14)) {
    mcpManager = new McpConnectionManager();
    permissionChecker = createMcpPermissionChecker({
      manager: mcpManager,
      base: {
        denyRules: standardRules.denyRules,
        askRules,
        prompt: approvalPrompt,
      },
      prompt: approvalPrompt,
    });
  }
  // ---------- s15：异步轮权限视图 + LLM 错误恢复 ----------
  // 在 MCP 宿主策略包好之后取异步视图——deny/ask 规则集与前台完全一致，
  // 仅 ask 命中的行为从"询问"变为"直接拒绝"（异步轮不与主 CLI 争抢输入）
  const asyncChecker = has(15) ? permissionChecker.forAsyncTurns() : undefined;
  const fallbackModelId = (process.env.FALLBACK_MODEL_ID ?? "").trim();
  const recovery = has(15)
    ? new LlmRecovery({
        primary: llm,
        ...(fallbackModelId
          ? { fallback: new OpenAICompatLLM({ model: fallbackModelId }) }
          : {}),
      })
    : undefined;

  // ---------- 工具集 ----------
  const baseTools: Tool[] = [
    new ReadFileTool({ workspace, allowOutsideWorkspace: true }),
    new WriteFileTool({ workspace, allowOutsideWorkspace: true }),
    new EditFileTool({ workspace, allowOutsideWorkspace: true }),
    new GlobTool({ workspace, allowOutsideWorkspace: true }),
    new BashTool({ cwd: workspace, backgroundManager: background }),
  ];
  if (has(5)) baseTools.push(new TodoWriteTool()); // s05
  if (skillTool) baseTools.push(skillTool); // s07
  if (has(8)) baseTools.push(new CompactTool()); // s08

  // s04：四挂点示例 hook（权限闸门仍在 registry 汇合点，hooks 是扩展层）
  const hooks = has(4) ? new HookRegistry() : undefined;
  if (hooks) {
    // 桥接（先注册，短路前也留痕）：hook 事件落 AgentTraceLog——
    // 控制台的 [HOOK] 日志是"当下看得见"，这里是"事后查得到"
    hooks
      .register("UserPromptSubmit", (query) => {
        void traceLog.emit({
          type: "hook",
          hookEvent: "UserPromptSubmit",
          detail: query.slice(0, 200),
        });
      })
      .register("PreToolUse", (call) => {
        void traceLog.emit({
          type: "hook",
          hookEvent: "PreToolUse",
          toolName: call.function.name,
        });
        return undefined;
      })
      .register("PostToolUse", (call, output) => {
        void traceLog.emit({
          type: "hook",
          hookEvent: "PostToolUse",
          toolName: call.function.name,
          detail: `output ${output.length} chars`,
        });
      })
      .register("Stop", (history) => {
        void traceLog.emit({
          type: "hook",
          hookEvent: "Stop",
          detail: `${history.filter((m) => (m as { role?: string }).role === "tool").length} tool calls`,
        });
        return undefined;
      });
    // 控制台示例 hook（logHook / 大输出提醒 / 工作目录注入 / 收尾统计）
    hooks
      .register("UserPromptSubmit", contextInjectHook)
      .register("PreToolUse", logHook)
      .register("PostToolUse", largeOutputHook)
      .register("Stop", summaryHook);
  }

  // s06：task 工具（子注册表 = baseTools 剔除 task，单层委派）
  const taskTool = has(6)
    ? createTaskTool({ llm, tools: baseTools, permissionChecker, traceLog })
    : undefined;

  const registry = new ToolRegistry();
  const builtinToolNames: string[] = [];
  for (const tool of baseTools) {
    registry.register(tool);
    builtinToolNames.push(tool.name);
  }
  if (has(10) && taskStore) {
    for (const tool of createTaskTools(taskStore)) {
      registry.register(tool);
      builtinToolNames.push(tool.name);
    }
  }
  if (has(12) && cronScheduler) {
    registry
      .register(new ScheduleCronTool(cronScheduler))
      .register(new ListCronsTool(cronScheduler))
      .register(new CancelCronTool(cronScheduler));
    builtinToolNames.push("schedule_cron", "list_crons", "cancel_cron");
  }
  if (has(13) && teamManager) {
    for (const tool of createTeamTools(teamManager)) {
      registry.register(tool);
      builtinToolNames.push(tool.name);
    }
  }
  let dynamicTools = false;
  if (has(14) && mcpManager) {
    registry.register(new ConnectMcpTool(mcpManager));
    builtinToolNames.push("connect_mcp");
    // 每轮组装动态工具池（连接 MCP server 后下一轮即可见新工具）
    registry.setDynamicToolProvider(() => mcpManager!.assembleTools(builtinToolNames));
    dynamicTools = true;
  }
  // ---------- s16：workflow runtime（宿主持有可信编排，模型只报名字） ----------
  let workflowRuntime: WorkflowRuntime | undefined;
  if (has(16)) {
    const workflowRegistry = new WorkflowRegistry();
    workflowRegistry.register(
      {
        name: "review-changes",
        description:
          "Review changed files across dimensions, verify each finding",
        phases: ["Review", "Verify"],
      },
      reviewChangesWorkflow,
    );
    workflowRuntime = new WorkflowRuntime({
      storeDir: path.join(workspace, ".runtime"),
      registry: workflowRegistry,
      // workflow 子 agent 与宿主同一 ChatLLM（lcc install 选 API runner 同思路）
      runner: () => new LlmWorkflowAgentRunner(llm),
      onEvent: (line) => console.log(`  [workflow] ${line}`),
    });
    registry.register(new WorkflowTool(workflowRuntime));
    builtinToolNames.push("Workflow");
  }
  if (taskTool) registry.register(taskTool);
  registry.setPermissionChecker(permissionChecker).assertAllStructured();

  // ---------- system prompt：指引句按层积累 ----------
  let baseInstructions =
    `You are a coding agent at ${workspace}. Environment: Windows; the bash tool runs cmd.exe. ` +
    "Use tools to solve tasks. Act, don't explain. ";
  if (has(5)) {
    baseInstructions += "For multi-step tasks, plan first with todo_write and keep it updated as you work. ";
  }
  if (has(6)) {
    baseInstructions += "Delegate self-contained investigations to the task tool when a fresh context helps. ";
  }
  if (has(8)) {
    baseInstructions += "You may call compact after finishing a phase to free context space. ";
  }
  if (has(10)) {
    baseInstructions +=
      "For multi-task work, create all task nodes first with create_task, then use " +
      "update_task with the returned runtime IDs to add blockedBy dependencies. ";
  }
  if (has(13)) {
    baseInstructions +=
      "For parallel work, create task nodes, optionally bind worktrees, then spawn " +
      "teammates and collect their results from team events. ";
  }
  baseInstructions +=
    "Do not ask for approval yourself; for risky operations still request the tool call — " +
    "the harness will approve or deny before execution.";
  const staticSystem = skillLoader
    ? buildSkillSystemPrompt(baseInstructions, skillLoader)
    : baseInstructions;

  // s09+：system prompt 构建器（agent 选项与装配观测点共用同一事实）
  const systemPromptBuilder = has(9)
    ? async (input: string): Promise<string> => {
        const records = await listMemoryFiles(memoryDir);
        const selected = await selectRelevantMemories(llm, [Message.user(input)], records);
        const withSkills = skillLoader
          ? buildSkillSystemPrompt(baseInstructions, skillLoader)
          : baseInstructions;
        // s15 对齐 lcc assemble_system_prompt：system 注入已连接 MCP 名单
        const mcpSection =
          has(15) && mcpManager && mcpManager.connectedNames().length > 0
            ? `\n\nConnected MCP servers: ${mcpManager.connectedNames().join(", ")}`
            : "";
        return buildMemorySystem(withSkills, loadMemories(selected)) + mcpSection;
      }
    : undefined;

  // ---------- agent ----------
  const agent = new FunctionCallAgent("alignment-agent", llm, registry, {
    config: new AgentConfig({ verbose: true }),
    traceLog,
    systemPrompt: staticSystem,
    ...(hooks ? { hooks } : {}),
    // s11/s13：后台命令通知 + teammate 团队事件在下一次模型调用前注入
    ...(background
      ? {
          collectNotifications: async (): Promise<string[]> => [
            ...background.collect(),
            ...(teamManager ? await teamManager.collectLeadEvents() : []),
          ],
        }
      : {}),
    ...(compactor ? { contextCompactor: compactor } : {}),
    // s15：轮级 cron 注入（drain → [Scheduled] user 消息 → 成功 ack / 失败 restore）
    ...(has(15) && cronScheduler
      ? {
          collectScheduledPrompts: async (): Promise<ScheduledPromptJob[]> =>
            cronScheduler.consumeQueue().map((job) => ({
              prompt: job.prompt,
              acknowledge: () => cronScheduler.acknowledge([job]),
              restore: () => cronScheduler.restore([job]),
            })),
        }
      : {}),
    // s15：429/529 退避 + fallback 切换 + 截断升级/续跑
    ...(recovery ? { llmRecovery: recovery } : {}),
    // s09：每轮召回注入 system；回合自然结束后提取持久记忆（达 10 条整理）
    ...(has(9)
      ? {
          ...(systemPromptBuilder ? { systemPromptBuilder } : {}),
          onRunCompleted: async ({ history }) => {
            const written = await extractMemories(llm, history, memoryDir);
            if (written > 0) {
              console.log(`[memory] 新增 ${written} 条持久记忆（.memory/）`);
              await consolidateMemories(llm, { memoryDir }).catch((error) => {
                console.warn(`[memory] 整理失败（不影响答案）: ${error}`);
              });
            }
          },
        }
      : {}),
  });

  // ---------- s12–s14：到期任务空闲交付（[Scheduled] prompt 触发一轮）；
  // s15 起交付移交 AsyncEventLoop（轮级注入 + 异步权限 + 无合成 prompt） ----------
  const scheduledRunner =
    cronScheduler && level < 15
      ? new ScheduledTurnRunner({
          scheduler: cronScheduler,
          runTurn: async (prompt: string) => {
            console.log(`\n⏰ [cron] 交付定时任务: ${prompt}`);
            await agent.run(`[Scheduled] ${prompt}`);
          },
        })
      : undefined;

  // ---------- s15：轮次串行化 + 自动唤醒（lcc agent_lock / async_event_loop） ----------
  const harnessLoop = has(15)
    ? new HarnessLoop({
        agent,
        registry,
        asyncChecker,
        foregroundChecker: permissionChecker,
      })
    : undefined;
  const asyncEventLoop = harnessLoop
    ? new AsyncEventLoop({
        loop: harnessLoop,
        ...(cronScheduler
          ? {
              cron: {
                poll: () => cronScheduler.pollDueJobs(),
                hasDue: () => cronScheduler.hasQueue(),
              },
            }
          : {}),
        ...(teamManager
          ? { team: { collect: () => teamManager.collectLeadEvents() } }
          : {}),
        ...(background
          ? {
              background: {
                hasCompleted: () => background.hasCompleted(),
                collect: () => background.collect(),
              },
            }
          : {}),
        onWake: (source, detail) => {
          console.log(`\n🔔 [auto-wake:${source}] ${detail}`);
        },
      })
    : undefined;

  const toolNames = registry.listTools().map((tool) => tool.name);
  return {
    agent,
    workspace,
    memoryDir,
    stage: level,
    toolNames,
    features: {
      hooks: has(4),
      subagent: has(6),
      skills: has(7),
      compactor: has(8),
      memory: has(9),
      taskSystem: has(10),
      background: has(11),
      cron: has(12),
      teams: has(13),
      mcp: has(14),
      integratedHarness: has(15),
      workflow: has(16),
    },
    pumpCron: async () => {
      if (!cronScheduler) return;
      await cronScheduler.pollDueJobs().catch((error) => {
        console.warn(`[cron] 轮询失败: ${error}`);
      });
      // s15 起空闲交付由 AsyncEventLoop 驱动（runEventTurn 轮内 drain）；
      // <s15 保持 turn 级逐任务交付
      if (!scheduledRunner) return;
      await scheduledRunner.deliverDue().catch((error) => {
        console.warn(`[cron] 交付失败（任务已重入队）: ${error}`);
      });
    },
    ...(harnessLoop ? { harnessLoop } : {}),
    ...(asyncEventLoop ? { asyncEventLoop } : {}),
    ...(mcpManager ? { mcp: mcpManager } : {}),
    ...(workflowRuntime ? { workflow: workflowRuntime } : {}),
    ...(systemPromptBuilder ? { buildSystemPrompt: systemPromptBuilder } : {}),
    dispose: async () => {
      asyncEventLoop?.stop();
      await background?.dispose();
    },
  };
}

/** 各章 README"试一下"参考 prompt（批量演示与 REPL help 共用） */
export const ALIGNMENT_PROMPTS: [string, string][] = [
  ["s01", 'Create a file called hello.py that prints "Hello, World!"'],
  ["s01", "List all Python files in this directory"],
  ["s01", "What is the current git branch?"],
  ["s02", "Read the file README.md and tell me what this project is about"],
  ["s02", 'Create a file called test.py that prints "hello", then read it back'],
  ["s02", "Find all Python files in this directory"],
  ["s02", "Read both README.md and requirements.txt, then create a summary file"],
  ["s03", "Create a file called test.txt in the current directory"],
  ["s03", "Delete the file test.txt"],
  ["s03", "What files are in the current directory?"],
  ["s03", "Try to write a file to /etc/something"],
  ["s04", "Read the file README.md（观察 [HOOK] 日志）"],
  ["s04", "Create a file called test.txt（观察 PostToolUse hook）"],
  ["s04", "Delete all temporary files in /tmp（bash + rm 触发权限闸门）"],
  ["s05", "Refactor hello.py: add type hints, docstrings, and a main guard（先列 3 步再执行）"],
  ["s05", "Create a Python package under demo_pkg with __init__.py, utils.py, and tests/test_utils.py"],
  ["s05", "Review Python files in this directory and fix any style issues"],
  ["s06", "Use a subtask to find what testing framework this project uses"],
  ["s06", "Delegate: read all .ts files in src/agents and summarize what each one does"],
  ["s06", "Use a task to create string_utils.ts with a slugify(text) function, then verify it from the parent agent"],
  ["s07", "What skills are available?"],
  ["s07", "Load the code-review skill and follow its instructions"],
  ["s07", "Review README.md and load the relevant skill first"],
  ["s08", "Read README.md, package.json, tsconfig.json, vitest.config.ts and SUMMARY.md, then summarize what each file is for（较早结果引用化）"],
  ["s08", "Run `dir /s /b` from the workspace root and summarize what you see（大输出观察 .task_outputs/ 转存）"],
  ["s08", "Compare src/context/compactor.ts and src/persistent-memory/store.ts: how do they manage session context vs cross-session memory?（可触发 auto compact）"],
  ["s09", "I prefer using tabs for indentation. Remember that."],
  ["s09", "What indentation style do I prefer?（重启进程后问同样问题可验证跨会话召回）"],
  ["s09", "I also prefer concise commit messages. Remember that.（观察相关性选择：与缩进无关）"],
  ["s09", "Do not create files in this session.（临时要求不应入库）"],
  ["s10", "Create tasks: setup database schema, create API endpoints (depends on schema), write tests (depends on endpoints), write docs (depends on schema)（观察 .tasks/ 生成 JSON）"],
  ["s10", "List all tasks and their statuses"],
  ["s10", "Claim the first unblocked task and complete it"],
  ["s10", "List tasks again — which ones are now unblocked?（观察依赖解锁）"],
  ["s11", "Run `node -e \"console.log('bg-ok')\"` in the background (use run_in_background), and read package.json while waiting（观察占位 bg_id）"],
  ["s11", "List all Markdown files, then tell me the background result when it arrives（观察 <task_notification> 注入）"],
  ["s11", "Run a 3-second background sleep (`node -e \"setTimeout(()=>console.log('slept'),3000)\"`), then continue with other work and collect the result later"],
  ["s12", "Schedule 'run date' every 2 minutes and keep it after restart.（观察 .scheduled_tasks.json）"],
  ["s12", "List all cron jobs."],
  ["s12", "Cancel the cron job you just created."],
  ["s13", "Create two independent tasks: inspect README and inspect package.json. Spawn two teammates to claim and complete them, then summarize team events."],
  ["s13", "Create a pending task called worktree-demo, bind a worktree named demo-wt, and show the task JSON."],
  ["s13", "Spawn a teammate named reviewer with a required plan. Ask it to plan a small README summary, review the submitted plan, and approve it."],
  ["s14", "Connect the docs server, search for agent hooks, and tell me the current documentation API version.（观察 mcp__docs__ 工具出现）"],
  ["s14", "Connect the deploy server, check the web service status, and do NOT trigger a deployment.（status 放行 / trigger 需确认）"],
  ["s15", "Schedule a one-off task 2 minutes from now that runs `node -e \"console.log('cron-ok')\"`（REPL 空闲时观察自动唤醒交付与 [Scheduled] 注入）"],
  ["s15", "Run a 2-second background task (use run_in_background), then stay idle and wait（REPL 空闲时观察后台完成自动唤醒与 <task_notification> 注入）"],
  ["s15", "Spawn a teammate and send it a message asking for a short README summary（观察团队事件自动唤醒一轮）"],
  ["s16", "Run the saved workflow named review-changes with args {\"changes\": \"def load_user(id): return db.execute(f'SELECT * FROM users WHERE id = {id}')\"}（观察一次 tool_use 内 launched→workflow_phase→task_notification 事件流与 .runtime/ 产物）"],
  ["s16", "Resume the previous review-changes run using the runId from the earlier result（观察全部 status=cached、agents=0 tokens=0）"],
];
