/**
 * S18 持久 effect 队列（来源：dsh-superagent src/app/effects.ts 移植 +
 * clowder dirty-bit drain 不变量）。
 *
 * 副作用一律先入 effect 表、事务提交后由本类执行（先存储后执行）：
 * - seq 保序：drain 按 seq 升序执行，同 Ticket 的 reply 消息严格按入队顺序投递；
 * - generation 防 ABA：执行期间同 (kind,key) 被重新入队则成功后不删新 payload；
 * - Later 不计失败：槽满/暂停类"现在不行"只推迟 due，attempts 不增；
 * - 指数退避：失败后 due = now + retry[0] * 2^attempts（封顶 retry[1]）；
 * - dirty-bit drain：drain 运行中若有新入队，结束后必再跑一轮——结构上不可能
 *   出现"队列非空、due、handler 已注册、无 drain 在跑"的堆积状态（clowder）。
 */

import type { EffectRow, OrchestrationStore } from "./store";

/** handler 抛出表示"现在不行"（如无空闲 worker 槽）：重排不计失败。 */
export class Later extends Error {}

export type EffectKind = "launch" | "reply";

export interface EffectPayloads {
  /** 启动一个 pending assignment；key = ticketId。 */
  launch: { ticketId: string; assignmentId: string };
  /** 投递一条 outbox 消息到 sink（REPL 打印）；key = 消息 id。 */
  reply: { messageId: string };
}

export type EffectHandler<K extends EffectKind> = (
  payload: EffectPayloads[K],
  key: string,
) => Promise<void> | void;

export interface EffectOptions {
  /** [初始退避, 最大退避] 毫秒，默认 [2000, 60000]（对齐 dsh）。 */
  retry?: [number, number];
  /** 保序 kind（如 reply）：drain 内串行执行，一个失败压住后面的。 */
  ordered?: boolean;
  /** 并发 kind（如 launch）：同批行并发执行不互相等待（WorkerSlots 同步预留防超额）。 */
  concurrent?: boolean;
}

interface Registered {
  run: (payload: unknown, key: string) => Promise<void>;
  retry: readonly [number, number];
  ordered: boolean;
  concurrent: boolean;
}

export class Effects {
  private readonly handlers = new Map<EffectKind, Registered>();
  private draining = false;
  private dirty = false;

  constructor(
    private readonly store: OrchestrationStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 注册 handler（每 kind 一次）；重复注册抛错（dsh 同款防御）。 */
  handle<K extends EffectKind>(kind: K, run: EffectHandler<K>, options: EffectOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`effect ${kind} 已有 handler`);
    const retry = options.retry ?? [2_000, 60_000];
    this.handlers.set(kind, {
      run: run as (payload: unknown, key: string) => Promise<void>,
      retry,
      ordered: options.ordered ?? false,
      concurrent: options.concurrent ?? false,
    });
  }

  /** 是否有待执行行（可按 kind / key 过滤）。 */
  pending(kind?: EffectKind, key?: string): boolean {
    if (kind === undefined) {
      return this.store.db.prepare("SELECT 1 FROM effect LIMIT 1").get() !== undefined;
    }
    if (key === undefined) {
      return (
        this.store.db.prepare("SELECT 1 FROM effect WHERE kind = ? LIMIT 1").get(kind) !==
        undefined
      );
    }
    return (
      this.store.db
        .prepare("SELECT 1 FROM effect WHERE kind = ? AND key = ? LIMIT 1")
        .get(kind, key) !== undefined
    );
  }

  /**
   * 排空 due 的行：一次 drain 清空全部可执行工作（含执行中派生的新行——
   * launch 成功会派生 reply），结构上不可能"队列非空、due、却无 drain 在跑"。
   * 已有 drain 在跑时仅置 dirty 标记——并发调用安全且不饥饿。
   */
  async drain(): Promise<void> {
    if (this.draining) {
      this.dirty = true;
      return;
    }
    this.draining = true;
    try {
      for (;;) {
        this.dirty = false;
        const rows = this.store.listDueEffects(this.now());
        const inflight: Promise<void>[] = [];
        for (const row of rows) {
          const handler = this.handlers.get(row.kind as EffectKind);
          if (!handler) continue;
          if (handler.concurrent) inflight.push(this.attempt(row));
          else await this.attempt(row);
        }
        await Promise.all(inflight);
        if (!this.dirty && this.store.listDueEffects(this.now()).length === 0) return;
      }
    } finally {
      this.draining = false;
    }
  }

  private async attempt(row: EffectRow): Promise<void> {
    const handler = this.handlers.get(row.kind as EffectKind);
    if (!handler) return; // 未注册 handler 的行保留
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      // payload 损坏不可重试：删除该行
      this.store.deleteEffect(row.kind, row.key, row.generation);
      return;
    }
    try {
      await handler.run(payload, row.key);
      // 成功：仅当 generation 未变才删除（执行期间重新入队则新 payload 留给下轮）
      this.store.deleteEffect(row.kind, row.key, row.generation);
    } catch (error) {
      if (error instanceof Later) {
        const delay = this.backoff(handler.retry, row.attempts);
        this.store.retryEffect(row.kind, row.key, this.now() + delay, "", false);
        return;
      }
      const attempts = row.attempts + 1;
      const delay = this.backoff(handler.retry, attempts);
      this.store.retryEffect(
        row.kind,
        row.key,
        this.now() + delay,
        error instanceof Error ? error.message : String(error),
        true,
      );
    }
  }

  private backoff(retry: readonly [number, number], attempts: number): number {
    return Math.min(retry[0] * 2 ** Math.min(attempts, 16), retry[1]);
  }
}
