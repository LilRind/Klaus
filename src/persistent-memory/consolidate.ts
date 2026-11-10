/**
 * 记忆整理（对齐 learn-claude-code s09 consolidate_memories）
 *
 * 记忆文件积累到阈值（10 条）后：先快照全部文件 → LLM 生成去重/更新后的
 * 记录列表 → 校验通过后整体替换 → 重建索引。删除或写入失败 → 恢复快照
 * 并重建索引后重新抛出（宁可放弃整理，不丢既有记忆）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatLLM } from "../core/llm";
import {
  MEMORY_INDEX_NAME,
  CONSOLIDATE_THRESHOLD,
  CONSOLIDATE_INPUT_CHAR_LIMIT,
  listMemoryFiles,
  memoryPath,
  rebuildMemoryIndex,
  validateMemoryRecord,
  writeMemoryFile,
} from "./store";
import { extractJsonArray } from "./recall";

export interface ConsolidateOptions {
  memoryDir: string;
  /** 触发阈值，默认 10（对齐 s09） */
  threshold?: number;
  /** 整理输入的字符上限，默认 20 000 */
  inputCharLimit?: number;
}

/** 整理并返回新记录数；不足阈值 → 0；失败 → 恢复快照后向上抛 */
export async function consolidateMemories(
  llm: ChatLLM,
  options: ConsolidateOptions,
): Promise<number> {
  const dir = path.resolve(options.memoryDir);
  const threshold = options.threshold ?? CONSOLIDATE_THRESHOLD;
  const inputLimit = options.inputCharLimit ?? CONSOLIDATE_INPUT_CHAR_LIMIT;

  const before = await listMemoryFiles(dir);
  if (before.length < threshold) return 0;

  const catalog = before
    .map(
      (record) =>
        `## ${record.name} (${record.type})\n${record.description}\n\n${record.body}`,
    )
    .join("\n\n")
    .slice(0, inputLimit);

  const output = await llm.invoke([
    {
      role: "system",
      content:
        "Consolidate the memory records below: merge duplicates, drop stale or " +
        "contradicted facts, keep durable preferences, feedback, project facts and " +
        "references. Return ONLY a JSON array of consolidated records; each item is " +
        '{"name": string, "type": "user"|"feedback"|"project"|"reference", ' +
        '"description": string, "body": string}. Do not invent new facts.',
    },
    { role: "user", content: catalog },
  ]);
  const parsed = extractJsonArray(output);
  if (parsed === null) {
    throw new Error("记忆整理输出不是合法 JSON 数组");
  }
  const consolidated = parsed.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new Error("记忆整理输出包含非对象条目");
    }
    return validateMemoryRecord(raw as Record<string, unknown>);
  });

  // 快照 → 替换 → 失败恢复（对齐 s09 的快照回滚）
  const snapshot = new Map<string, string>();
  for (const record of before) {
    snapshot.set(record.filename, await fs.readFile(memoryPath(dir, record.filename), "utf8"));
  }

  try {
    for (const filename of snapshot.keys()) {
      await fs.rm(memoryPath(dir, filename), { force: true });
    }
    for (const record of consolidated) {
      await writeMemoryFile(dir, record);
    }
    await rebuildMemoryIndex(dir);
    return consolidated.length;
  } catch (error) {
    for (const filename of await fs.readdir(dir).catch(() => [])) {
      if (filename.endsWith(".md") && filename !== MEMORY_INDEX_NAME) {
        await fs.rm(memoryPath(dir, filename), { force: true }).catch(() => {});
      }
    }
    for (const [filename, content] of snapshot) {
      await fs.writeFile(memoryPath(dir, filename), content, "utf8").catch(() => {});
    }
    await rebuildMemoryIndex(dir).catch(() => {});
    throw error;
  }
}
