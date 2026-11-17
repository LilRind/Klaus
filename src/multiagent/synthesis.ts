/**
 * 结果综合（来源：SN strategy helpers 的 preprocess + LLM 综合）：
 * Hash 精确去重 → Jaccard>0.85 相似去重 → 失败/无信息过滤 → LLM 统一综合。
 */

import { createHash } from "node:crypto";
import type { ChatLLM } from "../core/llm";
import type { AgentResult } from "./model";

export const NO_INFO_PATTERNS: readonly string[] = [
  "无法访问",
  "未找到",
  "failed to fetch",
  "no information available",
  "unable to retrieve",
];

export const SIMILARITY_THRESHOLD = 0.85;

export function exactDedup(results: AgentResult[]): AgentResult[] {
  const seen = new Set<string>();
  const out: AgentResult[] = [];
  for (const result of results) {
    const hash = createHash("sha256").update(result.response, "utf-8").digest("hex");
    if (seen.has(hash)) continue;
    seen.add(hash);
    out.push(result);
  }
  return out;
}

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[\s,，。;；、]+/).filter((token) => token.length > 0));
}

/** 词级 Jaccard 相似度。 */
export function jaccardSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function similarDedup(
  results: AgentResult[],
  threshold: number = SIMILARITY_THRESHOLD,
): AgentResult[] {
  const kept: AgentResult[] = [];
  for (const result of results) {
    const duplicate = kept.some((item) => jaccardSimilarity(item.response, result.response) > threshold);
    if (!duplicate) kept.push(result);
  }
  return kept;
}

export function filterInformative(results: AgentResult[]): AgentResult[] {
  return results.filter((result) => {
    if (!result.success) return false;
    const lowered = result.response.toLowerCase();
    return !NO_INFO_PATTERNS.some((pattern) => lowered.includes(pattern.toLowerCase()));
  });
}

export function preprocessResults(results: AgentResult[]): AgentResult[] {
  return filterInformative(similarDedup(exactDedup(results)));
}

export async function synthesizeResults(
  llm: ChatLLM,
  query: string,
  results: AgentResult[],
): Promise<string> {
  const informative = preprocessResults(results);
  if (informative.length === 0) return "（无可综合结果：全部子任务失败或无信息）";
  const sources = informative
    .map((result, index) => `=== 来源 ${index + 1}（${result.taskId}）===\n${result.response}`)
    .join("\n\n");
  const user = [
    `问题：${query}`,
    "",
    "以下是多个子任务的研究结果，请综合回答：",
    "1. 消除重复信息；2. 解决矛盾（如有）；3. 突出关键洞察；4. 用统一格式呈现。",
    "",
    sources,
  ].join("\n");
  return llm.invoke(
    [
      { role: "system", content: "你是多 Agent 编排系统的结果综合器。" },
      { role: "user", content: user },
    ],
    { temperature: 0 },
  );
}
