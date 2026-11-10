/**
 * load_skill 工具（对齐 learn-claude-code s07）
 *
 * 返回完整 SKILL.md 作为 tool_result；name 只查 SkillLoader 的注册表，
 * 不会被当作文件路径（防路径注入，对齐 s07 的安全语义）。
 */

import { Tool, tryParseJsonObject } from "../tool";
import type { SkillLoader } from "../../skills/skill-loader";

export class SkillTool extends Tool {
  override get name(): string {
    return "load_skill";
  }

  override get description(): string {
    return "Load the full SKILL.md instructions for a named skill";
  }

  override get parametersDescription(): string {
    return 'JSON: {"name": "code-review"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: { type: "string", description: "技能名（来自 system prompt 的技能目录）" },
      },
      required: ["name"],
    };
  }

  constructor(private readonly loader: SkillLoader) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input);
    if (args && typeof args.name === "string") {
      return this.executeArgs({ name: args.name });
    }
    // 裸字符串 = 技能名
    return this.executeArgs({ name: input.trim() });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const name = args.name;
    if (typeof name !== "string" || name.trim().length === 0) {
      return "❌ load_skill 需要非空 name 字段";
    }
    return this.loader.load(name);
  }
}
