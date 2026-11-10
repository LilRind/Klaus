/**
 * Cron 三工具（对齐 learn-claude-code s12）
 *
 * schedule_cron / list_crons / cancel_cron，回喂文案与 lcc 对齐。
 * 全部结构化契约；校验失败转 Error 文案回喂（不炸循环）。
 */

import { Tool, tryParseJsonObject } from "../tool";
import type { CronScheduler } from "../../scheduler/cron-scheduler";

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class ScheduleCronTool extends Tool {
  override get name(): string {
    return "schedule_cron";
  }

  override get description(): string {
    return "Schedule a prompt with a 5-field cron expression";
  }

  override get parametersDescription(): string {
    return 'JSON: {"cron": "*/5 * * * *", "prompt": "run tests", "recurring": true, "durable": true}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        cron: { type: "string", description: "5 段 cron：分 时 日 月 周" },
        prompt: { type: "string", description: "到点后交给 Agent 的任务" },
        recurring: { type: "boolean", description: "周期任务（默认 true）" },
        durable: { type: "boolean", description: "进程重启后保留（默认 true）" },
      },
      required: ["cron", "prompt"],
    };
  }

  constructor(private readonly scheduler: CronScheduler) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? {});
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const cron = asString(args.cron);
    const prompt = asString(args.prompt);
    if (!cron || !prompt) return "❌ 缺少必填参数 cron / prompt";
    const result = await this.scheduler.schedule(cron, prompt, {
      recurring: args.recurring === undefined ? undefined : args.recurring === true,
      durable: args.durable === undefined ? undefined : args.durable === true,
    });
    if (typeof result === "string") {
      return `Error: ${result}`;
    }
    return `Scheduled ${result.id}: ${result.cron} -> ${result.prompt}`;
  }
}

export class ListCronsTool extends Tool {
  override get name(): string {
    return "list_crons";
  }

  override get description(): string {
    return "List scheduled cron jobs";
  }

  override get parametersDescription(): string {
    return "JSON: {}（无参数）";
  }

  override get parametersSchema(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  constructor(private readonly scheduler: CronScheduler) {
    super();
  }

  override async execute(input: string): Promise<string> {
    return this.executeArgs(tryParseJsonObject(input.trim()) ?? {});
  }

  override async executeArgs(_args: Record<string, unknown>): Promise<string> {
    const jobs = [...this.scheduler.jobs.values()];
    if (jobs.length === 0) return "No cron jobs.";
    return jobs
      .map((job) => {
        const frequency = job.recurring ? "recurring" : "one-shot";
        const storage = job.durable ? "durable" : "session";
        return `${job.id}: ${job.cron} -> ${job.prompt.slice(0, 60)} [${frequency}, ${storage}]`;
      })
      .join("\n");
  }
}

export class CancelCronTool extends Tool {
  override get name(): string {
    return "cancel_cron";
  }

  override get description(): string {
    return "Cancel a cron job by ID";
  }

  override get parametersDescription(): string {
    return 'JSON: {"job_id": "cron_xxxx"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    };
  }

  constructor(private readonly scheduler: CronScheduler) {
    super();
  }

  override async execute(input: string): Promise<string> {
    return this.executeArgs(
      tryParseJsonObject(input.trim()) ?? { job_id: input.trim() },
    );
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const jobId = asString(args.job_id);
    if (!jobId) return "❌ 缺少必填参数 job_id";
    return await this.scheduler.cancel(jobId);
  }
}
