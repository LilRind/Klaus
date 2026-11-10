/**
 * s12 Cron Scheduler 离线验收（对齐 README"试一下"观察点）
 *
 * - 五段 cron 匹配（通配、步长、固定值、区间、列表；日/星期 OR 语义）；
 * - validateCron 全分支（字段数 / 步长 / 区间倒置 / 越界带字段名）；
 * - schedule/cancel + durable 原子持久化与非 durable 会话级；
 * - pollDueJobs：分钟标记去重、pendingDelivery 跳过、持久化失败回滚；
 * - consume/acknowledge/restore（至少一次交付：模型成功才确认，失败重入队）；
 * - loadDurableJobs：损坏报错不静默、pendingDelivery 重入队、坏条目跳过；
 * - 工具回喂文案 + ScheduledTurnRunner 与 FunctionCallAgent 集成。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cronMatches, validateCron } from "../src/scheduler/cron";
import {
  CronScheduler,
  ScheduledTurnRunner,
} from "../src/scheduler/cron-scheduler";
import {
  CancelCronTool,
  ListCronsTool,
  ScheduleCronTool,
} from "../src/tools/builtin/cron-tools";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";
import type { CronJob } from "../src/scheduler/cron-scheduler";
import type { ScheduleOptions } from "../src/scheduler/cron-scheduler";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s12-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

function newScheduler(): CronScheduler {
  return new CronScheduler({
    statePath: path.join(workspace, ".scheduled_tasks.json"),
  });
}

/** schedule 的必成功包装（校验失败直接让测试炸掉） */
async function mustSchedule(
  scheduler: CronScheduler,
  cron: string,
  prompt: string,
  options?: ScheduleOptions,
): Promise<CronJob> {
  const job = await scheduler.schedule(cron, prompt, options);
  if (typeof job === "string") throw new Error(job);
  return job;
}

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function turn(...toolCalls: ToolCallRequest[]): ToolInvocationResult {
  return { content: null, toolCalls };
}

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

/** 固定时刻：2026-11-09 周一 09:01 */
const MONDAY_0901 = new Date(2026, 10, 9, 9, 1, 0);

describe("cron 表达式（s12 对齐）", () => {
  it("五字段匹配：*/N、固定值、区间、列表、通配", () => {
    expect(cronMatches("* * * * *", MONDAY_0901)).toBe(true);
    expect(cronMatches("0 9 * * *", MONDAY_0901)).toBe(false); // 09:01
    expect(cronMatches("1 9 * * *", MONDAY_0901)).toBe(true);
    expect(cronMatches("*/5 * * * *", MONDAY_0901)).toBe(false); // 1 % 5
    expect(cronMatches("0-5 * * * *", MONDAY_0901)).toBe(true);
    expect(cronMatches("1,15,30 * * * *", MONDAY_0901)).toBe(true);
    expect(cronMatches("* * 9 11 *", MONDAY_0901)).toBe(true); // 11 月 9 日
    expect(cronMatches("* * * * 0", MONDAY_0901)).toBe(false); // 周日=0
    expect(cronMatches("* * * * 1", MONDAY_0901)).toBe(true); // 周一
  });

  it("日与星期同为具体值时 OR 语义（对齐标准 cron）", () => {
    expect(cronMatches("1 9 10 11 1", MONDAY_0901)).toBe(true); // day 不中但 weekday=1 中
    expect(cronMatches("1 9 10 11 2", MONDAY_0901)).toBe(false);
    expect(cronMatches("1 9 * 11 2", MONDAY_0901)).toBe(false);
    expect(cronMatches("1 9 10 11 *", MONDAY_0901)).toBe(false);
  });

  it("validateCron：字段数 / 步长 / 区间倒置 / 越界（带字段名）", () => {
    expect(validateCron("* * * *")).toBe("Expected 5 fields, got 4");
    expect(validateCron("*/0 * * * *")).toBe("minute: Invalid step: */0");
    expect(validateCron("5-1 * * * *")).toBe(
      "minute: Range start is greater than end: 5-1",
    );
    expect(validateCron("60 * * * *")).toBe("minute: Value 60 is outside [0-59]");
    expect(validateCron("* 24 * * *")).toBe("hour: Value 24 is outside [0-23]");
    expect(validateCron("* * 0 * *")).toBe(
      "day-of-month: Value 0 is outside [1-31]",
    );
    expect(validateCron("* * * 13 *")).toBe("month: Value 13 is outside [1-12]");
    expect(validateCron("* * * * 7")).toBe(
      "day-of-week: Value 7 is outside [0-6]",
    );
    expect(validateCron("*/5 9 * * 1-5")).toBeNull();
  });
});

describe("CronScheduler（调度与持久化）", () => {
  it("schedule：生成 cron_ 前缀 ID；durable 原子落盘", async () => {
    const scheduler = newScheduler();
    const job = await mustSchedule(scheduler, "*/2 * * * *", "run date");
    expect(job.id).toMatch(/^cron_[0-9a-f]{8}$/);
    expect(job.recurring).toBe(true);
    expect(job.durable).toBe(true);

    const raw = JSON.parse(
      await readFile(path.join(workspace, ".scheduled_tasks.json"), "utf8"),
    );
    expect(raw).toEqual([job]);
  });

  it("schedule 校验失败返回错误文案；空 prompt 拒绝", async () => {
    const scheduler = newScheduler();
    await expect(scheduler.schedule("bad", "p")).resolves.toBe(
      "Expected 5 fields, got 1",
    );
    await expect(scheduler.schedule("* * * * *", "  ")).resolves.toBe(
      "Prompt cannot be empty",
    );
    expect(scheduler.jobs.size).toBe(0);
  });

  it("非 durable 任务不落盘（会话级）", async () => {
    const scheduler = newScheduler();
    await scheduler.schedule("* * * * *", "session job", { durable: false });
    await expect(
      readFile(path.join(workspace, ".scheduled_tasks.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("pollDueJobs：到期入队 + 分钟标记去重", async () => {
    const scheduler = newScheduler();
    const job = await mustSchedule(scheduler, "* * * * *", "every minute");

    await scheduler.pollDueJobs(MONDAY_0901);
    expect(scheduler.hasQueue()).toBe(true);
    expect(job.pendingDelivery).toBe(true);
    expect(job.lastFired).toBe("2026-11-09 09:01");

    // 同一分钟再次轮询：last_fired 相同 → 不重复入队
    scheduler.consumeQueue();
    await scheduler.pollDueJobs(MONDAY_0901);
    expect(scheduler.hasQueue()).toBe(false);

    // 下一分钟再次到期
    job.pendingDelivery = false;
    await scheduler.pollDueJobs(new Date(2026, 10, 9, 9, 2, 0));
    expect(scheduler.hasQueue()).toBe(true);
    expect(job.lastFired).toBe("2026-11-09 09:02");
  });

  it("未到期不入队", async () => {
    const scheduler = newScheduler();
    await scheduler.schedule("0 9 * * *", "daily 9am");
    await scheduler.pollDueJobs(MONDAY_0901); // 09:01
    expect(scheduler.hasQueue()).toBe(false);
  });

  it("持久化失败回滚：任务不入队、状态还原", async () => {
    const scheduler = newScheduler();
    const job = await mustSchedule(scheduler, "* * * * *", "rollback me");
    const persist = vi
      .spyOn(scheduler, "saveDurableJobs")
      .mockRejectedValue(new Error("disk full"));

    await expect(scheduler.pollDueJobs(MONDAY_0901)).rejects.toThrow(
      "disk full",
    );
    expect(job.pendingDelivery).toBe(false);
    expect(job.lastFired).toBeNull();
    expect(scheduler.hasQueue()).toBe(false);
    persist.mockRestore();
  });

  it("acknowledge：recurring 清 pendingDelivery；one-shot 删除；持久化失败回滚", async () => {
    const scheduler = newScheduler();
    const recurring = await mustSchedule(scheduler, "* * * * *", "recurring");
    const oneShot = await mustSchedule(scheduler, "* * * * *", "once", {
      recurring: false,
    });
    await scheduler.pollDueJobs(MONDAY_0901);
    const fired = scheduler.consumeQueue();
    expect(fired.map((j) => j.id)).toEqual([recurring.id, oneShot.id]);

    await scheduler.acknowledge(fired);
    expect(recurring.pendingDelivery).toBe(false);
    expect(scheduler.jobs.has(oneShot.id)).toBe(false);
    expect(scheduler.hasQueue()).toBe(false);

    // 回滚路径：ack 时持久化失败 → one-shot 回表、pendingDelivery 还原、重入队
    const again = await mustSchedule(scheduler, "* * * * *", "once more", {
      recurring: false,
    });
    again.pendingDelivery = true;
    scheduler.restore([again]);
    const firedAgain = scheduler.consumeQueue();
    const failingPersist = vi
      .spyOn(scheduler, "saveDurableJobs")
      .mockRejectedValue(new Error("disk full"));
    await expect(scheduler.acknowledge(firedAgain)).rejects.toThrow(
      "disk full",
    );
    failingPersist.mockRestore();
    expect(scheduler.jobs.has(again.id)).toBe(true);
    expect(again.pendingDelivery).toBe(true);
    expect(scheduler.hasQueue()).toBe(true);
  });

  it("restore：失败后重入队等待再次交付", async () => {
    const scheduler = newScheduler();
    const job = await mustSchedule(scheduler, "* * * * *", "retry");
    job.pendingDelivery = true;
    scheduler.consumeQueue();
    scheduler.restore([job]);
    expect(scheduler.hasQueue()).toBe(true);
    expect(scheduler.consumeQueue()[0]?.id).toBe(job.id);
  });

  it("cancel：移除任务与队列项；未找到返回文案", async () => {
    const scheduler = newScheduler();
    const job = await mustSchedule(scheduler, "* * * * *", "cancel me");
    await scheduler.pollDueJobs(MONDAY_0901);
    await expect(scheduler.cancel(job.id)).resolves.toBe(`Cancelled ${job.id}`);
    expect(scheduler.jobs.size).toBe(0);
    expect(scheduler.hasQueue()).toBe(false);
    await expect(scheduler.cancel(job.id)).resolves.toBe(
      `Job ${job.id} not found`,
    );
  });

  it("loadDurableJobs：跨实例恢复 + pendingDelivery 重入队", async () => {
    const first = newScheduler();
    const job = await mustSchedule(first, "0 9 * * *", "daily at 9", {
      recurring: false,
    });
    job.pendingDelivery = true;
    await first.saveDurableJobs();

    const second = newScheduler();
    const { loaded, errors } = await second.loadDurableJobs();
    expect(loaded).toBe(1);
    expect(errors).toEqual([]);
    expect(second.jobs.get(job.id)?.prompt).toBe("daily at 9");
    expect(second.hasQueue()).toBe(true);
  });

  it("loadDurableJobs：文件损坏报错不静默；坏条目跳过", async () => {
    const statePath = path.join(workspace, ".scheduled_tasks.json");
    await writeFile(statePath, "{not json", "utf8");
    const broken = newScheduler();
    const brokenResult = await broken.loadDurableJobs();
    expect(brokenResult.loaded).toBe(0);
    expect(brokenResult.errors[0]).toMatch(/could not load/);

    // 构造坏条目（非法 cron 的 id）+ 合法条目混合
    const scheduler = newScheduler();
    const good = await mustSchedule(scheduler, "0 9 * * *", "good");
    const jobs = [
      { ...good, id: "bad_id", cron: "99 * * * *" },
      good,
    ];
    await writeFile(statePath, JSON.stringify(jobs), "utf8");
    const mixed = newScheduler();
    const mixedResult = await mixed.loadDurableJobs();
    expect(mixedResult.loaded).toBe(1);
    expect(mixedResult.errors[0]).toMatch(/skipped invalid saved job/);
  });
});

describe("cron 工具（s12 三工具契约）", () => {
  it("schedule/list/cancel 回喂文案对齐 lcc", async () => {
    const scheduler = newScheduler();
    const schedule = new ScheduleCronTool(scheduler);
    const list = new ListCronsTool(scheduler);
    const cancel = new CancelCronTool(scheduler);

    const scheduled = await schedule.executeArgs({
      cron: "*/2 * * * *",
      prompt: "run date",
    });
    expect(scheduled).toMatch(
      /^Scheduled cron_[0-9a-f]{8}: \*\/2 \* \* \* \* -> run date$/,
    );
    const id = (scheduled.split(" ")[1] ?? "").replace(/:$/, "");

    await expect(list.executeArgs({})).resolves.toBe(
      `${id}: */2 * * * * -> run date [recurring, durable]`,
    );
    await expect(cancel.executeArgs({ job_id: id })).resolves.toBe(
      `Cancelled ${id}`,
    );
    await expect(list.executeArgs({})).resolves.toBe("No cron jobs.");
  });

  it("schedule 校验失败 → Error 回喂；cancel 未找到文案", async () => {
    const scheduler = newScheduler();
    await expect(
      new ScheduleCronTool(scheduler).executeArgs({ cron: "x", prompt: "p" }),
    ).resolves.toBe("Error: Expected 5 fields, got 1");
    await expect(
      new CancelCronTool(scheduler).executeArgs({ job_id: "cron_00000000" }),
    ).resolves.toBe("Job cron_00000000 not found");
  });
});

describe("ScheduledTurnRunner + FunctionCallAgent 集成", () => {
  it("到期任务空闲交付：[Scheduled] prompt 进入模型；ack 清队", async () => {
    const scheduler = newScheduler();
    const llm = new ScriptedLLM([], [
      turn(call("t1", "list_crons", {})),
      finalTurn("scheduled done"),
    ]);
    const registry = new ToolRegistry()
      .register(new ListCronsTool(scheduler))
      .register(new ScheduleCronTool(scheduler));
    const agent = new FunctionCallAgent("s12-agent", llm, registry);
    const deliveredPrompts: string[] = [];
    const runner = new ScheduledTurnRunner({
      scheduler,
      runTurn: async (prompt) => {
        deliveredPrompts.push(prompt);
        await agent.run(`[Scheduled] ${prompt}`);
      },
    });

    await scheduler.schedule("* * * * *", "run date");
    await scheduler.pollDueJobs(MONDAY_0901);
    expect(await runner.deliverDue()).toBe(1);

    expect(deliveredPrompts).toEqual(["run date"]);
    expect(llm.toolCallsList[0]?.messages.at(-1)?.content).toBe(
      "[Scheduled] run date",
    );
    const job = [...scheduler.jobs.values()][0];
    expect(job?.pendingDelivery).toBe(false);
    expect(scheduler.hasQueue()).toBe(false);
  });

  it("模型调用失败 → 任务重入队（至少一次交付）", async () => {
    const scheduler = newScheduler();
    await scheduler.schedule("* * * * *", "must retry");
    await scheduler.pollDueJobs(MONDAY_0901);

    const llm = new ScriptedLLM([], []);
    const failingLlm = Object.create(llm) as ScriptedLLM;
    failingLlm.invokeWithTools = async () => {
      throw new Error("API down");
    };
    const agent = new FunctionCallAgent("s12-fail", failingLlm, new ToolRegistry());
    const runner = new ScheduledTurnRunner({
      scheduler,
      runTurn: async (prompt) => {
        await agent.run(`[Scheduled] ${prompt}`);
      },
    });

    await expect(runner.deliverDue()).rejects.toThrow("API down");
    expect(scheduler.hasQueue()).toBe(true);
    const job = [...scheduler.jobs.values()][0];
    expect(job?.pendingDelivery).toBe(true);
  });
});
