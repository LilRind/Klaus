/**
 * s16 Workflow Runtime（对齐 lcc Budget / ExecutionLimits /
 * LocalWorkflowTask / ExecutionState / WorkflowTool 核心生命周期）
 *
 * 一次 Workflow 工具调用跑完整套编排：脚本（宿主可信代码）通过
 * ExecutionState 的 agent/parallel/pipeline/workflow 原语发起 N 次子
 * agent 调用，每次结果逐条落 journal；一次调用返回
 * {launched, result, task}。resume 按稳定语义键回放缓存——没改过的
 * agent() 直接用 journal 结果（agents=0 tokens=0）。
 *
 * 翻译注记：asyncio.Semaphore → Promise 信号量；asyncio.gather(
 * return_exceptions=True) → Promise.allSettled（等全部分支落地后再抛
 * 第一个错，失败不炸已启动的 agent，journal 保持完整）；threading +
 * fcntl 跨进程 run 锁 → 进程内 Map 互斥（沿用决策 6）；脚本执行是
 * 同步等待完成（lcc run_workflow_sync 同语义），"async_launched" 只是
 * 生命周期事件，不是真正的后台执行。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SimpleJsonSchema, stableStringify, type JsonSchemaRecord } from "./workflow-schema";
import {
  WorkflowInputError,
  WorkflowJournal,
  reserveRunId,
  validateRunId,
  workflowSemanticKey,
} from "./workflow-journal";
import type { WorkflowAgentRunner } from "./workflow-runner";
import type { WorkflowMeta, WorkflowRegistry, WorkflowScript } from "./workflow-registry";

/** 每 run agent() 调用硬上限（对齐 lcc AGENT_CAP） */
export const WORKFLOW_AGENT_CAP = 1000;
/** parallel 并发上限（对齐 lcc CONCURRENCY） */
export const WORKFLOW_CONCURRENCY = 8;

/** Promise 信号量（asyncio.Semaphore 的最小翻译） */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next) next();
  }
}

export interface ExecutionLimitsOptions {
  agentCap?: number;
  concurrency?: number;
}

/** run 级共享限额（嵌套 workflow 也共享同一份计数与信号量） */
export class ExecutionLimits {
  private readonly cap: number;
  private count = 0;
  readonly semaphore: Semaphore;

  constructor(options: ExecutionLimitsOptions = {}) {
    this.cap = options.agentCap ?? WORKFLOW_AGENT_CAP;
    this.semaphore = new Semaphore(options.concurrency ?? WORKFLOW_CONCURRENCY);
  }

  claimAgent(): void {
    this.count += 1;
    if (this.count > this.cap) {
      throw new WorkflowInputError(`agent() cap reached (${this.cap})`);
    }
  }

  get agents(): number {
    return this.count;
  }
}

/**
 * token 预算（对齐 lcc Budget）：花完即抛错，绝不静默超支。
 * TS 的 ChatLLM 不透出 usage，token 由 runner 估算（chars/4，翻译注记）。
 */
export class TokenBudget {
  private spentCount = 0;

  constructor(private readonly total: number | null = null) {}

  add(n: number): void {
    if (this.total !== null && this.spentCount + n > this.total) {
      throw new WorkflowInputError(
        `token budget exceeded (${this.spentCount + n} > ${this.total})`,
      );
    }
    this.spentCount += n;
  }

  spent(): number {
    return this.spentCount;
  }

  remaining(): number {
    return this.total === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, this.total - this.spentCount);
  }
}

export interface WorkflowProgressEvent {
  type: string;
  [key: string]: unknown;
}

/** 序列化后的任务状态（lcc serialize_task 对齐） */
export interface SerializedTask {
  taskId: string;
  taskType: "local_workflow";
  runId: string;
  workflowName: string;
  status: "running" | "completed" | "failed";
  usage: { agents: number; tokens: number };
  progress: WorkflowProgressEvent[];
}

/** workflow 本地任务：状态 + 用量 + 进度事件（对齐 lcc LocalWorkflowTask） */
export class LocalWorkflowTask {
  status: "running" | "completed" | "failed" = "running";
  usage = { agents: 0, tokens: 0 };
  readonly progress: WorkflowProgressEvent[] = [];

  constructor(
    readonly taskId: string,
    readonly runId: string,
    readonly meta: WorkflowMeta,
    private readonly onEvent?: (line: string) => void,
  ) {}

  /** 生命周期事件行（async_launched / task_started / task_notification） */
  event(name: string, data: Record<string, unknown>): string {
    const line = `${name} ${Object.entries(data)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`;
    this.onEvent?.(line);
    return line;
  }

  /** 进度事件：入 progress 数组 + 可选外发 */
  progressEvent(
    type: string,
    data: Record<string, unknown>,
  ): WorkflowProgressEvent {
    const event = { type, ...data };
    this.progress.push(event);
    const line = `${type} ${Object.entries(data)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`;
    this.onEvent?.(line);
    return event;
  }
}

/** 任务序列化（对齐 lcc serialize_task：JSON 可写、字段名不变） */
export function serializeTask(task: LocalWorkflowTask): SerializedTask {
  return {
    taskId: task.taskId,
    taskType: "local_workflow",
    runId: task.runId,
    workflowName: task.meta.name,
    status: task.status,
    usage: { ...task.usage },
    progress: [...task.progress],
  };
}

export interface ExecutionStateOptions {
  task: LocalWorkflowTask;
  journal: WorkflowJournal;
  runner: WorkflowAgentRunner;
  budget: TokenBudget;
  args: Record<string, unknown>;
  registry: WorkflowRegistry;
  /** 嵌套 workflow 深度（子状态 +1） */
  depth?: number;
  /** 缺省新建（cap 1000 / 并发 8）；嵌套子状态必须共享父 limits */
  limits?: ExecutionLimitsOptions | ExecutionLimits;
}

/**
 * 注入 workflow 脚本的编排原语集合（对齐 lcc ExecutionState，即 ctx）：
 * phase / log / agent / parallel / pipeline / workflow。
 */
export class ExecutionState {
  readonly task: LocalWorkflowTask;
  readonly journal: WorkflowJournal;
  readonly runner: WorkflowAgentRunner;
  readonly budget: TokenBudget;
  readonly args: Record<string, unknown>;
  private readonly registry: WorkflowRegistry;
  private readonly depth: number;
  private currentPhase: string | undefined;
  private readonly phasesSeen = new Set<string>();
  private readonly limits: ExecutionLimits;

  constructor(options: ExecutionStateOptions) {
    this.task = options.task;
    this.journal = options.journal;
    this.runner = options.runner;
    this.budget = options.budget;
    this.args = options.args;
    this.registry = options.registry;
    this.depth = options.depth ?? 0;
    this.limits =
      options.limits instanceof ExecutionLimits
        ? options.limits
        : new ExecutionLimits(options.limits);
  }

  /**
   * 开启一个 phase；后续 agent() 归组其下。Upsert 语义：重复声明
   * 同名 phase（如每个 pipeline item 各声明一次）不重复通告。
   */
  phase(title: string): void {
    this.currentPhase = title;
    if (!this.phasesSeen.has(title)) {
      this.phasesSeen.add(title);
      this.task.progressEvent("workflow_phase", { title });
    }
  }

  /** 产出 workflow_log 进度行 */
  log(message: string): void {
    this.task.progressEvent("workflow_log", { message });
  }

  /**
   * 发起一次子 agent 调用。带 schema 时校验输出（失败追加
   * "Return valid JSON." 重试一次）；resume 时缓存命中直接回放
   * （缓存值同样过 schema 校验，坏缓存拒绝）。
   */
  async agent(
    prompt: string,
    schema?: JsonSchemaRecord,
    label?: string,
    phase?: string,
  ): Promise<unknown> {
    const agentLabel = label ?? `${prompt.slice(0, 24)}...`;
    this.limits.claimAgent();
    if (this.budget.remaining() <= 0) {
      throw new WorkflowInputError("token budget exceeded");
    }

    const key = workflowSemanticKey("agent", agentLabel, prompt, schema);
    const cached = this.journal.cached(key);
    if (cached !== undefined) {
      if (schema !== undefined) {
        const [ok, err] = new SimpleJsonSchema(schema).validate(cached);
        if (!ok) {
          throw new WorkflowInputError(
            `cached agent output failed schema validation: ${err}`,
          );
        }
      }
      this.task.progressEvent("workflow_agent", {
        label: agentLabel,
        phase: phase ?? this.currentPhase,
        status: "cached",
      });
      return cached;
    }

    let result: unknown;
    let tokens: number;
    await this.limits.semaphore.acquire();
    try {
      const run = await this.runner.run(prompt, schema, agentLabel);
      result = run.value;
      tokens = run.tokens;
    } finally {
      this.limits.semaphore.release();
    }

    if (schema !== undefined) {
      let [ok, err] = new SimpleJsonSchema(schema).validate(result);
      if (!ok) {
        const retry = await this.runner.run(
          `${prompt}\n\nReturn valid JSON.`,
          schema,
          agentLabel,
        );
        result = retry.value;
        tokens += retry.tokens;
        [ok, err] = new SimpleJsonSchema(schema).validate(result);
        if (!ok) {
          throw new WorkflowInputError(
            `agent({schema}) invalid output: ${err}`,
          );
        }
      }
    }

    this.budget.add(tokens);
    this.task.usage.agents += 1;
    this.task.usage.tokens += tokens;
    this.journal.record(key, result);
    this.task.progressEvent("workflow_agent", {
      label: agentLabel,
      phase: phase ?? this.currentPhase,
      status: "done",
    });
    return result;
  }

  /**
   * 屏障并发（对齐 lcc parallel）：全部分支落地后才返回；任一失败
   * 等全部落地后抛第一个错——失败不炸已启动的 agent，journal 完整。
   */
  async parallel(thunks: Array<() => Promise<unknown>>): Promise<unknown[]> {
    const settled = await Promise.allSettled(thunks.map((thunk) => thunk()));
    for (const outcome of settled) {
      if (outcome.status === "rejected") throw outcome.reason;
    }
    return settled.map(
      (outcome) => (outcome as PromiseFulfilledResult<unknown>).value,
    );
  }

  /**
    * 分 item 串行流水线（对齐 lcc pipeline）：item 之间无屏障——item A
    * 可以在 stage 3 而 item B 还在 stage 1。每个 stage 收到
    * (前一结果, 原始 item, 下标)；任一 stage 抛错即整个 workflow 失败。
    */
  async pipeline<Item>(
    items: readonly Item[],
    ...stages: Array<
      (previous: unknown, item: Item, index: number) => Promise<unknown>
    >
  ): Promise<unknown[]> {
    const runItem = async (item: Item, idx: number): Promise<unknown> => {
      let value: unknown = item;
      for (const stage of stages) {
        value = await stage(value, item, idx);
      }
      return value;
    };
    return this.parallel(items.map((item, idx) => () => runItem(item, idx)));
  }

  /**
   * 内联运行一个已保存 workflow 作为子流程：仅允许一层嵌套，
   * 子状态共享本 run 的 journal / budget / agent 计数。
   */
  async workflow(
    name: string,
    args?: Record<string, unknown> | null,
  ): Promise<unknown> {
    if (this.depth >= 1) {
      throw new WorkflowInputError("workflow() nesting is one level only");
    }
    const found = this.registry.get(name);
    if (!found) {
      throw new WorkflowInputError(`unknown workflow '${name}'`);
    }
    const childArgs = args ?? {};
    const child = new ExecutionState({
      task: this.task,
      journal: this.journal,
      runner: this.runner,
      budget: this.budget,
      args: childArgs,
      registry: this.registry,
      depth: this.depth + 1,
      limits: this.limits,
    });
    return found.script(child, childArgs);
  }
}

export interface WorkflowRuntimeOptions {
  /** 运行产物目录（.runtime/，workspace 内围栏由装配层保证） */
  storeDir: string;
  registry: WorkflowRegistry;
  /** runner 实例或工厂（工厂对齐 lcc RUNNER_FACTORY） */
  runner: WorkflowAgentRunner | (() => WorkflowAgentRunner);
  /** 可注入限额（测试用小值；缺省 1000 / 8） */
  agentCap?: number;
  concurrency?: number;
  /** 可注入 runId 生成（测试固定 id 验证碰撞/锁路径） */
  createRunId?: (name: string) => string;
  /** 生命周期/进度事件外发（REPL/demo 打印；测试缺省静默） */
  onEvent?: (line: string) => void;
}

export interface LaunchedEnvelope {
  status: "async_launched";
  taskId: string;
  taskType: "local_workflow";
  runId: string;
  workflowName: string;
}

export interface WorkflowRunOutput {
  launched: LaunchedEnvelope;
  result: unknown;
  task: SerializedTask;
}

interface SnapshotRecord {
  runId: string;
  workflowName: string;
  args: Record<string, unknown>;
  task: SerializedTask;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, filePath);
}

async function readSnapshot(
  storeDir: string,
  runId: string,
): Promise<{ workflowName?: string; args?: Record<string, unknown> }> {
  const snapshotPath = path.join(storeDir, `${runId}.json`);
  let content: string;
  try {
    content = await readFile(snapshotPath, "utf8");
  } catch {
    throw new WorkflowInputError(`resume snapshot not found for ${runId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WorkflowInputError(`invalid resume snapshot for ${runId}`);
  }
  return parsed as { workflowName?: string; args?: Record<string, unknown> };
}

/**
 * Workflow 运行时（对齐 lcc WorkflowTool.call）：meta/权限校验 →
 * runId 预留或校验 → run 锁 → journal 准备（resume 严格校验名字与
 * args）→ 注册本地任务 + 写 snapshot → 执行脚本 → 写 output/snapshot/
 * last_run → 返回 launched/result/task。
 */
export class WorkflowRuntime {
  private readonly storeDir: string;
  private readonly registry: WorkflowRegistry;
  private readonly runner: WorkflowAgentRunner | (() => WorkflowAgentRunner);
  private readonly createId: ((name: string) => string) | undefined;
  private readonly onEvent: ((line: string) => void) | undefined;
  private readonly limitOptions: ExecutionLimitsOptions;
  /** 进程内 run 锁：活跃 run 拒绝并发 resume（跨进程锁记改进项） */
  private readonly activeRuns = new Map<string, boolean>();

  constructor(options: WorkflowRuntimeOptions) {
    this.storeDir = options.storeDir;
    this.registry = options.registry;
    this.runner = options.runner;
    this.createId = options.createRunId;
    this.onEvent = options.onEvent;
    this.limitOptions = {
      ...(options.agentCap !== undefined ? { agentCap: options.agentCap } : {}),
      ...(options.concurrency !== undefined
        ? { concurrency: options.concurrency }
        : {}),
    };
  }

  /**
   * 运行一个已保存 workflow（lcc WorkflowTool.call + run_workflow 适配
   * 的合并入口）：类型与 registry 校验 → deny 名单 → runId → run 锁 →
   * 执行 → 产物落盘。
   */
  async run(
    name: unknown,
    args?: unknown,
    resumeFromRunId?: unknown,
  ): Promise<WorkflowRunOutput> {
    if (typeof name !== "string") {
      throw new WorkflowInputError("workflow name must be a string");
    }
    const found = this.registry.get(name);
    if (!found) {
      throw new WorkflowInputError(`unknown workflow '${name}'`);
    }
    if (
      args !== undefined &&
      args !== null &&
      (typeof args !== "object" || Array.isArray(args))
    ) {
      throw new WorkflowInputError("workflow args must be an object");
    }
    this.registry.checkPermission(name);

    const argsInput = (args ?? undefined) as Record<string, unknown> | undefined;
    const resuming = resumeFromRunId !== undefined && resumeFromRunId !== null;
    let runId: string;
    if (resuming) {
      runId = validateRunId(resumeFromRunId);
    } else {
      runId = await reserveRunId(name, this.storeDir, this.createId);
    }

    if (this.activeRuns.get(runId)) {
      throw new WorkflowInputError(`workflow run ${runId} is already active`);
    }
    this.activeRuns.set(runId, true);
    try {
      return await this.runLocked(
        found.meta,
        found.script,
        argsInput,
        runId,
        resuming,
      );
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  private async runLocked(
    meta: WorkflowMeta,
    script: WorkflowScript,
    argsInput: Record<string, unknown> | undefined,
    runId: string,
    resuming: boolean,
  ): Promise<WorkflowRunOutput> {
    let args: Record<string, unknown>;
    let journal: WorkflowJournal;
    if (resuming) {
      const snapshot = await readSnapshot(this.storeDir, runId);
      if (snapshot.workflowName !== meta.name) {
        throw new WorkflowInputError(
          "resume runId does not match workflow meta",
        );
      }
      const savedArgs = snapshot.args ?? {};
      if (argsInput === undefined) {
        args = savedArgs;
      } else if (stableStringify(argsInput) !== stableStringify(savedArgs)) {
        throw new WorkflowInputError(
          "resume args do not match the original run",
        );
      } else {
        args = argsInput;
      }
      journal = await WorkflowJournal.open(runId, true, this.storeDir);
    } else {
      args = argsInput ?? {};
      journal = await WorkflowJournal.open(runId, false, this.storeDir);
    }

    const taskId = `local_workflow_${runId}`;
    const task = new LocalWorkflowTask(taskId, runId, meta, this.onEvent);
    const launched: LaunchedEnvelope = {
      status: "async_launched",
      taskId,
      taskType: "local_workflow",
      runId,
      workflowName: meta.name,
    };
    task.event("async_launched", { runId, taskId });
    task.event("task_started", {
      workflow: meta.name,
      phases: (meta.phases ?? []).join(",") || "-",
      resume: resuming,
    });
    await writeJson(path.join(this.storeDir, `${runId}.json`), {
      runId,
      workflowName: meta.name,
      args,
      task: serializeTask(task),
    } satisfies SnapshotRecord);

    let result: unknown;
    try {
      const runner =
        typeof this.runner === "function" ? this.runner() : this.runner;
      const ctx = new ExecutionState({
        task,
        journal,
        runner,
        budget: new TokenBudget(
          typeof args.budget === "number" ? args.budget : null,
        ),
        args,
        registry: this.registry,
        limits: new ExecutionLimits(this.limitOptions),
      });
      result = await script(ctx, args);
      task.status = "completed";
    } catch (error) {
      task.status = "failed";
      result = { error: error instanceof Error ? error.message : String(error) };
    } finally {
      journal.close();
    }

    await writeJson(path.join(this.storeDir, `${runId}.output.json`), result);
    await writeJson(path.join(this.storeDir, `${runId}.json`), {
      runId,
      workflowName: meta.name,
      args,
      task: serializeTask(task),
    } satisfies SnapshotRecord);
    await writeFile(path.join(this.storeDir, "last_run.txt"), runId, "utf8");
    task.event("task_notification", {
      status: task.status,
      agents: task.usage.agents,
      tokens: task.usage.tokens,
      outputFile: `.runtime/${runId}.output.json`,
    });
    return { launched, result, task: serializeTask(task) };
  }
}
