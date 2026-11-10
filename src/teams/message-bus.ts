/**
 * s13 MessageBus：持久化文件邮箱 + 破坏性读取。
 *
 * lcc 用 threading.Condition；TS 单进程 async 事件驱动下等价物是
 * injectable sleep + 轮询 deadline。读取会删除整个 JSONL 文件，
 * 保证一条 teammate 事件只投递一次（至少一次由调用方 ack/重试负责）。
 */

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const VALID_AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type TeamMessageType =
  | "message"
  | "result"
  | "idle_notification"
  | "error"
  | "plan_request"
  | "plan_approval_request"
  | "plan_approval_response"
  | "shutdown_request"
  | "shutdown_response";

export interface TeamMessage {
  from: string;
  to: string;
  content: string;
  type: TeamMessageType;
  ts: number;
  metadata: Record<string, unknown>;
}

export interface MessageBusOptions {
  directory: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
}

export function isValidAgentName(name: string): boolean {
  return typeof name === "string" && VALID_AGENT_NAME.test(name);
}

export class MessageBus {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollIntervalMs: number;

  constructor(options: MessageBusOptions) {
    this.directory = path.resolve(options.directory);
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollIntervalMs = options.pollIntervalMs ?? 50;
  }

  private mailbox(agent: string): string {
    if (!isValidAgentName(agent)) {
      throw new Error(`Invalid mailbox recipient: ${JSON.stringify(agent)}`);
    }
    const target = path.resolve(this.directory, `${agent}.jsonl`);
    const rel = path.relative(this.directory, target);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Mailbox path escapes directory: ${JSON.stringify(agent)}`);
    }
    return target;
  }

  async send(
    fromAgent: string,
    toAgent: string,
    content: string,
    type: TeamMessageType = "message",
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    if (!isValidAgentName(fromAgent)) {
      throw new Error(`Invalid mailbox sender: ${JSON.stringify(fromAgent)}`);
    }
    const message: TeamMessage = {
      from: fromAgent,
      to: toAgent,
      content,
      type,
      ts: this.now(),
      metadata,
    };
    const target = this.mailbox(toAgent);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(message)}\n`, { encoding: "utf8", flag: "a" });
  }

  async readInbox(agent: string): Promise<TeamMessage[]> {
    const inbox = this.mailbox(agent);
    let raw: string;
    try {
      raw = await readFile(inbox, "utf8");
    } catch {
      return [];
    }
    const messages: TeamMessage[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      messages.push(JSON.parse(line) as TeamMessage);
    }
    await unlink(inbox);
    return messages;
  }

  async peek(agent: string): Promise<boolean> {
    try {
      return (await readFile(this.mailbox(agent), "utf8")).trim().length > 0;
    } catch {
      return false;
    }
  }

  async waitForMessages(agent: string, timeoutMs?: number): Promise<TeamMessage[]> {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    for (;;) {
      if (await this.peek(agent)) return this.readInbox(agent);
      const remaining = deadline - Date.now();
      if (remaining <= 0) return [];
      await this.sleep(Math.max(0, Math.min(this.pollIntervalMs, remaining)));
    }
  }
}
