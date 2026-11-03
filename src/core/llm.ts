/**
 * LLM 统一接口（对应书 7.2 HelloAgentsLLM + 7.2.3 自动检测机制）
 *
 * 关键设计：先定义 ChatLLM 接口，OpenAICompatLLM 只是它的默认实现。
 * Agent 只依赖接口——单元测试注入 ScriptedLLM 桩即可离线跑通全部循环逻辑，
 * 不需要真实 API Key（这也是书 7.1.2 "可测试性" 理念的落地）。
 */

import OpenAI from "openai";
import type { ChatMessage, ToolCallRequest } from "./message";
import { LLMConfigurationError, LLMInvocationError } from "./exceptions";

export type LLMProvider =
  | "openai"
  | "deepseek"
  | "zhipu"
  | "modelscope"
  | "siliconflow"
  | "ollama"
  | "custom";

/** 环境变量来源（允许测试注入，不直接耦合 process.env） */
export type EnvSource = Record<string, string | undefined>;

export interface LLMInvokeOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** 所有 Agent 依赖的最小 LLM 契约 */
export interface ChatLLM {
  readonly model: string;
  readonly provider: LLMProvider;
  invoke(messages: ChatMessage[], options?: LLMInvokeOptions): Promise<string>;
  stream(
    messages: ChatMessage[],
    options?: LLMInvokeOptions,
  ): AsyncGenerator<string>;
  /** 原生函数调用（OpenAI Function Calling）；不支持的能力可不实现 */
  invokeWithTools?(
    messages: ChatMessage[],
    tools: ToolSchema[],
    options?: LLMInvokeOptions & { toolChoice?: "auto" | "none" | "required" },
  ): Promise<ToolInvocationResult>;
}

/** OpenAI Function Calling 的工具 Schema */
export interface ToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    /** JSON Schema 形式的参数定义 */
    parameters: Record<string, unknown>;
  };
}

/** invokeWithTools 的返回：正文 + 模型发起的调用列表 */
export interface ToolInvocationResult {
  content: string | null;
  toolCalls: ToolCallRequest[];
}

interface ProviderDefaults {
  baseUrl?: string;
  defaultModel?: string;
  /** 该 provider 专属的 API Key 环境变量名 */
  apiKeyEnv?: string;
}

const PROVIDER_DEFAULTS: Record<LLMProvider, ProviderDefaults> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    apiKeyEnv: "OPENAI_API_KEY",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  },
  zhipu: {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4-flash",
    apiKeyEnv: "ZHIPU_API_KEY",
  },
  modelscope: {
    baseUrl: "https://api-inference.modelscope.cn/v1/",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    apiKeyEnv: "MODELSCOPE_API_KEY",
  },
  siliconflow: {
    baseUrl: "https://api.siliconflow.cn/v1",
    defaultModel: "Qwen/Qwen2.5-7B-Instruct",
    apiKeyEnv: "SILICONFLOW_API_KEY",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen2.5:0.5b",
  },
  custom: {},
};

/**
 * 自动检测 provider（对应书 7.2.3）：
 * baseUrl 关键字 > 模型名前缀 > provider 专属环境变量 > 默认 openai
 */
export function detectProvider(hints: {
  model?: string;
  baseUrl?: string;
  env?: EnvSource;
}): LLMProvider {
  const baseUrl = (hints.baseUrl ?? "").toLowerCase();
  if (baseUrl) {
    if (baseUrl.includes("modelscope")) return "modelscope";
    if (baseUrl.includes("bigmodel")) return "zhipu";
    if (baseUrl.includes("deepseek")) return "deepseek";
    if (baseUrl.includes("siliconflow")) return "siliconflow";
    if (baseUrl.includes("ollama") || baseUrl.includes(":11434")) return "ollama";
    if (baseUrl.includes("api.openai.com")) return "openai";
    return "custom";
  }

  const model = (hints.model ?? "").toLowerCase();
  if (model.startsWith("deepseek")) return "deepseek";
  if (model.startsWith("glm")) return "zhipu";
  if (model.startsWith("qwen")) return "modelscope";
  if (/^(gpt|o[134])/.test(model)) return "openai";

  const env = hints.env ?? {};
  if (env.MODELSCOPE_API_KEY) return "modelscope";
  if (env.DEEPSEEK_API_KEY) return "deepseek";
  if (env.ZHIPU_API_KEY) return "zhipu";
  if (env.SILICONFLOW_API_KEY) return "siliconflow";
  if (env.OLLAMA_HOST) return "ollama";
  if (env.OPENAI_API_KEY) return "openai";

  return "openai";
}

export interface OpenAICompatLLMOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  temperature?: number;
  provider?: LLMProvider;
  /** 测试/嵌入场景注入环境，默认 process.env */
  env?: EnvSource;
  /**
   * 透传给 Chat API 的额外请求体（provider 专有参数，如智谱的
   * thinking: {type:"disabled"}、DeepSeek 的 response_format 等）。
   * 框架保持 OpenAI 标准路径，厂商私有能力从这里扩展。
   */
  extraBody?: Record<string, unknown>;
}

/** 基于 OpenAI 兼容协议的默认实现（主流厂商与本地推理均兼容此协议） */
export class OpenAICompatLLM implements ChatLLM {
  readonly model: string;
  readonly provider: LLMProvider;
  readonly baseUrl: string;
  readonly extraBody?: Record<string, unknown>;

  private readonly client: OpenAI;
  private readonly defaultTemperature?: number;

  constructor(options: OpenAICompatLLMOptions = {}) {
    const env = options.env ?? process.env;
    // 先合并环境变量得到 model/baseUrl 提示，再做检测——
    // 否则 env 里的 LLM_MODEL_ID（如 deepseek-chat）不会参与 provider 推断
    const modelHint = options.model ?? env.LLM_MODEL_ID;
    const baseUrlHint = options.baseUrl ?? env.LLM_BASE_URL;
    this.provider = options.provider ?? detectProvider({
      model: modelHint,
      baseUrl: baseUrlHint,
      env,
    });
    const defaults = PROVIDER_DEFAULTS[this.provider];

    const apiKey =
      options.apiKey ??
      env.LLM_API_KEY ??
      (defaults.apiKeyEnv ? env[defaults.apiKeyEnv] : undefined) ??
      (this.provider === "ollama" ? "ollama" : undefined);
    if (!apiKey) {
      throw new LLMConfigurationError(
        `provider '${this.provider}' 缺少 API Key：请设置 LLM_API_KEY 或 ${defaults.apiKeyEnv ?? "对应提供商的环境变量"}`,
      );
    }

    this.baseUrl = baseUrlHint ?? defaults.baseUrl ?? "";
    if (!this.baseUrl) {
      throw new LLMConfigurationError(
        `provider '${this.provider}' 缺少服务地址：请设置 LLM_BASE_URL`,
      );
    }

    this.model = modelHint ?? defaults.defaultModel ?? "";
    if (!this.model) {
      throw new LLMConfigurationError(
        "缺少模型名称：请设置 LLM_MODEL_ID 或在构造参数中指定 model",
      );
    }

    const timeoutMs =
      options.timeoutMs ?? parseTimeout(env.LLM_TIMEOUT) ?? 60_000;
    this.defaultTemperature = options.temperature;
    this.extraBody = options.extraBody;
    this.client = new OpenAI({
      apiKey,
      baseURL: this.baseUrl,
      timeout: timeoutMs,
      maxRetries: 1,
    });
  }

  async invoke(
    messages: ChatMessage[],
    options: LLMInvokeOptions = {},
  ): Promise<string> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages),
        temperature: options.temperature ?? this.defaultTemperature,
        max_tokens: options.maxTokens,
        stream: false,
        ...(this.extraBody ?? {}),
      } as never);
      return response.choices[0]?.message?.content ?? "";
    } catch (cause) {
      throw new LLMInvocationError(
        `LLM 调用失败 (${this.provider}/${this.model}): ${describe(cause)}`,
        { cause },
      );
    }
  }

  async *stream(
    messages: ChatMessage[],
    options: LLMInvokeOptions = {},
  ): AsyncGenerator<string> {
    try {
      const stream = (await this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages),
        temperature: options.temperature ?? this.defaultTemperature,
        max_tokens: options.maxTokens,
        stream: true,
        ...(this.extraBody ?? {}),
      } as never)) as unknown as AsyncIterable<{
        choices?: Array<{ delta?: { content?: string } }>;
      }>;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
    } catch (cause) {
      throw new LLMInvocationError(
        `LLM 流式调用失败 (${this.provider}/${this.model}): ${describe(cause)}`,
        { cause },
      );
    }
  }

  async invokeWithTools(
    messages: ChatMessage[],
    tools: ToolSchema[],
    options: LLMInvokeOptions & { toolChoice?: "auto" | "none" | "required" } = {},
  ): Promise<ToolInvocationResult> {
    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: toOpenAIMessages(messages),
        temperature: options.temperature ?? this.defaultTemperature,
        max_tokens: options.maxTokens,
        tools: tools as never,
        tool_choice: options.toolChoice ?? "auto",
        stream: false,
        ...(this.extraBody ?? {}),
      } as never);
      const message = response.choices[0]?.message;
      return {
        content: message?.content ?? null,
        toolCalls: (message?.tool_calls ?? []).map((call) => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.function?.name ?? "",
            arguments: call.function?.arguments ?? "{}",
          },
        })),
      };
    } catch (cause) {
      throw new LLMInvocationError(
        `LLM 函数调用失败 (${this.provider}/${this.model}): ${describe(cause)}`,
        { cause },
      );
    }
  }
}

/**
 * ChatMessage → OpenAI SDK 消息参数。
 * SDK 用判别联合（每个 role 一个窄类型）拒绝宽化的 role 联合，
 * 这里逐条映射后收窄；框架实际只发 system/user/assistant，
 * "tool" 角色由 SimpleAgent 以 user 文本回插，不会走到 SDK 的 tool_call_id 变体。
 */
function toOpenAIMessages(
  messages: ChatMessage[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map(({ role, content, name }) => {
    const message =
      name === undefined ? { role, content } : { role, content, name };
    return message as OpenAI.Chat.ChatCompletionMessageParam;
  });
}

function parseTimeout(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return String(cause);
}
