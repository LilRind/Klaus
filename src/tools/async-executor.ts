/**
 * 异步工具执行器（对应书 7.5.4 async_tool_executor.py）
 *
 * 书里用 ThreadPoolExecutor + asyncio.gather；TS 里工具本来就是 async，
 * 真正要补的是**并发上限**（对应 max_workers=4）——
 * 用信号量实现有界并行，结果顺序与任务顺序一致（gather 语义）。
 */

import type { ToolRegistry } from "./registry";

export interface ParallelToolTask {
  toolName: string;
  input: string;
}

export class AsyncToolExecutor {
  private active = 0;
  private peakConcurrency = 0;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly maxConcurrency: number = 4,
  ) {}

  /** 异步执行单个工具（统一走注册表的异常包装） */
  async executeToolAsync(toolName: string, input: string): Promise<string> {
    return this.registry.executeTool(toolName, input);
  }

  /**
   * 并行执行多个工具任务：
   * - 并发数受 maxConcurrency 限制
   * - 结果顺序与 tasks 顺序一致
   * - 任一任务失败整体 reject（对应 asyncio.gather 默认语义）
   */
  async executeToolsParallel(tasks: ParallelToolTask[]): Promise<string[]> {
    if (tasks.length === 0) return [];
    const semaphore = { active: 0 };

    const results = await Promise.all(
      tasks.map(async (task) => {
        await this.acquire(semaphore);
        try {
          return await this.executeToolAsync(task.toolName, task.input);
        } finally {
          semaphore.active -= 1;
        }
      }),
    );
    return results;
  }

  /** 最近一次 executeToolsParallel 观测到的峰值并发（测试/监控用） */
  get lastPeakConcurrency(): number {
    return this.peakConcurrency;
  }

  private async acquire(semaphore: { active: number }): Promise<void> {
    while (semaphore.active >= this.maxConcurrency) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    semaphore.active += 1;
    this.active = semaphore.active;
    this.peakConcurrency = Math.max(this.peakConcurrency, this.active);
  }
}
