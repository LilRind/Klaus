/**
 * 第9章真实 LLM 验证（零 mock，硬断言）
 *
 * 与 vitest 离线套件的分工：
 * - 离线套件（ScriptedLLM 桩）锁定协议/边界/组装逻辑，跑测试不要 Key
 * - 本脚本验证"LLM 真的会用上下文和工具"——这类断言只有真实模型才有意义：
 *   A. ContextBuilder 注入的记忆真的影响回答（提到 TypeScript 偏好）
 *   B. 笔记 → ContextPacket 注入后回答真的引用笔记内容（第一阶段）
 *   C. Agentic 工具循环：LLM 真的会调 note 工具落盘（笔记数 +1）
 *
 * 运行：pnpm verify:9-real（需 .env 配置 LLM，消耗少量额度）
 */

import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ContextBuilder,
  MemoryConfig,
  MemoryManager,
  NoteTool,
  OpenAICompatLLM,
  SimpleAgent,
} from "../../src";
import { CodebaseMaintainer } from "./codebase-maintainer";

const failures: string[] = [];

function check(name: string, ok: boolean, detail: string): void {
  const mark = ok ? "✅" : "❌";
  console.log(`${mark} ${name}${ok ? "" : ` —— ${detail}`}`);
  if (!ok) failures.push(name);
}

async function testContextInjection(): Promise<void> {
  const memory = new MemoryManager({
    userId: "verify9_ctx",
    enableWorking: true,
    enableEpisodic: false,
    enableSemantic: false,
    enablePerceptual: false,
    config: new MemoryConfig({
      embedModelType: "tfidf",
      databasePath: "./memory_data/verify9_ctx.db",
    }),
  });
  await memory.clearAll();
  await memory.addMemory({
    content: "用户偏好用 TypeScript 写项目，示例必须能离线运行",
    importance: 0.9,
  });
  const builder = new ContextBuilder({ memorySource: memory });
  const agent = new SimpleAgent(
    "VerifyCtxAgent",
    new OpenAICompatLLM(),
    "只依据参考上下文回答，不知道就说不知道，回答不超过两句话。",
  );
  const built = await builder.build({ query: "我用什么语言写项目？有什么偏好？" });
  check(
    "[前置] 相关记忆进入上下文",
    built.context.includes("TypeScript"),
    `上下文缺失记忆: ${built.context.slice(0, 120)}`,
  );
  const answer = await agent.run(
    `[参考上下文]\n${built.context}\n\n[问题] 我用什么语言写项目？有什么偏好？`,
  );
  check(
    "A. 真实 LLM 基于注入记忆作答（提及 TypeScript）",
    /typescript/i.test(answer),
    `回答未体现记忆: ${answer.slice(0, 120)}`,
  );
  await memory.close();
}

async function testNoteIntegration(): Promise<void> {
  const workspace = "./verify9_notes";
  await fs.rm(workspace, { recursive: true, force: true });
  const note = new NoteTool({ workspace });
  await note.execute(
    JSON.stringify({
      action: "create",
      title: "第一阶段进展",
      content: "完成了 GSSC 四阶段实现，测试覆盖打分与压缩；第二阶段尚未开始。",
      type: "task",
      status: "completed",
      tags: ["phase1"],
    }),
  );
  const records = await note.searchRecords("项目现在进展如何");
  check("[前置] 笔记被检索到", records.length > 0, "中文检索未命中");
  const builder = new ContextBuilder();
  const built = await builder.build({
    query: "项目进展",
    extraPackets: note.toPackets(records),
  });
  const agent = new SimpleAgent(
    "VerifyNoteAgent",
    new OpenAICompatLLM(),
    "只依据项目笔记上下文回答，回答不超过两句话。",
  );
  const answer = await agent.run(
    `[项目笔记上下文]\n${built.context}\n\n[问题] 项目现在进展如何？`,
  );
  check(
    "B. 真实 LLM 引用笔记内容（提及第一阶段/完成）",
    /第一阶段/.test(answer) && /完成|已完成/.test(answer),
    `回答未引用笔记: ${answer.slice(0, 120)}`,
  );
  await fs.rm(workspace, { recursive: true, force: true });
}

async function testAgenticToolLoop(): Promise<void> {
  const workspace = "./verify9_project_notes";
  await fs.rm(workspace, { recursive: true, force: true });
  const maintainer = new CodebaseMaintainer({
    project: "verify9_project",
    codebasePath: path.resolve(import.meta.dirname, "assets", "codebase"),
  });
  const before = (await maintainer.noteTool.getStats()).total;
  await maintainer.run(
    '请用 note 工具创建一条笔记：标题"发现：utils.py 的 validate_email 缺少边界测试"，类型 insight，内容自拟一句话。',
  );
  const after = (await maintainer.noteTool.getStats()).total;
  check(
    "C. Agentic 循环：真实 LLM 自主调用 note 工具落盘（笔记 +1）",
    after === before + 1,
    `笔记数 ${before} → ${after}（应恰好 +1）`,
  );
  await maintainer.close();
  await fs.rm(workspace, { recursive: true, force: true });
}

async function main(): Promise<void> {
  console.log("=== 第9章真实 LLM 验证（零 mock）===\n");
  await testContextInjection();
  await testNoteIntegration();
  await testAgenticToolLoop();
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} 项失败: ${failures.join(", ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ 全部通过");
}

main().catch((error) => {
  console.error("验证脚本运行失败:", error);
  process.exitCode = 1;
});
