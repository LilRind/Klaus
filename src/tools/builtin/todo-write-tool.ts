/**
 * todo_write 工具（对齐 learn-claude-code s05）
 *
 * 只更新计划状态，不执行任何实际工作。全结构化契约（executeArgs +
 * parametersSchema），对齐线装配 assertAllStructured 必过。
 */

import { Tool } from "../tool";
import { TodoManager, type TodoItem } from "../../todo/todo-manager";

export class TodoWriteTool extends Tool {
  override get name(): string {
    return "todo_write";
  }

  override get description(): string {
    return "Create and manage a task list to plan work before executing it";
  }

  override get parametersDescription(): string {
    return 'JSON: {"todos": [{"content": "步骤", "status": "pending|in_progress|completed"}]}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description: "完整的任务列表（整表替换）",
          items: {
            type: "object",
            properties: {
              content: { type: "string", description: "任务内容（非空）" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    };
  }

  /** 共享的待办状态（装配处传入同一实例，Agent 与控制台看到同一份计划） */
  constructor(readonly manager: TodoManager = new TodoManager()) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const trimmed = input.trim();
    try {
      return this.executeArgs({ todos: trimmed });
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const todos = args.todos;
    if (todos === undefined) {
      return "❌ 缺少 todos 字段";
    }
    try {
      const output = this.manager.update(todos as TodoItem[] | string);
      console.log(output);
      return output;
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
