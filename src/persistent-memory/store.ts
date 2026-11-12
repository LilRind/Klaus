/**
 * 持久记忆存储（对齐 learn-claude-code s09 的 .memory 文件系统）
 *
 * 与书第八章 src/memory（认知记忆：四类记忆 + 向量/图存储 + RAG）的边界：
 * 本模块是【会话之外的可复用知识】——文件 + 索引 + 按需召回，绝不复用
 * 向量/图存储；与 s08 的边界：s08 管理当前会话的上下文预算，本模块管理
 * 跨压缩、跨会话仍然成立的信息。
 *
 * 形态（对齐 s09）：一个记忆一个 Markdown 文件（frontmatter 记录
 * name/description/type），MEMORY.md 是索引（每行对应一个文件）。
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "../skills/skill-loader";

export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 候选里出现这些短语 → 临时信息，不该跨会话保留（对齐 s09 TEMPORARY_MEMORY_MARKERS） */
export const TEMPORARY_MEMORY_MARKERS = [
  "this session",
  "current session",
  "this turn",
  "current turn",
  "this task",
  "current task",
  "for now",
  "just this once",
  "today only",
  "temporary",
  "本次会话",
  "当前会话",
  "这一轮",
  "当前轮次",
  "本次任务",
  "当前任务",
  "这次任务",
  "暂时",
  "临时",
  "今回だけ",
  "このセッション",
  "現在のタスク",
] as const;

export const MEMORY_INDEX_NAME = "MEMORY.md";
export const RECALL_CHAR_LIMIT = 20_000;
export const CONSOLIDATE_THRESHOLD = 10;
export const CONSOLIDATE_INPUT_CHAR_LIMIT = 20_000;

/** 从文件读出的完整记录 */
export interface MemoryRecord {
  name: string;
  type: MemoryType;
  description: string;
  body: string;
  filename: string;
}

/** LLM 提取出的候选（字段未校验——终审在 shouldStoreMemory） */
export interface MemoryCandidate {
  name?: unknown;
  type?: unknown;
  description?: unknown;
  body?: unknown;
  scope?: unknown;
}

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/** name → 文件名 slug（小写、非字母数字折叠为 -，防目录穿越） */
export function memorySlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "memory";
}

/**
 * 记忆文件路径（安全闸）：文件名不得含路径分隔符；resolve 后必须落在
 * memoryDir 内（防 ../ 目录穿越，对齐 s09 memory_path）。
 */
export function memoryPath(memoryDir: string, filename: string): string {
  if (filename !== path.basename(filename)) {
    throw new Error(`记忆文件名不得包含路径分隔符: ${filename}`);
  }
  const dir = path.resolve(memoryDir);
  const target = path.resolve(dir, filename);
  const rel = path.relative(dir, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`记忆路径越出存储目录: ${filename}`);
  }
  return target;
}

/** 校验一条记忆记录（字段完整 + type 合法），不合法抛错 */
export function validateMemoryRecord(record: {
  name?: unknown;
  type?: unknown;
  description?: unknown;
  body?: unknown;
}): { name: string; type: MemoryType; description: string; body: string } {
  const name = typeof record.name === "string" ? record.name.trim() : "";
  const description =
    typeof record.description === "string" ? record.description.trim() : "";
  const body = typeof record.body === "string" ? record.body.trim() : "";
  if (!name) throw new Error("记忆缺少非空 name");
  if (!isMemoryType(record.type)) {
    throw new Error(
      `记忆 type 非法: ${JSON.stringify(record.type)}，合法值: ${MEMORY_TYPES.join(" | ")}`,
    );
  }
  if (!description) throw new Error(`记忆 '${name}' 缺少非空 description`);
  if (!body) throw new Error(`记忆 '${name}' 缺少非空 body`);
  return { name, type: record.type, description, body };
}

/** 序列化为 Markdown 文档（frontmatter + 正文） */
export function memoryDocument(
  name: string,
  type: MemoryType,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\ntype: ${type}\n---\n\n${body}\n`;
}

/** 写入一条记忆并重建索引，返回文件路径 */
export async function writeMemoryFile(
  memoryDir: string,
  record: { name: string; type: MemoryType; description: string; body: string },
): Promise<string> {
  const valid = validateMemoryRecord(record);
  const target = memoryPath(memoryDir, `${memorySlug(valid.name)}.md`);
  await fs.mkdir(path.resolve(memoryDir), { recursive: true });
  await fs.writeFile(
    target,
    memoryDocument(valid.name, valid.type, valid.description, valid.body),
    "utf8",
  );
  await rebuildMemoryIndex(memoryDir);
  return target;
}

/** 列出全部记忆（目录不存在 → 空数组；非法文件跳过不炸） */
export async function listMemoryFiles(memoryDir: string): Promise<MemoryRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(path.resolve(memoryDir));
  } catch {
    return [];
  }
  const records: MemoryRecord[] = [];
  for (const filename of entries.sort()) {
    if (!filename.endsWith(".md") || filename === MEMORY_INDEX_NAME) continue;
    const content = await readMemoryFile(memoryDir, filename);
    if (content === null) continue;
    const { metadata, body } = parseFrontmatter(content);
    if (!isMemoryType(metadata.type)) continue;
    records.push({
      name: collapseWhitespace(metadata.name) || filename.replace(/\.md$/, ""),
      type: metadata.type,
      description: collapseWhitespace(metadata.description) || "",
      body: body.trim(),
      filename,
    });
  }
  return records;
}

/** 读单个记忆文件（不存在 → null；越权文件名 → null，不抛错） */
export async function readMemoryFile(
  memoryDir: string,
  filename: string,
): Promise<string | null> {
  try {
    return await fs.readFile(memoryPath(memoryDir, filename), "utf8");
  } catch {
    return null;
  }
}

/** 折叠连续空白（对齐 LCC " ".join(value.split()) 的索引行口径） */
function collapseWhitespace(value: unknown): string {
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean).join(" ").trim() : "";
}

/** 由文件重建 MEMORY.md 索引（写入后以文件为唯一事实源；行格式对齐 LCC） */
export async function rebuildMemoryIndex(memoryDir: string): Promise<string> {
  const records = await listMemoryFiles(memoryDir);
  const lines = records.map(
    (record) => {
      const description =
        record.description ||
        collapseWhitespace(record.body.split(/\r?\n/).find((line) => line.trim()) ?? "");
      return `- [${record.name}](${record.filename}) - ${description}`;
    },
  );
  const index = memoryPath(memoryDir, MEMORY_INDEX_NAME);
  await fs.mkdir(path.resolve(memoryDir), { recursive: true });
  await fs.writeFile(
    index,
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    "utf8",
  );
  return index;
}

/** 读索引内容（不存在 → null） */
export async function readMemoryIndex(memoryDir: string): Promise<string | null> {
  try {
    return await fs.readFile(memoryPath(memoryDir, MEMORY_INDEX_NAME), "utf8");
  } catch {
    return null;
  }
}

/** 文本是否带临时含义（小写化后匹配标记短语） */
export function containsTemporaryMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return TEMPORARY_MEMORY_MARKERS.some((marker) => lower.includes(marker));
}

/** 空白归一化比较文本（对齐 LCC _normalized_memory_text） */
function normalizedMemoryText(value: string): string {
  return value.toLowerCase().split(/\s+/).join(" ").trim();
}

/**
 * 入库终审（对齐 s09 should_store_memory）：
 * - 字段不完整 / type 非法 → 拒绝；
 * - name/description/body 拼接文本带临时含义（"本次会话别建文件"之类）→ 拒绝；
 * - 与已有记忆重名（slug 相同）或 description/body 归一化后相同
 *   → 视为重复拒绝（对齐 LCC should_store_memory：slug / description / body
 *   三层精确去重；改写重复交给 consolidate 在阈值后合并，不做模糊匹配）。
 */
export function shouldStoreMemory(
  candidate: MemoryCandidate,
  existing: readonly MemoryRecord[],
): boolean {
  let record: { name: string; type: MemoryType; description: string; body: string };
  try {
    record = validateMemoryRecord(candidate);
  } catch {
    return false;
  }
  if (
    containsTemporaryMarker(`${record.name}\n${record.description}\n${record.body}`)
  ) {
    return false;
  }
  const slug = memorySlug(record.name);
  const description = normalizedMemoryText(record.description);
  const body = normalizedMemoryText(record.body);
  return !existing.some((memory) => {
    if (memorySlug(memory.name) === slug) return true;
    if (normalizedMemoryText(memory.description) === description) return true;
    return normalizedMemoryText(memory.body) === body;
  });
}
