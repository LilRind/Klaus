/**
 * s18 路由（v2 定稿，对齐 SN 当前代码）：
 * - 早路由：mode=swarm 跳过分解直入 Swarm（SN force_swarm，orchestrator_router.go:269-312）；
 *   mode=simple 直通单 Agent；mode=dag 直通 DAG 线但仍需分解出计划。
 * - 分解后：isSimple（复杂度<阈值 且 ≤1 子任务 且 无建议工具，对齐 :888-889）→ simple；
 *   其余一律 DAG（对齐 :1070 起 switch——Supervisor 分支恒假禁用，hasDeps :1011-1015 为死变量）。
 * 明确不做：">5 子任务→swarm" 自动路由、strategy=swarm 建议、SupervisorWorkflow。
 */

import { DEFAULTS, type DagStrategy, type ExecutionMode, type TaskPlan } from "./model";

export interface RouteDecision {
  line: ExecutionMode;
  /** true = 不需要调用分解（swarm/simple）。 */
  skipDecompose: boolean;
  /** DAG 线内部模式（对齐 dag.go selectExecutionStrategy）。 */
  dagStrategy: DagStrategy;
  reason: string;
}

/** 早路由：返回 undefined 表示需要分解后判定。 */
export function resolveMode(mode: ExecutionMode | "auto" | undefined): RouteDecision | undefined {
  if (mode === "swarm") {
    return { line: "swarm", skipDecompose: true, dagStrategy: "parallel", reason: "mode=swarm 早路由（≡force_swarm），Lead 自主规划" };
  }
  if (mode === "simple") {
    return { line: "simple", skipDecompose: true, dagStrategy: "parallel", reason: "mode=simple 直通" };
  }
  if (mode === "dag") {
    return { line: "dag", skipDecompose: false, dagStrategy: "parallel", reason: "mode=dag 直通（仍需分解出计划）" };
  }
  return undefined;
}

export function hasDependencies(plan: TaskPlan): boolean {
  return plan.subtasks.some((sub) => sub.dependencies.length > 0 || sub.consumes.length > 0);
}

export function isSimplePlan(plan: TaskPlan): boolean {
  return (
    plan.complexity < DEFAULTS.simpleComplexityThreshold &&
    plan.subtasks.length <= 1 &&
    plan.subtasks.every((sub) => sub.suggestedTools.length === 0)
  );
}

/** 分解后路由。forceLine 用于 mode=dag（忽略 isSimple）。 */
export function routePlan(plan: TaskPlan, options: { forceLine?: "simple" | "dag" } = {}): RouteDecision {
  const dagStrategy: DagStrategy = hasDependencies(plan)
    ? "hybrid"
    : plan.strategy === "sequential"
      ? "sequential"
      : "parallel";
  const line = options.forceLine ?? (isSimplePlan(plan) ? "simple" : "dag");
  const reason =
    line === "simple"
      ? "isSimple：低复杂度且 ≤1 子任务且无工具"
      : dagStrategy === "hybrid"
        ? "存在 dependencies/consumes → DAG-hybrid"
        : dagStrategy === "sequential"
          ? "分解建议 sequential"
          : "默认 DAG-parallel";
  return { line, skipDecompose: false, dagStrategy, reason };
}
