/**
 * s13：任务绑定的 Git worktree。
 *
 * 关键安全语义：
 * - name 只是目录段，先正则校验再 resolve，必须落在 workspace/.worktrees 内；
 * - 所有 Git 子进程走 execFile 数组参数，不做 shell 插值；
 * - Git 操作成功后再写任务 JSON；绑定失败时保留 Git 产物并明确 Partial success，
 *   不自动删除任何用户工作；
 * - remove 永远保留分支；脏工作区默认拒绝，显式 discard_changes 才 force。
 */

import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import type { TaskRecord, TaskStore } from "./task-store";

const execFileAsync = promisify(execFile);

export const VALID_WORKTREE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface GitResult {
  ok: boolean;
  output: string;
}

export type GitRunner = (
  args: string[],
  cwd?: string,
) => Promise<GitResult> | GitResult;

export interface TaskWorktreeManagerOptions {
  workspaceRoot: string;
  taskStore: TaskStore;
  directory?: string;
  /** 测试注入；生产走 git execFile */
  gitRunner?: GitRunner;
  timeoutMs?: number;
}

export function validateWorktreeName(name: string): string | null {
  if (typeof name !== "string" || !VALID_WORKTREE_NAME.test(name)) {
    return (
      "worktree name must be 1-64 letters, digits, dots, underscores, " +
      "or dashes, and start with a letter or digit"
    );
  }
  if (name === "." || name === ".." || name.includes("..")) {
    return "worktree name cannot contain '..'";
  }
  return null;
}

interface WorktreeEntry {
  rawPath: string;
  branch?: string;
}

export class TaskWorktreeManager {
  readonly workspaceRoot: string;
  readonly directory: string;
  private readonly taskStore: TaskStore;
  private readonly gitRunner: GitRunner;
  private readonly timeoutMs: number;

  constructor(options: TaskWorktreeManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.directory = path.resolve(options.directory ?? path.join(this.workspaceRoot, ".worktrees"));
    if (!isWithin(this.workspaceRoot, this.directory)) {
      throw new Error("Worktree directory escapes the workspace");
    }
    this.taskStore = options.taskStore;
    this.gitRunner = options.gitRunner ?? defaultGitRunner(options.timeoutMs ?? 30_000);
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private worktreePath(name: string): string {
    const target = path.resolve(this.directory, name);
    if (target === this.directory || !isWithin(this.directory, target)) {
      throw new Error(`Worktree path escapes directory: ${JSON.stringify(name)}`);
    }
    return target;
  }

  private branch(name: string): string {
    return `wt/${name}`;
  }

  private async git(args: string[], cwd?: string): Promise<GitResult> {
    const result = await this.gitRunner(args, cwd);
    return {
      ok: result.ok,
      output: result.output.length > 5000 ? result.output.slice(0, 5000) : result.output,
    };
  }

  private async registry(): Promise<Map<string, WorktreeEntry>> {
    const result = await this.git(["worktree", "list", "--porcelain"]);
    if (!result.ok) {
      throw new Error(`cannot read Git worktree registry: ${result.output}`);
    }
    const entries = new Map<string, WorktreeEntry>();
    let current: WorktreeEntry | undefined;
    for (const line of [...result.output.split(/\r?\n/), ""]) {
      if (!line) {
        if (current?.rawPath) entries.set(path.resolve(current.rawPath), current);
        current = undefined;
        continue;
      }
      const separator = line.indexOf(" ");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);
      if (key === "worktree") current = { rawPath: value };
      else if (current) current = { ...current, [key]: value };
    }
    return entries;
  }

  private async registeredWorktree(
    name: string,
  ): Promise<{ path: string | null; error: string | null }> {
    let target: string;
    try {
      target = this.worktreePath(name);
    } catch (error) {
      return { path: null, error: errorMessage(error) };
    }
    let entries: Map<string, WorktreeEntry>;
    try {
      entries = await this.registry();
    } catch (error) {
      return { path: null, error: errorMessage(error) };
    }
    const entry = entries.get(target);
    if (!entry) {
      return { path: null, error: `worktree '${name}' is not registered with Git` };
    }
    const expectedBranch = `refs/heads/${this.branch(name)}`;
    if (entry.branch !== expectedBranch) {
      return {
        path: null,
        error: `worktree '${name}' is not registered on expected branch '${expectedBranch}'`,
      };
    }
    return { path: target, error: null };
  }

  async resolveTaskWorkingDirectory(
    task: TaskRecord,
  ): Promise<{ cwd: string; error?: undefined } | { cwd: string; error: string }> {
    if (!task.worktree) return { cwd: this.workspaceRoot };
    const worktreeName = task.worktree;
    const registered = await this.registeredWorktree(worktreeName);
    if (registered.error) return { cwd: this.workspaceRoot, error: registered.error };
    if (!registered.path) throw new Error(`worktree '${worktreeName}' resolved without a path`);
    return { cwd: registered.path, error: undefined };
  }

  async create(name: string, taskId: string): Promise<string> {
    const invalid = validateWorktreeName(name);
    if (invalid) return `Error: ${invalid}`;
    let target: string;
    try {
      target = this.worktreePath(name);
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
    const branch = this.branch(name);

    let task: TaskRecord;
    try {
      if (!(await this.taskStore.exists(taskId))) {
        return `Error: Task ${taskId} not found`;
      }
      task = await this.taskStore.load(taskId);
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
    if (task.status !== "pending" || task.owner !== null) {
      return `Error: Task ${taskId} must be pending and unowned`;
    }
    if (task.worktree) {
      return `Error: Task ${taskId} already uses worktree '${task.worktree}'`;
    }
    const tasks = await this.taskStore.list();
    if (tasks.some((candidate) => candidate.id !== taskId && candidate.worktree === name)) {
      return `Error: Worktree '${name}' is already bound to another task`;
    }

    const root = await this.git(["rev-parse", "--show-toplevel"]);
    if (!root.ok || path.resolve(root.output) !== this.workspaceRoot) {
      return "Error: Working directory must be the root of a Git repository";
    }
    const branchCheck = await this.git(["check-ref-format", "--branch", branch]);
    if (!branchCheck.ok) {
      return `Error: Invalid worktree branch '${branch}': ${branchCheck.output || "(no output)"}`;
    }
    const exists = await this.git([
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    if (exists.ok) return `Error: Branch '${branch}' already exists`;

    let entries: Map<string, WorktreeEntry>;
    try {
      entries = await this.registry();
    } catch (error) {
      return `Error: ${errorMessage(error)}`;
    }
    if (entries.has(target)) {
      return `Error: Worktree path is already registered: ${target}`;
    }
    try {
      await stat(target);
      return `Error: Worktree path already exists: ${target}`;
    } catch {
      // 目标路径不存在才继续创建
    }

    const added = await this.git(["worktree", "add", "-b", branch, target, "HEAD"]);
    if (!added.ok) {
      const [afterEntries, afterBranch] = await Promise.all([
        this.registry().catch(() => undefined),
        this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]),
      ]);
      const artifacts: string[] = [];
      try {
        await stat(target);
        artifacts.push(`checkout path '${target}'`);
      } catch {
        // 没有残留 checkout
      }
      if (afterEntries?.has(target)) artifacts.push("registered Git worktree");
      if (afterBranch.ok) artifacts.push(`branch '${branch}'`);
      if (artifacts.length > 0) {
        return (
          `Partial operation: git worktree add reported an error after leaving ` +
          `${artifacts.join(", ")}. Task ${taskId} remains unbound and no Git data ` +
          `was deleted. Run \`git worktree list\`, inspect '${target}' and '${branch}', ` +
          `then keep or remove those artifacts manually after preserving any work. ` +
          `Git error: ${added.output || "(no output)"}`
        );
      }
      return `Git error: ${added.output || "(no output)"}`;
    }

    try {
      task.worktree = name;
      await this.taskStore.save(task);
    } catch (error) {
      return (
        `Partial success: Worktree '${name}' was created at ${target} on branch ` +
        `'${branch}', but task binding failed: ${errorMessage(error)}. ` +
        "Git data was retained for manual recovery."
      );
    }
    return `Worktree '${name}' created at ${target} for task ${taskId}`;
  }

  async remove(name: string, discardChanges = false): Promise<string> {
    const invalid = validateWorktreeName(name);
    if (invalid) return `Error: ${invalid}`;
    const registered = await this.registeredWorktree(name);
    if (registered.error) return `Error: ${registered.error}`;
    if (!registered.path) return `Error: worktree '${name}' resolved without a path`;
    const target: string = registered.path;
    const bound = (await this.taskStore.list()).filter(
      (task) => (task.worktree ?? undefined) === name,
    );
    if (bound.length === 0) return `Error: Worktree '${name}' is not bound to a task`;
    const active = bound.filter((task) => task.status !== "completed");
    if (active.length > 0) {
      return `Error: Worktree '${name}' is bound to active task ${active[0]!.id}; complete it before removal`;
    }

    const status = await this.git(["status", "--porcelain", "--ignored"], target);
    if (!status.ok) {
      return `Error: Cannot verify worktree '${name}' status: ${status.output || "(no output)"}`;
    }
    const changed = status.output.split(/\r?\n/).filter((line) => line.trim()).length;
    if (changed > 0 && !discardChanges) {
      return `Error: Worktree '${name}' has ${changed} uncommitted change(s); preserve or discard them manually`;
    }

    const args: string[] = [
      "worktree",
      "remove",
      ...(discardChanges ? ["--force"] : []),
      target,
    ];
    const removed = await this.git(args);
    if (!removed.ok) return `Git error: ${removed.output || "(no output)"}`;
    try {
      for (const task of bound) {
        task.worktree = null;
        await this.taskStore.save(task);
      }
    } catch (error) {
      return (
        `Partial success: Worktree '${name}' was removed and branch ` +
        `'${this.branch(name)}' retained, but task unbinding failed: ` +
        `${errorMessage(error)}. Manual recovery is required.`
      );
    }
    return `Worktree '${name}' removed; branch '${this.branch(name)}' retained`;
  }
}

function defaultGitRunner(timeoutMs: number): GitRunner {
  return async (args, cwd) => {
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      });
      const output = `${stdout}${stderr}`.trim();
      return { ok: true, output: output || "(no output)" };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        killed?: boolean;
      };
      const output = [err.stdout, err.stderr].filter(Boolean).join("").trim();
      return {
        ok: false,
        output:
          output ||
          (err.killed ? `Timeout (${Math.round(timeoutMs / 1000)}s)` : err.message),
      };
    }
  };
}

function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
