/**
 * 对齐装配（demo 与 REPL 共享的唯一事实源）
 *
 * 装配层级：s01–s14 全量——文件/bash 工具（s01–s03）、hooks（s04）、
 * todo（s05）、task 子 agent（s06）、skills（s07）、compact（s08）、
 * 持久记忆（s09）、任务图（s10）、后台任务（s11）、cron（s12）、
 * 任务板/worktree/teammate（s13）、MCP 动态工具池（s14）。
 * 批量演示（alignment-demo.ts）与交互式会话（alignment-repl.ts）
 * 都从这里拿同一个 agent——两条入口的行为差异只剩"谁在驱动 prompt"。
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
  createStandardPermissionRules,
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
  type ApprovalPrompt,
} from "../../src/index";
import { Message } from "../../src/core/message";

export interface AlignmentAssemblyOptions {
  /** 工作区根目录（工具围栏放开，越区裁决权交给权限层） */
  workspace: string;
  /** 审批交互；REPL 传共享行队列的审批器，demo 默认控制台审批器 */
  prompt?: ApprovalPrompt;
}

export interface AlignmentAssembly {
  agent: FunctionCallAgent;
  workspace: string;
  memoryDir: string;
  /** 每轮 prompt 之间调用：轮询到期 cron + 空闲交付到期任务（至少一次语义） */
  pumpCron: () => Promise<void>;
  /** 收尾：清理后台进程树（durable cron 保留，重启后恢复） */
  dispose: () => Promise<void>;
}

export async function buildAlignmentAgent(
  options: AlignmentAssemblyOptions,
): Promise<AlignmentAssembly> {
  const workspace = path.resolve(options.workspace);
  const llm = new OpenAICompatLLM();
  const traceLog = new AgentTraceLog("alignment-agent");

  // s04：四挂点示例 hook（权限闸门仍在 registry 汇合点，hooks 是扩展层）
  const hooks = new HookRegistry()
    .register("UserPromptSubmit", contextInjectHook)
    .register("PreToolUse", logHook)
    .register("PostToolUse", largeOutputHook)
    .register("Stop", summaryHook);

  // s14：标准规则之上叠加 MCP 宿主策略（未配置的外部工具默认 confirm）
  const mcpManager = new McpConnectionManager();
  const standardRules = createStandardPermissionRules({ workspaceRoot: workspace });
  const approvalPrompt = options.prompt ?? new ConsoleApprovalPrompt();
  const permissionChecker = createMcpPermissionChecker({
    manager: mcpManager,
    base: {
      denyRules: standardRules.denyRules,
      askRules: standardRules.askRules,
      prompt: approvalPrompt,
    },
    prompt: approvalPrompt,
  });

  // s07：启动时扫描技能目录（目录进 system prompt，全文走 load_skill）
  const skillLoader = await new SkillLoader(path.join(workspace, "skills")).scan();
  const skillTool = new SkillTool(skillLoader);

  // s08：上下文压缩器
  const compactor = new ContextCompactor(llm, {
    transcriptDir: path.join(workspace, ".transcripts"),
    toolResultsDir: path.join(workspace, ".task_outputs", "tool-results"),
  });

  // s09：持久记忆目录
  const memoryDir = path.join(workspace, ".memory");

  // s10/s13：任务图 + 任务板/worktree/teammate
  const taskStore = new TaskStore({
    directory: path.join(workspace, ".tasks"),
    workspaceRoot: workspace,
  });
  const worktreeManager = new TaskWorktreeManager({ workspaceRoot: workspace, taskStore });
  const taskBoard = new TaskBoard({ store: taskStore, worktrees: worktreeManager });
  const teamManager = new TeamManager({
    llm,
    board: taskBoard,
    workspaceRoot: workspace,
    permissionChecker,
  });

  // s11/s12：后台任务 + cron 调度器
  const background = new BackgroundManager({ cwd: workspace });
  const cronScheduler = new CronScheduler({
    statePath: path.join(workspace, ".scheduled_tasks.json"),
  });
  const cronLoadResult = await cronScheduler.loadDurableJobs();
  if (cronLoadResult.errors.length > 0) {
    console.warn(`[cron] 恢复告警: ${cronLoadResult.errors.join("; ")}`);
  }

  // s06：基础工具集（子 agent 共享同一批工具实例 + 权限 + hooks）
  const baseTools = [
    new ReadFileTool({ workspace, allowOutsideWorkspace: true }),
    new WriteFileTool({ workspace, allowOutsideWorkspace: true }),
    new EditFileTool({ workspace, allowOutsideWorkspace: true }),
    new GlobTool({ workspace, allowOutsideWorkspace: true }),
    new BashTool({ cwd: workspace, backgroundManager: background }),
    new TodoWriteTool(),
    skillTool,
    new CompactTool(),
  ];
  const taskTool = createTaskTool({ llm, tools: baseTools, permissionChecker, hooks });

  const registry = new ToolRegistry();
  const builtinToolNames: string[] = [];
  for (const tool of baseTools) {
    registry.register(tool);
    builtinToolNames.push(tool.name);
  }
  for (const tool of createTaskTools(taskStore)) {
    registry.register(tool);
    builtinToolNames.push(tool.name);
  }
  for (const tool of createTeamTools(teamManager)) {
    registry.register(tool);
    builtinToolNames.push(tool.name);
  }
  registry
    .register(new ScheduleCronTool(cronScheduler))
    .register(new ListCronsTool(cronScheduler))
    .register(new CancelCronTool(cronScheduler))
    .register(new ConnectMcpTool(mcpManager));
  builtinToolNames.push("schedule_cron", "list_crons", "cancel_cron", "connect_mcp");
  // s14：每轮组装动态工具池（连接 MCP server 后下一轮即可见新工具）
  registry.setDynamicToolProvider(() => mcpManager.assembleTools(builtinToolNames));
  registry
    .register(taskTool)
    .setPermissionChecker(permissionChecker)
    .assertAllStructured();

  const baseInstructions =
    `You are a coding agent at ${workspace}. Environment: Windows; the bash tool runs cmd.exe. ` +
    "Use tools to solve tasks. Act, don't explain. " +
    "For multi-step tasks, plan first with todo_write and keep it updated as you work. " +
    "Delegate self-contained investigations to the task tool when a fresh context helps. " +
    "You may call compact after finishing a phase to free context space. " +
    "For multi-task work, create all task nodes first with create_task, then use " +
    "update_task with the returned runtime IDs to add blockedBy dependencies. " +
    "For parallel work, create task nodes, optionally bind worktrees, then spawn " +
    "teammates and collect their results from team events. " +
    "Do not ask for approval yourself; for risky operations still request the tool call — " +
    "the harness will approve or deny before execution.";

  const agent = new FunctionCallAgent("alignment-agent", llm, registry, {
    config: new AgentConfig({ verbose: true }),
    traceLog,
    hooks,
    // s11/s13：后台命令通知 + teammate 团队事件在下一次模型调用前注入
    collectNotifications: async () => [
      ...background.collect(),
      ...(await teamManager.collectLeadEvents()),
    ],
    contextCompactor: compactor,
    // s09：每次运行前召回相关记忆注入 system（背景知识，非新指令）
    systemPromptBuilder: async (input: string) => {
      const records = await listMemoryFiles(memoryDir);
      const selected = await selectRelevantMemories(llm, [Message.user(input)], records);
      return buildMemorySystem(
        buildSkillSystemPrompt(baseInstructions, skillLoader),
        loadMemories(selected),
      );
    },
    // s09：回合自然结束后提取持久记忆（达 10 条自动整理）
    onRunCompleted: async ({ history }) => {
      const written = await extractMemories(llm, history, memoryDir);
      if (written > 0) {
        console.log(`[memory] 新增 ${written} 条持久记忆（.memory/）`);
        await consolidateMemories(llm, { memoryDir }).catch((error) => {
          console.warn(`[memory] 整理失败（不影响答案）: ${error}`);
        });
      }
    },
  });

  // s12：到期任务空闲交付（[Scheduled] prompt 触发一轮；异步回合拒绝交互确认）
  const scheduledRunner = new ScheduledTurnRunner({
    scheduler: cronScheduler,
    runTurn: async (prompt: string) => {
      console.log(`\n⏰ [cron] 交付定时任务: ${prompt}`);
      await agent.run(`[Scheduled] ${prompt}`);
    },
  });

  return {
    agent,
    workspace,
    memoryDir,
    pumpCron: async () => {
      await cronScheduler.pollDueJobs().catch((error) => {
        console.warn(`[cron] 轮询失败: ${error}`);
      });
      await scheduledRunner.deliverDue().catch((error) => {
        console.warn(`[cron] 交付失败（任务已重入队）: ${error}`);
      });
    },
    dispose: async () => {
      await background.dispose();
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
];
