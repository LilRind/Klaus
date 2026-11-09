import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  AutoAllowPrompt,
  AutoDenyPrompt,
  PermissionChecker,
  containsDestructiveCommand,
  createStandardPermissionChecker,
  createStandardPermissionRules,
  type PermissionRule,
} from "../src/security/permission";
import { ToolRegistry } from "../src/tools/registry";
import {
  ReadFileTool,
  WriteFileTool,
  GlobTool,
} from "../src/tools/builtin/file-tools";
import { BashTool } from "../src/tools/builtin/bash-tool";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolInvocationResult } from "../src/core/llm";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = path.join("test_tmp", `perm_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(root, { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("PermissionChecker 三道闸门", () => {
  const denySecret: PermissionRule = {
    tools: ["echo"],
    test: (request) =>
      String(request.args.input ?? "").includes("secret") ? "包含敏感词" : null,
  };
  const askBig: PermissionRule = {
    tools: ["echo"],
    test: (request) =>
      String(request.args.input ?? "").length > 10 ? "输入过长" : null,
  };

  it("闸门 1 硬拒绝优先，且不触发审批器", async () => {
    const prompt = new AutoAllowPrompt();
    const checker = new PermissionChecker({
      denyRules: [denySecret],
      askRules: [askBig],
      prompt,
    });
    const outcome = await checker.check({
      toolName: "echo",
      args: { input: "secret-and-very-long" },
    });
    expect(outcome).toEqual({ allowed: false, reason: "包含敏感词" });
    expect(prompt.requests).toHaveLength(0);
  });

  it("闸门 2 命中 → 闸门 3 审批：allow / deny 两分支", async () => {
    const allow = new AutoAllowPrompt();
    const deny = new AutoDenyPrompt();
    const args = { input: "a-very-long-input" };
    const allowed = await new PermissionChecker({
      askRules: [askBig],
      prompt: allow,
    }).check({ toolName: "echo", args });
    expect(allowed.allowed).toBe(true);
    expect(allow.requests[0]?.reason).toBe("输入过长");

    const denied = await new PermissionChecker({
      askRules: [askBig],
      prompt: deny,
    }).check({ toolName: "echo", args });
    expect(denied).toEqual({
      allowed: false,
      reason: "输入过长（用户拒绝）",
    });
  });

  it("ask 命中但未配置审批器：安全默认拒绝", async () => {
    const outcome = await new PermissionChecker({ askRules: [askBig] }).check({
      toolName: "echo",
      args: { input: "a-very-long-input" },
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toContain("未配置审批器");
  });

  it("三道闸门都未命中：默认放行；工具名不匹配的规则不生效", async () => {
    const checker = new PermissionChecker({
      denyRules: [denySecret],
      askRules: [{ ...askBig, tools: ["other_tool"] }],
      prompt: new AutoDenyPrompt(),
    });
    expect(
      await checker.check({ toolName: "echo", args: { input: "short" } }),
    ).toEqual({ allowed: true });
  });
});

describe("标准规则集", () => {
  it("写入 .git 硬拒绝；工作区外写入询问；工作区内默认放行", async () => {
    const root = await makeWorkspace();
    const { denyRules, askRules } = createStandardPermissionRules({
      workspaceRoot: root,
    });
    const checker = new PermissionChecker({ denyRules, askRules });

    const gitWrite = await checker.check({
      toolName: "write_file",
      args: { path: ".git/config", content: "x" },
    });
    expect(gitWrite.allowed).toBe(false);
    expect(gitWrite.reason).toContain(".git");

    const outsideWrite = await checker.check({
      toolName: "write_file",
      args: { path: "../escape.txt", content: "x" },
    });
    expect(outsideWrite.allowed).toBe(false); // 未配 prompt → 默认拒
    expect(outsideWrite.reason).toContain("工作目录之外");

    const insideWrite = await checker.check({
      toolName: "write_file",
      args: { path: "ok.txt", content: "x" },
    });
    expect(insideWrite).toEqual({ allowed: true });
  });

  it("bash DENY_LIST 硬拒 + 破坏性词边界正则（对齐 s03）", async () => {
    const root = await makeWorkspace();
    const { denyRules, askRules } = createStandardPermissionRules({
      workspaceRoot: root,
    });
    const checker = new PermissionChecker({ denyRules, askRules });

    const denied = await checker.check({
      toolName: "bash",
      args: { command: "rm -rf /" },
    });
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toContain("硬拒绝列表");

    // del / rm 作为独立命令词命中；echo del、model 等子串不命中
    const ask = await checker.check({
      toolName: "bash",
      args: { command: "del test.txt" },
    });
    expect(ask.allowed).toBe(false); // 未配 prompt → 默认拒（证明命中了 ask 规则）
    expect(ask.reason).toContain("破坏性");

    expect(containsDestructiveCommand("rm test.txt")).toBe(true);
    expect(containsDestructiveCommand("del test.txt")).toBe(true);
    expect(containsDestructiveCommand("echo del test.txt")).toBe(false);
    expect(containsDestructiveCommand("echo model and delimiter")).toBe(false);
    expect(containsDestructiveCommand("chmod 777 x")).toBe(false); // 由关键字规则命中

    const keyword = await checker.check({
      toolName: "bash",
      args: { command: "echo x > /etc/passwd" },
    });
    expect(keyword.reason).toContain("破坏性");
  });
});

describe("ToolRegistry 权限闸门", () => {
  it("硬拒命中：工具不执行，返回 ⛔ observation", async () => {
    const root = await makeWorkspace();
    const registry = new ToolRegistry()
      .register(new WriteFileTool({ workspace: root }))
      .setPermissionChecker(
        createStandardPermissionChecker({ workspaceRoot: root }),
      );
    const result = await registry.executeToolArgs("write_file", {
      path: ".git/hooks/pre-commit",
      content: "evil",
    });
    expect(result).toContain("⛔ 权限已拒绝");
    expect(result).toContain(".git");
    await expect(
      fs.readFile(path.join(root, ".git/hooks/pre-commit"), "utf8"),
    ).rejects.toBeTruthy();
  });

  it("工作区外写入：ask → allow 放行执行（工具需放开围栏交给权限层裁决）", async () => {
    const root = await makeWorkspace();
    const outside = path.resolve(root, "..", "perm_outside.txt");
    const prompt = new AutoAllowPrompt();
    const registry = new ToolRegistry()
      .register(
        new WriteFileTool({ workspace: root, allowOutsideWorkspace: true }),
      )
      .setPermissionChecker(
        createStandardPermissionChecker({ workspaceRoot: root, prompt }),
      );
    const result = await registry.executeToolArgs("write_file", {
      path: outside,
      content: "outside",
    });
    expect(result).toContain("Wrote");
    expect(prompt.requests).toHaveLength(1);
    expect(prompt.requests[0]?.reason).toContain("工作目录之外");
    await fs.rm(path.resolve(root, "..", "perm_outside.txt"), { force: true });
  });

  it("ask → deny：返回拒绝 observation，工具不执行", async () => {
    const root = await makeWorkspace();
    const outside = path.resolve(root, "..", "perm_denied.txt");
    const registry = new ToolRegistry()
      .register(
        new WriteFileTool({ workspace: root, allowOutsideWorkspace: true }),
      )
      .setPermissionChecker(
        createStandardPermissionChecker({
          workspaceRoot: root,
          prompt: new AutoDenyPrompt(),
        }),
      );
    const result = await registry.executeToolArgs("write_file", {
      path: outside,
      content: "x",
    });
    expect(result).toContain("用户拒绝");
    await expect(fs.readFile(path.resolve(outside), "utf8")).rejects.toBeTruthy();
  });

  it("字符串入口（ReAct 路径）同样被闸门覆盖：权限看到 {input}", async () => {
    const denyEcho: PermissionRule = {
      tools: ["echo"],
      test: (request) =>
        String(request.args.input ?? "").includes("rm -rf") ? "危险命令" : null,
    };
    const registry = new ToolRegistry()
      .registerFunction({ name: "echo", description: "回声", func: (s) => s })
      .setPermissionChecker(new PermissionChecker({ denyRules: [denyEcho] }));
    expect(await registry.executeTool("echo", "safe")).toBe("safe");
    expect(await registry.executeTool("echo", "rm -rf /")).toContain(
      "⛔ 权限已拒绝",
    );
  });

  it("未安装 checker：直通执行（向后兼容）", async () => {
    const root = await makeWorkspace();
    const registry = new ToolRegistry().register(
      new WriteFileTool({ workspace: root }),
    );
    const result = await registry.executeToolArgs("write_file", {
      path: "free.txt",
      content: "x",
    });
    expect(result).toContain("Wrote");
  });
});

describe("FunctionCallAgent 拒绝回喂", () => {
  it("被拒调用以 ⛔ observation 回喂模型，循环继续", async () => {
    const root = await makeWorkspace();
    const registry = new ToolRegistry()
      .register(new WriteFileTool({ workspace: root }))
      .setPermissionChecker(
        createStandardPermissionChecker({ workspaceRoot: root }),
      );
    const llm = new ScriptedLLM(["改为直接回答"], [
      toolCall("c1", "write_file", '{"path":".git/evil.sh","content":"x"}'),
      { content: "改为直接回答", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, registry);
    const answer = await agent.run("写 .git/evil.sh");

    expect(answer).toBe("改为直接回答");
    const toolMessage = llm.toolCallsList[1]?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toContain("⛔ 权限已拒绝");
    await expect(
      fs.readFile(path.join(root, ".git/evil.sh"), "utf8"),
    ).rejects.toBeTruthy();
  });
});

function toolCall(id: string, name: string, args: string): ToolInvocationResult {
  return {
    content: null,
    toolCalls: [{ id, type: "function" as const, function: { name, arguments: args } }],
  };
}

describe("s03 四条验收 prompt 离线路径", () => {
  function assemble(root: string, prompt: AutoAllowPrompt | AutoDenyPrompt) {
    // 演示装配（对齐决策 5）：文件工具放开围栏，越区裁决权交给权限层
    const registry = new ToolRegistry()
      .register(new WriteFileTool({ workspace: root, allowOutsideWorkspace: true }))
      .register(new ReadFileTool({ workspace: root, allowOutsideWorkspace: true }))
      .register(new GlobTool({ workspace: root, allowOutsideWorkspace: true }))
      .register(new BashTool({ cwd: root }))
      .setPermissionChecker(
        createStandardPermissionChecker({ workspaceRoot: root, prompt }),
      );
    return registry;
  }

  it("prompt 1：工作区内创建文件 → 三闸门未命中，直接通过", async () => {
    const root = await makeWorkspace();
    const prompt = new AutoAllowPrompt();
    const llm = new ScriptedLLM(["created"], [
      toolCall("c1", "write_file", '{"path":"test.txt","content":"data"}'),
      { content: "created", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, assemble(root, prompt));
    await agent.run("Create a file called test.txt in the current directory");

    expect(await fs.readFile(path.join(root, "test.txt"), "utf8")).toBe("data");
    expect(prompt.requests).toHaveLength(0); // 全程无审批
  });

  it("prompt 2：删除文件（bash del）→ 闸门2 命中 → 人工审核，拒绝则 ⛔回喂", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "test.txt"), "data", "utf8");
    const prompt = new AutoDenyPrompt();
    const llm = new ScriptedLLM(["cannot delete"], [
      toolCall("c1", "bash", '{"command":"del test.txt"}'),
      { content: "cannot delete", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, assemble(root, prompt));
    await agent.run("Delete the file test.txt");

    expect(prompt.requests).toHaveLength(1);
    expect(prompt.requests[0]?.reason).toContain("破坏性");
    const toolMessage = llm.toolCallsList[1]?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toContain("⛔ 权限已拒绝");
    // 命令未执行，文件仍在
    expect(await fs.readFile(path.join(root, "test.txt"), "utf8")).toBe("data");
  });

  it("prompt 3：列目录（glob 只读）→ 默认放行", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "a.txt"), "x", "utf8");
    const prompt = new AutoAllowPrompt();
    const llm = new ScriptedLLM(["done"], [
      toolCall("c1", "glob", '{"pattern":"*"}'),
      { content: "done", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, assemble(root, prompt));
    await agent.run("What files are in the current directory?");

    const toolMessage = llm.toolCallsList[1]?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toContain("a.txt");
    expect(prompt.requests).toHaveLength(0);
  });

  it("prompt 4：写工作区外（/etc/something）→ 闸门2 越区 → 人工审核", async () => {
    const root = await makeWorkspace();
    const prompt = new AutoDenyPrompt();
    const llm = new ScriptedLLM(["refused"], [
      toolCall("c1", "write_file", '{"path":"/etc/something","content":"x"}'),
      { content: "refused", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("fc", llm, assemble(root, prompt));
    await agent.run("Try to write a file to /etc/something");

    expect(prompt.requests).toHaveLength(1);
    expect(prompt.requests[0]?.reason).toContain("工作目录之外");
    const toolMessage = llm.toolCallsList[1]?.messages.find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toContain("⛔ 权限已拒绝");
  });
});
