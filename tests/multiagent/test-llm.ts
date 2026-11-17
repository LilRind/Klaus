import type { ChatLLM, LLMInvokeOptions } from "../../src/core/llm";
import type { ChatMessage } from "../../src/core/message";

/** 批1 共享桩：按调用次序弹出脚本回复；可记录每次请求供断言。 */
export interface ScriptedInvoke {
  messages: ChatMessage[];
  options?: LLMInvokeOptions;
}

export function scriptedLlm(replies: string[], invocations?: ScriptedInvoke[]): ChatLLM {
  const queue = [...replies];
  return {
    model: "stub",
    provider: "openai",
    async invoke(messages, options) {
      invocations?.push({ messages, options });
      const reply = queue.shift();
      if (reply === undefined) throw new Error("ScriptedLLM 队列已空");
      return reply;
    },
    async *stream(messages, options) {
      yield await this.invoke(messages, options);
    },
  };
}
