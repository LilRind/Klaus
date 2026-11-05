/**
 * 示例 03：NoteTool 基本操作（对应书 9.4 code 03，无需 LLM）
 *
 * CRUD → 搜索 → 标签 → 摘要，全部走统一 JSON 入口。
 */

import { promises as fs } from "node:fs";
import { NoteTool } from "../../src";

async function main() {
  const workspace = "./notes_demo";
  await fs.rm(workspace, { recursive: true, force: true });
  const note = new NoteTool({ workspace });
  const run = async (payload: Record<string, unknown>) => {
    console.log(`\n▶ ${String(payload.action)}`);
    console.log(await note.execute(JSON.stringify(payload)));
  };

  await run({ action: "create", title: "探索代码库结构", content: "## 发现\n- examples/9/assets/codebase 下有 4 个模块\n- data_processor.py 含多个 TODO", type: "insight", tags: ["explore", "codebase"], priority: 0.7 });
  await run({ action: "create", title: "api_client 错误处理缺失", content: "API 调用没有超时与重试，失败直接抛异常", type: "blocker", status: "in_progress", tags: ["quality"], priority: 0.9 });
  await run({ action: "create", title: "重构计划", content: "## 任务清单\n- [ ] 补齐错误处理\n- [ ] 消除 utils.py 重复代码", type: "decision", tags: ["plan"], priority: 0.8 });

  const listResult = await note.execute(JSON.stringify({ action: "list" }));
  console.log(`\n▶ list\n${listResult}`);

  const firstId = (await note.searchRecords("api_client"))[0]?.id ?? "";
  await run({ action: "read", note_id: firstId });
  await run({ action: "search", query: "错误处理 blocker" });
  await run({ action: "update", note_id: firstId, status: "completed" });
  await run({ action: "summary" });
  await run({ action: "delete", note_id: firstId });
  await run({ action: "summary" });
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
