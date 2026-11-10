/**
 * s13 Agent Teams 第一层离线验收：任务板 worktree 强化。
 *
 * 覆盖：
 * - 名称/路径围栏与分支命名；
 * - create 的全量 preflight + 成功后任务绑定；
 * - 任务状态 / 重复绑定 / 已存在路径 / 已存在分支的错误文案；
 * - remove 的 completed 门槛、脏工作区保护、--force 与解绑；
 * - TaskBoard 认领时的 cwd 租约和坏 worktree fail-closed。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TaskStore } from "../src/tasks/task-store";
import {
  TaskWorktreeManager,
  validateWorktreeName,
} from "../src/tasks/task-worktrees";
import { TaskBoard } from "../src/teams/task-board";
import type { GitRunner, GitResult } from "../src/tasks/task-worktrees";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s13-wt-"));
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

function ok(output = ""): GitResult {
  return { ok: true, output };
}

function fail(output = "git failed"): GitResult {
  return { ok: false, output };
}

function newStore(): TaskStore {
  return new TaskStore({
    directory: path.join(workspace, ".tasks"),
    workspaceRoot: workspace,
  });
}

/** 可编程 Git stub：记录命令，并按 (子命令串, cwd) 返回结果 */
function scriptedGit(
  behavior: (args: string[], cwd?: string) => GitResult,
): GitRunner & { calls: { args: string[]; cwd?: string }[] } {
  const runner = Object.assign(
    async (args: string[], cwd?: string) => {
      runner.calls.push({ args, cwd });
      return behavior(args, cwd);
    },
    { calls: [] as { args: string[]; cwd?: string }[] },
  );
  return runner;
}

function happyGit(): ReturnType<typeof scriptedGit> {
  return scriptedGit((args) => {
    if (args[0] === "rev-parse") return ok(workspace);
    if (args[0] === "show-ref") return fail();
    return ok("");
  });
}

function newManager(runner: GitRunner) {
  const store = newStore();
  const manager = new TaskWorktreeManager({
    workspaceRoot: workspace,
    taskStore: store,
    gitRunner: runner,
  });
  return { store, manager, board: new TaskBoard({ store, worktrees: manager }) };
}

describe("validateWorktreeName", () => {
  it("接受 1-64 位字母数字开头的名字", () => {
    expect(validateWorktreeName("a")).toBeNull();
    expect(validateWorktreeName("A.b-_9".repeat(8).slice(0, 64))).toBeNull();
  });

  it("拒绝非法字符、路径段和越界长度", () => {
    expect(validateWorktreeName("")).toMatch(/1-64 letters/);
    expect(validateWorktreeName(".hidden")).toMatch(/start with/i);
    expect(validateWorktreeName("bad/name")).toMatch(/1-64 letters/);
    expect(validateWorktreeName("a..b")).toMatch(/cannot contain/);
    expect(validateWorktreeName(`${"a".repeat(65)}`)).toMatch(/1-64 letters/);
  });
});

describe("TaskWorktreeManager", () => {
  it("create：preflight 全通过后创建 wt/<name> 并绑定 pending 任务", async () => {
    const git = scriptedGit((args) => {
      if (args[0] === "rev-parse") return ok(workspace);
      if (args[0] === "check-ref-format") return ok();
      if (args[0] === "show-ref") return fail();
      if (args[0] === "worktree" && args[1] === "list") return ok("");
      if (args[0] === "worktree" && args[1] === "add") return ok("Preparing worktree");
      return fail(`unexpected command: ${args.join(" ")}`);
    });
    const { store, manager } = newManager(git);
    const task = await store.create("implement feature");

    const target = path.join(workspace, ".worktrees", "feature");
    const message = await manager.create("feature", task.id);

    expect(message).toBe(
      `Worktree 'feature' created at ${target} for task ${task.id}`,
    );
    await expect(store.load(task.id)).resolves.toMatchObject({
      worktree: "feature",
    });
    expect(git.calls.map(({ args }) => args.join(" "))).toEqual([
      "rev-parse --show-toplevel",
      "check-ref-format --branch wt/feature",
      "show-ref --verify --quiet refs/heads/wt/feature",
      "worktree list --porcelain",
      `worktree add -b wt/feature ${target} HEAD`,
    ]);
  });

  it("create 校验任务存在、pending 未认领、未绑定且名字不重复", async () => {
    const git = happyGit();
    const store = newStore();
    const manager = new TaskWorktreeManager({
      workspaceRoot: workspace,
      taskStore: store,
      gitRunner: git,
    });
    const a = await store.create("a");
    const b = await store.create("b");

    await expect(manager.create("missing", "task_00000000")).resolves.toBe(
      "Error: Task task_00000000 not found",
    );
    await store.claim(a.id, "agent");
    await expect(manager.create("claimed", a.id)).resolves.toBe(
      `Error: Task ${a.id} must be pending and unowned`,
    );
    await manager.create("bound", b.id);
    await expect(manager.create("another", b.id)).resolves.toBe(
      `Error: Task ${b.id} already uses worktree 'bound'`,
    );
    const c = await store.create("c");
    await expect(manager.create("bound", c.id)).resolves.toBe(
      "Error: Worktree 'bound' is already bound to another task",
    );
    await expect(manager.create("bad/name", c.id)).resolves.toBe(
      "Error: worktree name must be 1-64 letters, digits, dots, underscores, or dashes, and start with a letter or digit",
    );
  });

  it("create：仓库根 / 分支已存在 / 注册路径已存在均拒绝", async () => {
    const git = scriptedGit((args) => {
      if (args[0] === "rev-parse") return ok(path.join(workspace, "nested"));
      return ok();
    });
    const { store, manager } = newManager(git);
    const task = await store.create("a");
    await expect(manager.create("a", task.id)).resolves.toBe(
      "Error: Working directory must be the root of a Git repository",
    );

    const branchExists = scriptedGit((args) =>
      args[0] === "show-ref" ? ok() : args[0] === "rev-parse" ? ok(workspace) : ok(""),
    );
    const branchStore = newStore();
    const branchManager = new TaskWorktreeManager({
      workspaceRoot: workspace,
      taskStore: branchStore,
      gitRunner: branchExists,
    });
    const b = await branchStore.create("b");
    await expect(branchManager.create("exists", b.id)).resolves.toBe(
      "Error: Branch 'wt/exists' already exists",
    );

    const registryPath = path.join(workspace, ".worktrees", "registered");
    const registryExists = scriptedGit((args) => {
      if (args[0] === "rev-parse") return ok(workspace);
      if (args[0] === "worktree" && args[1] === "list") {
        return ok(`worktree ${registryPath}\nHEAD abc\nbranch refs/heads/wt/registered\n`);
      }
      return args[0] === "show-ref" ? fail() : ok();
    });
    const registryStore = newStore();
    const registryManager = new TaskWorktreeManager({
      workspaceRoot: workspace,
      taskStore: registryStore,
      gitRunner: registryExists,
    });
    const c = await registryStore.create("c");
    await expect(registryManager.create("registered", c.id)).resolves.toBe(
      `Error: Worktree path is already registered: ${registryPath}`,
    );
  });

  it("create 失败时保留错误输出；成功后绑定失败报告 Partial success", async () => {
    const store = newStore();
    const task = await store.create("a");
    const failure = new TaskWorktreeManager({
      workspaceRoot: workspace,
      taskStore: store,
      gitRunner: async (args) => {
        if (args[0] === "rev-parse") return ok(workspace);
        if (args[0] === "show-ref") return fail();
        if (args[0] === "worktree" && args[1] === "list") return ok("");
        if (args[0] === "worktree" && args[1] === "add") return fail("cannot create");
        return ok("");
      },
    });
    await expect(failure.create("fail", task.id)).resolves.toBe(
      "Git error: cannot create",
    );

    class SaveFailStore extends TaskStore {
      override async save(): Promise<void> {
        throw new Error("disk unavailable");
      }
    }
    const readonly = new SaveFailStore({
      directory: path.join(workspace, ".tasks"),
      workspaceRoot: workspace,
    });
    const roTask = await readonly.create("ro");
    const partial = new TaskWorktreeManager({
      workspaceRoot: workspace,
      taskStore: readonly,
      gitRunner: async (args) =>
        args[0] === "rev-parse" ? ok(workspace) : args[0] === "show-ref" ? fail() : ok(""),
    });
    await expect(partial.create("partial", roTask.id)).resolves.toMatch(
      /^Partial success: Worktree 'partial' was created/,
    );
  });

  it("remove：active 拒绝、脏工作区默认拒绝、force 删除并解绑完成态任务", async () => {
    const statusResults = new Map<string, GitResult>();
    let registeredPath = "";
    const git = scriptedGit((args, cwd) => {
      if (args[0] === "rev-parse") return ok(workspace);
      if (args[0] === "check-ref-format") return ok();
      if (args[0] === "show-ref") return fail();
      if (args[0] === "worktree" && args[1] === "list") {
        const target = registeredPath;
        return ok(
          `worktree ${target}\nHEAD abc\nbranch refs/heads/wt/${path.basename(target)}\n`,
        );
      }
      if (args[0] === "worktree" && args[1] === "remove") return ok();
      if (args[0] === "status") return statusResults.get(cwd ?? "") ?? ok();
      if (args[0] === "worktree" && args[1] === "add") {
        registeredPath = args[4] ?? "";
        return ok();
      }
      return fail(`unexpected: ${args.join(" ")}`);
    });
    const { store, manager, board } = newManager(git);
    const task = await store.create("task");
    await manager.create("task", task.id);
    await board.claim(task.id, "worker");
    await board.complete(task.id, "worker");
    await board.releaseCompletedAssignment("worker");

    const target = path.join(workspace, ".worktrees", "task");
    statusResults.set(target, ok("?? dirty.txt"));
    await expect(manager.remove("task")).resolves.toBe(
      "Error: Worktree 'task' has 1 uncommitted change(s); preserve or discard them manually",
    );
    await expect(manager.remove("task", true)).resolves.toBe(
      "Worktree 'task' removed; branch 'wt/task' retained",
    );
    await expect(store.load(task.id)).resolves.toMatchObject({ worktree: null });
    expect(git.calls.at(-1)?.args).toEqual([
      "worktree",
      "remove",
      "--force",
      target,
    ]);
  });

  it("resolve：注册分支不匹配/未注册时 fail-closed，TaskBoard 不能认领", async () => {
    const store = newStore();
    const task = await store.create("broken");
    await store.save({ ...task, worktree: "broken" });
    const manager = new TaskWorktreeManager({
      workspaceRoot: workspace,
      taskStore: store,
      gitRunner: async (args) => {
        if (args[0] === "worktree" && args[1] === "list") {
          return ok(`worktree ${path.join(workspace, ".worktrees", "other")}\nbranch refs/heads/wt/other\n`);
        }
        return fail("unexpected");
      },
    });
    const board = new TaskBoard({ store, worktrees: manager });
    const cwd = await manager.resolveTaskWorkingDirectory(
      await store.load(task.id),
    );
    expect(cwd.error).toContain("not registered");
    await expect(board.claim(task.id, "worker")).resolves.toBe(
      `Cannot claim ${task.id}: worktree 'broken' is not registered with Git`,
    );
  });
});

describe("TaskBoard 强化", () => {
  it("一个 owner 只有一份活跃 assignment；完成前不能重复认领", async () => {
    const git = scriptedGit(() => ok(""));
    const { store, board } = newManager(git);
    const first = await store.create("first");
    const second = await store.create("second");

    await expect(board.claim(first.id, "worker")).resolves.toBe(
      `Claimed ${first.id} (first)`,
    );
    await expect(board.claim(second.id, "worker")).resolves.toBe(
      `Owner worker must finish the current work turn for ${first.id} before claiming another task`,
    );
    await expect(board.assignmentCwd("worker")).resolves.toBe(workspace);
    await expect(board.complete(first.id, "worker")).resolves.toContain("Completed");
    expect(await board.releaseCompletedAssignment("worker")).toBe(true);
    await expect(board.claim(second.id, "worker")).resolves.toBe(
      `Claimed ${second.id} (second)`,
    );
  });

  it("releaseOwner：异常退出把 in_progress 任务放回任务板并递增版本", async () => {
    const git = scriptedGit(() => ok(""));
    const { store, board } = newManager(git);
    const task = await store.create("recover");
    await board.claim(task.id, "worker");
    expect(board.assignmentVersion("worker")).toBe(1);

    await board.releaseOwnerAndRequeue("worker");
    await expect(store.load(task.id)).resolves.toMatchObject({
      status: "pending",
      owner: null,
    });
    expect(board.assignmentVersion("worker")).toBe(2);
    await expect(board.assignmentCwd("worker")).resolves.toBe(workspace);
  });
});
