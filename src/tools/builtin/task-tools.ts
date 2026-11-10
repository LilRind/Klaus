/**
 * 任务系统六工具（对齐 learn-claude-code s10）
 *
 * 两阶段建图契约（写进各工具描述，让模型遵循）：
 * 1) create_task 只建节点，返回运行时生成的 ID；
 * 2) 拿到 ID 后用 update_task 补 blockedBy 依赖边。
 * 全部结构化契约（executeArgs + parametersSchema），对齐线
 * assertAllStructured 必过；校验失败转 ❌ observation 回喂，循环不炸。
 */

import { Tool, tryParseJsonObject } from "../tool";
import { TaskStore, type TaskRecord } from "../../tasks/task-store";

/** list_tasks 的三态标记（对齐 lcc run_list_tasks） */
const STATUS_MARKERS: Record<TaskRecord["status"], string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
};

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** 校验错误 → ❌ observation（对齐 todo_write 工具的错误契约） */
function errorMessage(error: unknown): string {
  return `❌ ${error instanceof Error ? error.message : String(error)}`;
}

export class CreateTaskTool extends Tool {
  override get name(): string {
    return "create_task";
  }

  override get description(): string {
    return "Create a task and return its runtime-generated ID";
  }

  override get parametersDescription(): string {
    return 'JSON: {"subject": "任务主题", "description": "可选说明"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        subject: { type: "string", description: "任务主题（非空）" },
        description: { type: "string", description: "任务说明（可选）" },
      },
      required: ["subject"],
      additionalProperties: false,
    };
  }

  constructor(private readonly store: TaskStore) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? { subject: input.trim() });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const subject = asString(args.subject);
    if (!subject?.trim()) {
      return "❌ 缺少必填参数 subject（非空字符串）";
    }
    try {
      const task = await this.store.create(
        subject,
        asString(args.description) ?? "",
      );
      return `Created ${task.id}: ${task.subject}`;
    } catch (error) {
      return errorMessage(error);
    }
  }
}

export class UpdateTaskTool extends Tool {
  override get name(): string {
    return "update_task";
  }

  override get description(): string {
    return "Add dependencies using IDs returned by create_task";
  }

  override get parametersDescription(): string {
    return 'JSON: {"task_id": "task_xxxx", "addBlockedBy": ["task_yyyy"]}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        task_id: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
        addBlockedBy: {
          type: "array",
          items: { type: "string", pattern: "^task_[0-9a-f]{8}$" },
          minItems: 1,
        },
      },
      required: ["task_id", "addBlockedBy"],
      additionalProperties: false,
    };
  }

  constructor(private readonly store: TaskStore) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? { task_id: input.trim(), addBlockedBy: [] });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const taskId = asString(args.task_id);
    if (!taskId) return "❌ 缺少必填参数 task_id";
    const addBlockedBy = args.addBlockedBy;
    if (
      !Array.isArray(addBlockedBy) ||
      addBlockedBy.length === 0 ||
      !addBlockedBy.every((id): id is string => typeof id === "string")
    ) {
      return "❌ addBlockedBy 必须是非空字符串数组（至少一个任务 ID）";
    }
    try {
      const task = await this.store.updateDependencies(taskId, addBlockedBy);
      const deps = task.blockedBy.join(", ") || "(none)";
      return `Updated ${task.id} blockedBy: ${deps}`;
    } catch (error) {
      return errorMessage(error);
    }
  }
}

export class ListTasksTool extends Tool {
  override get name(): string {
    return "list_tasks";
  }

  override get description(): string {
    return "List tasks with status, owner, and dependencies";
  }

  override get parametersDescription(): string {
    return "JSON: {}（无参数）";
  }

  override get parametersSchema(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  constructor(private readonly store: TaskStore) {
    super();
  }

  override async execute(input: string): Promise<string> {
    return this.executeArgs(tryParseJsonObject(input.trim()) ?? {});
  }

  override async executeArgs(_args: Record<string, unknown>): Promise<string> {
    const tasks = await this.store.list().catch(errorMessage);
    if (typeof tasks === "string") return tasks;
    if (tasks.length === 0) {
      return "No tasks. Use create_task to add some.";
    }
    return tasks
      .map((task) => {
        const deps = task.blockedBy.length
          ? ` (blockedBy: ${task.blockedBy.join(", ")})`
          : "";
        const owner = task.owner ? ` [${task.owner}]` : "";
        return `${STATUS_MARKERS[task.status]} ${task.id}: ${task.subject} [${task.status}]${owner}${deps}`;
      })
      .join("\n");
  }
}

export class GetTaskTool extends Tool {
  override get name(): string {
    return "get_task";
  }

  override get description(): string {
    return "Get the full task record (description and dependencies) by ID";
  }

  override get parametersDescription(): string {
    return 'JSON: {"task_id": "task_xxxx"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    };
  }

  constructor(private readonly store: TaskStore) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? { task_id: input.trim() });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const taskId = asString(args.task_id);
    if (!taskId) return "❌ 缺少必填参数 task_id";
    try {
      return JSON.stringify(await this.store.load(taskId), null, 2);
    } catch (error) {
      return errorMessage(error);
    }
  }
}

export class ClaimTaskTool extends Tool {
  override get name(): string {
    return "claim_task";
  }

  override get description(): string {
    return "Claim a pending task whose dependencies are all completed";
  }

  override get parametersDescription(): string {
    return 'JSON: {"task_id": "task_xxxx"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    };
  }

  constructor(
    private readonly store: TaskStore,
    private readonly owner = "agent",
  ) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? { task_id: input.trim() });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const taskId = asString(args.task_id);
    if (!taskId) return "❌ 缺少必填参数 task_id";
    try {
      return await this.store.claim(taskId, this.owner);
    } catch (error) {
      return errorMessage(error);
    }
  }
}

export class CompleteTaskTool extends Tool {
  override get name(): string {
    return "complete_task";
  }

  override get description(): string {
    return "Complete a task claimed by this agent (owner must match)";
  }

  override get parametersDescription(): string {
    return 'JSON: {"task_id": "task_xxxx"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    };
  }

  constructor(
    private readonly store: TaskStore,
    private readonly owner = "agent",
  ) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? { task_id: input.trim() });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const taskId = asString(args.task_id);
    if (!taskId) return "❌ 缺少必填参数 task_id";
    try {
      return await this.store.complete(taskId, this.owner);
    } catch (error) {
      return errorMessage(error);
    }
  }
}

/** 对齐装配便利工厂：一次注册六个任务工具（共享同一 store） */
export function createTaskTools(
  store: TaskStore,
  owner = "agent",
): Tool[] {
  return [
    new CreateTaskTool(store),
    new UpdateTaskTool(store),
    new ListTasksTool(store),
    new GetTaskTool(store),
    new ClaimTaskTool(store, owner),
    new CompleteTaskTool(store, owner),
  ];
}
