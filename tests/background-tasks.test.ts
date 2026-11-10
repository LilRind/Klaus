/**
 * s11 Background Tasks 离线验收（对齐 README"试一下"观察点）
 *
 * - runBashProcess：spawn 执行 / 非零退出码 / 超时；
 * - BackgroundManager：bg_id 递增登记、completed|failed 状态、collect 破坏性出队、
 *   <task_notification> XML 格式（summary 截 500）；
 * - BashTool 后台路由：仅显式 run_in_background === true；占位回喂；
 *   权限闸门先于后台分发（被拒不进后台）；
 * - Agent 集成：下一轮 LLM 调用前注入通知，且只投递一次；
 * - dispose 尽力清理运行中的进程树。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BackgroundManager,
  formatBashResult,
  runBashProcess,
} from "../src/background/background-manager";
import { BashTool } from "../src/tools/builtin/bash-tool";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { AutoDenyPrompt, createStandardPermissionChecker } from "../src/security/permission";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s11-"));
});

afterEach(async () => {
  // Windows 下后台进程退出与目录删除存在竞态：重试几次兜底
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
});

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function turn(...toolCalls: ToolCallRequest[]): ToolInvocationResult {
  return { content: null, toolCalls };
}

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

/** 跨平台短命令（shell:true 下 Windows/POSIX 均可用 node） */
const ECHO_OK = `node -e "console.log('bg-ready')"`;
const EXIT_3 = `node -e "process.exit(3)"`;

describe("runBashProcess（spawn 内核）", () => {
  it("成功命令返回输出 + 退出码 0", async () => {
    const { output, exitCode } = await runBashProcess(ECHO_OK, { cwd: workspace });
    expect(output).toContain("bg-ready");
    expect(exitCode).toBe(0);
  });

  it("非零退出码原样返回（failed 判定依据）", async () => {
    const { output, exitCode } = await runBashProcess(EXIT_3, { cwd: workspace });
    expect(exitCode).toBe(3);
    expect(output).toBe("(no output)");
  });

  it("超时返回错误文案 + null 退出码", async () => {
    const long = `node -e "setTimeout(() => {}, 10000)"`;
    const { output, exitCode } = await runBashProcess(long, {
      cwd: workspace,
      timeoutMs: 300,
    });
    expect(output).toMatch(/Timeout/);
    expect(exitCode).toBeNull();
  });
});

describe("formatBashResult（对齐 _format_bash_result）", () => {
  it("退出码 0 或 null 原样输出", () => {
    expect(formatBashResult("ok", 0)).toBe("ok");
    expect(formatBashResult("timeout msg", null)).toBe("timeout msg");
  });

  it("非零退出码加 Error 前缀", () => {
    expect(formatBashResult("boom", 3)).toBe(
      "Error: command exited with status 3\nboom",
    );
  });
});

describe("BackgroundManager", () => {
  it("start 登记 bg_0001 递增 ID；空命令拒绝", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const id1 = await manager.start(ECHO_OK);
    const id2 = await manager.start(ECHO_OK);
    expect(id1).toBe("bg_0001");
    expect(id2).toBe("bg_0002");
    expect(manager.tasks.get(id1)).toMatchObject({
      command: ECHO_OK,
      status: "running",
    });
    await expect(manager.start("   ")).rejects.toThrow(/cannot be empty/i);
    await manager.waitFor(id1);
    await manager.waitFor(id2);
    await manager.dispose();
  });

  it("exit 0 → completed；collect 只投递一次且格式对齐", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const id = await manager.start(ECHO_OK);
    await manager.waitFor(id);
    expect(manager.tasks.get(id)?.status).toBe("completed");

    const [notification] = manager.collect();
    expect(notification).toContain("<task_notification>");
    expect(notification).toContain(`<task_id>${id}</task_id>`);
    expect(notification).toContain("<status>completed</status>");
    expect(notification).toContain(`<command>${ECHO_OK}</command>`);
    expect(notification).toContain("bg-ready");
    // 破坏性出队：已收集任务不再出现
    expect(manager.collect()).toEqual([]);
    await manager.dispose();
  });

  it("非零退出 → failed；summary 截 500 字符", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const big = `node -e "console.log('x'.repeat(2000)); process.exit(2)"`;
    const id = await manager.start(big);
    await manager.waitFor(id);
    expect(manager.tasks.get(id)?.status).toBe("failed");

    const [notification] = manager.collect();
    expect(notification).toContain("<status>failed</status>");
    expect(notification).toContain("command exited with status 2");
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(notification ?? "")?.[1];
    expect(summary?.length).toBeLessThanOrEqual(500);
    await manager.dispose();
  });

  it("dispose 尽力终止运行中的进程（生命周期清理，不是沙箱）", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const id = await manager.start(
      `node -e "setTimeout(() => console.log('late'), 8000)"`,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(manager.tasks.get(id)?.status).toBe("running");
    await manager.dispose();
    // 清理后 collect 不产生完成通知（或不再挂起）
    expect(manager.collect()).toEqual([]);
  });
});

describe("BashTool 后台路由（显式 run_in_background）", () => {
  it("schema 含 run_in_background；仅显式 true 走后台并返回占位结果", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const tool = new BashTool({ cwd: workspace, backgroundManager: manager });
    const schema = tool.parametersSchema as {
      properties: Record<string, unknown>;
    };
    expect(schema.properties.run_in_background).toBeDefined();

    const id = await manager.start(ECHO_OK); // 占用 bg_0001
    await manager.waitFor(id);
    manager.collect();

    const placeholder = await tool.executeArgs({
      command: ECHO_OK,
      run_in_background: true,
    });
    expect(placeholder).toBe(
      "[Background task bg_0002 started] The result will be collected on a later turn.",
    );

    // 缺省 / 字符串 "true" 均走同步路径
    const sync = await tool.executeArgs({ command: ECHO_OK });
    expect(sync).toBe("bg-ready");
    const syncString = await tool.executeArgs({
      command: ECHO_OK,
      run_in_background: "true",
    } as Record<string, unknown>);
    expect(syncString).toBe("bg-ready");
    await manager.dispose();
  });

  it("未挂 manager 时 run_in_background 退化为同步执行", async () => {
    const tool = new BashTool({ cwd: workspace });
    await expect(
      tool.executeArgs({ command: ECHO_OK, run_in_background: true }),
    ).resolves.toBe("bg-ready");
  });

  it("权限闸门先于后台分发：被拒命令不进后台", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const registry = new ToolRegistry()
      .register(new BashTool({ cwd: workspace, backgroundManager: manager }))
      .setPermissionChecker(
        createStandardPermissionChecker({
          workspaceRoot: workspace,
          prompt: new AutoDenyPrompt(),
        }),
      );

    const output = await registry.executeToolArgs("bash", {
      command: "del something",
      run_in_background: true,
    });
    expect(output).toContain("⛔");
    expect(manager.tasks.size).toBe(0);
    await manager.dispose();
  });
});

describe("Agent 集成（下一轮注入通知，只投一次）", () => {
  it("run1 启动后台命令 → 完成后 run2 首次 LLM 调用前注入 <task_notification>", async () => {
    const manager = new BackgroundManager({ cwd: workspace });
    const registry = new ToolRegistry().register(
      new BashTool({ cwd: workspace, backgroundManager: manager }),
    );
    const llm = new ScriptedLLM([], [
      turn(call("t1", "bash", { command: ECHO_OK, run_in_background: true })),
      finalTurn("started"),
      finalTurn("noted"),
    ]);
    const agent = new FunctionCallAgent("s11-agent", llm, registry, {
      collectNotifications: () => manager.collect(),
    });

    const first = await agent.run("Run the echo command in the background");
    expect(first).toBe("started");
    // 第二次模型调用（工具结果回喂后）可见占位 tool 消息
    const toolMessage = (llm.toolCallsList[1]?.messages ?? []).find(
      (m) => m.role === "tool",
    );
    expect(toolMessage?.content).toContain(
      "[Background task bg_0001 started]",
    );

    await manager.waitFor("bg_0001");

    const second = await agent.run("Continue");
    expect(second).toBe("noted");
    // run2 的首次模型调用已携带通知（history 注入 + conversation 可见）
    const secondCallMessages = llm.toolCallsList[2]?.messages ?? [];
    const notificationMessage = secondCallMessages.find((m) =>
      m.content?.includes("<task_notification>"),
    );
    expect(notificationMessage?.content).toContain("<task_id>bg_0001</task_id>");
    expect(notificationMessage?.content).toContain("<status>completed</status>");
    expect(notificationMessage?.content).toContain("bg-ready");

    // 只投递一次：collect 已消费
    expect(manager.collect()).toEqual([]);
    await manager.dispose();
  });
});
