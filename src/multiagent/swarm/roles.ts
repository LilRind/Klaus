/**
 * s18 Swarm 角色库（来源：SN roles/swarm/role_prompts.py 的 12 角色裁剪为 6，
 * 差异记录于 design.md D7）+ 模型分档（small/medium/large 回落主 llm）。
 */

import type { ChatLLM } from "../../core/llm";

export const SWARM_ROLES = ["researcher", "analyst", "writer", "coder", "critic", "planner"] as const;
export type SwarmRole = (typeof SWARM_ROLES)[number];

const ROLE_METHODOLOGY: Record<SwarmRole, string> = {
  researcher: "调研方法：先明确要查什么，再检索；交叉验证至少两个来源；把结论连同出处写入 workspace，避免只给印象。",
  analyst: "分析方法：先列出可比维度，再逐项对比；区分事实与推断；给出结构化结论（表格/要点）与置信度。",
  writer: "写作方法：先列大纲再成文；面向读者组织信息，避免堆砌；交付前自查逻辑连贯与格式统一。",
  coder: "编码方法：小步实现、随手验证；先读再改；说明关键决策与风险；交付可运行的最小实现。",
  critic: "评审方法：从正确性、完备性、风险三处挑刺；每条意见给出可执行的改进建议，不做空泛否定。",
  planner: "规划方法：把目标拆成可验证的步骤；标出依赖与风险；为每步定义完成判据。",
};

export function rolePrompt(role: string): string {
  const typed = role as SwarmRole;
  const methodology = ROLE_METHODOLOGY[typed];
  return methodology ?? ROLE_METHODOLOGY.researcher;
}

export interface RoleModelSet {
  llm: ChatLLM;
  small?: ChatLLM;
  medium?: ChatLLM;
  large?: ChatLLM;
}

export function resolveRoleModel(
  tier: "small" | "medium" | "large",
  models: RoleModelSet,
): { llm: ChatLLM; fellBack: boolean } {
  const picked = models[tier];
  return picked ? { llm: picked, fellBack: false } : { llm: models.llm, fellBack: true };
}
