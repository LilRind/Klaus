/**
 * RAG 文档处理层（对应书 8.3.4 memory/rag/document.py）
 *
 * 流程与书一致：任意格式 → 统一文本 → Markdown 结构感知分块 → 向量化。
 * 差异点：书用微软 MarkItDown 转 PDF/Office/图片/音频，那是 Python 生态；
 * TS 侧原生支持 md/txt/json/csv/html（html 剥标签），PDF/DOCX 明确报错
 * 并提示先用外部工具转 Markdown——管道结构完全一致，格式面收窄。
 */

import { readFile } from "node:fs/promises";

export interface DocumentParagraph {
  content: string;
  headingPath: string | null;
  start: number;
  end: number;
}

export interface DocumentChunk {
  content: string;
  start: number;
  end: number;
  headingPath: string | null;
}

export interface ChunkOptions {
  /** 每块目标 token 数（默认 512，对应书 chunk_tokens） */
  chunkTokens?: number;
  /** 相邻块重叠 token 数（默认 64，保持上下文连续性） */
  overlapTokens?: number;
}

const SUPPORTED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".csv",
  ".html",
  ".htm",
  ".xml",
  ".ts",
  ".js",
  ".py",
]);

/** 读取文件并统一为文本（MarkItDown 的轻量等价物） */
export async function loadDocument(filePath: string): Promise<string> {
  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error(
      `暂不支持 ${extension} 格式（TS 版支持 ${[...SUPPORTED_EXTENSIONS].join("/")}）。` +
        `PDF/DOCX 请先转换为 Markdown 再摄取——对应书里 MarkItDown 的转换步骤。`,
    );
  }
  const raw = await readFile(filePath, "utf-8");
  if (extension === ".html" || extension === ".htm" || extension === ".xml") {
    return stripHtmlTags(raw);
  }
  if (extension === ".json") {
    return jsonToText(raw);
  }
  return raw;
}

/** 近似 token 估算（对应书 _approx_token_len）：CJK 每字 1 token，拉丁约 4 字符 1 token */
export function approxTokenLen(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch)) cjk += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** Markdown 结构感知分段：按标题层级切分，段落携带 heading_path（书 _split_paragraphs_with_headings） */
export function splitParagraphsWithHeadings(text: string): DocumentParagraph[] {
  const lines = text.split(/\r?\n/);
  const headingStack: string[] = [];
  const paragraphs: DocumentParagraph[] = [];
  let buffer: string[] = [];
  let charPos = 0;

  const flushBuffer = (endPos: number) => {
    if (buffer.length === 0) return;
    const content = buffer.join("\n").trim();
    if (content.length === 0) {
      buffer = [];
      return;
    }
    paragraphs.push({
      content,
      headingPath: headingStack.length ? headingStack.join(" > ") : null,
      start: Math.max(0, endPos - content.length),
      end: endPos,
    });
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushBuffer(charPos);
      const level = headingMatch[1]?.length ?? 1;
      const title = (headingMatch[2] ?? "").trim();
      // 维持层级栈：进入 level 层时弹出同级及更深的旧标题
      headingStack.splice(Math.max(0, level - 1));
      headingStack.push(title);
      charPos += line.length + 1;
      continue;
    }

    if (line.trim().length === 0) {
      flushBuffer(charPos);
    } else {
      buffer.push(line);
    }
    charPos += line.length + 1;
  }
  flushBuffer(charPos);

  if (paragraphs.length === 0) {
    return [
      { content: text.trim(), headingPath: null, start: 0, end: text.length },
    ];
  }
  return paragraphs;
}

/** Token 预算分块 + 尾部重叠（书 _chunk_paragraphs 的直译） */
export function chunkParagraphs(
  paragraphs: DocumentParagraph[],
  chunkTokens = 512,
  overlapTokens = 64,
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  let current: DocumentParagraph[] = [];
  let currentTokens = 0;
  let index = 0;

  while (index < paragraphs.length) {
    const paragraph = paragraphs[index];
    if (!paragraph) break;
    const paragraphTokens = approxTokenLen(paragraph.content) || 1;

    if (currentTokens + paragraphTokens <= chunkTokens || current.length === 0) {
      current.push(paragraph);
      currentTokens += paragraphTokens;
      index += 1;
      continue;
    }

    chunks.push(emitChunk(current));

    // 从尾部回取重叠段落（信息连续性）
    if (overlapTokens > 0) {
      const kept: DocumentParagraph[] = [];
      let keptTokens = 0;
      for (let i = current.length - 1; i >= 0; i--) {
        const tail = current[i];
        if (!tail) break;
        const tokens = approxTokenLen(tail.content) || 1;
        if (keptTokens + tokens > overlapTokens) break;
        kept.unshift(tail);
        keptTokens += tokens;
      }
      current = kept;
      currentTokens = keptTokens;
    } else {
      current = [];
      currentTokens = 0;
    }
  }

  if (current.length > 0) {
    chunks.push(emitChunk(current));
  }
  return chunks;
}

/** 一步到位：文本 → 分块（对应书 chunk_text 便利入口） */
export function chunkText(
  text: string,
  options: ChunkOptions = {},
): DocumentChunk[] {
  return chunkParagraphs(
    splitParagraphsWithHeadings(text),
    options.chunkTokens ?? 512,
    options.overlapTokens ?? 64,
  );
}

function emitChunk(paragraphs: DocumentParagraph[]): DocumentChunk {
  const headingPath =
    [...paragraphs].reverse().find((p) => p.headingPath)?.headingPath ?? null;
  const first = paragraphs[0];
  const last = paragraphs[paragraphs.length - 1];
  if (!first || !last) throw new Error("emitChunk 收到空段落列表");
  return {
    content: paragraphs.map((p) => p.content).join("\n\n"),
    start: first.start,
    end: last.end,
    headingPath,
  };
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function jsonToText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    return renderJsonValue(parsed, 0);
  } catch {
    return raw;
  }
}

function renderJsonValue(value: unknown, depth: number): string {
  if (depth > 6) return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => renderJsonValue(item, depth + 1)).join("\n");
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${renderJsonValue(item, depth + 1)}`)
      .join("\n");
  }
  return String(value);
}
