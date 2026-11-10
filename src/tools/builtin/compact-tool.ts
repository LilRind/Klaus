/**
 * compact 工具（对齐 learn-claude-code s08）
 *
 * 模型主动请求压缩：一个阶段结束后，后续工作只需要保留摘要。
 * 工具本身无状态——返回确认文案；真正的 compactHistory 由 Agent 在
 * 【整批工具执行完、结果全部回喂后】统一执行（防止孤立 tool_result、
 * 防止丢失已发生的副作用记录导致模型重复执行）。
 */

import { Tool } from "../tool";

export const COMPACT_TOOL_NAME = "compact";

export class CompactTool extends Tool {
  override get name(): string {
    return COMPACT_TOOL_NAME;
  }

  override get description(): string {
    return "Summarize earlier conversation to free context space after finishing a phase";
  }

  override get parametersDescription(): string {
    return "无需参数（调用即请求在本批工具完成后压缩历史）";
  }

  override get parametersSchema(): Record<string, unknown> {
    return { type: "object", properties: {} };
  }

  override async execute(_input: string): Promise<string> {
    return this.executeArgs({});
  }

  override async executeArgs(_args: Record<string, unknown>): Promise<string> {
    return "Compaction requested after this tool batch.";
  }
}
