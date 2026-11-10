/**
 * 持久化任务系统（对齐 learn-claude-code s10）
 *
 * 与 s05 TodoWrite 的分工（lcc 对照表）：
 * - todo_write：当前会话的执行清单，进程内状态，无依赖、无分工；
 * - task system：`.tasks/{id}.json` 跨会话任务图——blockedBy 依赖、owner 认领、
 *   两阶段建图（先 create 全部节点拿到运行时 ID，再 update_task 补边）。
 *
 * 状态机：pending --claim--> in_progress --complete--> completed。
 * 一条回复里的多个 create_task 在任何结果产生前就已确定，
 * 所以 create 永远拿不到同级调用的 ID——依赖边必须等 ID 返回后第二阶段补。
 */

import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** lcc TASK_ID_PATTERN：task_ + 8 位小写 hex */
export const TASK_ID_PATTERN = /^task_[0-9a-f]{8}$/;

export type TaskStatus = "pending" | "in_progress" | "completed";

const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

/** 任务记录（lcc Task dataclass 的 TS 翻译，JSON 落盘形状一致） */
export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner: string | null;
  blockedBy: string[];
  /** s13：可选任务绑定 worktree 名；null 表示使用共享 workspace */
  worktree: string | null;
}

export interface TaskStoreOptions {
  /** 任务目录（通常 workspace/.tasks） */
  directory: string;
  /** 工作区根：store 目录越界即拒（对齐 lcc _root 的 workspace 围栏） */
  workspaceRoot: string;
}

/** ID 生成冲突重试上限（对齐 lcc 100 次） */
const MAX_ID_ATTEMPTS = 100;

/** child 是否位于 parent 内（含相等；防 ../ 穿越与绝对路径逃逸） */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export class TaskStore {
  private readonly directory: string;
  private readonly workspaceRoot: string;

  constructor(options: TaskStoreOptions) {
    this.directory = path.resolve(options.directory);
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    if (!isWithin(this.workspaceRoot, this.directory)) {
      throw new Error("Task store escapes the workspace");
    }
  }

  /** 任务目录（create=true 时自动创建） */
  private async root(create = false): Promise<string> {
    if (create) {
      await mkdir(this.directory, { recursive: true });
    }
    return this.directory;
  }

  /** 校验 ID 并解析出安全路径（对齐 lcc _path 的双重检查） */
  private async taskPath(taskId: string, createRoot = false): Promise<string> {
    if (typeof taskId !== "string" || !TASK_ID_PATTERN.test(taskId)) {
      throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
    }
    const root = await this.root(createRoot);
    const target = path.resolve(root, `${taskId}.json`);
    if (!isWithin(root, target)) {
      throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
    }
    return target;
  }

  async exists(taskId: string): Promise<boolean> {
    try {
      await stat(await this.taskPath(taskId));
      return true;
    } catch {
      return false;
    }
  }

  /** 创建任务：随机 ID + 排他写入（wx），冲突重试（对齐 lcc create） */
  async create(subject: string, description = ""): Promise<TaskRecord> {
    const trimmed = subject.trim();
    if (!trimmed) {
      throw new Error("Task subject cannot be empty");
    }
    const root = await this.root(true);
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
      const task: TaskRecord = {
        id: `task_${randomBytes(4).toString("hex")}`,
        subject: trimmed,
        description,
        status: "pending",
        owner: null,
        blockedBy: [],
        worktree: null,
      };
      const file = path.join(root, `${task.id}.json`);
      let handle;
      try {
        handle = await open(file, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      try {
        await handle.writeFile(JSON.stringify(task, null, 2), "utf8");
      } finally {
        await handle.close();
      }
      return task;
    }
    throw new Error("Could not allocate a unique task ID");
  }

  /**
   * 添加依赖边（对齐 lcc update_dependencies）：
   * 目标必须 pending 且未认领；依赖去重保序；
   * 校验非自依赖 / 依赖存在 /（仅新增边时）DFS 查环；
   * 重复添加已有边幂等跳过。
   */
  async updateDependencies(
    taskId: string,
    addBlockedBy: string[],
  ): Promise<TaskRecord> {
    if (!Array.isArray(addBlockedBy)) {
      throw new Error("addBlockedBy must be an array of task IDs");
    }
    const task = await this.load(taskId);
    if (task.status !== "pending" || task.owner !== null) {
      throw new Error(
        `Task ${taskId} dependencies can only be updated while pending and unowned`,
      );
    }

    const dependencies = [...new Set(addBlockedBy)];
    for (const dependency of dependencies) {
      if (dependency === taskId) {
        throw new Error("Task cannot depend on itself");
      }
      if (!(await this.exists(dependency))) {
        throw new Error(`Dependency not found: ${dependency}`);
      }
      if (
        !task.blockedBy.includes(dependency) &&
        (await this.dependsOn(dependency, taskId))
      ) {
        throw new Error(`Dependency cycle detected: ${taskId} -> ${dependency}`);
      }
    }

    task.blockedBy.push(
      ...dependencies.filter((d) => !task.blockedBy.includes(d)),
    );
    await this.save(task);
    return task;
  }

  async save(task: TaskRecord): Promise<void> {
    const file = await this.taskPath(task.id, true);
    await writeFile(file, JSON.stringify(task, null, 2), "utf8");
  }

  /** 读取并校验（ID 匹配 + status 合法，对齐 lcc load） */
  async load(taskId: string): Promise<TaskRecord> {
    const file = await this.taskPath(taskId);
    const data = JSON.parse(await readFile(file, "utf8")) as TaskRecord;
    if (data.id !== taskId) {
      throw new Error(`Task file ID does not match ${taskId}`);
    }
    if (!TASK_STATUSES.includes(data.status)) {
      throw new Error(`Invalid task status: ${String(data.status)}`);
    }
    return {
      ...data,
      blockedBy: Array.isArray(data.blockedBy) ? data.blockedBy : [],
      worktree: data.worktree ?? null,
    };
  }

  /** 按 ID 排序列出全部任务（对齐 lcc sorted glob） */
  async list(): Promise<TaskRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(await this.root());
    } catch {
      return [];
    }
    const ids = entries
      .filter((name) => /^task_[0-9a-f]{8}\.json$/.test(name))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
    const tasks: TaskRecord[] = [];
    for (const id of ids) {
      tasks.push(await this.load(id));
    }
    return tasks;
  }

  /** taskId 是否（传递地）依赖 targetId（对齐 lcc _depends_on 的 DFS） */
  private async dependsOn(taskId: string, targetId: string): Promise<boolean> {
    const pending = [taskId];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (current === targetId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(await this.load(current)).blockedBy);
    }
    return false;
  }

  /** 未完成依赖：非 completed 或文件缺失/读取失败均计入（对齐 lcc） */
  async incompleteDependencies(task: TaskRecord): Promise<string[]> {
    const incomplete: string[] = [];
    for (const dependency of task.blockedBy) {
      try {
        if ((await this.load(dependency)).status !== "completed") {
          incomplete.push(dependency);
        }
      } catch {
        incomplete.push(dependency);
      }
    }
    return incomplete;
  }

  async canStart(taskId: string): Promise<boolean> {
    return (await this.incompleteDependencies(await this.load(taskId))).length === 0;
  }

  /** 认领：仅 pending + 依赖全 completed（对齐 lcc claim_task 文案） */
  async claim(taskId: string, owner = "agent"): Promise<string> {
    const task = await this.load(taskId);
    if (task.status !== "pending") {
      return `Task ${taskId} is ${task.status}, cannot claim`;
    }
    const dependencies = await this.incompleteDependencies(task);
    if (dependencies.length > 0) {
      return `Blocked by: [${dependencies.map((d) => `'${d}'`).join(", ")}]`;
    }
    task.owner = owner;
    task.status = "in_progress";
    await this.save(task);
    return `Claimed ${task.id} (${task.subject})`;
  }

  /**
   * 完成：仅 in_progress + owner 匹配；完成前快照 ready 集合，
   * 写盘后计算"刚解锁"的下游（对齐 lcc complete_task）。
   */
  async complete(taskId: string, owner = "agent"): Promise<string> {
    const task = await this.load(taskId);
    if (task.status !== "in_progress") {
      return `Task ${taskId} is ${task.status}, cannot complete`;
    }
    if (task.owner !== owner) {
      return `Task ${taskId} is owned by ${task.owner}, not ${owner}`;
    }
    const beforeTasks = await this.list();
    const readyBefore = new Set<string>();
    for (const candidate of beforeTasks) {
      if (
        candidate.status === "pending" &&
        candidate.blockedBy.length > 0 &&
        (await this.canStart(candidate.id))
      ) {
        readyBefore.add(candidate.id);
      }
    }
    task.status = "completed";
    await this.save(task);
    const unblocked: string[] = [];
    for (const candidate of await this.list()) {
      if (
        candidate.status === "pending" &&
        candidate.blockedBy.length > 0 &&
        !readyBefore.has(candidate.id) &&
        (await this.canStart(candidate.id))
      ) {
        unblocked.push(candidate.subject);
      }
    }

    let message = `Completed ${task.id} (${task.subject})`;
    if (unblocked.length > 0) {
      message += `\nUnblocked: ${unblocked.join(", ")}`;
    }
    return message;
  }
}
