import { describe, expect, it } from "vitest";
import {
  detectProvider,
  OpenAICompatLLM,
  type EnvSource,
} from "../src/core/llm";
import { LLMConfigurationError } from "../src/core/exceptions";

describe("detectProvider 自动检测（对应书 7.2.3）", () => {
  it("按 baseUrl 关键字识别", () => {
    expect(detectProvider({ baseUrl: "https://api-inference.modelscope.cn/v1/" })).toBe("modelscope");
    expect(detectProvider({ baseUrl: "https://open.bigmodel.cn/api/paas/v4" })).toBe("zhipu");
    expect(detectProvider({ baseUrl: "https://api.deepseek.com/v1" })).toBe("deepseek");
    expect(detectProvider({ baseUrl: "http://localhost:11434/v1" })).toBe("ollama");
    expect(detectProvider({ baseUrl: "https://api.openai.com/v1" })).toBe("openai");
    expect(detectProvider({ baseUrl: "https://llm.example.com/v1" })).toBe("custom");
  });

  it("按模型名前缀识别", () => {
    expect(detectProvider({ model: "deepseek-chat" })).toBe("deepseek");
    expect(detectProvider({ model: "glm-4-flash" })).toBe("zhipu");
    expect(detectProvider({ model: "Qwen/Qwen2.5-72B-Instruct" })).toBe("modelscope");
    expect(detectProvider({ model: "gpt-4o-mini" })).toBe("openai");
  });

  it("按 provider 专属环境变量识别", () => {
    expect(detectProvider({ env: { DEEPSEEK_API_KEY: "sk-x" } })).toBe("deepseek");
    expect(detectProvider({ env: { OPENAI_API_KEY: "sk-x" } })).toBe("openai");
    expect(detectProvider({ env: {} })).toBe("openai");
  });
});

describe("OpenAICompatLLM 配置解析", () => {
  const emptyEnv: EnvSource = {};

  it("显式参数优先，未知 baseUrl 归为 custom provider", () => {
    const llm = new OpenAICompatLLM({
      model: "my-model",
      apiKey: "sk-test",
      baseUrl: "https://llm.example.com/v1",
      env: emptyEnv,
    });
    expect(llm.provider).toBe("custom");
    expect(llm.model).toBe("my-model");
    expect(llm.baseUrl).toBe("https://llm.example.com/v1");
  });

  it("extraBody 存储 provider 专有参数（如智谱 thinking 开关）", () => {
    const llm = new OpenAICompatLLM({
      model: "glm-5.3-flash",
      apiKey: "sk-test",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      extraBody: { thinking: { type: "disabled" } },
      env: emptyEnv,
    });
    expect(llm.extraBody).toEqual({ thinking: { type: "disabled" } });
  });

  it("统一环境变量回退 + 按模型名推断 provider 默认 baseUrl", () => {
    const llm = new OpenAICompatLLM({
      env: { LLM_MODEL_ID: "deepseek-chat", LLM_API_KEY: "sk-test" },
    });
    expect(llm.provider).toBe("deepseek");
    expect(llm.model).toBe("deepseek-chat");
    expect(llm.baseUrl).toBe("https://api.deepseek.com/v1");
  });

  it("provider 专属密钥可单独触发检测并补全默认模型", () => {
    const llm = new OpenAICompatLLM({ env: { ZHIPU_API_KEY: "key" } });
    expect(llm.provider).toBe("zhipu");
    expect(llm.model).toBe("glm-4-flash");
  });

  it("ollama 本地推理不需要 API Key", () => {
    const llm = new OpenAICompatLLM({ env: { OLLAMA_HOST: "http://localhost:11434" } });
    expect(llm.provider).toBe("ollama");
    expect(llm.model).toBe("qwen2.5:0.5b");
  });

  it("缺少 API Key 抛 LLMConfigurationError", () => {
    expect(() => new OpenAICompatLLM({ env: emptyEnv })).toThrow(
      LLMConfigurationError,
    );
  });
});
