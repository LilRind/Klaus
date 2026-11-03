/**
 * ReflectionAgent（对应书 7.4.3，核心逻辑来自第四章 Reflection.py）
 *
 * 设计（书第四章的三段式 + Memory 轨迹模块）：
 * 1. Memory 记录 execution/reflection 交替轨迹——反思和修改都从
 *    memory.getLastExecution() 取"最近一次执行"，而不是闭包局部变量，
 *    轨迹对外可观测（getTrajectory），第八章的 Memory 机制可无缝接上；
 * 2. 提示词三件套（initial/reflect/refine）沿用第七章的通用化版本，
 *    customPrompts 支持部分覆盖（如第四章的代码评审视角）；
 * 3. 停止条件双语判定："无需改进" 或 "no need for improvement"。
 */

import { Agent } from "../core/agent";
import type { ChatLLM } from "../core/llm";
import { AgentConfig } from "../core/config";
import { Memory } from "../core/memory";
import { Message } from "../core/message";
import { fillTemplate } from "../core/prompt";

export interface ReflectionPrompts {
  initial: string;
  reflect: string;
  refine: string;
}

export const DEFAULT_REFLECTION_PROMPTS: ReflectionPrompts = {
  initial: `
请根据以下要求完成任务:

任务: {task}

请提供一个完整、准确的回答。
`,
  reflect: `
请仔细审查以下回答，并找出可能的问题或改进空间:

# 原始任务:
{task}

# 当前回答:
{content}

请分析这个回答的质量，指出不足之处，并提出具体的改进建议。
如果回答已经很好，请回答"无需改进"。
`,
  refine: `
请根据反馈意见改进你的回答:

# 原始任务:
{task}

# 上一轮回答:
{last_attempt}

# 反馈意见:
{feedback}

请提供一个改进后的回答。
`,
};

export interface ReflectionAgentOptions {
  systemPrompt?: string;
  config?: AgentConfig;
  /** 最大反思轮数，默认 3（对应书第四章 max_iterations） */
  maxRounds?: number;
  /** 部分覆盖默认提示词（未提供的键沿用默认） */
  customPrompts?: Partial<ReflectionPrompts>;
}

export class ReflectionAgent extends Agent {
  readonly prompts: ReflectionPrompts;
  readonly maxRounds: number;

  /** 任务轨迹记忆：execution/reflection 交替记录（对应书第四章 Memory 模块） */
  readonly memory = new Memory();

  /** 最近一轮的反思反馈（供外部检视） */
  lastFeedback = "";

  constructor(
    name: string,
    llm: ChatLLM,
    options: ReflectionAgentOptions = {},
  ) {
    super(name, llm, options.systemPrompt, options.config);
    this.prompts = { ...DEFAULT_REFLECTION_PROMPTS, ...options.customPrompts };
    this.maxRounds = options.maxRounds ?? 3;
  }

  override async run(task: string): Promise<string> {
    // 每次任务重置轨迹：memory 描述的是"当前任务"的执行历史
    this.memory.clear();
    this.lastFeedback = "";

    // 1. 初始执行 → 记入 memory
    this.log("✍️ 生成初始回答...");
    const initial = await this.llm.invoke([
      { role: "user", content: fillTemplate(this.prompts.initial, { task }) },
    ]);
    this.memory.addRecord("execution", initial);

    // 2. 反思-修改循环：始终从 memory 取最近一次执行
    for (let round = 1; round <= this.maxRounds; round++) {
      this.log(`🔍 第 ${round}/${this.maxRounds} 轮反思...`);
      const lastAttempt = this.memory.getLastExecution() ?? "";
      const feedback = await this.llm.invoke([
        {
          role: "user",
          content: fillTemplate(this.prompts.reflect, {
            task,
            content: lastAttempt,
          }),
        },
      ]);
      this.memory.addRecord("reflection", feedback);
      this.lastFeedback = feedback;

      // 反思认为无需改进 → 提前收敛（双语判定，对应书第四章）
      if (isNoImprovementNeeded(feedback)) {
        this.log("✅ 反思认定无需改进，收敛");
        break;
      }

      this.log("🔧 根据反馈修改...");
      const refined = await this.llm.invoke([
        {
          role: "user",
          content: fillTemplate(this.prompts.refine, {
            task,
            last_attempt: lastAttempt,
            feedback,
          }),
        },
      ]);
      this.memory.addRecord("execution", refined);
    }

    // 3. 最终答案 = memory 里最近一次执行（对应书 final_code）
    const finalAnswer = this.memory.getLastExecution() ?? "";
    this.addMessage(Message.user(task));
    this.addMessage(Message.assistant(finalAnswer));
    return finalAnswer;
  }

  private log(message: string): void {
    if (this.config.verbose) console.log(message);
  }
}

/** 停止条件：中文"无需改进"或英文"no need for improvement" */
export function isNoImprovementNeeded(feedback: string): boolean {
  return (
    feedback.includes("无需改进") ||
    feedback.toLowerCase().includes("no need for improvement")
  );
}
