/**
 * 记忆提取（对齐 learn-claude-code s09 extract_memories）
 *
 * 回合结束后检查当前对话，只提取以后仍可能有用的信息。模型返回的只是
 * 候选：必须带 scope，且只有 persistent 表示应当跨会话保留（current_task
 * 是本次任务的命令/临时路径/临时限制）；再经 shouldStoreMemory 终审
 * （字段完整 / 无临时含义 / 与现有记忆去重）才写盘。
 */

import type { ChatLLM } from "../core/llm";
import type { Message } from "../core/message";
import {
  listMemoryFiles,
  shouldStoreMemory,
  writeMemoryFile,
  type MemoryCandidate,
} from "./store";
import { extractJsonArray } from "./recall";

/** 参与提取的最近消息条数（对齐 s09 dialogue_text 的 max_messages=12） */
const EXTRACT_MAX_MESSAGES = 12;

/** 提取并入库，返回实际写入条数；LLM 失败/输出非法 → 0（不炸回合） */
export async function extractMemories(
  llm: ChatLLM,
  history: readonly Message[],
  memoryDir: string,
): Promise<number> {
  if (history.length === 0) return 0;
  const dialogue = history
    .slice(-EXTRACT_MAX_MESSAGES)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n\n");
  let candidates: unknown[] | null;
  try {
    const output = await llm.invoke([
      {
        role: "system",
        content:
          "Extract durable facts worth remembering across future sessions from the " +
          "conversation (user preferences, lasting feedback, stable project facts, " +
          "useful references). Return ONLY a JSON array; each item is " +
          '{"name": string, "type": "user"|"feedback"|"project"|"reference", ' +
          '"description": string, "body": string, "scope": "persistent"|"current_task"}. ' +
          'Use scope "current_task" for one-off commands, temporary paths and ' +
          "session-only constraints. Return [] when nothing is worth persisting.",
      },
      { role: "user", content: dialogue },
    ]);
    candidates = extractJsonArray(output);
  } catch {
    return 0;
  }
  if (candidates === null) return 0;

  const existing = await listMemoryFiles(memoryDir);
  let written = 0;
  for (const raw of candidates) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as MemoryCandidate;
    // 只有明确声明跨会话的候选才进入终审（对齐 s09 的 scope 闸）
    if (candidate.scope !== "persistent") continue;
    if (!shouldStoreMemory(candidate, existing)) continue;
    try {
      const record = {
        name: String(candidate.name),
        type: candidate.type as never,
        description: String(candidate.description),
        body: String(candidate.body),
      };
      await writeMemoryFile(memoryDir, record);
      existing.push({
        ...record,
        filename: `${record.name}.md`,
      });
      written += 1;
    } catch {
      // 单条写入失败不阻断其余候选
    }
  }
  return written;
}
