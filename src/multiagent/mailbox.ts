/**
 * s18 Mailbox（来源：SN activities/p2p.go SendAgentMessage）。
 * 本地化：进程内 per-agent 队列 + per-box seq；读取即消费（SN 接收方下轮读取语义）。
 */

import { DEFAULTS, type P2PMessage, type P2PMessageType } from "./model";

export const P2P_MESSAGE_TYPES: readonly P2PMessageType[] = [
  "request",
  "offer",
  "accept",
  "delegation",
  "info",
];

export interface MailboxOptions {
  now?: () => string;
  /** journal 接入点：每次 send 回调。 */
  onSend?: (message: P2PMessage) => void;
}

export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailboxError";
  }
}

export class MailboxStore {
  private readonly boxes = new Map<string, { seq: number; queue: P2PMessage[] }>();

  constructor(private readonly options: MailboxOptions = {}) {}

  send(
    from: string,
    to: string,
    type: P2PMessageType,
    payload: Record<string, unknown> = {},
  ): P2PMessage {
    if (!P2P_MESSAGE_TYPES.includes(type)) {
      throw new MailboxError(`非法消息类型 ${String(type)}；支持：${P2P_MESSAGE_TYPES.join("/")}`);
    }
    const box = this.box(to);
    box.seq += 1;
    const message: P2PMessage = {
      seq: box.seq,
      from,
      to,
      type,
      payload,
      at: (this.options.now ?? (() => new Date().toISOString()))(),
    };
    box.queue.push(message);
    this.options.onSend?.(message);
    return message;
  }

  /** 读取即消费：返回并清空当前队列（同一条消息不会被读取两次）。 */
  readInbox(agent: string): P2PMessage[] {
    const box = this.boxes.get(agent);
    if (!box || box.queue.length === 0) return [];
    return box.queue.splice(0, box.queue.length);
  }

  private box(agent: string): { seq: number; queue: P2PMessage[] } {
    let box = this.boxes.get(agent);
    if (!box) {
      box = { seq: 0, queue: [] };
      this.boxes.set(agent, box);
    }
    return box;
  }
}
