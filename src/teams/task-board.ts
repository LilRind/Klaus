/**
 * s13 TaskBoard：在 s10 TaskStore 之上加 teammate 协作约束。
 *
 * - owner 同时最多一份 assignment（含 cwd 租约）；
 * - assignment version 在认领/释放时递增，用于让旧 plan 审批失效；
 * - 坏 worktree fail-closed：不能认领，不静默回退共享目录；
 * - releaseOwner 是异常退出路径：in_progress 放回 pending，便于其他 worker 接手。
 */

import type { TaskRecord, TaskStore } from "../tasks/task-store";
import type { TaskWorktreeManager } from "../tasks/task-worktrees";

export interface TaskAssignment {
  taskId: string;
  cwd: string;
}

export interface TaskBoardOptions {
  store: TaskStore;
  worktrees?: TaskWorktreeManager;
}

export class TaskBoard {
  readonly store: TaskStore;
  readonly worktrees?: TaskWorktreeManager;
  private readonly assignments = new Map<string, TaskAssignment>();
  private readonly versions = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: TaskBoardOptions) {
    this.store = options.store;
    this.worktrees = options.worktrees;
  }

  private serialize<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  assignmentVersion(owner: string): number {
    return this.versions.get(owner) ?? 0;
  }

  getAssignment(owner: string): TaskAssignment | undefined {
    const assignment = this.assignments.get(owner);
    return assignment ? { ...assignment } : undefined;
  }

  private advanceVersion(owner: string): void {
    this.versions.set(owner, this.assignmentVersion(owner) + 1);
  }

  private async ownerInProgress(owner: string): Promise<TaskRecord | null> {
    return (await this.store.list()).find(
      (task) => task.status === "in_progress" && task.owner === owner,
    ) ?? null;
  }

  async claim(taskId: string, owner = "agent"): Promise<string> {
    return this.serialize(async () => {
      const task = await this.store.load(taskId);
      if (task.status !== "pending") {
        return `Task ${taskId} is ${task.status}, cannot claim`;
      }
      if (task.owner) return `Task ${taskId} is already owned by ${task.owner}`;
      const assignment = this.assignments.get(owner);
      if (assignment) {
        return (
          `Owner ${owner} must finish the current work turn for ${assignment.taskId} ` +
          "before claiming another task"
        );
      }
      const current = await this.ownerInProgress(owner);
      if (current) {
        return `Owner ${owner} must complete ${current.id} before claiming another task`;
      }
      if (!(await this.store.canStart(taskId))) {
        const dependencies = await this.store.incompleteDependencies(task);
        return `Blocked by: [${dependencies.map((d) => `'${d}'`).join(", ")}]`;
      }
      let cwd: string;
      if (this.worktrees) {
        const resolved = await this.worktrees.resolveTaskWorkingDirectory(task);
        if (resolved.error) return `Cannot claim ${taskId}: ${resolved.error}`;
        cwd = resolved.cwd;
      } else {
        cwd = process.cwd();
      }
      task.owner = owner;
      task.status = "in_progress";
      await this.store.save(task);
      this.assignments.set(owner, { taskId: task.id, cwd });
      this.advanceVersion(owner);
      return `Claimed ${task.id} (${task.subject})`;
    });
  }

  async complete(
    taskId: string,
    owner = "agent",
    gate?: string,
  ): Promise<string> {
    return this.serialize(async () => {
      const task = await this.store.load(taskId);
      if (task.status !== "in_progress") {
        return `Task ${taskId} is ${task.status}, cannot complete`;
      }
      if (task.owner !== owner) {
        return `Task ${taskId} is owned by ${task.owner}, not ${owner}; cannot complete`;
      }
      if (gate && ["required", "pending", "rejected"].includes(gate)) {
        return `Task ${taskId} cannot complete while plan status is ${gate}`;
      }
      const assignment = this.assignments.get(owner);
      if (!assignment || assignment.taskId !== task.id) {
        let cwd: string;
        if (this.worktrees) {
          const resolved = await this.worktrees.resolveTaskWorkingDirectory(task);
          if (resolved.error) return `Task ${taskId} cannot complete: ${resolved.error}`;
          cwd = resolved.cwd;
        } else {
          cwd = process.cwd();
        }
        this.assignments.set(owner, { taskId: task.id, cwd });
      }
      return this.store.complete(taskId, owner);
    });
  }

  async assignmentCwd(owner: string): Promise<string> {
    const assignment = this.assignments.get(owner);
    if (!assignment) return this.worktrees?.workspaceRoot ?? process.cwd();
    const task = await this.store.load(assignment.taskId);
    if (task.status === "completed" || task.owner !== owner) {
      throw new Error(`Assignment for ${owner} is no longer active`);
    }
    if (this.worktrees) {
      const resolved = await this.worktrees.resolveTaskWorkingDirectory(task);
      if (resolved.error) throw new Error(resolved.error);
      if (resolved.cwd !== assignment.cwd) {
        throw new Error(`Assignment cwd changed for task ${task.id}`);
      }
      return resolved.cwd;
    }
    return assignment.cwd;
  }

  currentWorkIdentity(owner: string): { version: number; taskId: string | null } {
    return {
      version: this.assignmentVersion(owner),
      taskId: this.assignments.get(owner)?.taskId ?? null,
    };
  }

  async releaseCompletedAssignment(owner: string): Promise<boolean> {
    const assignment = this.assignments.get(owner);
    if (!assignment) return false;
    const task = await this.store.load(assignment.taskId);
    if (task.status !== "completed" || task.owner !== owner) return false;
    this.assignments.delete(owner);
    this.advanceVersion(owner);
    return true;
  }

  releaseOwner(owner: string): void {
    this.assignments.delete(owner);
    this.advanceVersion(owner);
  }

  async releaseOwnerAndRequeue(owner: string): Promise<void> {
    await this.serialize(async () => {
      const task = await this.ownerInProgress(owner);
      if (task) {
        task.status = "pending";
        task.owner = null;
        await this.store.save(task);
      }
      this.releaseOwner(owner);
    });
  }

  async scanUnclaimed(): Promise<TaskRecord[]> {
    const ready: TaskRecord[] = [];
    for (const task of await this.store.list()) {
      if (task.status !== "pending" || task.owner !== null) continue;
      if (!(await this.store.canStart(task.id))) continue;
      if (this.worktrees) {
        const resolved = await this.worktrees.resolveTaskWorkingDirectory(task);
        if (resolved.error) continue;
      }
      ready.push(task);
    }
    return ready;
  }

  async claimNext(owner: string): Promise<TaskRecord | null> {
    if (this.assignments.has(owner) || (await this.ownerInProgress(owner))) return null;
    for (const task of await this.scanUnclaimed()) {
      const result = await this.claim(task.id, owner);
      if (result.startsWith("Claimed ")) return this.store.load(task.id);
    }
    return null;
  }
}
