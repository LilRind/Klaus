/**
 * ReActAgent（对应书 7.4.2 MyReActAgent）
 *
 * Thought/Action/Observation 循环。协议：
 *   Action: tool_name[tool_input]  调工具
 *   Action: Finish[最终答案]       收尾
 * 执行历史不进 LLM 的多轮 messages，而是回填到提示词模板的
 * {history} 区块——这是 ReAct 范式和 SimpleAgent 多轮对话的关键差异。
 */

import { Agent } from "../core/agent";
import type { ChatLLM } from "../core/llm";
import { AgentConfig } from "../core/config";
import { Message } from "../core/message";
import type { ToolRegistry } from "../tools/registry";

export const DEFAULT_REACT_PROMPT = `你是一个具备推理和行动能力的AI助手。你可以通过思考分析问题，然后调用合适的工具来获取信息，最终给出准确的答案。

## 可用工具
{tools}

## 工作流程
请严格按照以下格式进行回应，每次只能执行一个步骤：

Thought: 你的思考过程，用于分析问题、拆解任务和规划下一步行动。
Action: 你决定采取的行动，必须是以下格式之一：
- \`{tool_name}[{tool_input}]\` - 调用指定工具
- \`Finish[最终答案]\` - 当你有足够信息给出最终答案时

## 重要提醒
1. 每次回应必须包含 Thought 和 Action 两部分
2. 工具调用的格式必须严格遵循：工具名[参数]
3. 只有当你确信有足够信息回答问题时，才使用 Finish
4. 如果工具返回的信息不够，继续使用其他工具或相同工具的不同参数

## 当前任务
**Question:** {question}

## 执行历史
{history}

现在开始你的推理和行动：`;

export interface ReactAgentOptions {
  systemPrompt?: string;
  config?: AgentConfig;
  maxSteps?: number;
  promptTemplate?: string;
}

export class ReActAgent extends Agent {
  readonly toolRegistry: ToolRegistry;
  readonly maxSteps: number;
  readonly promptTemplate: string;

  /** 当前任务的执行历史（Action/Observation 交替） */
  currentHistory: string[] = [];

  constructor(
    name: string,
    llm: ChatLLM,
    toolRegistry: ToolRegistry,
    options: ReactAgentOptions = {},
  ) {
    super(name, llm, options.systemPrompt, options.config);
    this.toolRegistry = toolRegistry;
    this.maxSteps = options.maxSteps ?? this.config.maxSteps;
    this.promptTemplate = options.promptTemplate ?? DEFAULT_REACT_PROMPT;
  }

  override async run(input: string): Promise<string> {
    this.currentHistory = [];

    for (let step = 1; step <= this.maxSteps; step++) {
      const prompt = this.buildPrompt(input);
      const responseText = await this.llm.invoke([
        { role: "user", content: prompt },
      ]);

      const { action } = parseReActOutput(responseText);

      // Finish 分支
      if (action?.startsWith("Finish")) {
        const finalAnswer = parseFinishInput(action);
        this.addMessage(Message.user(input));
        this.addMessage(Message.assistant(finalAnswer));
        return finalAnswer;
      }

      // 工具调用分支
      if (action) {
        const { toolName, toolInput } = parseAction(action);
        let observation: string;
        try {
          observation = await this.toolRegistry.executeTool(toolName, toolInput);
        } catch (error) {
          observation = `❌ ${error instanceof Error ? error.message : String(error)}`;
        }
        this.currentHistory.push(`Action: ${action}`, `Observation: ${observation}`);
      }
    }

    // 达到最大步数仍未 Finish
    const finalAnswer = "抱歉，我无法在限定步数内完成这个任务。";
    this.addMessage(Message.user(input));
    this.addMessage(Message.assistant(finalAnswer));
    return finalAnswer;
  }

  /** 填充提示词模板：工具菜单 + 当前任务 + 执行历史 */
  protected buildPrompt(input: string): string {
    return this.promptTemplate
      .replaceAll("{tools}", this.toolRegistry.getToolsDescription())
      .replaceAll("{question}", input)
      .replaceAll("{history}", this.currentHistory.join("\n"));
  }
}

export interface ReActOutput {
  thought: string;
  action: string;
}

/** 解析 Thought/Action（对应书 _parse_output） */
export function parseReActOutput(text: string): ReActOutput {
  const thoughtMatch = text.match(/Thought:\s*([\s\S]*?)(?=\n\s*Action:|$)/i);
  const actionMatch = text.match(/Action:\s*([^\n]+)/i);
  return {
    thought: (thoughtMatch?.[1] ?? "").trim(),
    action: normalizeAction(actionMatch?.[1] ?? ""),
  };
}

/** 解析 Finish[最终答案] */
export function parseFinishInput(action: string): string {
  const cleaned = normalizeAction(action);
  const match = cleaned.match(/^Finish\s*\[([\s\S]*)\]\s*$/i);
  if (match?.[1] !== undefined) return match[1].trim();
  return cleaned.replace(/^Finish:?\s*/i, "").trim();
}

/** 解析 tool_name[tool_input] */
export function parseAction(action: string): { toolName: string; toolInput: string } {
  const cleaned = normalizeAction(action);
  const match = cleaned.match(/^(.+?)\[(.*)\]$/s);
  if (match?.[1] !== undefined) {
    return { toolName: match[1].trim(), toolInput: (match[2] ?? "").trim() };
  }
  return { toolName: cleaned, toolInput: "" };
}

/**
 * 剥掉模型习惯性包裹的 Markdown 反引号。
 * 提示词模板的格式示例带反引号（`tool[input]`），模型会照抄——
 * 真实运行发现 glm 会输出 `` Action: `calculator[...]` ``，
 * 解析层必须容错，否则整串被当成工具名。
 */
function normalizeAction(raw: string): string {
  return raw.trim().replace(/^`+/, "").replace(/`+$/, "").trim();
}
