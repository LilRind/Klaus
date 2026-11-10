/**
 * s13 Agent Teams 离线验收：MessageBus、类型化协议、TeammateRuntime、Lead 工具。
 *
 * 全部使用 ScriptedLLM / FunctionTool stub，不访问真实模型；文件 mailbox 和
 * 任务 JSON 则真实落临时目录，验证持久语义。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore } from "../src/tasks/task-store";
import { TaskWorktreeManager } from "../src/tasks/task-worktrees";
import { TaskBoard } from "../src/teams/task-board";
import { MessageBus } from "../src/teams/message-bus";
import { TeamProtocol } from "../src/teams/team-protocol";
import { TeamManager } from "../src/teams/team-manager";
import { createTeamTools } from "../src/tools/builtin/team-tools";
import { FunctionTool, Tool, type ToolFunctionOptions } from "../src/tools/tool";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";
import type { GitResult } from "../src/tasks/task-worktrees";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s13-team-"));
});

afterEach(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
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

function fn(options: ToolFunctionOptions): Tool {
  return new FunctionTool(options.func, options);
}

function newHarness(
  toolResponses: ToolInvocationResult[],
  tools: Tool[] = [],
) {
  const llm = new ScriptedLLM([], toolResponses);
  const store = new TaskStore({
    directory: path.join(workspace, ".tasks"),
    workspaceRoot: workspace,
  });
  const worktrees = new TaskWorktreeManager({
    workspaceRoot: workspace,
    taskStore: store,
    gitRunner: async (): Promise<GitResult> => ({
      ok: true,
      output: "",
    }),
  });
  const board = new TaskBoard({ store, worktrees });
  const bus = new MessageBus({ directory: path.join(workspace, ".mailboxes") });
  const protocol = new TeamProtocol();
  const manager = new TeamManager({
    llm,
    board,
    bus,
    protocol,
    autoStart: false,
    workspaceTools: () => tools,
  });
  return { llm, store, board, bus, protocol, manager };
}

describe("MessageBus（s13）", () => {
  it("消息落 JSONL、读取是破坏性出队、非法收件人拒绝", async () => {
    const bus = new MessageBus({
      directory: path.join(workspace, ".mailboxes"),
      now: () => 123,
    });
    await bus.send("alice", "lead", "hello", "message", { request_id: "req_000001" });
    const file = path.join(workspace, ".mailboxes", "lead.jsonl");
    expect((await readFile(file, "utf8")).trim()).toBe(
      JSON.stringify({
        from: "alice",
        to: "lead",
        content: "hello",
        type: "message",
        ts: 123,
        metadata: { request_id: "req_000001" },
      }),
    );
    await expect(bus.readInbox("lead")).resolves.toHaveLength(1);
    await expect(bus.readInbox("lead")).resolves.toEqual([]);
    await expect(bus.send("alice", "../escape", "bad")).rejects.toThrow(
      /Invalid mailbox recipient/,
    );
  });

  it("wait 等到消息后出队，超时空手返回", async () => {
    let ticks = 0;
    const bus = new MessageBus({
      directory: path.join(workspace, ".mailboxes"),
      sleep: async () => {
        ticks += 1;
      },
    });
    await bus.send("lead", "worker", "wake");
    const waiting = bus.waitForMessages("worker", 30);
    await expect(waiting).resolves.toHaveLength(1);
    await expect(bus.waitForMessages("worker", 0)).resolves.toEqual([]);
    expect(ticks).toBe(0);
  });
});

describe("TeamProtocol（类型化协议）", () => {
  it("request_id 匹配类型/方向/状态才接受响应；重复响应拒绝", async () => {
    const protocol = new TeamProtocol();
    const id = protocol.createRequest({
      type: "shutdown",
      sender: "lead",
      target: "worker",
      payload: "",
    });
    expect(id).toMatch(/^req_\d{6}$/);
    expect(
      protocol.matchResponse("shutdown_response", id, true, "worker", "lead"),
    ).toBe(true);
    expect(
      protocol.matchResponse("shutdown_response", id, true, "worker", "lead"),
    ).toBe(false);
    const planId = protocol.createRequest({
      type: "plan_approval",
      sender: "worker",
      target: "lead",
      payload: "plan",
    });
    expect(
      protocol.matchResponse("shutdown_response", planId, true, "lead", "worker"),
    ).toBe(false);
    expect(protocol.getRequest(planId)?.status).toBe("pending");
  });
});

describe("TeammateRuntime / TeamManager", () => {
  it("spawn：校验名字与初始任务；初始任务已预认领并注入 Work directory", async () => {
    const { manager, store, board } = newHarness([finalTurn("done")]);
    const task = await store.create("initial");
    await expect(manager.spawnTeammate("Lead", "dev", "start")).resolves.toBe(
      "Invalid teammate name: 'Lead' is reserved by the runtime",
    );
    await expect(manager.spawnTeammate("bad name", "dev", "start")).resolves.toMatch(
      /Invalid teammate name/,
    );
    await expect(manager.spawnTeammate("worker", "dev", "start", task.id)).resolves.toBe(
      `Teammate 'worker' spawned as dev for ${task.id}. End this turn; the runtime will deliver its events.`,
    );
    const runtime = manager.getRuntime("worker")!;
    await expect(board.assignmentCwd("worker")).resolves.toBe(workspace);
    expect(runtime.messages[0]!.content).toContain(
      `[Assigned task ${task.id}] initial`,
    );
    expect(runtime.messages[0]!.content).toContain(`Work directory: ${workspace}`);
    await expect(manager.listTeammates()).resolves.toBe("worker: working");
  });

  it("工作回合执行工具并回喂 tool 消息；最终 result/idle 事件进 Lead 收件箱", async () => {
    const executed: string[] = [];
    const probe = fn({
      name: "probe",
      description: "probe",
      parametersSchema: { type: "object", properties: {} },
      func: () => {
        executed.push("probe");
        return "probe-ok";
      },
    });
    const { manager, store, bus } = newHarness([
      turn(call("t1", "probe", {})),
      finalTurn("feature finished"),
    ], [probe]);
    const task = await store.create("probe work");
    const runtime = await manager.spawnRuntime("worker", "dev", "do work", {
      taskId: task.id,
    });
    await expect(runtime.work()).resolves.toBe("continue");
    expect(executed).toEqual(["probe"]);
    expect(runtime.messages.at(-1)).toMatchObject({
      role: "tool",
      content: "probe-ok",
      toolCallId: "t1",
    });
    await expect(runtime.work()).resolves.toBe("idle");
    const lead = await bus.readInbox("lead");
    expect(lead.map((m) => [m.type, m.content])).toEqual([
      ["result", "feature finished"],
      ["idle_notification", "Waiting for more work."],
    ]);
  });

  it("plan gate：submit 后阻塞写工具；Lead approve 后放行并按 assignment 版本防重放", async () => {
    const executed: string[] = [];
    const write = fn({
      name: "write_file",
      description: "write",
      parametersSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
      func: () => {
        executed.push("write");
        return "written";
      },
    });
    const responses = [
      turn(call("p1", "submit_plan", { plan: "write safely" })),
      turn(call("w1", "write_file", { path: "a.txt", content: "a" })),
      turn(call("c1", "complete_task", { task_id: "task_00000000" })),
      finalTurn("done after plan"),
    ];
    const { manager, store, bus, board } = newHarness(responses, [write]);
    const task = await store.create("planned work");
    responses[2]!.toolCalls[0]!.function.arguments = JSON.stringify({
      task_id: task.id,
    });
    const runtime = await manager.spawnRuntime("worker", "dev", "work", {
      taskId: task.id,
      requirePlan: true,
    });
    await expect(runtime.work()).resolves.toBe("continue");
    const request = (await bus.readInbox("lead")).find(
      (message) => message.type === "plan_approval_request",
    )!;
    expect(manager.planGate("worker")).toBe("pending");

    // Lead 审批：生成对 teammate 的响应，下一工作回合先应用到 gate。
    await expect(
      manager.reviewPlan(String(request.metadata.request_id), true, "go"),
    ).resolves.toBe(`Plan approved (${String(request.metadata.request_id)})`);
    await expect(runtime.work()).resolves.toBe("continue");
    expect(executed).toEqual(["write"]);
    await expect(runtime.work()).resolves.toBe("continue");
    await expect(runtime.work()).resolves.toBe("idle");
    expect(manager.planGate("worker")).toBe("required");
    expect(board.assignmentVersion("worker")).toBe(2);
  });

  it("计划未批时写工具被阻塞，complete 也被 plan gate 拒绝", async () => {
    const write = fn({
      name: "write_file",
      description: "write",
      parametersSchema: { type: "object", properties: {} },
      func: () => "should not run",
    });
    const responses = [
      turn(call("p1", "submit_plan", { plan: "plan" })),
      turn(
        call("w1", "write_file", {}),
        call("c1", "complete_task", { task_id: "task_00000000" }),
      ),
    ];
    const { manager, llm, store } = newHarness(responses, [write]);
    const gatedTask = await store.create("gated");
    responses[1]!.toolCalls[1]!.function.arguments = JSON.stringify({
      task_id: gatedTask.id,
    });
    await manager.spawnRuntime("worker", "dev", "work", {
      taskId: gatedTask.id,
      requirePlan: true,
    });
    const runtime = manager.getRuntime("worker")!;
    await runtime.work();
    await runtime.work();
    const toolMessage = runtime.messages.filter((m) => m.role === "tool").at(-2);
    expect(toolMessage?.content).toContain("Blocked: plan status is pending");
    const completeMessage = runtime.messages.filter((m) => m.role === "tool").at(-1);
    expect(completeMessage?.content).toContain(
      `Task ${gatedTask.id} cannot complete while plan status is pending`,
    );
    expect(llm.toolCallsList).toHaveLength(2);
  });

  it("shutdown：仅接受 Lead 的 pending 请求，ack 后停止并释放 abandoned assignment", async () => {
    const { manager, bus, store, protocol } = newHarness([
      turn(call("s1", "send_message", { to: "lead", content: "progress" })),
    ]);
    const task = await store.create("shutdown work");
    const runtime = await manager.spawnRuntime("worker", "dev", "work", {
      taskId: task.id,
    });
    await runtime.work();
    const shutdownMessage = await manager.requestShutdown("worker");
    const shutdownId = shutdownMessage!.match(/req_\d{6}/)![0];
    expect(shutdownId).toMatch(/^req_\d{6}$/);
    await expect(runtime.work()).resolves.toBe("stop");
    const response = (await bus.readInbox("lead")).find(
      (message) => message.type === "shutdown_response",
    )!;
    expect(response.metadata).toMatchObject({
      request_id: shutdownId,
      approve: true,
    });
    expect(
      protocol.matchResponse(
        "shutdown_response",
        shutdownId,
        true,
        "worker",
        "lead",
      ),
    ).toBe(true);
    expect(protocol.getRequest(shutdownId)?.status).toBe("approved");
    await manager.cleanupTeammate("worker");
    await expect(store.load(task.id)).resolves.toMatchObject({
      status: "pending",
      owner: null,
    });
    await expect(manager.listTeammates()).resolves.toBe("No active teammates.");
  });

  it("idle 自动认领第一个 ready 任务；不可用 worktree 任务跳过", async () => {
    const { manager, store } = newHarness([finalTurn("auto done")]);
    const ready = await store.create("ready");
    const blocked = await store.create("blocked");
    await store.updateDependencies(blocked.id, [ready.id]);
    const runtime = await manager.spawnRuntime("idle-worker", "dev", "start");
    await expect(runtime.waitForWorkOnce()).resolves.toBe(true);
    expect(runtime.messages.at(-1)?.content).toContain(
      `[Auto-claimed task ${ready.id}] ready`,
    );
    await expect(store.load(blocked.id)).resolves.toMatchObject({
      status: "pending",
    });
  });
});

describe("Lead team tools", () => {
  it("七个工具的名称/schema/回喂文案", async () => {
    const { manager, store } = newHarness([]);
    const task = await store.create("tool task");
    const tools = createTeamTools(manager);
    expect(tools.map((tool) => tool.name)).toEqual([
      "spawn_teammate",
      "list_teammates",
      "send_message",
      "request_shutdown",
      "request_plan",
      "review_plan",
      "create_worktree",
    ]);
    for (const tool of tools) {
      expect(tool.parametersSchema?.type).toBe("object");
    }
    const [spawnTool, listTool, sendTool, shutdownTool, planTool, reviewTool] = tools;
    await expect(
      spawnTool!.executeArgs?.({
        name: "worker",
        role: "dev",
        prompt: "start",
        task_id: task.id,
      }),
    ).resolves.toBe(
      `Teammate 'worker' spawned as dev for ${task.id}. End this turn; the runtime will deliver its events.`,
    );
    await expect(listTool!.executeArgs?.({})).resolves.toBe("worker: working");
    await expect(
      sendTool!.executeArgs?.({ to: "missing", content: "hi" }),
    ).resolves.toBe("Teammate 'missing' is not active");
    await expect(shutdownTool!.executeArgs?.({ teammate: "worker" })).resolves.toMatch(
      /^Shutdown requested from worker \(req_\d{6}\)$/,
    );
    await expect(
      planTool!.executeArgs?.({ teammate: "worker", task: "show plan" }),
    ).resolves.toBe("Plan requested from worker");
    await expect(
      reviewTool!.executeArgs?.({ request_id: "req_000000", approve: true }),
    ).resolves.toBe("Request req_000000 not found");
  });
});
