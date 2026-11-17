/**
 * 混合执行模式（来源：SN patterns/execution/hybrid.go；本地化偏差：依赖完成用
 * Promise 事件唤醒（零延迟），替代 SN 的 30s 增量轮询）。dependency_results 注入。
 */

import { Semaphore } from "../../workflow/workflow-runtime";
import { DEFAULTS, type AgentResult, type Subtask } from "../model";
import type { TaskRunner } from "./parallel";

export interface HybridOptions {
  maxConcurrency?: number;
  passDependencyResults?: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 安全检查：未知依赖立即报错；Kahn 快速环检测防永久挂起（正式验证在批2 decompose）。 */
function assertSchedulable(tasks: Subtask[]): void {
  const ids = new Set(tasks.map((task) => task.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, 0);
  }
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) throw new Error(`未知依赖 ${dep}（子任务 ${task.id}）`);
      indegree.set(task.id, (indegree.get(task.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), task.id]);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    processed += 1;
    for (const next of dependents.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (processed !== tasks.length) throw new Error("依赖图存在环，无法调度");
}

export async function runHybrid(
  tasks: Subtask[],
  runTask: TaskRunner,
  options: HybridOptions = {},
): Promise<AgentResult[]> {
  assertSchedulable(tasks);
  const semaphore = new Semaphore(options.maxConcurrency ?? DEFAULTS.maxConcurrency);
  const passResults = options.passDependencyResults ?? true;
  const completions = new Map<string, Deferred<AgentResult>>();
  for (const task of tasks) completions.set(task.id, deferred<AgentResult>());
  // 防御：Promise.all 首个拒绝后，兄弟任务的后续拒绝若无消费者会成为 unhandledRejection
  for (const completion of completions.values()) completion.promise.catch(() => undefined);

  for (const task of tasks) {
    void (async () => {
      try {
        const deps = await Promise.all(task.dependencies.map((dep) => completions.get(dep)!.promise));
        await semaphore.acquire();
        try {
          const dependencyResults = Object.fromEntries(
            task.dependencies.map((dep, index) => [dep, deps[index] as AgentResult] as const),
          );
          const result = await runTask(
            task,
            passResults && task.dependencies.length > 0 ? { dependencyResults } : {},
          );
          completions.get(task.id)!.resolve(result);
        } finally {
          semaphore.release();
        }
      } catch (error) {
        completions.get(task.id)!.reject(error);
      }
    })();
  }

  return Promise.all(tasks.map((task) => completions.get(task.id)!.promise));
}
