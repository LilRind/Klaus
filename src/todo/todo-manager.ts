/**
 * TodoManager（对齐 learn-claude-code s05 的 TodoManager）
 *
 * 持有内存中的任务列表，负责解析与校验更新，并渲染给模型看。
 * 关键洞察：todo_write 不给 Agent 增加任何执行能力，增加的是规划能力——
 * 状态本身活在 Harness 内存里，实际工作仍由其他工具完成。
 *
 * 校验规则（对齐 s05）：
 * - 一次更新最多 20 项；
 * - 每项必须有非空 content；status ∈ pending / in_progress / completed；
 * - 同一时间只能有一个 in_progress（多任务并行是反模式）；
 * - 字符串输入必须是 JSON 数组（TS 天然无 eval，不解析 Python 字面量）。
 */

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export const TODO_MAX_ITEMS = 20;

/** 连续多少个工具轮未使用 todo_write 后注入 reminder（对齐 s05） */
export const TODO_REMINDER_ROUNDS = 3;

const TODO_STATUSES: readonly TodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
];

export class TodoManager {
  /** 当前任务列表（会话级内存态，不落盘） */
  items: TodoItem[] = [];

  /**
   * 整表替换（对齐 s05 update：一次更新就是一份新计划）。
   * @param todos TodoItem 数组或 JSON 数组字符串
   * @returns 渲染后的清单（回喂给模型）
   */
  update(todos: TodoItem[] | string): string {
    this.items = this.validate(todos);
    return this.render();
  }

  /** 渲染：[ ] 待办 / [>] 进行中 / [x] 已完成（对齐 s05 render 符号） */
  render(): string {
    if (this.items.length === 0) return "(empty todo list)";
    return this.items
      .map((item) => {
        const mark =
          item.status === "completed"
            ? "[x]"
            : item.status === "in_progress"
              ? "[>]"
              : "[ ]";
        return `${mark} ${item.content}`;
      })
      .join("\n");
  }

  /** 解析 + 校验（抛错由调用方转为错误 observation） */
  private validate(todos: TodoItem[] | string): TodoItem[] {
    const list = parseTodos(todos);
    if (list.length > TODO_MAX_ITEMS) {
      throw new Error(`一次更新最多 ${TODO_MAX_ITEMS} 项，收到 ${list.length} 项`);
    }
    const validated: TodoItem[] = [];
    let inProgressCount = 0;
    for (const [index, raw] of list.entries()) {
      if (!raw || typeof raw !== "object") {
        throw new Error(`第 ${index + 1} 项不是对象: ${JSON.stringify(raw)}`);
      }
      const record = raw as Record<string, unknown>;
      const content = record.content;
      if (typeof content !== "string" || content.trim().length === 0) {
        throw new Error(`第 ${index + 1} 项缺少非空 content`);
      }
      const status = record.status;
      if (typeof status !== "string" || !TODO_STATUSES.includes(status as TodoStatus)) {
        throw new Error(
          `第 ${index + 1} 项 status 非法: ${JSON.stringify(status)}，合法值: ${TODO_STATUSES.join(" | ")}`,
        );
      }
      if (status === "in_progress") {
        inProgressCount += 1;
        if (inProgressCount > 1) {
          throw new Error("同一时间只能有一个 in_progress 任务");
        }
      }
      validated.push({ content: content.trim(), status: status as TodoStatus });
    }
    return validated;
  }
}

/** 输入归一化：数组直通；字符串必须是 JSON 数组 */
function parseTodos(todos: TodoItem[] | string): unknown[] {
  if (typeof todos !== "string") return todos;
  const trimmed = todos.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("不是数组");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `todos 字符串必须是 JSON 数组，例如 [{"content":"a","status":"pending"}]（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
}
