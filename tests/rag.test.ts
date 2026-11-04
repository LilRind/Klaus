import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approxTokenLen,
  chunkText,
  loadDocument,
  splitParagraphsWithHeadings,
} from "../src/memory/rag/document";
import { RAGPipeline } from "../src/memory/rag/pipeline";
import { RAGTool } from "../src/tools/builtin/rag-tool";
import { InMemoryVectorStore } from "../src/memory/storage/vector-store";
import { InMemoryDocumentStore } from "../src/memory/storage/document-store";
import { InMemoryGraphStore } from "../src/memory/storage/graph-store";
import { MemoryManager } from "../src/memory/manager";
import { TFIDFEmbedding } from "../src/memory/embedding";
import { ScriptedLLM } from "./scripted-llm";

describe("文档处理层（书 8.3.4）", () => {
  it("token 估算：CJK 每字 1，拉丁约 4 字符 1", () => {
    expect(approxTokenLen("你好世界")).toBe(4);
    expect(approxTokenLen("abcdefgh")).toBe(2);
    expect(approxTokenLen("")).toBe(0);
  });

  it("标题层级分段：heading_path 随层级进出", () => {
    const markdown = [
      "# 第一章",
      "第一段内容。",
      "## 第一节",
      "小节内容。",
      "# 第二章",
      "第二章内容。",
    ].join("\n");
    const paragraphs = splitParagraphsWithHeadings(markdown);
    expect(paragraphs.map((p) => p.headingPath)).toEqual([
      "第一章",
      "第一章 > 第一节",
      "第二章",
    ]);
  });

  it("小预算分块产生多块且带重叠", () => {
    const text = Array.from({ length: 12 }, (_, i) => `第${i}段，这里是内容。`).join("\n\n");
    const chunks = chunkText(text, { chunkTokens: 24, overlapTokens: 8 });
    expect(chunks.length).toBeGreaterThan(1);
    // 相邻块之间应有内容重叠（尾部段落回填）
    const overlap = chunks.slice(1).some((chunk, index) =>
      chunks[index]?.content.split("\n\n").some((part) => chunk.content.includes(part)),
    );
    expect(overlap).toBe(true);
  });

  it("loadDocument 支持 md/html/json，未知格式提示外部转换", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rag-doc-"));
    await writeFile(join(dir, "note.md"), "# 标题\n内容", "utf-8");
    await writeFile(join(dir, "page.html"), "<h1>标题</h1><p>正文</p>", "utf-8");
    await writeFile(join(dir, "data.json"), JSON.stringify({ name: "张三", tags: ["a"] }), "utf-8");
    await writeFile(join(dir, "paper.pdf"), "%PDF-fake", "utf-8");

    expect(await loadDocument(join(dir, "note.md"))).toContain("内容");
    const html = await loadDocument(join(dir, "page.html"));
    expect(html).toContain("标题");
    expect(html).toContain("正文");
    expect(html).not.toContain("<");
    const json = await loadDocument(join(dir, "data.json"));
    expect(json).toContain("张三");
    expect(json).toContain("tags");

    await expect(loadDocument(join(dir, "photo.webp"))).rejects.toThrow(/暂不支持/);
  });

  it("PDF 摄取：真实 pdf-parse 解析手工构造的最小 PDF", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rag-pdf-"));
    const filePath = join(dir, "sample.pdf");
    await writeFile(filePath, buildMinimalPdf("HelloAgents PDF test"));
    const text = await loadDocument(filePath);
    expect(text).toContain("HelloAgents PDF test");
  });

  it("PDF/DOCX 解析器可注入替换（路由测试）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rag-route-"));
    const pdfPath = join(dir, "fake.pdf");
    const docxPath = join(dir, "fake.docx");
    await writeFile(pdfPath, "binary-ish");
    await writeFile(docxPath, "binary-ish");

    let pdfCalled = false;
    let docxCalled = false;
    const text = await Promise.all([
      loadDocument(pdfPath, { pdfParser: async () => { pdfCalled = true; return "PDF 文本"; } }),
      loadDocument(docxPath, { docxParser: async () => { docxCalled = true; return "DOCX 文本"; } }),
    ]);
    expect(pdfCalled).toBe(true);
    expect(docxCalled).toBe(true);
    expect(text).toEqual(["PDF 文本", "DOCX 文本"]);
  });
});

/** 手工构造带正确 xref 偏移的最小 PDF（单页 Helvetica 文本），供真实 pdf-parse 解析 */
function buildMinimalPdf(text: string): Buffer {
  const escaped = text.replace(/([()\\])/g, "\\$1");
  const content = `BT /F1 24 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("RAGPipeline（书 8.3.4/8.3.5）", () => {
  function buildPipeline(namespace = "test", llm?: ScriptedLLM) {
    return new RAGPipeline({
      vectorStore: new InMemoryVectorStore(),
      embedder: new TFIDFEmbedding(),
      llm,
      ragNamespace: namespace,
    });
  }

  const knowledge = [
    "# Python 基础",
    "Python 是一种解释型、面向对象的编程语言，由 Guido van Rossum 创建。",
    "",
    "# 记忆系统",
    "工作记忆容量有限，默认 50 条，TTL 默认 60 分钟。",
  ].join("\n");

  it("摄取 → 统计 → 检索 → 命名空间隔离", async () => {
    const pipeline = buildPipeline("ns1");
    const other = buildPipeline("ns2");
    const result = await pipeline.ingest({ text: knowledge, source: "入门手册" });
    expect(result.chunkCount).toBeGreaterThan(0);

    expect((await pipeline.stats()).chunks).toBe(result.chunkCount);
    expect((await other.stats()).chunks).toBe(0);

    const hits = await pipeline.search("Python 是什么语言", { topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain("Python");
    expect(hits[0]?.source).toBe("入门手册");
    expect(hits[0]?.metadata.rag_namespace).toBe("ns1");
  });

  it("ask：命中资料时引用来源，无命中时明确直答", async () => {
    const llm = new ScriptedLLM([
      "根据资料，Python 是解释型语言。[1]",
      "知识库未找到相关内容，基于模型知识回答。",
    ]);
    const pipeline = buildPipeline("qa", llm);
    await pipeline.ingest({ text: knowledge });

    const answered = await pipeline.ask("Python 是什么语言");
    expect(answered.answer).toContain("[1]");
    expect(answered.sources.length).toBeGreaterThan(0);
    expect(llm.lastMessages()[0]?.content).toContain("参考资料");

    const empty = await pipeline.ask("量子力学的最新进展", { scoreThreshold: 0.3 });
    expect(empty.sources).toEqual([]);
    expect(empty.answer).toContain("知识库");
  });

  it("MQE + HyDE 扩展检索：多查询去重合并", async () => {
    // 队列顺序：MQE 生成 → HyDE 生成 → 最终问答
    const llm = new ScriptedLLM([
      "Python 语言简介\nPython 是什么",
      "Python 是一门解释型编程语言，常用于脚本与数据科学。",
      "综合答案",
    ]);
    const pipeline = buildPipeline("expand", llm);
    await pipeline.ingest({ text: knowledge });

    const hits = await pipeline.search("Python", {
      topK: 3,
      enableMqe: true,
      mqeExpansions: 2,
      enableHyde: true,
    });
    expect(hits.length).toBeGreaterThan(0);
    // MQE 一次 + HyDE 一次 = 前两次 LLM 调用
    expect(llm.invokeCount).toBe(2);
  });

  it("clear 清空命名空间", async () => {
    const pipeline = buildPipeline("clean");
    await pipeline.ingest({ text: knowledge });
    expect((await pipeline.stats()).chunks).toBeGreaterThan(0);
    await pipeline.clear();
    expect((await pipeline.stats()).chunks).toBe(0);
  });
});

describe("RAGTool（统一入口）", () => {
  it("add_document/search/ask/stats/clear 全链路 + 错误输入", async () => {
    const llm = new ScriptedLLM(["工作记忆默认容量是 50 条。[1]"]);
    const tool = new RAGTool({
      ragNamespace: "tool_test",
      llm,
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
    });

    expect(
      await tool.execute(
        JSON.stringify({
          action: "add_document",
          text: "工作记忆容量有限，默认 50 条。情景记忆存 SQLite 和 Qdrant。",
          title: "记忆系统笔记",
        }),
      ),
    ).toContain("✅");

    expect(await tool.execute(JSON.stringify({ action: "search", query: "工作记忆 容量" }))).toContain("50 条");
    expect(await tool.execute(JSON.stringify({ action: "ask", query: "工作记忆默认容量多少" }))).toContain("[1]");
    expect(await tool.execute(JSON.stringify({ action: "stats" }))).toContain("分块数");
    expect(await tool.execute("{oops")).toContain("❌");
    expect(await tool.execute(JSON.stringify({ action: "unknown" }))).toContain("未知操作");
    expect(await tool.execute(JSON.stringify({ action: "clear" }))).toContain("🗑️");
  });

  it("RAG→记忆联动（书 8.1.3）：save_to_memory 存语义记忆且按 chunk 去重", async () => {
    const memoryManager = new MemoryManager({
      userId: "rag_link_user",
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      documentStore: new InMemoryDocumentStore(),
    });
    const tool = new RAGTool({
      ragNamespace: "link_test",
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      memoryManager,
    });
    await tool.execute(
      JSON.stringify({
        action: "add_document",
        text: "工作记忆容量默认 50 条，TTL 60 分钟。",
        title: "联动测试",
      }),
    );

    // 第一次检索并保存 → 存入语义记忆
    const first = await tool.execute(
      JSON.stringify({ action: "search", query: "工作记忆 容量", save_to_memory: true }),
    );
    expect(first).toContain("已将 1 条检索结果存入记忆");
    const saved = await memoryManager.listMemories({ memoryTypes: ["semantic"] });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.metadata.knowledge_type).toBe("rag_retrieval");
    expect(saved[0]?.metadata.rag_source).toBe("联动测试");
    expect(saved[0]?.importance).toBeGreaterThanOrEqual(0.5);

    // 第二次保存同一命中 → chunk_id 去重，不重复写入
    const second = await tool.execute(
      JSON.stringify({ action: "search", query: "工作记忆 容量", save_to_memory: true }),
    );
    expect(second).not.toContain("存入记忆");
    expect(await memoryManager.listMemories({ memoryTypes: ["semantic"] })).toHaveLength(1);

    // 不带 save_to_memory → 不写记忆
    await tool.execute(JSON.stringify({ action: "search", query: "TTL" }));
    expect(await memoryManager.listMemories({ memoryTypes: ["semantic"] })).toHaveLength(1);
  });
});
