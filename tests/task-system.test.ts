/**
 * s10 Task System 离线验收（对齐 README"试一下"观察点）
 *
 * - TaskStore 持久化（.tasks/{id}.json）、ID 排他写入、状态机校验；
 * - blockedBy 依赖校验全分支（自依赖 / 不存在 / 环 / 重复边幂等 / 非 pending 目标）；
 * - claim 依赖闸门 → complete 解锁下游；
 * - 六个结构化工具的回喂文案与 lcc 逐字对齐；
 * - Agent 集成：ScriptedLLM 驱动 list → claim → complete 全链路。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TaskStore,
  TASK_ID_PATTERN,
} from "../src/tasks/task-store";
import {
  ClaimTaskTool,
  CompleteTaskTool,
  CreateTaskTool,
  GetTaskTool,
  ListTasksTool,
  UpdateTaskTool,
} from "../src/tools/builtin/task-tools";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s10-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function newStore(): TaskStore {
  return new TaskStore({
    directory: path.join(workspace, ".tasks"),
    workspaceRoot: workspace,
  });
}

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

/** 从 "Created task_xxxx: subject" 中提取任务 ID */
function createdTaskId(message: string): string {
  const id = message.split(" ")[1]?.replace(/:$/, "");
  if (!id) throw new Error(`无法从创建结果提取 ID: ${message}`);
  return id;
}

describe("TaskStore（s10 对齐）", () => {
  it("create：生成合法 ID、pending 起始态、落盘 JSON", async () => {
    const store = newStore();
    const task = await store.create("setup database schema", "初始表结构");

    expect(TASK_ID_PATTERN.test(task.id)).toBe(true);
    expect(task.status).toBe("pending");
    expect(task.owner).toBeNull();
    expect(task.blockedBy).toEqual([]);

    const raw = JSON.parse(
      await readFile(path.join(workspace, ".tasks", `${task.id}.json`), "utf8"),
    );
    expect(raw).toEqual(task);
  });

  it("空 subject 拒绝", async () => {
    const store = newStore();
    await expect(store.create("   ")).rejects.toThrow(
      /subject cannot be empty/i,
    );
  });

  it("非法 ID 拒绝（防路径穿越）", async () => {
    const store = newStore();
    await expect(store.load("../escape")).rejects.toThrow(/Invalid task ID/);
    await expect(store.exists("task_ZZZZZZZZ")).resolves.toBe(false);
  });

  it("存储目录越出 workspace 拒绝", () => {
    expect(
      () =>
        new TaskStore({
          directory: path.join(workspace, "..", "outside-tasks"),
          workspaceRoot: workspace,
        }),
    ).toThrow(/escapes the workspace/);
  });

  it("updateDependencies：合法建边 + 重复边幂等", async () => {
    const store = newStore();
    const schema = await store.create("schema");
    const api = await store.create("api");

    await store.updateDependencies(api.id, [schema.id]);
    await store.updateDependencies(api.id, [schema.id]); // 重复添加安全

    const reloaded = await store.load(api.id);
    expect(reloaded.blockedBy).toEqual([schema.id]);
  });

  it("updateDependencies 校验分支：自依赖 / 不存在 / 被更新的任务须 pending 未认领", async () => {
    const store = newStore();
    const a = await store.create("a");
    const b = await store.create("b");

    await expect(store.updateDependencies(a.id, [a.id])).rejects.toThrow(
      /depend on itself/,
    );
    await expect(
      store.updateDependencies(a.id, ["task_00000000"]),
    ).rejects.toThrow(/Dependency not found/);

    // lcc 语义：限制的是"被更新的任务"（a），依赖目标 b 只需存在——
    // 已认领/进行中的任务仍然可以作为别人的依赖
    await store.claim(b.id, "agent");
    await expect(store.updateDependencies(a.id, [b.id])).resolves.toMatchObject({
      id: a.id,
      blockedBy: [b.id],
    });

    const c = await store.create("c");
    await store.claim(c.id, "agent");
    await expect(store.updateDependencies(c.id, [a.id])).rejects.toThrow(
      /pending and unowned/,
    );
  });

  it("updateDependencies 环检测：a→b 后 b→a 拒绝（DFS）", async () => {
    const store = newStore();
    const a = await store.create("a");
    const b = await store.create("b");
    await store.updateDependencies(a.id, [b.id]);

    await expect(store.updateDependencies(b.id, [a.id])).rejects.toThrow(
      /cycle detected/,
    );
  });

  it("load 校验：ID 不匹配 / 非法 status 拒绝", async () => {
    const store = newStore();
    const task = await store.create("a");
    const file = path.join(workspace, ".tasks", `${task.id}.json`);

    const mismatch = { ...task, id: "task_00000000" };
    await writeFile(file, JSON.stringify(mismatch), "utf8");
    await expect(store.load(task.id)).rejects.toThrow(/does not match/);

    const badStatus = { ...task, status: "done" };
    await writeFile(file, JSON.stringify(badStatus), "utf8");
    await expect(store.load(task.id)).rejects.toThrow(/Invalid task status/);
  });

  it("list 按 ID 排序返回全部任务；目录不存在时空数组", async () => {
    const store = newStore();
    expect(await store.list()).toEqual([]);
    const a = await store.create("a");
    const b = await store.create("b");
    const ids = (await store.list()).map((t) => t.id).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("跨 store 实例持久化往返（跨会话恢复）", async () => {
    const first = newStore();
    const schema = await first.create("schema");
    await first.claim(schema.id, "agent");

    const second = newStore();
    const restored = await second.load(schema.id);
    expect(restored.status).toBe("in_progress");
    expect(restored.owner).toBe("agent");
  });
});

describe("任务状态机（claim / complete / 解锁）", () => {
  it("依赖未完成 → Blocked by；完成后解锁下游", async () => {
    const store = newStore();
    const schema = await store.create("create schema");
    const api = await store.create("write API");
    await store.updateDependencies(api.id, [schema.id]);

    await expect(store.claim(api.id, "agent")).resolves.toBe(
      `Blocked by: ['${schema.id}']`,
    );

    await expect(store.claim(schema.id, "agent")).resolves.toBe(
      `Claimed ${schema.id} (create schema)`,
    );
    await expect(store.complete(schema.id, "agent")).resolves.toBe(
      `Completed ${schema.id} (create schema)\nUnblocked: write API`,
    );

    await expect(store.claim(api.id, "agent")).resolves.toBe(
      `Claimed ${api.id} (write API)`,
    );
  });

  it("claim 拒绝非 pending；complete 校验状态与 owner", async () => {
    const store = newStore();
    const a = await store.create("a");
    const b = await store.create("b");

    await store.claim(a.id, "agent");
    await expect(store.claim(a.id, "agent")).resolves.toBe(
      `Task ${a.id} is in_progress, cannot claim`,
    );
    await expect(store.complete(b.id, "agent")).resolves.toBe(
      `Task ${b.id} is pending, cannot complete`,
    );
    await expect(store.complete(a.id, "other")).resolves.toBe(
      `Task ${a.id} is owned by agent, not other`,
    );
    await expect(store.complete(a.id, "agent")).resolves.toContain(
      `Completed ${a.id}`,
    );
    await expect(store.complete(a.id, "agent")).resolves.toBe(
      `Task ${a.id} is completed, cannot complete`,
    );
  });

  it("依赖文件缺失 → 计入未完成（不可认领）", async () => {
    const store = newStore();
    const a = await store.create("a");
    const b = await store.create("b");
    const blocked = await store.updateDependencies(b.id, [a.id]);
    await rm(path.join(workspace, ".tasks", `${a.id}.json`));

    expect(await store.incompleteDependencies(blocked)).toEqual([a.id]);
    await expect(store.claim(b.id, "agent")).resolves.toBe(
      `Blocked by: ['${a.id}']`,
    );
  });

  it("完成多个上游后才解锁（全部 completed 才 can_start）", async () => {
    const store = newStore();
    const up1 = await store.create("up1");
    const up2 = await store.create("up2");
    const down = await store.create("down");
    await store.updateDependencies(down.id, [up1.id, up2.id]);

    await store.claim(up1.id, "agent");
    const message = await store.complete(up1.id, "agent");
    expect(message).not.toContain("Unblocked");
    expect(await store.canStart(down.id)).toBe(false);

    await store.claim(up2.id, "agent");
    await expect(store.complete(up2.id, "agent")).resolves.toContain(
      "Unblocked: down",
    );
    expect(await store.canStart(down.id)).toBe(true);
  });
});

describe("任务工具（s10 六工具契约）", () => {
  it("create / update / list / get 回喂文案对齐 lcc", async () => {
    const store = newStore();
    const create = new CreateTaskTool(store);
    const update = new UpdateTaskTool(store);
    const list = new ListTasksTool(store);
    const get = new GetTaskTool(store);

    const created = await create.executeArgs({ subject: "create schema" });
    expect(created).toMatch(/^Created task_[0-9a-f]{8}: create schema$/);
    const id = createdTaskId(created);

    const apiCreated = await create.executeArgs({
      subject: "write API",
      description: "REST endpoints",
    });
    const apiId = createdTaskId(apiCreated);

    await expect(
      update.executeArgs({ task_id: apiId, addBlockedBy: [id] }),
    ).resolves.toBe(`Updated ${apiId} blockedBy: ${id}`);

    const listing = await list.executeArgs({});
    expect(listing.split("\n").sort()).toEqual(
      [
        `[ ] ${id}: create schema [pending]`,
        `[ ] ${apiId}: write API [pending] (blockedBy: ${id})`,
      ].sort(),
    );

    const detail = await get.executeArgs({ task_id: apiId });
    expect(JSON.parse(detail)).toMatchObject({
      id: apiId,
      subject: "write API",
      status: "pending",
      blockedBy: [id],
    });
  });

  it("create schema 不含 blockedBy 且禁额外字段（两阶段建图契约）", () => {
    const schema = new CreateTaskTool(newStore()).parametersSchema as {
      properties: Record<string, unknown>;
      additionalProperties: boolean;
    };
    expect(schema.properties.blockedBy).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);

    const update = new UpdateTaskTool(newStore()).parametersSchema as {
      required: string[];
      properties: { addBlockedBy: { minItems: number } };
    };
    expect(update.required).toEqual(["task_id", "addBlockedBy"]);
    expect(update.properties.addBlockedBy.minItems).toBe(1);
  });

  it("list 空任务引导创建", async () => {
    await expect(
      new ListTasksTool(newStore()).executeArgs({}),
    ).resolves.toBe("No tasks. Use create_task to add some.");
  });

  it("claim / complete 工具走 owner=agent 默认", async () => {
    const store = newStore();
    const create = new CreateTaskTool(store);
    const claim = new ClaimTaskTool(store);
    const complete = new CompleteTaskTool(store);

    const id = createdTaskId(await create.executeArgs({ subject: "a" }));
    await expect(claim.executeArgs({ task_id: id })).resolves.toBe(
      `Claimed ${id} (a)`,
    );
    await expect(complete.executeArgs({ task_id: id })).resolves.toBe(
      `Completed ${id} (a)`,
    );
    expect((await store.load(id)).owner).toBe("agent");
  });

  it("工具校验错误转为 ❌ observation（不抛出炸循环）", async () => {
    const store = newStore();
    const update = new UpdateTaskTool(store);
    await expect(
      update.executeArgs({ task_id: "task_00000000", addBlockedBy: ["task_00000001"] }),
    ).resolves.toMatch(/^❌ /);
    await expect(new ClaimTaskTool(store).executeArgs({})).resolves.toMatch(
      /^❌ /,
    );
  });
});

describe("Agent 集成（s10 对齐线）", () => {
  it("ScriptedLLM 驱动 list → claim → complete，工具轨迹回喂", async () => {
    const store = newStore();
    const schema = await store.create("create schema");

    const llm = new ScriptedLLM([], [
      turn(call("t1", "list_tasks", {})),
      turn(call("t2", "claim_task", { task_id: schema.id })),
      turn(call("t3", "complete_task", { task_id: schema.id })),
      finalTurn("done"),
    ]);
    const registry = new ToolRegistry();
    registry
      .register(new ListTasksTool(store))
      .register(new ClaimTaskTool(store))
      .register(new CompleteTaskTool(store))
      .assertAllStructured();
    const agent = new FunctionCallAgent("s10-agent", llm, registry);

    const answer = await agent.run("Claim and complete the first task");
    expect(answer).toBe("done");

    // conversation 累积——最后一次模型调用包含全部三条工具结果
    const toolMessages = (llm.toolCallsList.at(-1)?.messages ?? []).filter(
      (m) => m.role === "tool",
    );
    const contents = toolMessages.map((m) => m.content ?? "");
    expect(contents[0]).toContain(`[ ] ${schema.id}: create schema`);
    expect(contents[1]).toBe(`Claimed ${schema.id} (create schema)`);
    expect(contents[2]).toBe(
      `Completed ${schema.id} (create schema)`,
    );
    expect((await store.load(schema.id)).status).toBe("completed");
  });

  it("update_task 用 create 返回的运行时 ID 建边（两阶段建图端到端）", async () => {
    const store = newStore();
    const schema = await store.create("create schema");
    const api = await store.create("write API");

    const update = new UpdateTaskTool(store);
    const output = await update.executeArgs({
      task_id: api.id,
      addBlockedBy: [schema.id],
    });
    expect(output).toBe(`Updated ${api.id} blockedBy: ${schema.id}`);

    // 同级并行 create 无法引用彼此的运行时 ID——这正是两阶段契约存在的原因：
    // 一条回复里的多个 tool_calls 在任何结果产生前就已确定
    const files = await readdir(path.join(workspace, ".tasks"));
    expect(files).toHaveLength(2);
  });
});
