/**
 * s18 组装层（批1 范围：simple + DAG 两条线；swarm 线批3 接入）。
 * run 级 journal：.multiagent/<runId>/events.jsonl 逐事件追加（崩溃=interrupted 不续跑）。
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { CalculatorTool } from "../tools/builtin/calculator";
import { AdvancedSearchTool } from "../tools/builtin/search";
import { EditFileTool, GlobTool, ReadFileTool, WriteFileTool } from "../tools/builtin/file-tools";
import { PermissionChecker } from "../security/permission";
import { ToolRegistry } from "../tools/registry";
import type { ChatLLM } from "../core/llm";
import { decomposeTask } from "./decompose";
import { DEFAULTS, type ExecutionMode } from "./model";
import { MailboxStore } from "./mailbox";
import { WorkspaceStore } from "./workspace";
import { TaskBoardStore } from "./swarm/board";
import { LeadEngine, type LeadWorkerHandle } from "./swarm/lead";
import { SwarmWorker } from "./swarm/worker";
import { resolveRoleModel } from "./swarm/roles";
import { runHybrid } from "./patterns/hybrid";
import { runParallel, type TaskRunner } from "./patterns/parallel";
import { extractNumericValue, runSequential } from "./patterns/sequential";
import { resolveMode, routePlan } from "./router";
import { synthesizeResults } from "./synthesis";

export interface JournalEvent {
  at: string;
  type: string;
  [key: string]: unknown;
}

export class MultiagentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MultiagentError";
  }
}

export interface MultiagentOptions {
  llm: ChatLLM;
  /** 默认 auto（分解后路由）。 */
  mode?: ExecutionMode | "auto";
  /** journal 根目录，默认 .multiagent。 */
  journalRoot?: string;
  maxConcurrency?: number;
  now?: () => Date;
  runId?: string;
  /** swarm 线配置（批3）；lead/worker 可用不同 LLM，未配回落 llm。 */
  swarmOptions?: SwarmRunOptions;
}

export interface SwarmRunOptions {
  leadLlm?: ChatLLM;
  workerLlm?: ChatLLM;
  maxWorkers?: number;
  checkpointIntervalMs?: number;
  /** 单 worker 迭代上限（默认 50；测试可调小以真实触发强制收敛）。 */
  workerIterationLimit?: number;
  /** swarm 整体超时（默认 120s），超时 interrupted 收尾。 */
  timeoutMs?: number;
}

export interface RunResult {
  runId: string;
  line: ExecutionMode;
  final: string;
  events: JournalEvent[];
}

let runCounter = 0;

export class MultiagentOrchestrator {
  readonly runId: string;
  private readonly events: JournalEvent[] = [];
  private readonly journalFile: string;
  private journalReady = false;
  private activeSwarm:
    | {
        pushEvent: (event: import("./model").LeadEvent) => void;
        states: Map<string, LeadWorkerHandle>;
        board: TaskBoardStore;
        workspace: WorkspaceStore;
      }
    | undefined;

  /** 回放一个 run 的 journal（无则空数组）。 */
  static replay(runId: string, journalRoot = ".multiagent"): JournalEvent[] {
    try {
      return readFileSync(path.join(journalRoot, runId, "events.jsonl"), "utf-8")
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as JournalEvent);
    } catch {
      return [];
    }
  }

  /** swarm 运行中注入 human_input；非运行态返回 false。 */
  humanInput(text: string): boolean {
    if (!this.activeSwarm) return false;
    this.emit("human.input", { text });
    this.activeSwarm.pushEvent({ type: "human_input", text });
    return true;
  }

  /** 运行中 swarm 的只读快照（agents/tasks/workspace 查看命令用）。 */
  swarmSnapshot():
    | {
        agents: Array<{ agentId: string; role: string; status: string }>;
        tasks: import("./swarm/board").SwarmTask[];
        workspaceEntries: import("./model").WorkspaceEntry[];
      }
    | undefined {
    if (!this.activeSwarm) return undefined;
    return {
      agents: [...this.activeSwarm.states.values()].map((state) => ({
        agentId: state.agentId,
        role: state.role,
        status: state.status,
      })),
      tasks: this.activeSwarm.board.list(),
      workspaceEntries: this.activeSwarm.workspace.listAll(0),
    };
  }

  constructor(private readonly options: MultiagentOptions) {
    this.runId = options.runId ?? `run-${Date.now().toString(36)}-${(runCounter += 1).toString(36)}`;
    this.journalFile = path.join(options.journalRoot ?? ".multiagent", this.runId, "events.jsonl");
  }

  private emit(type: string, data: Record<string, unknown> = {}): void {
    const event: JournalEvent = {
      at: (this.options.now ?? (() => new Date()))().toISOString(),
      type,
      ...data,
    };
    this.events.push(event);
    if (!this.journalReady) {
      mkdirSync(path.dirname(this.journalFile), { recursive: true });
      this.journalReady = true;
    }
    appendFileSync(this.journalFile, `${JSON.stringify(event)}\n`, "utf-8");
  }

  async run(input: string): Promise<RunResult> {
    this.emit("run.started", { input });
    const early = resolveMode(this.options.mode ?? "auto");
    if (early?.line === "swarm") {
      this.emit("route.decision", { line: "swarm", skipDecompose: true });
      return this.runSwarm(input);
    }
    if (early?.line === "simple") {
      this.emit("route.decision", { line: "simple", skipDecompose: true });
      return this.runSimple(input);
    }

    const outcome = await decomposeTask(this.options.llm, input);
    if (outcome.kind === "degraded") {
      this.emit("decompose.degraded", { code: outcome.code, reason: outcome.reason });
      this.emit("route.decision", { line: "simple", reason: "分解降级兜底" });
      return this.runSimple(input);
    }
    this.emit("decompose.completed", {
      complexity: outcome.plan.complexity,
      subtasks: outcome.plan.subtasks.length,
    });

    const decision = routePlan(outcome.plan, {
      forceLine: this.options.mode === "dag" ? "dag" : undefined,
    });
    this.emit("route.decision", {
      line: decision.line,
      dagStrategy: decision.dagStrategy,
      reason: decision.reason,
    });
    if (decision.line === "simple") return this.runSimple(input);

    const runner = this.withJournal(createDagTaskRunner(this.options.llm));
    const maxConcurrency = this.options.maxConcurrency ?? DEFAULTS.maxConcurrency;
    const results =
      decision.dagStrategy === "hybrid"
        ? await runHybrid(outcome.plan.subtasks, runner, { maxConcurrency })
        : decision.dagStrategy === "sequential"
          ? await runSequential(outcome.plan.subtasks, runner)
          : await runParallel(outcome.plan.subtasks, runner, { maxConcurrency });

    const final = await synthesizeResults(this.options.llm, input, results);
    this.emit("synthesis.completed", { chars: final.length });
    this.emit("run.completed", { chars: final.length });
    return { runId: this.runId, line: "dag", final, events: this.events };
  }

  private async runSimple(input: string): Promise<RunResult> {
    const final = await this.options.llm.invoke([{ role: "user", content: input }]);
    this.emit("run.completed", { chars: final.length });
    return { runId: this.runId, line: "simple", final, events: this.events };
  }

  /** swarm 线：Lead 事件循环（Promise 竞争驻留点）+ 默认 worker 工厂。 */
  private async runSwarm(input: string): Promise<RunResult> {
    const swarm = this.options.swarmOptions ?? {};
    const leadLlm = swarm.leadLlm ?? this.options.llm;
    const workerLlm = swarm.workerLlm ?? this.options.llm;
    const workspace = new WorkspaceStore({
      now: () => this.nowIso(),
      onAppend: (entry) => this.emit("workspace.append", { topic: entry.topic, seq: entry.seq }),
    });
    const mailbox = new MailboxStore({
      now: () => this.nowIso(),
      onSend: (message) => this.emit("mailbox.send", { from: message.from, to: message.to, type: message.type }),
    });
    const board = new TaskBoardStore();
    const runRoot = path.dirname(this.journalFile);
    const states = new Map<string, LeadWorkerHandle>();
    const workersById = new Map<string, SwarmWorker>();
    const eventQueue: import("./model").LeadEvent[] = [];
    const waiters: Array<(event: import("./model").LeadEvent) => void> = [];
    const pushEvent = (event: import("./model").LeadEvent): void => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else eventQueue.push(event);
    };
    let workerInflight = 0;

    const startWorkerRun = (agentId: string): void => {
      workerInflight += 1;
      void (async () => {
        const worker = workersById.get(agentId);
        const state = states.get(agentId);
        if (!worker || !state) return;
        try {
          const signal = await worker.runTask();
          state.status = worker.status;
          this.emit(signal.type === "idle" ? "agent.idle" : "agent.completed", {
            agentId,
            keyFindings: signal.type === "idle" ? signal.keyFindings : undefined,
          });
          pushEvent(
            signal.type === "idle"
              ? { type: "agent_idle", agentId, keyFindings: signal.keyFindings }
              : { type: "agent_completed", agentId, summary: signal.type === "done" ? signal.summary : undefined },
          );
        } catch (error) {
          state.status = "idle";
          this.emit("worker.error", { agentId, error: String(error) });
          pushEvent({ type: "agent_idle", agentId, keyFindings: `执行异常：${String(error)}` });
        } finally {
          workerInflight -= 1;
        }
      })();
    };

    const rosterSummary = () =>
      [...states.values()].map((state) => `${state.agentId}(${state.role})=${state.status}`).join("\n");
    const boardSummary = () => board.snapshot();

    const spawnWorker = (action: Extract<import("./model").LeadAction, { type: "spawn_agent" }>): LeadWorkerHandle => {
      const agentId = action.agentId ?? `w${states.size + 1}`;
      const workspaceDir = path.join(runRoot, "workspaces", agentId);
      mkdirSync(workspaceDir, { recursive: true });
      const registry = new ToolRegistry()
        .register(new CalculatorTool())
        .register(new ReadFileTool({ workspace: workspaceDir }))
        .register(new WriteFileTool({ workspace: workspaceDir }))
        .register(new EditFileTool({ workspace: workspaceDir }))
        .register(new GlobTool({ workspace: workspaceDir }));
      // SearchTool 仅当环境配置了搜索 key 才注册（interview §4 安全默认）
      if (process.env.TAVILY_API_KEY || process.env.SERPAPI_API_KEY) {
        registry.register(new AdvancedSearchTool());
      }
      registry.setPermissionChecker(new PermissionChecker());
      const resolved = resolveRoleModel(action.tier ?? "medium", { llm: workerLlm });
      if (resolved.fellBack) this.emit("model.fallback", { agentId, tier: action.tier ?? "medium" });
      const worker = new SwarmWorker({
        agentId,
        role: action.role,
        llm: resolved.llm,
        workspace,
        mailbox,
        tools: registry,
        rosterSummary,
        boardSummary,
        ...(swarm.workerIterationLimit ? { iterationLimit: swarm.workerIterationLimit } : {}),
        now: () => this.nowIso(),
      });
      const state: LeadWorkerHandle = {
        agentId,
        role: action.role,
        status: "running",
        assign: (task) => {
          const ok = worker.assign(task);
          if (ok && worker.status === "running") {
            state.status = "running";
            startWorkerRun(agentId);
          }
          return ok;
        },
        requestShutdown: () => worker.requestShutdown(),
      };
      states.set(agentId, state);
      workersById.set(agentId, worker);
      worker.assign({
        id: action.taskId ?? `${agentId}-default`,
        description: action.taskDescription,
      });
      startWorkerRun(agentId);
      return state;
    };

    const nextEvent = async (): Promise<import("./model").LeadEvent> => {
      const queued = eventQueue.shift();
      if (queued) return queued;
      return new Promise((resolve) => waiters.push(resolve));
    };

    const lead = new LeadEngine({
      llm: leadLlm,
      workspace,
      mailbox,
      board,
      spawnWorker,
      workers: () => [...states.values()],
      emit: (type, data) => this.emit(type, data),
      workspaceRoot: path.join(runRoot, "workspaces"),
      now: () => Date.now(),
      maxWorkers: swarm.maxWorkers ?? DEFAULTS.maxWorkers,
    });

    const timeoutMs = swarm.timeoutMs ?? DEFAULTS.swarmTimeoutMs;
    const startedAt = Date.now();
    let final: string | undefined;

    const actions = await lead.decide({ type: "initial_plan", input });
    await lead.execute(actions);

    this.activeSwarm = { pushEvent, states, board, workspace };
    while (final === undefined) {
      if (lead.isDone || lead.finalReply !== undefined) {
        final = lead.finalReply ?? "（Lead 已结束，无 final_reply）";
        break;
      }
      const settled =
        states.size > 0 &&
        workerInflight === 0 &&
        eventQueue.length === 0 &&
        [...states.values()].every((state) => state.status === "idle" || state.status === "done") &&
        board.pending().length === 0;
      if (settled) {
        this.emit("swarm.closing", {});
        if (lead.finalReply !== undefined) {
          final = lead.finalReply;
        } else {
          const findings = workspace
            .listAll(0)
            .map((entry) => `[${entry.topic}] ${JSON.stringify(entry.entry)}`)
            .join("\n");
          const notes = [...workersById.values()].flatMap((worker) => worker.runningNotes).join("\n");
          final = await leadLlm.invoke(
            [
              { role: "system", content: "你是多 Agent 团队的 Lead，负责把团队产出综合成给用户的最终回答。" },
              { role: "user", content: `用户请求：${input}\n\n## Workspace\n${findings}\n\n## Notes\n${notes}` },
            ],
            { temperature: 0.3 },
          );
          this.emit("synthesis.completed", { chars: final.length });
        }
        break;
      }
      if (Date.now() - startedAt > timeoutMs) {
        this.emit("swarm.timeout", { elapsedMs: Date.now() - startedAt });
        final = "（swarm 运行超时，已强制收尾——journal 保留完整时间线）";
        break;
      }
      const checkpointMs = swarm.checkpointIntervalMs ?? DEFAULTS.checkpointIntervalMs;
      let checkpointResolve: ((event: import("./model").LeadEvent) => void) | undefined;
      const checkpointPromise = new Promise<import("./model").LeadEvent>((resolve) => {
        checkpointResolve = resolve;
      });
      const timer = setTimeout(() => checkpointResolve?.({ type: "checkpoint" }), checkpointMs);
      const event = await Promise.race([nextEvent(), checkpointPromise]);
      clearTimeout(timer);
      const eventActions = await lead.decide(event);
      await lead.execute(eventActions);
    }
    this.activeSwarm = undefined;

    this.emit("run.completed", { chars: final.length });
    return { runId: this.runId, line: "swarm", final, events: this.events };
  }

  private withJournal(runner: TaskRunner): TaskRunner {
    return async (subtask, context) => {
      this.emit("task.started", { taskId: subtask.id });
      const result = await runner(subtask, context);
      this.emit("task.completed", { taskId: subtask.id, success: result.success });
      return result;
    };
  }

  private nowIso(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}

/** DAG 线子任务执行器：纯 LLM 调用（工具型执行属 Swarm worker，批3）。 */
export function createDagTaskRunner(llm: ChatLLM): TaskRunner {
  return async (subtask, context) => {
    const injections: string[] = [];
    if (context.previousResults && Object.keys(context.previousResults).length > 0) {
      injections.push(`## previous_results\n${JSON.stringify(context.previousResults, null, 2)}`);
    }
    if (context.dependencyResults && Object.keys(context.dependencyResults).length > 0) {
      injections.push(`## dependency_results\n${JSON.stringify(context.dependencyResults, null, 2)}`);
    }
    const user = [subtask.description, ...injections].join("\n\n");
    let response: string;
    let success = true;
    try {
      response = await llm.invoke(
        [
          { role: "system", content: "你是多 Agent 编排的子任务执行 worker，独立完成给定子任务并给出简洁结论。" },
          { role: "user", content: user },
        ],
        { temperature: 0.3 },
      );
    } catch (error) {
      // 单任务失败不炸整 run：转 success=false，交由 synthesis 过滤（spec：失败结果被过滤）
      response = `子任务 ${subtask.id} 执行失败：${error instanceof Error ? error.message : String(error)}`;
      success = false;
    }
    return {
      taskId: subtask.id,
      response,
      tokens: Math.ceil(response.length / 4),
      success,
      numericValue: extractNumericValue(response),
    };
  };
}
