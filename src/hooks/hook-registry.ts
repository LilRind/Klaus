/**
 * Hook 注册表（对齐 learn-claude-code s04）
 *
 * "挂在循环上，不写进循环里"：四个事件覆盖一个完整的 agent cycle——
 * 输入（UserPromptSubmit）→ 执行前（PreToolUse）→ 执行后（PostToolUse）→
 * 退出（Stop）。循环只调用 trigger()，具体逻辑全在 hook 回调里。
 *
 * 与 s04 的架构差异（决策 3，刻意设计）：
 * - lcc 把权限检查从循环体移进 PreToolUse hook——它只有一条 agent_loop；
 * - 我们的权限闸门留在 ToolRegistry 双入口汇合点（覆盖函数调用 + 文本协议
 *   全部 5 条调用路径，含冻结的教学线），Hooks 是纯行为扩展层。
 *   PreToolUse 保留软拦截语义：返回非空字符串 → 本次执行被阻止、原因回喂模型。
 *
 * 返回值语义（对齐 s04 trigger_hooks）：
 * - UserPromptSubmit / PostToolUse：不参与控制流；
 * - PreToolUse：非空 → 阻止本次工具执行；
 * - Stop：非空 → 注入 user 消息强制续跑循环。
 */

import type { ToolCallRequest } from "../core/message";

export type HookEvent =
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop";

/** 用户输入提交后、进入 LLM 前（通知型，不参与控制流） */
export type UserPromptSubmitHook = (query: string) => void;

/** 工具执行前；返回非空字符串 = 软拦截，原因作为 observation 回喂 */
export type PreToolUseHook = (call: ToolCallRequest) => string | undefined;

/** 工具执行后（通知型，不参与控制流） */
export type PostToolUseHook = (call: ToolCallRequest, output: string) => void;

/** 循环即将自然退出时；返回非空字符串 = 注入该消息并强制续跑 */
export type StopHook = (history: readonly unknown[]) => string | undefined;

type HookCallback =
  | UserPromptSubmitHook
  | PreToolUseHook
  | PostToolUseHook
  | StopHook;

export class HookRegistry {
  private readonly hooks: Record<HookEvent, HookCallback[]> = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };

  /** 挂载一个 hook（按注册顺序执行；事件决定回调签名） */
  register(event: "UserPromptSubmit", callback: UserPromptSubmitHook): this;
  register(event: "PreToolUse", callback: PreToolUseHook): this;
  register(event: "PostToolUse", callback: PostToolUseHook): this;
  register(event: "Stop", callback: StopHook): this;
  register(event: HookEvent, callback: HookCallback): this {
    this.hooks[event].push(callback);
    return this;
  }

  /** 注销（不传 callback 移除该事件全部回调，便于测试） */
  unregister(event: HookEvent, callback?: HookCallback): this {
    if (!callback) {
      this.hooks[event] = [];
    } else {
      this.hooks[event] = this.hooks[event].filter((h) => h !== callback);
    }
    return this;
  }

  /** 某事件挂载的回调数（测试/诊断用） */
  count(event: HookEvent): number {
    return this.hooks[event].length;
  }

  /** 触发 UserPromptSubmit（通知型；回调异常向上抛） */
  triggerUserPromptSubmit(query: string): void {
    for (const callback of this.hooks.UserPromptSubmit) {
      (callback as UserPromptSubmitHook)(query);
    }
  }

  /**
   * 触发 PreToolUse：按注册顺序执行，首个返回非空字符串的 hook 短路——
   * 该字符串即拦截原因，回喂给模型。
   */
  triggerPreToolUse(call: ToolCallRequest): string | undefined {
    for (const callback of this.hooks.PreToolUse) {
      const blocked = (callback as PreToolUseHook)(call);
      if (blocked !== undefined && blocked !== "") return blocked;
    }
    return undefined;
  }

  /** 触发 PostToolUse（通知型） */
  triggerPostToolUse(call: ToolCallRequest, output: string): void {
    for (const callback of this.hooks.PostToolUse) {
      (callback as PostToolUseHook)(call, output);
    }
  }

  /**
   * 触发 Stop：返回非空字符串 = 强制续跑（该消息注入为 user 消息）；
   * 全部返回空 = 允许终止。
   */
  triggerStop(history: readonly unknown[]): string | undefined {
    for (const callback of this.hooks.Stop) {
      const force = (callback as StopHook)(history);
      if (force !== undefined && force !== "") return force;
    }
    return undefined;
  }
}

// ---------- 内置示例 hook（对齐 s04 的四个演示回调；label 可定制前缀） ----------

export const LARGE_OUTPUT_CHAR_LIMIT = 100_000;

export interface DemoHooks {
  userPromptSubmit: UserPromptSubmitHook;
  preToolUse: PreToolUseHook;
  postToolUse: PostToolUseHook;
  stop: StopHook;
}

/**
 * 四挂点示例 hook 工厂（对齐 s04 的四个演示回调）。
 * label 决定控制台前缀：默认 "HOOK"（父/装配层）；子 agent 传 "sub-hook"。
 */
export function createDemoHooks(label = "HOOK"): DemoHooks {
  const tag = `[${label}]`;
  return {
    preToolUse(call) {
      console.log(`${tag} PreToolUse: ${call.function.name}(${summarize(call)})`);
      return undefined;
    },
    postToolUse(call, output) {
      if (output.length > LARGE_OUTPUT_CHAR_LIMIT) {
        console.warn(
          `${tag} PostToolUse: output of ${call.function.name} is ${output.length} chars (> ${LARGE_OUTPUT_CHAR_LIMIT})`,
        );
      }
    },
    userPromptSubmit() {
      console.log(`${tag} UserPromptSubmit: working in ${process.cwd()}`);
    },
    stop(history) {
      const toolCount = countToolMessages(history);
      console.log(`${tag} Stop: session used ${toolCount} tool calls`);
      return undefined;
    },
  };
}

// 具名默认版（label=HOOK，父/装配层与既有用法兼容）
export function logHook(call: ToolCallRequest): string | undefined {
  return createDemoHooks().preToolUse(call);
}

export function largeOutputHook(
  call: ToolCallRequest,
  output: string,
): void {
  createDemoHooks().postToolUse(call, output);
}

export function contextInjectHook(): void {
  createDemoHooks().userPromptSubmit("");
}

export function summaryHook(history: readonly unknown[]): string | undefined {
  return createDemoHooks().stop(history);
}

// ---------- 内部辅助 ----------

function summarize(call: ToolCallRequest): string {
  const args = call.function.arguments;
  return args.length > 80 ? `${args.slice(0, 80)}...` : args;
}

/** 从任意消息数组里数 tool 角色（兼容 Message / ChatMessage） */
function countToolMessages(history: readonly unknown[]): number {
  let count = 0;
  for (const message of history) {
    const role = (message as { role?: unknown }).role;
    if (role === "tool") count += 1;
  }
  return count;
}
