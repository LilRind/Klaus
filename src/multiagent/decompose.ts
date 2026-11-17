/**
 * s18 任务分解器：一次 LLM 调用输出结构化计划。
 * 来源：SN DecomposeTaskActivity（复杂度+子任务+依赖声明）的进程内 TS 版。
 * 失败一律降级（带错误码），与 s19 线 assessment 的"缺证据不接受"哲学一致。
 * 全量校验（批2 补全）：基础形状 + Kahn 环检测 + 生产者集合覆盖 consumes。
 */

import type { ChatLLM } from "../core/llm";
import type { Subtask, TaskPlan } from "./model";

export type DecomposeErrorCode = "llmError" | "invalidJson" | "invalidPlan";

export type DecomposeOutcome =
  | { kind: "plan"; plan: TaskPlan }
  | { kind: "degraded"; code: DecomposeErrorCode; reason: string };

const SYSTEM_PROMPT = [
  "你是多 Agent 编排系统的任务分解器。把用户请求分解为可执行的子任务计划。",
  '只输出一个 JSON 对象，形如：',
  '{"complexity":0.6,"strategy":"parallel","subtasks":[{"id":"t1","description":"做什么","dependencies":[],"produces":["topic_a"],"consumes":[],"suggestedTools":[]}]}',
  "规则：complexity 为 0-1；strategy 只能是 parallel 或 sequential；子任务 1-12 个；",
  "简单判定：闲聊、常识问答、单跳查询等无需多步协作的问题，complexity 应低于 0.3 且只给 0-1 个子任务；",
  "dependencies 只能引用同计划内其他子任务 id 且不得自依赖；后面的任务需要前面结果时用 sequential 或声明 dependencies。不要输出 JSON 以外的任何文字。",
].join("\n");

/** 批1 基础校验：返回错误列表（空数组 = 通过）。 */
export function validatePlanBasics(plan: TaskPlan): string[] {
  const errors: string[] = [];
  if (typeof plan.complexity !== "number" || !Number.isFinite(plan.complexity) || plan.complexity < 0 || plan.complexity > 1) {
    errors.push(`complexity 非法：${String(plan.complexity)}`);
  }
  if (plan.strategy !== "parallel" && plan.strategy !== "sequential") {
    errors.push(`strategy 非法：${String(plan.strategy)}（仅 parallel/sequential）`);
  }
  if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
    errors.push("subtasks 为空或缺失");
    return errors;
  }
  const ids = new Set<string>();
  for (const [index, raw] of plan.subtasks.entries()) {
    const label = `subtasks[${index}]`;
    if (typeof raw.id !== "string" || raw.id.trim() === "") {
      errors.push(`${label}.id 非法`);
      continue;
    }
    if (ids.has(raw.id)) errors.push(`子任务 id 重复：${raw.id}`);
    ids.add(raw.id);
    if (typeof raw.description !== "string" || raw.description.trim() === "") {
      errors.push(`${label}.description 非法`);
    }
    for (const field of ["dependencies", "produces", "consumes", "suggestedTools"] as const) {
      if (!Array.isArray(raw[field]) || raw[field].some((x) => typeof x !== "string")) {
        errors.push(`${label}.${field} 必须是字符串数组`);
      }
    }
  }
  for (const sub of plan.subtasks) {
    for (const dep of sub.dependencies ?? []) {
      if (dep === sub.id) errors.push(`子任务 ${sub.id} 自依赖`);
      else if (!ids.has(dep)) errors.push(`子任务 ${sub.id} 依赖不存在的 ${dep}`);
    }
  }
  return errors;
}

/** 批2 全量校验：基础 + 环检测（Kahn）+ 生产者集合（consumes 必须有 produces）。 */
export function validatePlan(plan: TaskPlan): string[] {
  const errors = validatePlanBasics(plan);
  if (errors.length > 0) return errors;

  const ids = new Set(plan.subtasks.map((sub) => sub.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const sub of plan.subtasks) indegree.set(sub.id, 0);
  for (const sub of plan.subtasks) {
    for (const dep of sub.dependencies) {
      indegree.set(sub.id, (indegree.get(sub.id) ?? 0) + 1);
      dependents.set(dep, [...(dependents.get(dep) ?? []), sub.id]);
    }
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id);
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    processed += 1;
    for (const next of dependents.get(id) ?? []) {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }
  if (processed !== plan.subtasks.length) {
    errors.push("依赖图存在环（Kahn 检测未消费全部节点）");
  }

  const producers = new Set<string>();
  for (const sub of plan.subtasks) {
    for (const topic of sub.produces) producers.add(topic);
  }
  const consumers = new Map<string, string[]>();
  for (const sub of plan.subtasks) {
    for (const topic of sub.consumes) {
      consumers.set(topic, [...(consumers.get(topic) ?? []), sub.id]);
    }
  }
  for (const [topic, consumerIds] of consumers) {
    if (!producers.has(topic)) {
      errors.push(`主题 ${topic} 被 [${consumerIds.join(", ")}] 消费但无任何生产者`);
    }
  }
  return errors;
}

/** 从混杂文本提取首个平衡 JSON 对象（沿用 goal-evaluator/assessment 容错解析先例）。 */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

function coercePlan(raw: unknown): TaskPlan | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const subtasksRaw = value.subtasks;
  if (!Array.isArray(subtasksRaw)) return undefined;
  const subtasks: Subtask[] = subtasksRaw.map((item) => {
    const sub = (item ?? {}) as Record<string, unknown>;
    return {
      id: String(sub.id ?? ""),
      description: String(sub.description ?? ""),
      dependencies: Array.isArray(sub.dependencies) ? sub.dependencies.map(String) : [],
      produces: Array.isArray(sub.produces) ? sub.produces.map(String) : [],
      consumes: Array.isArray(sub.consumes) ? sub.consumes.map(String) : [],
      suggestedTools: Array.isArray(sub.suggestedTools) ? sub.suggestedTools.map(String) : [],
    };
  });
  return {
    complexity: typeof value.complexity === "number" ? value.complexity : Number.NaN,
    strategy: value.strategy === "sequential" ? "sequential" : "parallel",
    subtasks,
  };
}

/** 分解一次输入：LLM/解析/校验失败一律降级，永不抛错。 */
export async function decomposeTask(llm: ChatLLM, input: string): Promise<DecomposeOutcome> {
  let text: string;
  try {
    text = await llm.invoke(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: input },
      ],
      { temperature: 0 },
    );
  } catch (error) {
    return {
      kind: "degraded",
      code: "llmError",
      reason: `分解调用失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const parsed = extractJsonObject(text);
  if (parsed === undefined) {
    return { kind: "degraded", code: "invalidJson", reason: "分解输出不含可解析 JSON" };
  }
  const plan = coercePlan(parsed);
  if (plan === undefined) {
    return { kind: "degraded", code: "invalidJson", reason: "分解输出不是计划对象" };
  }
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    return { kind: "degraded", code: "invalidPlan", reason: errors.join("；") };
  }
  return { kind: "plan", plan };
}
