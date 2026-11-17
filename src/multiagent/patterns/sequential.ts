/**
 * 串行执行模式（来源：SN patterns/execution/sequential.go 的 previous_results 注入；
 * numeric_value 自动提数为 SN 字段的本地等价实现）。
 */

import type { AgentResult } from "../model";
import type { TaskRunner } from "./parallel";

export interface SequentialOptions {
  passPreviousResults?: boolean;
}

/** 提取文本中首个数值（"增长 15.3%" → 15.3）。 */
export function extractNumericValue(text: string): number | undefined {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const value = Number.parseFloat(match[0]);
  return Number.isFinite(value) ? value : undefined;
}

export async function runSequential(
  tasks: Parameters<TaskRunner>[0][],
  runTask: TaskRunner,
  options: SequentialOptions = {},
): Promise<AgentResult[]> {
  const pass = options.passPreviousResults ?? true;
  const previous: Record<string, AgentResult> = {};
  const results: AgentResult[] = [];
  for (const subtask of tasks) {
    const context = pass && Object.keys(previous).length > 0 ? { previousResults: { ...previous } } : {};
    const result = await runTask(subtask, context);
    previous[subtask.id] = result;
    results.push(result);
  }
  return results;
}
