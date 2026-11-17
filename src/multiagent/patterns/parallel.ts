/**
 * 并行执行模式（来源：SN patterns/execution/parallel.go 的信号量并发；
 * 本地实现复用 s16 Semaphore，默认 5，结果按原序汇总）。
 */

import { Semaphore } from "../../workflow/workflow-runtime";
import { DEFAULTS, type AgentResult, type Subtask } from "../model";

export interface TaskRunContext {
  /** sequential：全部已完成前序结果。 */
  previousResults?: Record<string, AgentResult>;
  /** hybrid：被依赖子任务的结果。 */
  dependencyResults?: Record<string, AgentResult>;
}

export type TaskRunner = (subtask: Subtask, context: TaskRunContext) => Promise<AgentResult>;

export interface ParallelOptions {
  maxConcurrency?: number;
}

export async function runParallel(
  tasks: Subtask[],
  runTask: TaskRunner,
  options: ParallelOptions = {},
): Promise<AgentResult[]> {
  const semaphore = new Semaphore(options.maxConcurrency ?? DEFAULTS.maxConcurrency);
  const results = new Array<AgentResult>(tasks.length);
  await Promise.all(
    tasks.map(async (subtask, index) => {
      await semaphore.acquire();
      try {
        results[index] = await runTask(subtask, {});
      } finally {
        semaphore.release();
      }
    }),
  );
  return results;
}
