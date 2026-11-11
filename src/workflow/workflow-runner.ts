/**
 * s16 Workflow Agent Runners（对齐 lcc MockAgentRunner / AnthropicAgentRunner）
 *
 * workflow 子 agent 是纯 LLM 调用（无工具、无文件）：Runner 接口隔离
 * "谁在回答"——Mock 确定性可复现（demo/测试），LLM Runner 复用宿主
 * ChatLLM（与主循环同一客户端）。schema 以 JSON 追加进 prompt，剥代码
 * 围栏解析；解析失败把原文交给 ExecutionState 的 schema 校验触发一次重试。
 */

import type { ChatLLM } from "../core/llm";
import {
  fillSchema,
  stableSeed,
  stableStringify,
  type JsonSchemaRecord,
} from "./workflow-schema";
import { WorkflowInputError } from "./workflow-journal";

/** Runner 一次调用的产出：值 + token 计量 */
export interface RunnerOutput {
  value: unknown;
  tokens: number;
}

/** workflow 子 agent 的最小执行契约 */
export interface WorkflowAgentRunner {
  run(prompt: string, schema?: JsonSchemaRecord, label?: string): Promise<RunnerOutput>;
}

/** workflow agent 环境说明（对齐 lcc WORKFLOW_AGENT_ENVIRONMENT） */
function workflowAgentEnvironment(): string {
  const host = process.platform === "win32" ? "Windows" : "Unix-like";
  return (
    `Host OS: ${host}. This workflow agent only responds to its supplied ` +
    "step; it has no direct shell or file tools."
  );
}

/** Mock tokens 公式（对齐 lcc _tokens：prompt//4 + JSON//4） */
function estimateTokens(prompt: string, value: unknown): number {
  return (
    Math.floor(prompt.length / 4) +
    Math.floor(stableStringify(value).length / 4)
  );
}

/**
 * 确定性 Mock runner（对齐 lcc MockAgentRunner）：
 * findings/isReal 两个演示 schema 特化，其余走通用 filler。
 */
export class MockWorkflowAgentRunner implements WorkflowAgentRunner {
  async run(
    prompt: string,
    schema?: JsonSchemaRecord,
    label?: string,
  ): Promise<RunnerOutput> {
    let value: unknown;
    if (schema === undefined) {
      value = `[mock] ${(label ?? prompt).slice(0, 60)}`;
      return { value, tokens: estimateTokens(prompt, value) };
    }
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    if ("findings" in properties) {
      const n = 1 + Number(stableSeed(prompt) % 2n);
      const severities = ["high", "medium", "low"];
      value = {
        findings: Array.from({ length: n }, (_, i) => ({
          title: `${label ?? "audit"} #${i + 1}`,
          severity:
            severities[Number(stableSeed(`${prompt}${i}`) % 3n)],
        })),
      };
    } else if ("isReal" in properties) {
      const real = stableSeed(prompt) % 4n !== 0n;
      value = {
        isReal: real,
        reason: real ? "reproduced" : "could not reproduce",
      };
    } else {
      value = fillSchema(schema, prompt);
    }
    return { value, tokens: estimateTokens(prompt, value) };
  }
}

/**
 * 剥 Markdown 代码围栏后解析 JSON；全文不是合法 JSON 时退化为
 * "从第一个 { 起尝试解析第一个完整 JSON 对象"（对齐 lcc raw_decode 扫描）。
 */
export function parseRunnerJson(text: string): unknown {
  let stripped = text.trim();
  if (stripped.startsWith("```")) {
    const lines = stripped.split("\n");
    const body = lines.slice(1);
    const last = body[body.length - 1];
    if (last !== undefined && last.trim() === "```") {
      body.pop();
    }
    stripped = body.join("\n").trim();
  }
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    for (let position = 0; position < stripped.length; position++) {
      if (stripped[position] !== "{") continue;
      try {
        return JSON.parse(stripped.slice(position)) as unknown;
      } catch {
        // 该位置不是完整 JSON，继续向后扫描
      }
    }
    throw new WorkflowInputError("workflow agent returned invalid JSON");
  }
}

const WORKFLOW_AGENT_SYSTEM_PREFIX =
  "You are a focused workflow agent. Complete only the supplied step. ";
const WORKFLOW_AGENT_SYSTEM_SUFFIX =
  " Do not claim access to files or results not included in the prompt.";

/**
 * LLM Runner（对齐 lcc AnthropicAgentRunner 的宿主复用思路）：
 * 与主循环同一 ChatLLM；schema 追加进 prompt；usage 不经接口透出，
 * token 用 chars/4 估算（翻译注记，真实 usage 记改进项）。
 */
export class LlmWorkflowAgentRunner implements WorkflowAgentRunner {
  constructor(
    private readonly llm: ChatLLM,
    private readonly options: { maxTokens?: number } = {},
  ) {}

  async run(
    prompt: string,
    schema?: JsonSchemaRecord,
    label?: string,
  ): Promise<RunnerOutput> {
    void label;
    let request = prompt;
    if (schema !== undefined) {
      request +=
        "\n\nReturn only one JSON object matching this schema:\n" +
        stableStringify(schema);
    }
    const text = await this.llm.invoke(
      [
        {
          role: "system",
          content:
            WORKFLOW_AGENT_SYSTEM_PREFIX +
            workflowAgentEnvironment() +
            WORKFLOW_AGENT_SYSTEM_SUFFIX,
        },
        { role: "user", content: request },
      ],
      { maxTokens: this.options.maxTokens ?? 2000 },
    );
    if (schema === undefined) {
      const value = text.trim();
      return { value, tokens: estimateTokens(request, value) };
    }
    try {
      const value = parseRunnerJson(text);
      return { value, tokens: estimateTokens(request, value) };
    } catch (error) {
      if (error instanceof WorkflowInputError) {
        // 解析失败 → 原文交给 ExecutionState 的 schema 校验触发一次重试
        return { value: text, tokens: estimateTokens(request, text) };
      }
      throw error;
    }
  }
}
