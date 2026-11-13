/**
 * S18 研判器（来源：dsh-superagent AssessmentSchema 裁剪版；调用形态沿用本项目
 * goal-evaluator 的"独立无工具 LLM 调用 + 平文 JSON 解析"先例）。
 *
 * 模型输出必须过手写校验（零依赖，项目风格）：accept 需要 intent_evidence 引证 +
 * 1..5 张子票（title/scope）；任何一项不满足都降级为 ignore 并带错误码——
 * "缺证据的接受"在代码层就不存在（dsh 的核心思想）。
 */

import type { ChatLLM } from "../core/llm";
import type { Trigger } from "./model";

export const MAX_ASSESSMENT_TICKETS = 5;

export interface TicketDraft {
  title: string;
  scope: string;
}

export type AssessmentErrorCode =
  | "invalidJson"
  | "invalidShape"
  | "acceptWithoutTickets"
  | "tooManyTickets"
  | "missingEvidence";

export type AssessmentOutcome =
  | { kind: "accept"; reason: string; tickets: TicketDraft[] }
  | { kind: "ignore"; reason: string; code?: AssessmentErrorCode };

export const ASSESSMENT_SYSTEM_PROMPT = [
  "你是多 Agent 编排系统的研判器。判断用户输入是否是可执行的工作请求，并拆解为独立工单。",
  '只输出一个 JSON 对象，accept 形如：',
  '{"decision":"accept","reason":"一句话理由","intent_evidence":"用户原文中表明工作意图的关键引文","tickets":[{"title":"简短标题","scope":"这票工作的边界：做什么、不做什么"}]}',
  'ignore 形如：{"decision":"ignore","reason":"一句话理由（如闲聊/提问/信息不足）"}',
  "规则：accept 必须给出 1-5 张相互独立的子票；scope 要可直接执行、不预设实现；无法判断或非工作请求用 ignore。不要输出 JSON 以外的任何文字。",
].join("\n");

/** 手写校验（dsh zod schema 的零依赖等价物）：任何不合格都降级 ignore + 错误码。 */
export function outcomeFromRaw(raw: unknown): AssessmentOutcome {
  if (raw === null || typeof raw !== "object") {
    return { kind: "ignore", reason: "研判输出不是对象", code: "invalidShape" };
  }
  const value = raw as Record<string, unknown>;
  const decision = value["decision"];
  const reason = value["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    return { kind: "ignore", reason: "研判缺少 reason", code: "invalidShape" };
  }
  if (decision === "ignore") return { kind: "ignore", reason };
  if (decision !== "accept") {
    return { kind: "ignore", reason: `未知 decision：${String(decision)}`, code: "invalidShape" };
  }
  const evidence = value["intent_evidence"];
  if (typeof evidence !== "string" || evidence.trim() === "") {
    return { kind: "ignore", reason: "accept 缺少 intent_evidence 引证", code: "missingEvidence" };
  }
  const ticketsRaw = value["tickets"];
  if (!Array.isArray(ticketsRaw) || ticketsRaw.length === 0) {
    return { kind: "ignore", reason: "accept 至少需要一张子票", code: "acceptWithoutTickets" };
  }
  if (ticketsRaw.length > MAX_ASSESSMENT_TICKETS) {
    return {
      kind: "ignore",
      reason: `子票数超过上限 ${MAX_ASSESSMENT_TICKETS}`,
      code: "tooManyTickets",
    };
  }
  const tickets: TicketDraft[] = [];
  for (const item of ticketsRaw) {
    if (item === null || typeof item !== "object") {
      return { kind: "ignore", reason: "子票不是对象", code: "invalidShape" };
    }
    const draft = item as Record<string, unknown>;
    const title = draft["title"];
    const scope = draft["scope"];
    if (typeof title !== "string" || title.trim() === "" || title.length > 160) {
      return { kind: "ignore", reason: "子票 title 非法", code: "invalidShape" };
    }
    if (typeof scope !== "string" || scope.trim() === "" || scope.length > 2000) {
      return { kind: "ignore", reason: "子票 scope 非法", code: "invalidShape" };
    }
    tickets.push({ title, scope });
  }
  return { kind: "accept", reason, tickets };
}

/** 从模型输出提取第一个平衡的 JSON 对象（对齐 goal-evaluator 的容错解析）。 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** 研判一次 Trigger：LLM 调用/解析/校验失败一律降级 ignore（带错误码），永不抛错。 */
export async function assessTrigger(llm: ChatLLM, trigger: Trigger): Promise<AssessmentOutcome> {
  let text: string;
  try {
    text = await llm.invoke(
      [
        { role: "system", content: ASSESSMENT_SYSTEM_PROMPT },
        { role: "user", content: trigger.text },
      ],
      { temperature: 0 },
    );
  } catch (error) {
    return {
      kind: "ignore",
      reason: `研判调用失败：${error instanceof Error ? error.message : String(error)}`,
      code: "invalidJson",
    };
  }
  const parsed = extractJsonObject(text);
  if (parsed === undefined) {
    return { kind: "ignore", reason: "研判输出不含可解析 JSON", code: "invalidJson" };
  }
  return outcomeFromRaw(parsed);
}
