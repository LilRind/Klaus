/**
 * s18 组装层（批1 范围：simple + DAG 两条线；swarm 线批3 接入）。
 * run 级 journal：.multiagent/<runId>/events.jsonl 逐事件追加（崩溃=interrupted 不续跑）。
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { ChatLLM } from "../core/llm";
import { decomposeTask } from "./decompose";
import { DEFAULTS, type ExecutionMode } from "./model";
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
}

export interface RunResult {
  runId: string;
  line: "simple" | "dag";
  final: string;
  events: JournalEvent[];
}

let runCounter = 0;

export class MultiagentOrchestrator {
  readonly runId: string;
  private readonly events: JournalEvent[] = [];
  private readonly journalFile: string;
  private journalReady = false;

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
      throw new MultiagentError("swarmPendingBatch3", "swarm 线在批3 交付（当前批1 仅 simple/DAG）");
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

  private withJournal(runner: TaskRunner): TaskRunner {
    return async (subtask, context) => {
      this.emit("task.started", { taskId: subtask.id });
      const result = await runner(subtask, context);
      this.emit("task.completed", { taskId: subtask.id, success: result.success });
      return result;
    };
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
    const response = await llm.invoke(
      [
        { role: "system", content: "你是多 Agent 编排的子任务执行 worker，独立完成给定子任务并给出简洁结论。" },
        { role: "user", content: user },
      ],
      { temperature: 0.3 },
    );
    return {
      taskId: subtask.id,
      response,
      tokens: Math.ceil(response.length / 4),
      success: true,
      numericValue: extractNumericValue(response),
    };
  };
}
