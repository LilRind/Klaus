/**
 * s16 Workflow 工具（模型面适配，对齐 lcc WORKFLOW_TOOL + run_workflow_sync）
 *
 * schema 只暴露 name/args/resume_from_run_id 且 additionalProperties:false
 * ——模型无法提交可执行代码或元数据，代码只从宿主 WorkflowRegistry
 * 解析。WorkflowInputError 转 "Error: " 文案留在工具边界回喂（不让
 * 宿主循环退出），其余异常交注册表统一包装。
 */

import { Tool, tryParseJsonObject } from "../tool";
import { WorkflowInputError } from "../../workflow/workflow-journal";
import type { WorkflowRuntime } from "../../workflow/workflow-runtime";

export class WorkflowTool extends Tool {
  constructor(private readonly runtime: WorkflowRuntime) {
    super();
  }

  override get name(): string {
    return "Workflow";
  }

  override get description(): string {
    return "Run a saved workflow by name. Pass input in args.";
  }

  override get parametersDescription(): string {
    return 'JSON: {"name": "已保存 workflow 名称", "args": "可选输入对象", "resume_from_run_id": "可选续跑 runId"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", description: "已保存 workflow 的名称" },
        args: { type: "object", description: "workflow 输入（可选）" },
        resume_from_run_id: {
          type: "string",
          description: "从该 runId 续跑，未改过的 agent() 使用 journal 缓存（可选）",
        },
      },
      required: ["name"],
      additionalProperties: false,
    };
  }

  override async execute(input: string): Promise<string> {
    const parsed = tryParseJsonObject(input.trim());
    return this.executeArgs(parsed ?? { name: input.trim() });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    try {
      const out = await this.runtime.run(
        args.name,
        args.args,
        args.resume_from_run_id,
      );
      return JSON.stringify(out);
    } catch (error) {
      if (error instanceof WorkflowInputError) {
        return `Error: ${error.message}`;
      }
      throw error;
    }
  }
}
