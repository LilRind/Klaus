/**
 * s16 Workflow 注册表（对齐 lcc WORKFLOWS dict + validate_meta + check_permission）
 *
 * 宿主持有的可信脚本仓：模型只提交 name/args，代码永远从这里解析
 * （模型无法提交可执行代码）。meta 在注册时即校验（坏编排不要等到
 * 执行时才发现，与 s12 校验 cron 表达式同一思路），launch 前运行时
 * 再校验一次。deny 名单是宿主层第二道闸门（模型提供的 name 是不可信
 * 输入），叠加在 ToolRegistry 权限闸门之上。
 */

import {
  WORKFLOW_NAME_RE,
  WorkflowInputError,
} from "./workflow-journal";
import type { ExecutionState } from "./workflow-runtime";

export interface WorkflowMeta {
  name: string;
  description: string;
  phases?: string[];
}

export type WorkflowScript = (
  ctx: ExecutionState,
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface RegisteredWorkflow {
  meta: WorkflowMeta;
  script: WorkflowScript;
}

export interface WorkflowRegistryOptions {
  /** 拒绝名单（lcc settings deny）：命中即拒绝启动 */
  deny?: readonly string[];
}

export class WorkflowRegistry {
  private readonly workflows = new Map<string, RegisteredWorkflow>();
  private readonly deny: readonly string[];

  constructor(options: WorkflowRegistryOptions = {}) {
    this.deny = options.deny ?? [];
  }

  /** meta 校验（对齐 lcc validate_meta，错误文案逐字对齐） */
  static validateMeta(meta: unknown): WorkflowMeta {
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
      throw new WorkflowInputError("meta must be an object literal");
    }
    const record = meta as Record<string, unknown>;
    if (!record.name || !record.description) {
      throw new WorkflowInputError("meta requires `name` and `description`");
    }
    if (
      typeof record.name !== "string" ||
      !WORKFLOW_NAME_RE.test(record.name)
    ) {
      throw new WorkflowInputError(
        "meta.name must be a 1-64 character slug using letters, numbers, '.', '_', or '-'",
      );
    }
    if (typeof record.description !== "string") {
      throw new WorkflowInputError("meta.description must be a string");
    }
    if (record.phases !== undefined) {
      if (
        !Array.isArray(record.phases) ||
        !record.phases.every(
          (phase) => typeof phase === "string" && phase.length > 0,
        )
      ) {
        throw new WorkflowInputError(
          "meta.phases must be a list of non-empty strings",
        );
      }
    }
    return {
      name: record.name,
      description: record.description,
      ...(record.phases !== undefined
        ? { phases: record.phases as string[] }
        : {}),
    };
  }

  /** 注册可信 workflow（meta 先校验，坏编排注册即报错） */
  register(meta: unknown, script: WorkflowScript): this {
    const validated = WorkflowRegistry.validateMeta(meta);
    this.workflows.set(validated.name, { meta: validated, script });
    return this;
  }

  get(name: string): RegisteredWorkflow | undefined {
    return this.workflows.get(name);
  }

  has(name: string): boolean {
    return this.workflows.has(name);
  }

  names(): string[] {
    return [...this.workflows.keys()];
  }

  /** 宿主 deny 名单检查（对齐 lcc check_permission） */
  checkPermission(name: string): void {
    if (this.deny.includes(name)) {
      throw new WorkflowInputError(`workflow '${name}' denied by settings`);
    }
  }
}
