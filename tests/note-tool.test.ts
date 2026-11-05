import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NoteTool, deserializeNote } from "../src/tools/builtin/note-tool";

const workspaces: string[] = [];

function makeTool(): NoteTool {
  const dir = path.join("test_tmp", `notes_${Math.random().toString(36).slice(2)}`);
  workspaces.push(dir);
  return new NoteTool({ workspace: dir });
}

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function create(
  note: NoteTool,
  title: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const raw = await note.execute(
    JSON.stringify({ action: "create", title, content: `正文：${title}`, ...extra }),
  );
  const id = raw.match(/ID: (note_[A-Za-z0-9_]+)/)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

describe("NoteTool CRUD", () => {
  it("create → read 往返（frontmatter + 正文）", async () => {
    const note = makeTool();
    const id = await create(note, "探索代码库", {
      type: "insight",
      tags: ["explore", "codebase"],
      priority: 0.8,
    });
    const raw = await note.execute(JSON.stringify({ action: "read", note_id: id }));
    expect(raw).toContain("标题: 探索代码库");
    expect(raw).toContain("类型: insight");
    expect(raw).toContain("标签: explore, codebase");
    expect(raw).toContain("正文：探索代码库");
  });

  it("update 修改状态与标签", async () => {
    const note = makeTool();
    const id = await create(note, "修复阻塞点", { type: "blocker", status: "in_progress" });
    const raw = await note.execute(
      JSON.stringify({ action: "update", note_id: id, status: "completed", tags: ["done"] }),
    );
    expect(raw).toContain("completed");
    const read = await note.execute(JSON.stringify({ action: "read", note_id: id }));
    expect(read).toContain("completed");
    expect(read).toContain("done");
  });

  it("list 按 type/status 过滤", async () => {
    const note = makeTool();
    await create(note, "任务一", { type: "task" });
    await create(note, "任务二", { type: "task" });
    await create(note, "洞察", { type: "insight" });
    const tasks = await note.execute(JSON.stringify({ action: "list", type: "task" }));
    expect(tasks).toContain("共 2 条笔记");
    expect(tasks).not.toContain("洞察");
  });

  it("search 命中标题权重最高", async () => {
    const note = makeTool();
    await create(note, "API 错误处理分析");
    await create(note, "其他笔记");
    const raw = await note.execute(JSON.stringify({ action: "search", query: "API 错误" }));
    expect(raw).toContain("API 错误处理分析");
    expect(raw.indexOf("API 错误处理分析")).toBeLessThan(
      raw.indexOf("其他笔记") === -1 ? Infinity : raw.indexOf("其他笔记"),
    );
  });

  it("summary 统计状态与未解决 blocker", async () => {
    const note = makeTool();
    await create(note, "阻塞一", { type: "blocker", status: "in_progress" });
    await create(note, "完成任务", { type: "task", status: "completed" });
    const raw = await note.execute(JSON.stringify({ action: "summary" }));
    expect(raw).toContain("未解决的阻塞点 1 个");
    expect(raw).toContain("completed=1");
  });

  it("delete 后再读报不存在", async () => {
    const note = makeTool();
    const id = await create(note, "待删除");
    expect(await note.execute(JSON.stringify({ action: "delete", note_id: id }))).toContain("已删除");
    expect(await note.execute(JSON.stringify({ action: "read", note_id: id }))).toContain("不存在");
  });
});

describe("NoteTool 边界与集成", () => {
  it("非法 JSON / 未知 action / 缺参数都有明确错误", async () => {
    const note = makeTool();
    expect(await note.execute("not json")).toContain("❌");
    expect(await note.execute(JSON.stringify({ action: "hack" }))).toContain("未知操作");
    expect(await note.execute(JSON.stringify({ action: "create" }))).toContain("❌");
  });

  it("frontmatter 解析容忍多行正文与特殊字符", () => {
    const raw = [
      "---",
      "id: note_x",
      "title: 含,逗号 与空格",
      "type: blocker",
      "status: blocked",
      "tags: [a, b]",
      "priority: 0.9",
      "created: 2026-11-05T00:00:00Z",
      "updated: 2026-11-05T01:00:00Z",
      "---",
      "",
      "# 含,逗号 与空格",
      "",
      "正文第一行",
      "- 列表项 **加粗**",
      "带 `code` 与 $pecial 字符",
    ].join("\n");
    const record = deserializeNote(raw, "fallback");
    expect(record.id).toBe("note_x");
    expect(record.title).toBe("含,逗号 与空格");
    expect(record.type).toBe("blocker");
    expect(record.tags).toEqual(["a", "b"]);
    expect(record.content).toContain("- 列表项 **加粗**");
  });

  it("searchRecords + toPackets 供 ContextBuilder 集成", async () => {
    const note = makeTool();
    await create(note, "重构计划", { type: "decision", priority: 0.9 });
    const records = await note.searchRecords("重构");
    expect(records).toHaveLength(1);
    // 中文整句查询（无空格）也要能命中（CJK 单字展开）
    const sentence = await note.searchRecords("我们下一步的重构计划是什么");
    expect(sentence).toHaveLength(1);
    expect(records).toHaveLength(1);
    const packets = note.toPackets(records);
    expect(packets[0]?.type).toBe("note");
    expect(packets[0]?.source).toContain("note_");
    expect(packets[0]?.content).toContain("decision");
  });
});
