/**
 * s15 自动唤醒离线测试（对齐 lcc async_event_loop / agent_lock）：
 * HarnessLoop 轮次 FIFO 串行化 + 事件轮权限切换/还原；
 * AsyncEventLoop tick 单源优先级（cron → team → background）、busy 跳过、
 * 事件文本即唤醒轮输入、启动/停止生命周期。
 */

import { describe, expect, it } from "vitest";
import {
  AsyncEventLoop,
  HarnessLoop,
  type WakeSource,
} from "../src/harness/async-event-loop";
import { PermissionChecker } from "../src/security/permission";
import type { FunctionCallAgent } from "../src/agents/function-call-agent";
import type { ToolRegistry } from "../src/tools/registry";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 注入睡眠必须让出事件循环（setTimeout/immediate 宏任务）——
 * `async () => {}` 这类纯微任务睡眠会在 run 循环里形成热自旋，
 * 饿死测试自身的 delay 定时器（生产默认是 setTimeout，无此问题）。
 */
const yieldingSleep = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 只带 run / runEventTurn 形状的 agent 桩（HarnessLoop 只调这两个入口） */
function stubAgent(runs: string[]): FunctionCallAgent {
  return {
    run: async (input: string) => {
      runs.push(`user:${input}`);
      await delay(5);
      return input;
    },
    runEventTurn: async (input?: string) => {
      runs.push(`event:${input ?? ""}`);
      await delay(5);
      return input ?? "";
    },
  } as unknown as FunctionCallAgent;
}

function stubRegistry(applied: unknown[]): ToolRegistry {
  return {
    setPermissionChecker: (checker: unknown) => {
      applied.push(checker);
    },
  } as unknown as ToolRegistry;
}

describe("HarnessLoop（lcc agent_lock 的单进程翻译）", () => {
  it("用户轮与事件轮 FIFO 串行，不并发", async () => {
    const runs: string[] = [];
    const loop = new HarnessLoop({ agent: stubAgent(runs) });
    const p1 = loop.runUserTurn("a");
    const p2 = loop.runEventTurn("team events");
    const p3 = loop.runUserTurn("b");
    await Promise.all([p1, p2, p3]);
    expect(runs).toEqual(["user:a", "event:team events", "user:b"]);
    expect(loop.isBusy()).toBe(false);
  });

  it("事件轮期间切换异步权限视图，结束还原前台闸门", async () => {
    const runs: string[] = [];
    const applied: unknown[] = [];
    const foreground = new PermissionChecker();
    const asyncView = foreground.forAsyncTurns();
    const loop = new HarnessLoop({
      agent: stubAgent(runs),
      registry: stubRegistry(applied),
      asyncChecker: asyncView,
      foregroundChecker: foreground,
    });
    await loop.runUserTurn("plain");
    expect(applied).toEqual([]); // 用户轮不动权限
    await loop.runEventTurn();
    expect(applied).toEqual([asyncView, foreground]);
  });
});

describe("AsyncEventLoop.tickOnce（cron → team → background 单源优先级）", () => {
  function makeLoop(overrides: Partial<Record<"busy", boolean>>, events: {
    cronDue: boolean;
    teamEvents: string[];
    backgroundReady: boolean;
  }) {
    const runs: string[] = [];
    const wakes: WakeSource[] = [];
    let busy = overrides.busy ?? false;
    const fakeLoop = {
      isBusy: () => busy,
      runEventTurn: async (input?: string) => {
        runs.push(input ?? "");
        return "";
      },
    } as unknown as HarnessLoop;
    let cronDue = events.cronDue;
    let teamEvents = events.teamEvents;
    let backgroundReady = events.backgroundReady;
    const loop = new AsyncEventLoop({
      loop: fakeLoop,
      cron: {
        poll: async () => {},
        hasDue: () => cronDue,
      },
      team: {
        collect: async () => {
          const current = teamEvents;
          teamEvents = [];
          return current;
        },
      },
      background: {
        hasCompleted: () => backgroundReady,
        collect: () => {
          backgroundReady = false;
          return ["<task_notification>x"];
        },
      },
      onWake: (source) => wakes.push(source),
    });
    return { loop, runs, wakes, setBusy: (value: boolean) => (busy = value) };
  }

  it("cron 优先：队列非空即唤醒（轮内 drain，无合成 prompt）", async () => {
    const { loop, runs, wakes } = makeLoop({}, { cronDue: true, teamEvents: ["t"], backgroundReady: true });
    expect(await loop.tickOnce()).toBe(true);
    expect(runs).toEqual([""]);
    expect(wakes).toEqual(["cron"]);
  });

  it("cron 空时团队事件唤醒，事件文本 join 后作为轮输入", async () => {
    const { loop, runs, wakes } = makeLoop({}, { cronDue: false, teamEvents: ["[Team] a", "[Team] b"], backgroundReady: true });
    expect(await loop.tickOnce()).toBe(true);
    expect(runs).toEqual(["[Team] a\n[Team] b"]);
    expect(wakes).toEqual(["team"]);
  });

  it("再空则后台完成唤醒，通知文本作为轮输入", async () => {
    const { loop, runs, wakes } = makeLoop({}, { cronDue: false, teamEvents: [], backgroundReady: true });
    expect(await loop.tickOnce()).toBe(true);
    expect(runs).toEqual(["<task_notification>x"]);
    expect(wakes).toEqual(["background"]);
  });

  it("三源皆空 → 不唤醒", async () => {
    const { loop, runs } = makeLoop({}, { cronDue: false, teamEvents: [], backgroundReady: false });
    expect(await loop.tickOnce()).toBe(false);
    expect(runs).toEqual([]);
  });

  it("busy 时跳过（agent_lock 忙判定），事件保留待下个 tick", async () => {
    const { loop, runs, wakes, setBusy } = makeLoop({}, { cronDue: true, teamEvents: [], backgroundReady: false });
    setBusy(true);
    expect(await loop.tickOnce()).toBe(false);
    expect(runs).toEqual([]);
    expect(wakes).toEqual([]);
    setBusy(false);
    expect(await loop.tickOnce()).toBe(true);
  });
});

describe("AsyncEventLoop 生命周期（注入时钟，零真实等待）", () => {
  it("start 后按 interval tick；stop 后退出且幂等", async () => {
    const runs: string[] = [];
    const fakeLoop = {
      isBusy: () => false,
      runEventTurn: async (input?: string) => {
        runs.push(input ?? "");
        return "";
      },
    } as unknown as HarnessLoop;
    let cronDue = false;
    const loop = new AsyncEventLoop({
      loop: fakeLoop,
      cron: {
        poll: async () => {
          cronDue = runs.length < 2;
        },
        hasDue: () => cronDue,
      },
      intervalMs: 1,
      sleep: yieldingSleep,
    });
    loop.start();
    expect(loop.isRunning).toBe(true);
    // 唤醒两轮后 cron 不再到期；tick 继续空转
    while (runs.length < 2) {
      await delay(1);
    }
    expect(runs).toEqual(["", ""]);
    loop.stop();
    while (loop.isRunning) {
      await delay(1);
    }
    expect(loop.isRunning).toBe(false);
    const runsAfterStop = runs.length;
    await delay(5);
    expect(runs.length).toBe(runsAfterStop);
    loop.stop(); // 幂等
  });

  it("start 幂等：二次调用不产生第二条循环", async () => {
    const fakeLoop = {
      isBusy: () => false,
      runEventTurn: async () => "",
    } as unknown as HarnessLoop;
    const loop = new AsyncEventLoop({ loop: fakeLoop, intervalMs: 1, sleep: yieldingSleep });
    loop.start();
    loop.start();
    expect(loop.isRunning).toBe(true);
    loop.stop();
    while (loop.isRunning) {
      await delay(1);
    }
  });
});
