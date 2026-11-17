/**
 * s18 协商协议（来源：书 16.6 / SN p2p.go 的 Contract-Net 三步裁剪）：
 * request 广播 → offer(置信度) → accept 最高者 + 未中标 info 通知。
 */

import type { MailboxStore } from "./mailbox";

export interface TaskRequestPayload {
  taskId: string;
  description: string;
  skills: string[];
}

export interface Offer {
  from: string;
  confidence: number;
}

export function broadcastTaskRequest(
  mailbox: MailboxStore,
  coordinator: string,
  candidates: string[],
  request: TaskRequestPayload,
): void {
  for (const candidate of candidates) {
    mailbox.send(coordinator, candidate, "request", { ...request });
  }
}

export function submitOffer(
  mailbox: MailboxStore,
  from: string,
  coordinator: string,
  taskId: string,
  confidence: number,
): void {
  mailbox.send(from, coordinator, "offer", { taskId, confidence });
}

export function selectWinner(offers: Offer[]): Offer {
  return offers.reduce((best, offer) => (offer.confidence > best.confidence ? offer : best));
}

export function completeNegotiation(
  mailbox: MailboxStore,
  coordinator: string,
  offers: Offer[],
  request: { taskId: string },
): { winner: Offer; losers: Offer[] } {
  if (offers.length === 0) throw new Error("没有收到任何 offer，无法完成协商");
  const winner = selectWinner(offers);
  mailbox.send(coordinator, winner.from, "accept", { taskId: request.taskId });
  for (const loser of offers) {
    if (loser.from === winner.from) continue;
    mailbox.send(coordinator, loser.from, "info", {
      taskId: request.taskId,
      result: `未中标（中标者 ${winner.from}）`,
    });
  }
  return { winner, losers: offers.filter((offer) => offer.from !== winner.from) };
}
