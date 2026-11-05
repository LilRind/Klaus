import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TerminalTool, tokenizeCommand } from "../src/tools/builtin/terminal-tool";

const roots: string[] = [];

async function makeWorkspace(): Promise<{
  tool: TerminalTool;
  root: string;
  write: (rel: string, content: string) => Promise<void>;
}> {
  const root = path.join("test_tmp", `term_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const tool = new TerminalTool({ workspace: root });
  return {
    tool,
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

describe("tokenizeCommand", () => {
  it("空白分隔 + 引号包裹", () => {
    expect(tokenizeCommand('grep -rn "def process" src')).toEqual([
      "grep",
      "-rn",
      "def process",
      "src",
    ]);
  });
});

describe("TerminalTool 安全机制", () => {
  it("白名单外命令直接拒绝", async () => {
    const { tool } = await makeWorkspace();
    const raw = await tool.execute("rm -rf /");
    expect(raw).toContain("不允许的命令");
    expect(raw).toContain("rm");
  });

  it("路径逃逸（..）被拦截", async () => {
    const { tool } = await makeWorkspace();
    expect(await tool.execute("cat ../package.json")).toContain("❌");
    expect(await tool.execute("cat ../../etc/passwd")).toContain("❌");
  });

  it("绝对路径越界被拦截", async () => {
    const { tool } = await makeWorkspace();
    const outside = path.resolve("package.json");
    expect(await tool.execute(`cat ${outside}`)).toContain("❌");
  });
});

describe("TerminalTool 命令", () => {
  it("pwd / ls / cd / tree", async () => {
    const { tool, write } = await makeWorkspace();
    await write("src/a.ts", "export const a = 1;\n");
    await write("src/deep/b.ts", "export const b = 2;\n");
    expect(await tool.execute("pwd")).toBe(".");
    expect(await tool.execute("ls")).toContain("src/");
    expect(await tool.execute("cd src")).toContain("src");
    expect(await tool.execute("pwd")).toBe("src");
    const tree = await tool.execute("tree -L 2");
    expect(tree).toContain("deep/");
    expect(tree).toContain("a.ts");
  });

  it("cat / head / tail", async () => {
    const { tool, write } = await makeWorkspace();
    await write("data.txt", "one\ntwo\nthree\nfour\nfive\n");
    expect(await tool.execute("cat data.txt")).toContain("three");
    expect(await tool.execute("head -n 2 data.txt")).toBe("one\ntwo");
    expect(await tool.execute("tail -n 1 data.txt")).toBe("five");
  });

  it("grep 支持递归与行号", async () => {
    const { tool, write } = await makeWorkspace();
    await write("src/one.ts", "export function process_data() {}\n");
    await write("src/two.ts", "// TODO: fix\n");
    const raw = await tool.execute("grep -rn TODO src");
    expect(raw).toContain("TODO");
    expect(raw).toMatch(/two\.ts:\d+:.*TODO/);
    expect(await tool.execute("grep process src")).toContain("需要 -r");
  });

  it("grep --include 按文件名过滤，未知参数明确报错（对应书 9.5 示例）", async () => {
    const { tool, write } = await makeWorkspace();
    await write("src/one.py", "TODO: py\n");
    await write("src/two.ts", "TODO: ts\n");
    const raw = await tool.execute("grep -rn TODO src --include=*.py");
    expect(raw).toContain("one.py");
    expect(raw).not.toContain("two.ts");
    expect(await tool.execute("grep -A 3 TODO src")).toContain("不支持参数");
  });

  it("find 按名称与类型过滤", async () => {
    const { tool, write } = await makeWorkspace();
    await write("a.py", "x = 1\n");
    await write("b.txt", "y\n");
    await write("src/c.py", "z = 2\n");
    const raw = await tool.execute("find . -name *.py -type f");
    expect(raw).toContain("a.py");
    expect(raw).toContain("c.py");
    expect(raw).not.toContain("b.txt");
  });

  it("wc / stat / du", async () => {
    const { tool, write } = await makeWorkspace();
    await write("doc.md", "hello world\nsecond line\n");
    expect(await tool.execute("wc -l doc.md")).toBe("2");
    expect(await tool.execute("wc -w doc.md")).toBe("4");
    expect(await tool.execute("stat doc.md")).toContain("文件");
    expect(await tool.execute("du .")).toMatch(/\.\d+K/);
  });

  it("sort / uniq / cut / awk 文本处理", async () => {
    const { tool, write } = await makeWorkspace();
    await write("rows.txt", "apple\t3\nbanana\t1\napple\t3\ncherry\t2\n");
    const sorted = await tool.execute("sort rows.txt");
    expect(sorted.split("\n")[0]).toContain("apple");
    await write("csv.txt", "a,b,c\n1,2,3\n");
    expect(await tool.execute("cut -d , -f 2 csv.txt")).toBe("b\n2");
    expect(await tool.execute("awk '{print $2}' rows.txt")).toBe("3\n1\n3\n2");
  });

  it("输出截断（maxOutputBytes）生效", async () => {
    const { tool, write, root } = await makeWorkspace();
    await write("big.txt", "x".repeat(300));
    const small = new TerminalTool({ workspace: root, maxOutputBytes: 100 });
    const raw = await small.execute("cat big.txt");
    expect(raw).toContain("输出被截断");
    expect(tool).toBeDefined();
  });
});
