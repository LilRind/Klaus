import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatLog, type ChatLogEntry } from "../examples/8/chat-log";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function entry(overrides: Partial<ChatLogEntry> = {}): ChatLogEntry {
  return {
    ts: new Date().toISOString(),
    user: "log_test",
    session: "session_20261105_100000",
    command: "/ask",
    arg: "MySQL 索引",
    output: "回答全文……",
    durationMs: 1200,
    ok: true,
    ...overrides,
  };
}

describe("ChatLog 聊天逐字日志（jsonl append-only）", () => {
  it("append 逐字落盘，可读回并解析", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatlog-"));
    tempDirs.push(dir);
    const log = new ChatLog(dir);

    await log.append(entry({ arg: "第一个问题", output: "回答A" }));
    await log.append(entry({ command: "/stats", arg: "", output: "统计", durationMs: 80 }));

    const lines = (await readFile(join(dir, "log_test-" + new Date().toISOString().slice(0, 10) + ".jsonl"), "utf-8"))
      .split("\n")
      .filter((line) => line.trim());
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]!) as ChatLogEntry;
    expect(first.arg).toBe("第一个问题");
    expect(first.output).toBe("回答A");
    expect(first.session).toMatch(/^session_\d{8}_\d{6}$/);
  });

  it("开关关闭后不再写入", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatlog-"));
    tempDirs.push(dir);
    const log = new ChatLog(dir);
    log.setEnabled(false);
    await log.append(entry());
    expect(await log.readDay("log_test")).toHaveLength(0);
    log.setEnabled(true);
    expect(log.isEnabled).toBe(true);
  });

  it("summarize 汇总命令分布、提问耗时与时间线", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatlog-"));
    tempDirs.push(dir);
    const log = new ChatLog(dir);
    await log.append(entry({ command: "/ask", arg: "Q1", durationMs: 1000 }));
    await log.append(entry({ command: "/ask", arg: "Q2", durationMs: 3000 }));
    await log.append(entry({ command: "/stats", arg: "", durationMs: 100, ok: true }));

    const summary = await log.summarize("log_test");
    expect(summary.totalCommands).toBe(3);
    expect(summary.askCount).toBe(2);
    expect(summary.avgAskMs).toBe(2000);
    expect(summary.commandCounts["/ask"]).toBe(2);
    expect(summary.timeline).toHaveLength(3);
  });

  it("md 转录默认关闭；开启后写入 👤/🤖 可读块且文件头只写一次", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chatlog-md-"));
    tempDirs.push(dir);
    const log = new ChatLog(dir);

    // 默认关：不产生 md
    await log.appendMarkdown(entry({ arg: "不该出现" }));
    expect(await log.readDay("log_test")).toHaveLength(0); // jsonl 也未 append（appendMarkdown 不写 jsonl）
    expect(log.isMarkdownEnabled).toBe(false);

    // 开启后：用户与助手发言成对出现，含会话头
    log.setMarkdownEnabled(true);
    await log.appendMarkdown(entry({ arg: "MySQL 索引何时失效", output: "回答全文" }));
    await log.appendMarkdown(entry({ command: "/stats", arg: "", output: "统计OK" }));

    const md = await readFile(join(dir, "log_test-" + new Date().toISOString().slice(0, 10) + ".md"), "utf-8");
    expect(md).toContain("# 聊天逐字转录（用户: log_test");
    expect(md.match(/# 聊天逐字转录/g)).toHaveLength(1); // 头只写一次
    expect(md).toContain("👤 用户");
    expect(md).toContain("MySQL 索引何时失效");
    expect(md).toContain("🤖 助手");
    expect(md).toContain("回答全文");
    expect(md).toContain("（/stats）");
  });
});
