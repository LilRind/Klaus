/**
 * s01–s03 全部"试一下"环节的离线验收（对齐三章 README）
 *
 * ScriptedLLM 扮演模型（按 README 预期的工具调用决策），
 * AutoAllow/AutoDenyPrompt 扮演人工审批，bash 真实执行——
 * 断言覆盖"观察重点"本身：s01 的循环启停、s02 的单/多工具形态。
 */

import { afterEach, describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import {
  ReadFileTool,
  WriteFileTool,
  GlobTool,
} from "../src/tools/builtin/file-tools";
import { BashTool } from "../src/tools/builtin/bash-tool";
import {
  AutoAllowPrompt,
  AutoDenyPrompt,
  createStandardPermissionChecker,
  type ApprovalPrompt,
} from "../src/security/permission";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

const roots: string[] = [];

async function makeWorkspace(): Promise<string> {
  const root = path.join("test_tmp", `align_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "README.md"),
    "# Demo Project\nA minimal agent harness for learning.\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(root, "requirements.txt"),
    "anthropic\ndotenv\n",
    "utf8",
  );
  await fs.writeFile(path.join(root, "a.py"), "print('a')\n", "utf8");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "b.py"), "print('b')\n", "utf8");
  return root;
}

/** 演示装配：文件工具放开围栏（决策 5），越区裁决权交给权限层 */
function assemble(root: string, prompt: ApprovalPrompt) {
  return new ToolRegistry()
    .register(new ReadFileTool({ workspace: root, allowOutsideWorkspace: true }))
    .register(new WriteFileTool({ workspace: root, allowOutsideWorkspace: true }))
    .register(new GlobTool({ workspace: root, allowOutsideWorkspace: true }))
    .register(new BashTool({ cwd: root }))
    .setPermissionChecker(
      createStandardPermissionChecker({ workspaceRoot: root, prompt }),
    );
}

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

function turn(...toolCalls: ToolCallRequest[]): ToolInvocationResult {
  return { content: null, toolCalls };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("s01 Agent Loop 试一下（观察点：调工具→循环继续；不调→结束）", () => {
  it("不调工具的回答：1 次 LLM 调用即结束", async () => {
    const root = await makeWorkspace();
    const llm = new ScriptedLLM([], [finalTurn("Paris")]);
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    const answer = await agent.run("What is the capital of France?");
    expect(answer).toBe("Paris");
    expect(llm.toolCallsList).toHaveLength(1);
    expect(agent.getHistory().map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("prompt 1：创建 hello.py → 工具轮后循环继续，文件真实落盘", async () => {
    const root = await makeWorkspace();
    const llm = new ScriptedLLM(
      [],
      [
        turn(call("c1", "write_file", {
          path: "hello.py",
          content: 'print("Hello, World!")',
        })),
        finalTurn("Created hello.py"),
      ],
    );
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    await agent.run('Create a file called hello.py that prints "Hello, World!"');

    expect(
      await fs.readFile(path.join(root, "hello.py"), "utf8"),
    ).toBe('print("Hello, World!")');
    // 观察点：调了工具 → 第二次 LLM 调用发生，且能看到第一轮的 tool 结果
    expect(llm.toolCallsList).toHaveLength(2);
    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("Wrote");
  });

  it("prompt 2：List all Python files → glob 递归，观察点同上", async () => {
    const root = await makeWorkspace();
    const llm = new ScriptedLLM(
      [],
      [
        turn(call("c1", "glob", { pattern: "**/*.py" })),
        finalTurn("Found a.py and src/b.py"),
      ],
    );
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    await agent.run("List all Python files in this directory");

    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("a.py");
    expect(toolMessage?.content).toContain(path.join("src", "b.py").replace(/\\/g, "/"));
  });

  it("prompt 3：What is the current git branch → bash 真实执行 git branch", async () => {
    const root = await makeWorkspace();
    execSync("git init -b main", { cwd: root, stdio: "ignore" });
    execSync(
      "git -c user.name=t -c user.email=t@t commit --allow-empty -m init",
      { cwd: root, stdio: "ignore" },
    );
    const llm = new ScriptedLLM(
      [],
      [
        turn(call("c1", "bash", { command: "git branch" })),
        finalTurn("Current branch is main"),
      ],
    );
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    await agent.run("What is the current git branch?");

    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("main");
  });
});

describe("s02 Tool Use 试一下（观察点：单工具 vs 单轮多工具、顺序与结果）", () => {
  it("prompt 1：read_file 单工具，内容回喂", async () => {
    const root = await makeWorkspace();
    const llm = new ScriptedLLM(
      [],
      [
        turn(call("c1", "read_file", { path: "README.md" })),
        finalTurn("It is a minimal agent harness for learning."),
      ],
    );
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    await agent.run("Read the file README.md and tell me what this project is about");

    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("Demo Project");
  });

  it("prompt 2：先写后读（跨轮接力：写结果驱动读决策）", async () => {
    const root = await makeWorkspace();
    const llm = new ScriptedLLM(
      [],
      [
        turn(call("c1", "write_file", {
          path: "test.py",
          content: 'print("hello")',
        })),
        turn(call("c2", "read_file", { path: "test.py" })),
        finalTurn("Written and verified"),
      ],
    );
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    await agent.run('Create a file called test.py that prints "hello", then read it back');

    expect(await fs.readFile(path.join(root, "test.py"), "utf8")).toBe('print("hello")');
    const messages = llm.toolCallsList[2]?.messages ?? [];
    const toolMessages = messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2); // write 回执 + read 内容
    expect(toolMessages[1]?.content).toBe('print("hello")');
  });

  it("prompt 4：单轮两个 read_file tool_calls，顺序执行、id 正确回指，再写 summary", async () => {
    const root = await makeWorkspace();
    const llm = new ScriptedLLM(
      [],
      [
        turn(
            call("c1", "read_file", { path: "README.md" }),
            call("c2", "read_file", { path: "requirements.txt" }),
        ),
        turn(call("c3", "write_file", {
          path: "summary.md",
          content: "demo project; deps: anthropic, dotenv",
        })),
        finalTurn("Summary created"),
      ],
    );
    const agent = new FunctionCallAgent("fc", llm, assemble(root, new AutoAllowPrompt()));
    await agent.run(
      "Read both README.md and requirements.txt, then create a summary file",
    );

    // 观察点：单轮多调用 → 两条 tool 消息，顺序与 toolCallId 正确
    const firstTurn = llm.toolCallsList[1]?.messages ?? [];
    const toolMessages = firstTurn.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[0]?.toolCallId).toBe("c1");
    expect(toolMessages[0]?.content).toContain("Demo Project");
    expect(toolMessages[1]?.toolCallId).toBe("c2");
    expect(toolMessages[1]?.content).toContain("anthropic");
    expect(
      await fs.readFile(path.join(root, "summary.md"), "utf8"),
    ).toContain("deps");
  });
});

describe("s03 Permission 试一下（Windows 词边界补充用例）", () => {
  it("DEL 大写同样触发闸门 2（正则大小写不敏感）", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "t.txt"), "x", "utf8");
    const prompt = new AutoDenyPrompt();
    const llm = new ScriptedLLM([], [
      turn(call("c1", "bash", { command: "DEL t.txt" })),
      finalTurn("denied"),
    ]);
    const agent = new FunctionCallAgent("fc", llm, assemble(root, prompt));
    await agent.run("Delete the file t.txt");

    expect(prompt.requests).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "t.txt"), "utf8")).toBe("x");
  });

  it("model / delimiter / echo del 不触发闸门 2", async () => {
    const root = await makeWorkspace();
    const prompt = new AutoDenyPrompt();
    const registry = assemble(root, prompt);
    for (const command of [
      "echo model",
      "echo delimiter",
      "echo del test.txt",
    ]) {
      const output = await registry.executeToolArgs("bash", { command });
      expect(output).not.toContain("⛔");
    }
    expect(prompt.requests).toHaveLength(0);
  });
});
