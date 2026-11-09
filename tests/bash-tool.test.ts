import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { BashTool } from "../src/tools/builtin/bash-tool";
import { ToolRegistry } from "../src/tools/registry";
import {
  AutoAllowPrompt,
  createStandardPermissionChecker,
} from "../src/security/permission";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = path.join("test_tmp", `bash_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("BashTool 执行语义（对齐 s03 run_bash）", () => {
  it("执行命令并合并 stdout/stderr；空输出占位", async () => {
    const root = await makeWorkspace();
    const tool = new BashTool({ cwd: root });
    expect(await tool.executeArgs({ command: "echo hello" })).toBe("hello");
    // cmd.exe 的 cd 无输出
    expect(await tool.executeArgs({ command: "cd" })).toBeTruthy();
  });

  it("工作目录生效：命令在 workspace 下执行", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "marker.txt"), "x", "utf8");
    const tool = new BashTool({ cwd: root });
    expect(await tool.executeArgs({ command: "type marker.txt" })).toBe("x");
  });

  it("输出截断到 maxOutputChars", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(60000), "utf8");
    const tool = new BashTool({ cwd: root, maxOutputChars: 50000 });
    const output = await tool.executeArgs({ command: "type big.txt" });
    expect(output.length).toBe(50000);
  });

  it("超时返回 Error: Timeout", async () => {
    // 超时用例不建临时目录：被 kill 的进程短暂锁住 cwd，清理会 EBUSY
    const tool = new BashTool({ cwd: process.cwd(), timeoutMs: 200 });
    const output = await tool.executeArgs({ command: "ping -n 10 127.0.0.1" });
    expect(output).toContain("Timeout");
  }, 10_000);

  it("字符串入口：裸命令与 JSON 都可；换行命令拒绝", async () => {
    const root = await makeWorkspace();
    const tool = new BashTool({ cwd: root });
    expect(await tool.execute("echo hi")).toBe("hi");
    expect(await tool.execute('{"command": "echo json"}')).toBe("json");
    expect(await tool.executeArgs({ command: "echo a\necho b" })).toContain("❌");
  });
});

describe("BashTool + 标准权限闸门", () => {
  it("只读命令默认放行；del 触发人工审批，放行后执行", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "victim.txt"), "x", "utf8");
    const prompt = new AutoAllowPrompt();
    const registry = new ToolRegistry()
      .register(new BashTool({ cwd: root }))
      .setPermissionChecker(
        createStandardPermissionChecker({ workspaceRoot: root, prompt }),
      );

    expect(await registry.executeToolArgs("bash", { command: "type victim.txt" }))
      .toBe("x");
    expect(prompt.requests).toHaveLength(0);

    expect(await registry.executeToolArgs("bash", { command: "del victim.txt" }))
      .toBe("(no output)");
    expect(prompt.requests).toHaveLength(1);
    expect(prompt.requests[0]?.reason).toContain("破坏性");
    // del 已执行，文件删除
    await expect(fs.access(path.join(root, "victim.txt"))).rejects.toBeTruthy();
  });

  it("DENY_LIST 命中硬拒绝，不执行也不询问", async () => {
    const root = await makeWorkspace();
    const prompt = new AutoAllowPrompt();
    const registry = new ToolRegistry()
      .register(new BashTool({ cwd: root }))
      .setPermissionChecker(
        createStandardPermissionChecker({ workspaceRoot: root, prompt }),
      );
    const result = await registry.executeToolArgs("bash", {
      command: "sudo echo hi",
    });
    expect(result).toContain("⛔ 权限已拒绝");
    expect(result).toContain("sudo");
    expect(prompt.requests).toHaveLength(0);
  });
});
