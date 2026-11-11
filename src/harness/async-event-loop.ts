/**
 * s15 自动唤醒 + 轮次串行化（对齐 lcc s15_integrated_harness/code.py:3273-3300
 * 的 async_event_loop 与 3092-3094 的 agent_lock）。
 *
 * HarnessLoop：用户轮 / 事件轮共用一个 Promise 链互斥（agent_lock 的
 * 单进程 async 翻译），事件轮期间把 registry 权限切换到异步视图
 * （ask → 直接拒绝），结束后还原前台闸门。
 *
 * AsyncEventLoop：默认 1s tick（对齐 lcc `time.sleep(1)`），依次检查
 * cron 队列 → Lead 收件箱 → 后台完成，任一事件非空即唤醒一轮
 * runEventTurn。单 tick 单源（多源下一 tick 补投——cron 有持久化
 * pendingDelivery、team 邮箱持久、bg ready 队列持久，至少一次不破）。
 */
import type { FunctionCallAgent } from "../agents/function-call-agent";
import type { PermissionChecker } from "../security/permission";
import type { ToolRegistry } from "../tools/registry";

/**
 * 轮级 cron 注入任务（agent 的 collectScheduledPrompts 钩子契约）：
 * prompt 注入为 `[Scheduled]` user 消息；模型调用成功后 harness 调
 * acknowledge（至少一次语义），最终失败由 agent 调 restore 重入队。
 */
export interface ScheduledPromptJob {
  prompt: string;
  acknowledge: () => Promise<void>;
  restore: () => void;
}

export interface HarnessLoopOptions {
  agent: FunctionCallAgent;
  /** 提供时事件轮期间切换异步权限视图、结束时还原 */
  registry?: ToolRegistry;
  /** 异步轮权限视图（PermissionChecker.forAsyncTurns() 的产物） */
  asyncChecker?: PermissionChecker;
  /** 前台权限闸门（事件轮结束还原用） */
  foregroundChecker?: PermissionChecker;
}

export class HarnessLoop {
  private readonly options: HarnessLoopOptions;
  /** 互斥队列尾：所有轮次串行接在同一条 Promise 链上 */
  private tail: Promise<unknown> = Promise.resolve();
  private busy = false;

  constructor(options: HarnessLoopOptions) {
    this.options = options;
  }

  /** 是否有轮次正在执行（唤醒 tick 据此跳过，对齐 lcc agent_lock 忙判定） */
  isBusy(): boolean {
    return this.busy;
  }

  /** 用户前台轮：排队等互斥 + 前台权限（ask 可询问） */
  runUserTurn(input: string): Promise<string> {
    return this.enqueue(() => this.options.agent.run(input));
  }

  /**
   * 异步事件轮：排队等互斥 + 事件轮期间换异步权限视图（cron/团队/后台
   * 唤醒均不可弹人工审批，对齐 lcc 异步轮语义）。
   */
  async runEventTurn(input?: string): Promise<string> {
    return this.enqueue(async () => {
      const { registry, asyncChecker, foregroundChecker } = this.options;
      if (registry && asyncChecker) {
        registry.setPermissionChecker(asyncChecker);
      }
      try {
        return await this.options.agent.runEventTurn(input);
      } finally {
        if (registry && foregroundChecker) {
          registry.setPermissionChecker(foregroundChecker);
        }
      }
    });
  }

  /** FIFO 串行：入队顺序即执行顺序（用户先入队先跑，先到先服务） */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail
      .then(() => {
        this.busy = true;
        return task();
      })
      .finally(() => {
        this.busy = false;
      });
    // 链条吞错（失败不断链），错误仍从本次调用的 Promise 抛给调用方
    this.tail = run.catch(() => undefined);
    return run;
  }
}

export type WakeSource = "cron" | "team" | "background";

export interface AsyncEventLoopOptions {
  loop: HarnessLoop;
  /** cron 事件源：每 tick 先 poll 到期入队，队列非空即唤醒（轮内 drain） */
  cron?: { poll: () => Promise<void>; hasDue: () => boolean };
  /** 团队事件源：collect 破坏性出队 Lead 收件箱（非空即唤醒） */
  team?: { collect: () => Promise<string[]> };
  /** 后台事件源：hasCompleted 非破坏 peek → collect 破坏性出队 */
  background?: { hasCompleted: () => boolean; collect: () => string[] };
  /** 默认 1000ms（对齐 lcc async_event_loop） */
  intervalMs?: number;
  /** tick 间隔睡眠；测试注入假时钟 */
  sleep?: (ms: number) => Promise<void>;
  /** tick 异常观测点（唤醒轮失败不崩循环，对齐 lcc daemon 线程语义） */
  onTickError?: (error: unknown) => void;
  /** 唤醒观测点（REPL 打印 / 测试断言） */
  onWake?: (source: WakeSource, detail: string) => void;
}

export class AsyncEventLoop {
  private readonly options: AsyncEventLoopOptions;
  private running = false;
  private stopped = false;

  constructor(options: AsyncEventLoopOptions) {
    this.options = options;
  }

  /** 启动后台轮询（幂等）；进程内定时，无独立线程 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    void this.run();
  }

  /** 停止轮询（幂等；进行中的唤醒轮会自然结束） */
  stop(): void {
    this.stopped = true;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * 单次 tick（测试驱动入口）：busy 跳过；按 cron → team → background
   * 优先级检查，命中即唤醒一轮。返回是否发生了唤醒。
   */
  async tickOnce(): Promise<boolean> {
    const { loop, cron, team, background, onWake } = this.options;
    if (loop.isBusy()) return false;
    if (cron) {
      await cron.poll();
      if (cron.hasDue()) {
        onWake?.("cron", "due jobs");
        await loop.runEventTurn();
        return true;
      }
    }
    if (team) {
      const events = await team.collect();
      if (events.length > 0) {
        onWake?.("team", `${events.length} events`);
        await loop.runEventTurn(events.join("\n"));
        return true;
      }
    }
    if (background && background.hasCompleted()) {
      const notifications = background.collect();
      if (notifications.length > 0) {
        onWake?.("background", `${notifications.length} notifications`);
        await loop.runEventTurn(notifications.join("\n"));
        return true;
      }
    }
    return false;
  }

  private async run(): Promise<void> {
    const intervalMs = this.options.intervalMs ?? 1_000;
    const sleep =
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    while (!this.stopped) {
      await sleep(intervalMs);
      if (this.stopped) break;
      try {
        await this.tickOnce();
      } catch (error) {
        this.options.onTickError?.(error);
      }
    }
    this.running = false;
  }
}
