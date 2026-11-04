import { describe, expect, it, vi } from "vitest";
import { MemoryManager } from "../src/memory/manager";
import { MemoryTool } from "../src/tools/builtin/memory-tool";
import { classifyMemoryTypeByRules } from "../src/tools/builtin/memory-tool";
import { ScriptedLLM } from "./scripted-llm";
import {
  InMemoryDocumentStore,
  InMemoryGraphStore,
  InMemoryVectorStore,
} from "../src/index";
import { TFIDFEmbedding } from "../src/memory/embedding";
import type { Clock } from "../src/memory/base";

function buildManager(clock?: Clock, types?: string[]) {
  const manager = new MemoryManager({
    userId: "test_user",
    clock,
    enablePerceptual: types?.includes("perceptual") ?? true,
    embedder: new TFIDFEmbedding(),
    vectorStore: new InMemoryVectorStore(),
    graphStore: new InMemoryGraphStore(),
    documentStore: new InMemoryDocumentStore(),
  });
  return manager;
}

describe("MemoryManager（书 8.2.4）", () => {
  it("多类型写入与跨类型搜索", async () => {
    const manager = buildManager();
    await manager.addMemory({ content: "Python 工作笔记", memoryType: "working" });
    await manager.addMemory({ content: "张三学会了 Python 装饰器", memoryType: "episodic", importance: 0.8 });
    await manager.addMemory({ content: "Python 是解释型语言", memoryType: "semantic", importance: 0.9 });

    const stats = await manager.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byType.working).toBe(1);
    expect(stats.byType.episodic).toBe(1);
    expect(stats.byType.semantic).toBe(1);

    const results = await manager.searchMemories({ query: "Python", limit: 5 });
    expect(results.length).toBe(3);
    expect(new Set(results.map((result) => result.memoryType)).size).toBe(3);
  });

  it("未启用的类型写入报错", async () => {
    const manager = new MemoryManager({
      enableWorking: true,
      enableEpisodic: false,
      enableSemantic: false,
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      documentStore: new InMemoryDocumentStore(),
    });
    await expect(
      manager.addMemory({ content: "x", memoryType: "episodic" }),
    ).rejects.toThrow(/未启用/);
  });

  it("遗忘策略：重要性 / 时间 / 容量", async () => {
    const manager = buildManager();
    await manager.addMemory({ content: "不重要", memoryType: "working", importance: 0.1 });
    await manager.addMemory({ content: "重要", memoryType: "working", importance: 0.9 });

    expect(await manager.forgetMemories({ strategy: "importance_based", threshold: 0.5 })).toBe(1);
    expect((await manager.getStats()).total).toBe(1);

    let current = Date.UTC(2026, 0, 1);
    const clock: Clock = () => new Date(current);
    const timeManager = buildManager(clock);
    await timeManager.addMemory({
      content: "三十天前的记忆",
      // 用情景记忆：工作记忆自带 60 分钟 TTL，会先于遗忘策略清掉旧数据
      memoryType: "episodic",
      timestamp: new Date(Date.UTC(2025, 11, 1)).toISOString(),
    });
    current = Date.UTC(2026, 0, 31);
    expect(
      await timeManager.forgetMemories({ strategy: "time_based", maxAgeDays: 30 }),
    ).toBe(1);

    const capacityManager = buildManager(undefined);
    for (let i = 0; i < 6; i++) {
      await capacityManager.addMemory({
        content: `记忆 ${i}`,
        memoryType: "working",
        importance: i / 10,
      });
    }
    expect(
      await capacityManager.forgetMemories({ strategy: "capacity_based", maxCount: 3 }),
    ).toBe(3);
  });

  it("固化：达标记忆从 working 移动到 episodic，未达标留下", async () => {
    const manager = buildManager();
    await manager.addMemory({ content: "重要结论", memoryType: "working", importance: 0.9 });
    await manager.addMemory({ content: "随口一提", memoryType: "working", importance: 0.3 });

    const count = await manager.consolidateMemories({
      fromType: "working",
      toType: "episodic",
      importanceThreshold: 0.7,
    });
    expect(count).toBe(1);

    const stats = await manager.getStats();
    expect(stats.byType.working).toBe(1);
    expect(stats.byType.episodic).toBe(1);
    const summary = await manager.getSummary();
    expect(summary).toContain("重要结论");
    expect(summary).toContain("episodic");
  });

  it("update/remove/clearAll 生命周期", async () => {
    const manager = buildManager();
    const id = await manager.addMemory({ content: "旧内容", memoryType: "working" });
    expect(await manager.updateMemory(id, { content: "新内容", importance: 0.8 })).toBe(true);
    const results = await manager.searchMemories({ query: "新内容" });
    expect(results[0]?.item.content).toBe("新内容");
    expect(await manager.removeMemory(id)).toBe(true);
    expect(await manager.removeMemory(id)).toBe(false);
    await manager.clearAll();
    expect((await manager.getStats()).total).toBe(0);
  });
});

describe("MemoryTool（书 8.2.3，JSON 协议统一入口）", () => {
  function buildTool(memoryTypes?: string[]) {
    return new MemoryTool({
      userId: "tool_user",
      memoryTypes: memoryTypes as never,
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      documentStore: new InMemoryDocumentStore(),
    });
  }

  it("add 自动补会话与时间元数据；search/summary/stats 全链路", async () => {
    const tool = buildTool(["working", "episodic", "semantic"]);
    const addResult = await tool.execute(
      JSON.stringify({ action: "add", content: "张三在学 TypeScript", memory_type: "working", importance: 0.7 }),
    );
    expect(addResult).toContain("✅");
    expect(tool.session).toMatch(/^session_\d{8}_\d{6}$/);

    const searchResult = await tool.execute(
      JSON.stringify({ action: "search", query: "TypeScript" }),
    );
    expect(searchResult).toContain("张三在学 TypeScript");

    expect(await tool.execute(JSON.stringify({ action: "stats" }))).toContain("记忆统计");
    const summary = await tool.execute(JSON.stringify({ action: "summary" }));
    expect(summary).toContain("记忆摘要");
    expect(summary).toContain("working");
  });

  it("perceptual 添加自动推断模态；update/remove 闭环", async () => {
    const tool = buildTool(["working", "perceptual"]);
    await tool.execute(
      JSON.stringify({
        action: "add",
        content: "代码截图一张",
        memory_type: "perceptual",
        file_path: "uploads/code.png",
      }),
    );
    const perceptual = await tool.memoryManager.listMemories({ memoryTypes: ["perceptual"] });
    expect(perceptual[0]?.metadata.modality).toBe("image");
    expect(perceptual[0]?.metadata.raw_data).toBe("uploads/code.png");

    const id = perceptual[0]?.id as string;
    expect(
      await tool.execute(JSON.stringify({ action: "update", memory_id: id, importance: 0.9 })),
    ).toContain("✅");
    expect(
      await tool.execute(JSON.stringify({ action: "remove", memory_id: id })),
    ).toContain("✅");
  });

  it("forget/consolidate/clear_all 与错误输入", async () => {
    const tool = buildTool(["working", "episodic"]);
    await tool.execute(JSON.stringify({ action: "add", content: "低价值", importance: 0.05 }));
    expect(
      await tool.execute(
        JSON.stringify({ action: "forget", strategy: "importance_based", threshold: 0.2 }),
      ),
    ).toContain("遗忘 1 条");

    await tool.execute(JSON.stringify({ action: "add", content: "重要工作", importance: 0.9 }));
    expect(
      await tool.execute(
        JSON.stringify({ action: "consolidate", from_type: "working", to_type: "episodic" }),
      ),
    ).toContain("已整合 1 条");

    expect(await tool.execute("{bad json")).toContain("❌");
    expect(await tool.execute(JSON.stringify({ action: "unknown" }))).toContain("未知操作");
    expect(await tool.execute(JSON.stringify({ action: "clear_all" }))).toContain("清空");
  });

  it("auto_classify：LLM 判定记忆类型（书 8.2.3）", async () => {
    const llm = new ScriptedLLM(["semantic"]);
    const tool = new MemoryTool({
      userId: "classify_user",
      memoryTypes: ["working", "episodic", "semantic"],
      llm,
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      documentStore: new InMemoryDocumentStore(),
    });
    const result = await tool.execute(
      JSON.stringify({ action: "add", content: "Qdrant 是一种向量数据库", auto_classify: true }),
    );
    expect(result).toContain("类型: semantic");
    expect(llm.invokeCount).toBe(1);
  });

  it("auto_classify：LLM 输出无法解析时回落规则分类器", async () => {
    const llm = new ScriptedLLM(["这个我也说不清楚"]);
    const tool = new MemoryTool({
      userId: "classify_user",
      memoryTypes: ["working", "episodic", "semantic"],
      llm,
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      documentStore: new InMemoryDocumentStore(),
    });
    // "完成了"是事件线索 → 规则分类器判 episodic
    const result = await tool.execute(
      JSON.stringify({ action: "add", content: "张三完成了记忆模块的复刻", auto_classify: true }),
    );
    expect(result).toContain("类型: episodic");
  });

  it("auto_classify：未配置 LLM 降级规则分类器并提醒一次", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const tool = new MemoryTool({
      userId: "classify_user",
      memoryTypes: ["working", "episodic", "semantic", "perceptual"],
      embedder: new TFIDFEmbedding(),
      vectorStore: new InMemoryVectorStore(),
      graphStore: new InMemoryGraphStore(),
      documentStore: new InMemoryDocumentStore(),
    });
    const result = await tool.execute(
      JSON.stringify({ action: "add", content: "用户上传了一张代码截图", auto_classify: true }),
    );
    expect(result).toContain("类型: perceptual");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("规则分类器");
    warn.mockRestore();
  });

  it("规则分类器四分支", () => {
    expect(classifyMemoryTypeByRules("一张 photo.png 截图")).toBe("perceptual");
    expect(classifyMemoryTypeByRules("2026 年 3 月张三完成了项目")).toBe("episodic");
    expect(classifyMemoryTypeByRules("递归是指函数调用自身的机制")).toBe("semantic");
    expect(classifyMemoryTypeByRules("当前正在编辑第三段")).toBe("working");
  });
});
