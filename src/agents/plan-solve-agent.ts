/**
 * PlanAndSolveAgent（对应书 7.4.4，结构来自第四章 Plan_and_solve.py）
 *
 * 设计（书第四章的组合式结构）：
 * - Planner：独立的规划器，输出强结构化步骤列表；解析失败返回 [] 而不是抛异常
 * - Executor：独立的执行器，逐步执行并累积历史
 * - Agent 只做编排：planner.plan() → 空计划则优雅终止 → executor.execute()
 * 对应书 7.4.4 说的"完整的异常处理机制，确保后续步骤能够稳定执行"。
 */

import { Agent } from "../core/agent";
import type { ChatLLM } from "../core/llm";
import { AgentConfig } from "../core/config";
import { Message } from "../core/message";
import { fillTemplate } from "../core/prompt";

export interface PlanSolvePrompts {
  planner: string;
  executor: string;
}

export const DEFAULT_PLAN_SOLVE_PROMPTS: PlanSolvePrompts = {
  planner: `
你是一个顶级的AI规划专家。你的任务是将用户提出的复杂问题分解成一个由多个简单步骤组成的行动计划。
请确保计划中的每个步骤都是一个独立的、可执行的子任务，并且严格按照逻辑顺序排列。
你的输出必须是一个Python列表，其中每个元素都是一个描述子任务的字符串。

问题: {question}

请严格按照以下格式输出你的计划:
\`\`\`python
["步骤1", "步骤2", "步骤3", ...]
\`\`\`
`,
  executor: `
你是一位顶级的AI执行专家。你的任务是严格按照给定的计划，一步步地解决问题。
你将收到原始问题、完整的计划、以及到目前为止已经完成的步骤和结果。
请你专注于解决"当前步骤"，并仅输出该步骤的最终答案，不要输出任何额外的解释或对话。

# 原始问题:
{question}

# 完整计划:
{plan}

# 历史步骤与结果:
{history}

# 当前步骤:
{current_step}

请仅输出针对"当前步骤"的回答:
`,
};

/** 规划器（对应书第四章 Planner 类） */
export class Planner {
  constructor(
    private readonly llm: ChatLLM,
    readonly promptTemplate: string = DEFAULT_PLAN_SOLVE_PROMPTS.planner,
  ) {}

  /** 生成计划；输出无法解析时返回 []（优雅失败，不抛异常） */
  async plan(question: string): Promise<string[]> {
    const response = await this.llm.invoke([
      {
        role: "user",
        content: fillTemplate(this.promptTemplate, { question }),
      },
    ]);
    try {
      return parsePlan(response);
    } catch {
      return [];
    }
  }
}

/** 执行器（对应书第四章 Executor 类） */
export class Executor {
  /** 最近一次执行的"步骤: 结果"历史行 */
  lastHistoryLines: string[] = [];

  constructor(
    private readonly llm: ChatLLM,
    readonly promptTemplate: string = DEFAULT_PLAN_SOLVE_PROMPTS.executor,
  ) {}

  /** 逐步执行计划，返回最后一步的结果（对应书 final_answer） */
  async execute(question: string, steps: string[]): Promise<string> {
    this.lastHistoryLines = [];
    let finalAnswer = "";

    for (const [index, step] of steps.entries()) {
      const result = await this.llm.invoke([
        {
          role: "user",
          content: fillTemplate(this.promptTemplate, {
            question,
            plan: steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
            history:
              this.lastHistoryLines.length > 0
                ? this.lastHistoryLines.join("\n")
                : "无",
            current_step: step,
          }),
        },
      ]);
      this.lastHistoryLines.push(`步骤 ${index + 1}: ${step}\n结果: ${result}`);
      finalAnswer = result;
    }
    return finalAnswer;
  }
}

export interface PlanAndSolveAgentOptions {
  systemPrompt?: string;
  config?: AgentConfig;
  customPrompts?: Partial<PlanSolvePrompts>;
}

export class PlanAndSolveAgent extends Agent {
  readonly planner: Planner;
  readonly executor: Executor;

  /** 最近一次任务的计划步骤 */
  lastPlan: string[] = [];

  constructor(
    name: string,
    llm: ChatLLM,
    options: PlanAndSolveAgentOptions = {},
  ) {
    super(name, llm, options.systemPrompt, options.config);
    const prompts: PlanSolvePrompts = {
      ...DEFAULT_PLAN_SOLVE_PROMPTS,
      ...options.customPrompts,
    };
    this.planner = new Planner(llm, prompts.planner);
    this.executor = new Executor(llm, prompts.executor);
  }

  override async run(question: string): Promise<string> {
    // 1. 规划
    const steps = await this.planner.plan(question);
    this.lastPlan = steps;

    // 2. 空计划 → 优雅终止（对应书"无法生成有效的行动计划"）
    if (steps.length === 0) {
      const failure = "❌ 无法生成有效的行动计划：规划器输出无法解析为步骤列表。";
      this.addMessage(Message.user(question));
      this.addMessage(Message.assistant(failure));
      return failure;
    }

    // 3. 逐步执行
    const finalAnswer = await this.executor.execute(question, steps);
    this.addMessage(Message.user(question));
    this.addMessage(Message.assistant(finalAnswer));
    return finalAnswer;
  }
}

/**
 * 解析规划器输出（书第四章用 ```python 围栏 + ast.literal_eval）：
 * 围栏内容优先，退而求其次扫描首个方括号；
 * 兼容双引号 JSON 与单引号 Python 列表；解析不了抛错，
 * Planner 层捕获后转为空计划优雅终止。
 */
export function parsePlan(plannerOutput: string): string[] {
  // 路径 1：```python ... ``` 围栏（书第四章的 split 提取方式）
  const fenceMatch = plannerOutput.split(/```(?:python|json)?/i);
  const candidates = fenceMatch.length > 1
    ? [fenceMatch[1] ?? "", plannerOutput]
    : [plannerOutput];

  for (const candidate of candidates) {
    const steps = tryParseSteps(candidate);
    if (steps !== undefined) return steps;
  }
  throw new Error(
    `规划器输出不是合法的步骤列表: ${plannerOutput.trim().slice(0, 100)}`,
  );
}

function tryParseSteps(raw: string): string[] | undefined {
  const stripped = raw.replace(/```/g, "").trim();
  const arrayMatch = stripped.match(/\[([\s\S]*)\]/);
  // 注意只判断是否匹配：[] 的捕获组是空串，不能当作"没匹配上"
  if (!arrayMatch) return undefined;

  const body = (arrayMatch[1] ?? "").trim();
  if (body === "") return []; // 显式空列表

  // 路径 A：标准 JSON（双引号）
  try {
    const parsed: unknown = JSON.parse(`[${body}]`);
    if (Array.isArray(parsed) && parsed.every((i) => typeof i === "string")) {
      return parsed;
    }
  } catch {
    // 落到引号提取兜底
  }

  // 路径 B：单引号 Python 列表，逐个提取引号内字符串
  const items = [...body.matchAll(/["']([^"']*)["']/g)].map((m) => m[1] ?? "");
  if (items.length > 0) return items;
  return undefined;
}
