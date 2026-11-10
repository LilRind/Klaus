/**
 * Cron 调度器（对齐 learn-claude-code s12）
 *
 * 交付语义：到期 → 先持久化（pendingDelivery + lastFired）→ 入队 →
 * Agent 空闲时以 "[Scheduled] {prompt}" 用户消息触发一轮 → 模型成功后
 * 才 acknowledge（recurring 清 pendingDelivery / one-shot 删除）→
 * 失败 restore 重入队——至少一次交付。
 *
 * durable 任务原子写 .scheduled_tasks.json（tmp+rename）；损坏时启动报错
 * 不静默。调度器只在宿主显式轮询/启动定时器时工作——导入模块不启线程。
 */

import { randomBytes } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { cronMatches, validateCron } from "./cron";

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  durable: boolean;
  /** 已到期但尚未被模型接收 */
  pendingDelivery: boolean;
  /** 本地时间 "YYYY-MM-DD HH:MM"，防同一分钟重复入队 */
  lastFired: string | null;
}

export interface CronSchedulerOptions {
  /** durable 任务持久化文件；不传则纯内存（不落盘） */
  statePath?: string;
  /** 可注入时钟（默认真实时间；轮询入口也可显式传 moment） */
  now?: () => Date;
}

export interface ScheduleOptions {
  recurring?: boolean;
  durable?: boolean;
}

export interface LoadDurableResult {
  loaded: number;
  errors: string[];
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** 本地时间分钟标记（对齐 lcc strftime "%Y-%m-%d %H:%M"） */
export function minuteMarker(moment: Date): string {
  return (
    `${moment.getFullYear()}-${pad2(moment.getMonth() + 1)}-` +
    `${pad2(moment.getDate())} ${pad2(moment.getHours())}:${pad2(moment.getMinutes())}`
  );
}

const MAX_ID_ATTEMPTS = 100;

export class CronScheduler {
  readonly jobs = new Map<string, CronJob>();
  private readonly queue: CronJob[] = [];
  private readonly statePath: string | undefined;
  private readonly now: () => Date;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: CronSchedulerOptions = {}) {
    this.statePath = options.statePath;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 注册任务（对齐 lcc schedule_job）：校验失败返回错误文案；
   * durable 任务写入失败回滚（从 jobs 移除并重抛）。
   */
  async schedule(
    cron: string,
    prompt: string,
    options: ScheduleOptions = {},
  ): Promise<CronJob | string> {
    const validationError = validateCron(cron);
    if (validationError) return validationError;
    if (!prompt.trim()) return "Prompt cannot be empty";

    const job: CronJob = {
      id: await this.newJobId(),
      cron,
      prompt,
      recurring: options.recurring ?? true,
      durable: options.durable ?? true,
      pendingDelivery: false,
      lastFired: null,
    };
    this.jobs.set(job.id, job);
    try {
      if (job.durable) {
        await this.saveDurableJobs();
      }
    } catch (error) {
      this.jobs.delete(job.id);
      throw error;
    }
    return job;
  }

  private async newJobId(): Promise<string> {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const id = `cron_${randomBytes(4).toString("hex")}`;
      if (!this.jobs.has(id)) return id;
    }
    throw new Error("Could not allocate a cron job ID");
  }

  /** 取消任务：同步移除队列项；持久化失败回滚（对齐 lcc cancel_job） */
  async cancel(jobId: string): Promise<string> {
    const job = this.jobs.get(jobId);
    if (!job) return `Job ${jobId} not found`;

    this.jobs.delete(jobId);
    this.removeQueued(jobId);
    try {
      if (job.durable) {
        await this.saveDurableJobs();
      }
    } catch (error) {
      this.jobs.set(jobId, job);
      this.queue.push(...this.removedQueueSnapshot);
      throw error;
    }
    return `Cancelled ${jobId}`;
  }

  private removedQueueSnapshot: CronJob[] = [];

  private removeQueued(jobId: string): void {
    const index = this.queue.findIndex((job) => job.id === jobId);
    if (index >= 0) {
      this.removedQueueSnapshot = this.queue.splice(index, 1);
    } else {
      this.removedQueueSnapshot = [];
    }
  }

  /** 到期任务入队（对齐 lcc poll_due_jobs；moment 缺省用注入时钟） */
  async pollDueJobs(moment?: Date): Promise<void> {
    const at = moment ?? this.now();
    const marker = minuteMarker(at);
    for (const job of [...this.jobs.values()]) {
      if (job.pendingDelivery || job.lastFired === marker) continue;
      if (!cronMatches(job.cron, at)) continue;
      await this.enqueueDueJob(job, marker);
    }
  }

  /** 先持久化再入队；持久化失败还原状态并重抛（对齐 lcc _enqueue_due_job） */
  private async enqueueDueJob(job: CronJob, marker: string): Promise<void> {
    const oldPending = job.pendingDelivery;
    const oldLastFired = job.lastFired;
    job.pendingDelivery = true;
    job.lastFired = marker;
    try {
      if (job.durable) {
        await this.saveDurableJobs();
      }
    } catch (error) {
      job.pendingDelivery = oldPending;
      job.lastFired = oldLastFired;
      throw error;
    }
    this.queue.push(job);
  }

  hasQueue(): boolean {
    return this.queue.length > 0;
  }

  /** 取走到期任务（快照 + 清空，对齐 lcc consume_cron_queue） */
  consumeQueue(): CronJob[] {
    const jobs = [...this.queue];
    this.queue.length = 0;
    return jobs;
  }

  /**
   * 模型成功接收后的确认（对齐 lcc acknowledge_cron_jobs）：
   * recurring 清 pendingDelivery；one-shot 删除；持久化失败整体回滚并重入队。
   */
  async acknowledge(jobs: CronJob[]): Promise<void> {
    const changed: { job: CronJob; pending: boolean }[] = [];
    const removed: CronJob[] = [];
    for (const delivered of jobs) {
      const current = this.jobs.get(delivered.id);
      if (!current) continue;
      changed.push({ job: current, pending: current.pendingDelivery });
      if (current.recurring) {
        current.pendingDelivery = false;
      } else {
        removed.push(current);
        this.jobs.delete(current.id);
      }
    }
    try {
      if (changed.some(({ job }) => job.durable)) {
        await this.saveDurableJobs();
      }
    } catch (error) {
      for (const job of removed) {
        this.jobs.set(job.id, job);
      }
      for (const { job, pending } of changed) {
        job.pendingDelivery = pending;
      }
      const queuedIds = new Set(this.queue.map((job) => job.id));
      for (const { job } of changed) {
        if (!queuedIds.has(job.id)) {
          this.queue.push(job);
          queuedIds.add(job.id);
        }
      }
      throw error;
    }
  }

  /** 交付失败后重入队（对齐 lcc restore_cron_jobs） */
  restore(jobs: CronJob[]): void {
    const queuedIds = new Set(this.queue.map((job) => job.id));
    for (const delivered of jobs) {
      const current = this.jobs.get(delivered.id);
      if (!current) continue;
      current.pendingDelivery = true;
      if (!queuedIds.has(current.id)) {
        this.queue.push(current);
        queuedIds.add(current.id);
      }
    }
  }

  /** durable 任务原子落盘（tmp + rename；对齐 lcc save_durable_jobs） */
  async saveDurableJobs(): Promise<void> {
    if (!this.statePath) return;
    const payload = [...this.jobs.values()]
      .filter((job) => job.durable)
      .map((job) => ({ ...job }));
    const temporary = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(payload, null, 2), "utf8");
      await rename(temporary, this.statePath);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  /** 从磁盘恢复 durable 任务；损坏/坏条目报错不静默（对齐 lcc load_durable_jobs） */
  async loadDurableJobs(): Promise<LoadDurableResult> {
    const result: LoadDurableResult = { loaded: 0, errors: [] };
    if (!this.statePath) return result;
    let payload: unknown;
    try {
      payload = JSON.parse(await readFile(this.statePath, "utf8"));
      if (!Array.isArray(payload)) {
        throw new Error("expected a JSON list");
      }
    } catch (error) {
      result.errors.push(
        `could not load ${path.basename(this.statePath)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return result;
    }
    for (const item of payload) {
      try {
        const job = this.parseJob(item);
        const validationError = validateCron(job.cron);
        if (validationError) throw new Error(validationError);
        if (!job.id.startsWith("cron_")) throw new Error("invalid job ID");
        if (!job.prompt.trim()) throw new Error("prompt cannot be empty");
        this.jobs.set(job.id, job);
        if (job.pendingDelivery) {
          this.queue.push(job);
        }
        result.loaded += 1;
      } catch (error) {
        result.errors.push(
          `skipped invalid saved job: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return result;
  }

  private parseJob(item: unknown): CronJob {
    if (typeof item !== "object" || item === null) {
      throw new Error("job entry must be an object");
    }
    const raw = item as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      typeof raw.cron !== "string" ||
      typeof raw.prompt !== "string" ||
      typeof raw.recurring !== "boolean" ||
      typeof raw.durable !== "boolean"
    ) {
      throw new Error("job entry is missing required fields");
    }
    return {
      id: raw.id,
      cron: raw.cron,
      prompt: raw.prompt,
      recurring: raw.recurring,
      durable: raw.durable,
      pendingDelivery: raw.pendingDelivery === true,
      lastFired: typeof raw.lastFired === "string" ? raw.lastFired : null,
    };
  }

  /**
   * 启动轮询定时器（对齐 lcc cron_scheduler_loop 每秒一次）。
   * 单个轮询错误不中断调度（等价 lcc 的逐任务 try/except 打印）。
   */
  startPolling(intervalMs = 1_000): void {
    this.stopPolling();
    this.timer = setInterval(() => {
      void this.pollDueJobs().catch(() => undefined);
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export interface ScheduledTurnRunnerOptions {
  scheduler: CronScheduler;
  /** 交付一个到期 prompt（宿主负责把它交给 Agent 循环并触发模型调用） */
  runTurn: (prompt: string) => Promise<void>;
  /** 异步回合边界（s15 深化：切换非交互权限模式）；失败安全收尾 */
  onTurnStart?: () => void | Promise<void>;
  onTurnEnd?: () => void | Promise<void>;
}

/**
 * 到期任务的空闲交付器（对齐 lcc queue_processor_loop + run_agent_turn_locked：
 * 只在队列非空且 Agent 空闲时触发一轮；模型调用失败把任务放回队列）。
 * lcc 把同批到期任务并入一轮；TS 翻译为逐任务顺序交付（各自独立 ack）。
 */
export class ScheduledTurnRunner {
  private busy = false;

  constructor(private readonly options: ScheduledTurnRunnerOptions) {}

  /** 交付当前到期的任务；返回成功交付数；失败时未确认任务全部重入队并重抛 */
  async deliverDue(): Promise<number> {
    if (this.busy) return 0;
    const jobs = this.options.scheduler.consumeQueue();
    if (jobs.length === 0) return 0;

    this.busy = true;
    const acked = new Set<string>();
    try {
      for (const job of jobs) {
        try {
          await this.options.onTurnStart?.();
          try {
            await this.options.runTurn(job.prompt);
            await this.options.scheduler.acknowledge([job]);
            acked.add(job.id);
          } finally {
            await this.options.onTurnEnd?.();
          }
        } catch (error) {
          this.options.scheduler.restore(
            jobs.filter((j) => !acked.has(j.id)),
          );
          throw error;
        }
      }
      return jobs.length;
    } finally {
      this.busy = false;
    }
  }
}
