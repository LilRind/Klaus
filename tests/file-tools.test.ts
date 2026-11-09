import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EditFileTool,
  GlobTool,
  ReadFileTool,
  WriteFileTool,
  globPatternToRegExp,
} from "../src/tools/builtin/file-tools";
import { ToolRegistry } from "../src/tools/registry";
import { FunctionTool } from "../src/tools/tool";
import { ToolExecutionError } from "../src/core/exceptions";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolInvocationResult } from "../src/core/llm";

const roots: string[] = [];

async function makeWorkspace(): Promise<{
  root: string;
  write: (rel: string, content: string) => Promise<void>;
}> {
  const root = path.join("test_tmp", `files_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(root, { recursive: true });
  return {
    root,
    write: async (rel, content) => {
      const target = path.join(root, rel);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, "utf8");
    },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("ReadFileTool", () => {
  it("读取全文 / limit 截断并提示剩余行数", async () => {
    const { root, write } = await makeWorkspace();
    await write("a.txt", "l1\nl2\nl3\nl4\n");
    const tool = new ReadFileTool({ workspace: root });

    expect(await tool.executeArgs({ path: "a.txt" })).toBe("l1\nl2\nl3\nl4");
    expect(await tool.executeArgs({ path: "a.txt", limit: 2 })).toBe(
      "l1\nl2\n... (2 more lines)",
    );
    // 字符串入口：裸路径与 JSON 对象都可以
    expect(await tool.execute("a.txt")).toBe("l1\nl2\nl3\nl4");
    expect(await tool.execute('{"path": "a.txt", "limit": 1}')).toBe(
      "l1\n... (3 more lines)",
    );
  });

  it("文件不存在 / 越出工作区 / 非法 JSON 输入返回 ❌", async () => {
    const { root } = await makeWorkspace();
    const tool = new ReadFileTool({ workspace: root });
    expect(await tool.executeArgs({ path: "missing.txt" })).toContain("❌");
    expect(await tool.executeArgs({ path: "../outside.txt" })).toContain(
      "路径越出工作区",
    );
    expect(await tool.execute('{"path": "a.txt"')).toContain("❌");
  });

  it("allowOutsideWorkspace 放开后可读工作区外的绝对路径", async () => {
    const { root } = await makeWorkspace();
    const outside = path.resolve("package.json");
    const fenced = new ReadFileTool({ workspace: root });
    const open = new ReadFileTool({ workspace: root, allowOutsideWorkspace: true });
    expect(await fenced.executeArgs({ path: outside })).toContain("❌");
    expect(await open.executeArgs({ path: outside })).toContain("hello-agents");
  });
});

describe("WriteFileTool", () => {
  it("写入并自动创建父目录，返回字节数", async () => {
    const { root } = await makeWorkspace();
    const tool = new WriteFileTool({ workspace: root });
    const result = await tool.executeArgs({
      path: "notes/deep/a.md",
      content: "hello",
    });
    expect(result).toBe("Wrote 5 bytes to notes/deep/a.md");
    expect(await fs.readFile(path.join(root, "notes/deep/a.md"), "utf8")).toBe(
      "hello",
    );
  });

  it("缺 content / 裸字符串输入 / 空 content 的边界", async () => {
    const { root } = await makeWorkspace();
    const tool = new WriteFileTool({ workspace: root });
    expect(await tool.executeArgs({ path: "a.txt" })).toContain("content");
    expect(await tool.execute("a.txt")).toContain("需要 JSON 参数");
    expect(await tool.execute('{"path": "a.txt"')).toContain("❌");
    // 空 content 是合法的（写空文件）
    expect(await tool.executeArgs({ path: "empty.txt", content: "" })).toContain(
      "Wrote 0 bytes",
    );
  });
});

describe("EditFileTool", () => {
  it("只替换第一处精确匹配", async () => {
    const { root, write } = await makeWorkspace();
    await write("a.txt", "foo\nbar\nfoo");
    const tool = new EditFileTool({ workspace: root });
    expect(await tool.executeArgs({
      path: "a.txt",
      old_text: "foo",
      new_text: "baz",
    })).toBe("Edited a.txt");
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe(
      "baz\nbar\nfoo",
    );
  });

  it("未命中 / old=new / 参数缺失时不改文件", async () => {
    const { root, write } = await makeWorkspace();
    await write("a.txt", "content");
    const tool = new EditFileTool({ workspace: root });
    expect(
      await tool.executeArgs({ path: "a.txt", old_text: "nope", new_text: "x" }),
    ).toContain("未找到要替换的文本");
    expect(
      await tool.executeArgs({ path: "a.txt", old_text: "c", new_text: "c" }),
    ).toContain("相同");
    expect(await tool.executeArgs({ path: "a.txt", old_text: "", new_text: "x" })).toContain(
      "old_text",
    );
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("content");
  });
});

describe("GlobTool", () => {
  it("** 跨目录递归、单层 * 只匹配当前层", async () => {
    const { root, write } = await makeWorkspace();
    await write("top.ts", "1");
    await write("src/a.ts", "1");
    await write("src/deep/b.ts", "1");
    await write("docs/readme.md", "1");
    const tool = new GlobTool({ workspace: root });

    const recursive = await tool.executeArgs({ pattern: "**/*.ts" });
    expect(recursive.split("\n")).toEqual(["src/a.ts", "src/deep/b.ts", "top.ts"]);
    expect(await tool.executeArgs({ pattern: "*.ts" })).toBe("top.ts");
    expect(await tool.executeArgs({ pattern: "**/*.missing" })).toBe("(no matches)");
    // 字符串入口：裸模式
    expect(await tool.execute("*.ts")).toBe("top.ts");
  });

  it("超过 200 条时封顶并提示收窄", async () => {
    const { root } = await makeWorkspace();
    for (let i = 0; i < 205; i++) {
      await fs.writeFile(path.join(root, `f${String(i).padStart(3, "0")}.log`), "x");
    }
    const tool = new GlobTool({ workspace: root });
    const result = await tool.executeArgs({ pattern: "*.log" });
    const lines = result.split("\n");
    expect(lines).toHaveLength(201);
    expect(lines[200]).toBe("... (5 more matches omitted; narrow the pattern)");
  });

  it("越出工作区的模式被围栏拦截", async () => {
    const { root } = await makeWorkspace();
    const tool = new GlobTool({ workspace: root });
    expect(await tool.executeArgs({ pattern: "../**/*.ts" })).toContain("❌");
  });

  it("globPatternToRegExp 的 ** 与转义语义", () => {
    expect(globPatternToRegExp("**/*.ts").test("a.ts")).toBe(true);
    expect(globPatternToRegExp("**/*.ts").test("src/deep/a.ts")).toBe(true);
    expect(globPatternToRegExp("src/**").test("src/a/b")).toBe(true);
    expect(globPatternToRegExp("src/**").test("other/a")).toBe(false);
    expect(globPatternToRegExp("a.b.txt").test("axb.txt")).toBe(false);
    expect(globPatternToRegExp("a.b.txt").test("a.b.txt")).toBe(true);
  });
});

describe("ToolRegistry 双入口分发", () => {
  it("executeToolArgs 结构化直达 + executeTool JSON 字符串自动归一化", async () => {
    const { root } = await makeWorkspace();
    const registry = new ToolRegistry().register(
      new WriteFileTool({ workspace: root }),
    );
    await registry.executeToolArgs("write_file", {
      path: "a.txt",
      content: "direct",
    });
    // ReAct 文本协议下模型传 JSON 字符串 → 字符串入口归一化到 executeArgs
    await registry.executeTool(
      "write_file",
      '{"path": "b.txt", "content": "normalized"}',
    );
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("direct");
    expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("normalized");
  });

  it("executeToolArgs 打到不支持结构化的工具时抛 ToolExecutionError", async () => {
    const registry = new ToolRegistry().registerFunction({
      name: "echo",
      description: "回声",
      func: (input) => input,
    });
    await expect(registry.executeToolArgs("echo", { a: 1 })).rejects.toThrow(
      ToolExecutionError,
    );
  });

  it("FunctionTool 提供 argsFunc 后支持结构化入口", async () => {
    const registry = new ToolRegistry().registerFunction({
      name: "kv",
      description: "读键值",
      parametersSchema: {
        type: "object",
        properties: { key: { type: "string" } },
        required: ["key"],
      },
      func: (input) => `str:${input}`,
      argsFunc: (args) => `args:${String(args.key)}`,
    });
    expect(await registry.executeToolArgs("kv", { key: "name" })).toBe("args:name");
    expect(await registry.executeTool("kv", "raw")).toBe("str:raw");
  });
});

describe("FunctionCallAgent 结构化闭环（write → read → 最终回答）", () => {
  it("模型工具参数 JSON 直达 executeArgs，文件真实落盘", async () => {
    const { root } = await makeWorkspace();
    const registry = new ToolRegistry()
      .register(new WriteFileTool({ workspace: root }))
      .register(new ReadFileTool({ workspace: root }));
    const llm = new ScriptedLLM(["done"], [
      toolCall("c1", "write_file", '{"path":"notes/a.md","content":"hello"}'),
      toolCall("c2", "read_file", '{"path":"notes/a.md"}'),
      { content: "done", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, registry);
    const answer = await agent.run("写并读回 notes/a.md");

    expect(answer).toBe("done");
    expect(await fs.readFile(path.join(root, "notes/a.md"), "utf8")).toBe("hello");
    const messages = llm.toolCallsList[2]?.messages ?? [];
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages[0]?.content).toContain("Wrote 5 bytes to notes/a.md");
    expect(toolMessages[1]?.content).toBe("hello");
  });
});

function toolCall(id: string, name: string, args: string): ToolInvocationResult {
  return {
    content: null,
    toolCalls: [{ id, type: "function" as const, function: { name, arguments: args } }],
  };
}
