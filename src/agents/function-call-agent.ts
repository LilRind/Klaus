/**
 * FunctionCallAgent（对应书 7.4.5）
 *
 * 用 OpenAI 原生 Function Calling 替代文本协议：
 * 模型返回结构化 tool_calls（JSON 参数），不再靠正则解析模型输出，
 * 鲁棒性显著优于 [TOOL_CALL:...] 文本协议（书里的核心论点）。
 * 前提：LLM 实现必须支持 invokeWithTools。
 */

import { Agent } from "../core/agent";
import type { ChatLLM, ToolSchema } from "../core/llm";
import type { ToolCallRequest } from "../core/message";
import { AgentError } from "../core/exceptions";
import { AgentConfig } from "../core/config";
import { Message } from "../core/message";
import type { AgentTraceLog } from "../core/trace-log";
import { parseJsonObjectArguments } from "../tools/tool";
import type { ToolRegistry } from "../tools/registry";
import { HookRegistry } from "../hooks/hook-registry";
import type { GoalGate } from "../goal/goal-types";
import { TODO_REMINDER_ROUNDS } from "../todo/todo-manager";
import {
  ContextCompactor,
  type CompactionObserver,
  type CompactionOperation,
  isPromptTooLongError,
  MAX_REACTIVE_RETRIES,
} from "../context/compactor";
import { COMPACT_TOOL_NAME } from "../tools/builtin/compact-tool";
import {
  CONTINUATION_PROMPT,
  ESCALATED_MAX_TOKENS,
  LlmRecovery,
  MAX_RECOVERY_RETRIES,
} from "../harness/llm-recovery";
import type { ScheduledPromptJob } from "../harness/async-event-loop";

export interface FunctionCallAgentOptions {
  systemPrompt?: string;
  config?: AgentConfig;
  maxToolIterations?: number;
  /** 执行轨迹日志（JSONL 审计 + md 转录），不传则不落盘 */
  traceLog?: AgentTraceLog;
  /**
   * Hook 注册表（s04 对齐）：四挂点扩展层，不传则为空注册表（零影响）。
   * 权限闸门仍在 ToolRegistry 汇合点——hooks 是行为扩展，不是安全边界。
   */
  hooks?: HookRegistry;
  /**
   * 轨迹输出前缀（s06 对齐：子 agent 用 "[sub] "，与父的输出区分；
   * 插在每行行首，保留消息自带的前导换行）
   */
  tracePrefix?: string;
  /**
   * 上下文压缩器（s08 对齐）：传入后每次调用模型前跑四步压缩管线，
   * history 即工作数组（system 独立于 history，压缩永不动 system）。
   * 不传时本 Agent 行为与 s07 之前完全一致（存量零回归的开关化设计）。
   */
  contextCompactor?: ContextCompactor;
  /**
   * 每次运行前重建 system prompt（s09 对齐：注入本轮召回的记忆）。
   * 返回值作为本轮 system 消息；不传时用构造时的静态 systemPrompt。
   */
  systemPromptBuilder?: (input: string) => Promise<string>;
  /**
   * run 自然结束（模型不再调工具）后的回调（s09 对齐：回合后记忆提取）。
   * 回调异常 fail-open——答案已产出，不因提取失败丢给调用方。
   */
  onRunCompleted?: (context: {
    history: readonly Message[];
    input: string;
    answer: string;
  }) => Promise<void>;
  /**
   * 每次调用 LLM 前收集后台完成通知（s11 对齐）：
   * 返回的非空字符串以独立 role:"user" 消息注入（Anthropic 并入最后
   * user 消息 text block 的 OpenAI 翻译，与 todo reminder 同一决策）。
   * 注入发生在 compactor.prepare 之前（s15 管线顺序：通知 → 压缩）。
   * 不传时行为与之前完全一致（存量零回归）。
   */
  collectNotifications?: () => string[] | Promise<string[]>;
  /**
   * 每轮 LLM 调用前排空到期 cron（s15 轮级注入，对齐 lcc
   * consume_cron_queue）：返回的任务逐条注入 `[Scheduled] {prompt}`
   * user 消息；模型调用成功后 harness 调 acknowledge（至少一次语义），
   * 最终失败由本 Agent 调 restore 重入队。不传时不注入（存量零回归）。
   */
  collectScheduledPrompts?:
    | (() => ScheduledPromptJob[] | Promise<ScheduledPromptJob[]>);
  /**
   * s15 错误恢复：429/529 指数退避 + fallback 切换 + 截断升级/续跑
   * （对齐 lcc RecoveryState/with_retry）。不传时仅保留既有
   * reactive compact 路径（存量零回归）。
   */
  llmRecovery?: LlmRecovery;
  /**
   * s17 Goal gate（对齐 lcc /goal 的会话级 Stop hook）：模型不再调用
   * 工具只代表这一轮想停——s04 Stop hook 放行后，独立判断器读对话
   * 证据决定是否继续。block → 注入 `[Goal still active]` 消息续跑
   * （消耗迭代配额，有界）；defer/limit/error/achieved/failed → 返回
   * （控制权交还调用方 / AsyncEventLoop 唤醒源）。不传时零影响。
   */
  goalGate?: GoalGate;
  /**
   * s17 defer 判据：是否仍有后台任务在跑（BackgroundManager.hasRunning）。
   * 为真时 goal gate 不评估直接 defer——关键结果还没回到对话。
   */
  isBackgroundRunning?: () => boolean;
}

export class FunctionCallAgent extends Agent {
  readonly toolRegistry: ToolRegistry;
  readonly maxToolIterations: number;
  private readonly traceLog: AgentTraceLog | undefined;
  private readonly hooks: HookRegistry;
  private readonly tracePrefix: string | undefined;
  private readonly contextCompactor: ContextCompactor | undefined;
  private readonly systemPromptBuilder:
    | ((input: string) => Promise<string>)
    | undefined;
  private readonly onRunCompleted:
    | ((context: {
        history: readonly Message[];
        input: string;
        answer: string;
      }) => Promise<void>)
    | undefined;
  private readonly collectNotifications:
    | (() => string[] | Promise<string[]>)
    | undefined;
  private readonly collectScheduledPrompts:
    | (() => ScheduledPromptJob[] | Promise<ScheduledPromptJob[]>)
    | undefined;
  private readonly llmRecovery: LlmRecovery | undefined;
  private readonly goalGate: GoalGate | undefined;
  private readonly isBackgroundRunning: (() => boolean) | undefined;
  /** systemPromptBuilder 产出的本轮 system（run 期间生效） */
  private activeSystemPrompt: string | undefined;
  /** s05：连续未使用 todo_write 的工具轮数（reminder 计数器） */
  private roundsSinceTodoWrite = 0;

  constructor(
    name: string,
    llm: ChatLLM,
    toolRegistry: ToolRegistry,
    options: FunctionCallAgentOptions = {},
  ) {
    super(name, llm, options.systemPrompt, options.config);
    if (typeof llm.invokeWithTools !== "function") {
      throw new AgentError(
        "FunctionCallAgent 需要支持 invokeWithTools 的 LLM 实现（如 OpenAICompatLLM）",
      );
    }
    this.toolRegistry = toolRegistry;
    this.maxToolIterations = options.maxToolIterations ?? this.config.maxToolIterations;
    this.traceLog = options.traceLog;
    this.hooks = options.hooks ?? new HookRegistry();
    this.tracePrefix = options.tracePrefix;
    this.contextCompactor = options.contextCompactor;
    this.systemPromptBuilder = options.systemPromptBuilder;
    this.onRunCompleted = options.onRunCompleted;
    this.collectNotifications = options.collectNotifications;
    this.collectScheduledPrompts = options.collectScheduledPrompts;
    this.llmRecovery = options.llmRecovery;
    this.goalGate = options.goalGate;
    this.isBackgroundRunning = options.isBackgroundRunning;
  }

  override async run(input: string): Promise<string> {
    // s04 对齐：用户输入提交后、进入 LLM 前触发（通知型，不参与控制流）
    this.hooks.triggerUserPromptSubmit(input);
    return this.startTurn(input, { addUserMessage: true });
  }

  /**
   * s15 对齐：无固定用户输入的事件轮（cron 空闲交付 / 自动唤醒）——
   * 不触发 UserPromptSubmit hook、不强制添加用户消息；可选 input 为
   * 事件文本（团队事件 / 后台通知 join 后的整段文本，即本轮 user 消息，
   * 对齐 lcc async_event_loop 的 history.append 形态，code.py:3288-3292）。
   */
  async runEventTurn(input?: string): Promise<string> {
    return this.startTurn(input, { addUserMessage: input !== undefined });
  }

  /**
   * 统一轮循环（对齐 lcc agent_loop，code.py:3139-3261）：run 与
   * runEventTurn 的公共主体。每轮顺序：cron drain 注入 → 异步通知 →
   * 压缩 → 模型调用（恢复包装）→ 截断升级/续跑 → 工具执行 → reminder。
   */
  private async startTurn(
    input: string | undefined,
    options: { addUserMessage: boolean },
  ): Promise<string> {
    const startedAt = Date.now();
    // s09 对齐：每次运行前重建 system（注入本轮召回的持久记忆）
    if (this.systemPromptBuilder) {
      this.activeSystemPrompt = await this.systemPromptBuilder(input ?? "");
    }
    // s01 对齐：输入先入 history，循环中的工具轨迹实时回写——
    // 下一次 run 的 conversation 自动携带上一轮的调用与结果，
    // 模型看得到之前"跑过什么命令、看到什么输出"（会话级全轨迹语义）
    if (options.addUserMessage && input !== undefined) {
      this.addMessage(Message.user(input));
    }
    await this.traceLog?.emit({
      type: "run_start",
      input: input ?? "(event turn)",
    });
    // s15 对齐 lcc agent_loop 顶部 `state = RecoveryState()`：每轮新建恢复状态
    this.llmRecovery?.beginTurn();
    // s17 对齐 lcc begin_query：每轮开始重置连续 block 计数（cap 按 query 计）
    this.goalGate?.beginQuery?.();
    const conversation = this.buildConversation();
    // s15 轮级 cron 注入的 active_request 累积（对齐 lcc 3155-3158，压缩摘要键）
    const scheduledRequests: string[] = [];
    /** 本轮已 drain、待 ack 的 cron 任务（模型成功后 ack，最终失败 restore） */
    let pendingScheduled: ScheduledPromptJob[] = [];

    let response = "";
    for (let iteration = 0; iteration < this.maxToolIterations; iteration++) {
      // s14 对齐：每轮重新组装工具池——connect_mcp 等连接动作生效后，
      // 下一轮模型调用即可看到新工具（静态注册表场景零开销差异）
      const tools = this.buildToolSchemas();

      // s15 轮级 cron 注入（对齐 lcc 3149-3158 consume_cron_queue）：每轮
      // 顶部 drain 到期任务，逐条注入 [Scheduled] user 消息；模型调用成功后
      // acknowledge（3184），最终失败 restore（3178）——至少一次语义
      if (this.collectScheduledPrompts) {
        const jobs = await this.collectScheduledPrompts();
        for (const job of jobs) {
          const scheduled = Message.user(`[Scheduled] ${job.prompt}`);
          this.addMessage(scheduled);
          conversation.push(scheduled.toChatMessage());
          scheduledRequests.push(`Run scheduled task: ${job.prompt}`);
          this.trace(`\n⏰ 注入定时任务: ${job.prompt.slice(0, 60)}`);
        }
        pendingScheduled = jobs;
      }

      // s11 对齐：每次调用模型前收集已完成的异步结果（后台命令等），
      // 以 <task_notification> 独立 user 消息注入——工具调用已用占位结果
      // 回喂过，通知不复用 tool_use_id
      if (this.collectNotifications) {
        const notifications = await this.collectNotifications();
        for (const text of notifications) {
          const notification = Message.user(text);
          this.addMessage(notification);
          conversation.push(notification.toChatMessage());
        }
        if (notifications.length > 0) {
          this.trace(`\n🔔 注入 ${notifications.length} 条异步任务通知`);
        }
      }

      // s08 对齐：每次调用模型前跑压缩管线（低成本优先，按需升级）；
      // s08 对齐：每次调用模型前跑压缩管线（低成本优先，按需升级）；
      // history 即工作数组——压缩结果原样写回，下一轮从压缩后的历史继续
      // s15 对齐 lcc 3155-3158：cron 注入累积进 active_request（压缩摘要键）
      const activeRequest =
        [input ?? "", ...scheduledRequests].filter(Boolean).join("\n") ||
        (input ?? "");
      if (this.contextCompactor) {
        const compacted = await this.contextCompactor.prepare(
          this.history,
          activeRequest,
          this.compactionObserver(),
        );
        this.replaceHistory(compacted);
        conversation.length = 0;
        conversation.push(...this.buildConversation());
      }

      let result;
      try {
        result = await this.invokeModel(conversation, tools, activeRequest);
      } catch (error) {
        // s15 对齐 lcc 3178-3182：最终失败 → restore 未 ack 的 cron，
        // 追加 [Error] assistant 消息留痕，再抛给调用方
        this.restorePendingScheduled(pendingScheduled);
        const label =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        this.addMessage(new Message(`[Error] ${label}`, "assistant"));
        throw error;
      }
      if (!result) break;
      // s15 对齐 lcc 3184：模型调用成功即 ack 本轮排空的 cron（截断也算成功）
      await this.acknowledgePendingScheduled(pendingScheduled);
      pendingScheduled = [];

      // s15 对齐 lcc 3187-3199：finish_reason 截断 → 升级 max_tokens 一次，
      // 再注入 CONTINUATION_PROMPT 续跑 ≤MAX_RECOVERY_RETRIES 次，仍不行则
      // 优雅返回已产出的部分文本
      if (this.llmRecovery && LlmRecovery.isTruncation(result)) {
        if (!this.llmRecovery.hasEscalated) {
          this.llmRecovery.markEscalated();
          this.trace(
            `\n⏫ max_tokens 截断：升级 maxTokens 至 ${ESCALATED_MAX_TOKENS} 重试`,
          );
          continue;
        }
        const assistantMessage = new Message(result.content ?? "", "assistant");
        this.addMessage(assistantMessage);
        conversation.push(assistantMessage.toChatMessage());
        if (this.llmRecovery.recoveryCount < MAX_RECOVERY_RETRIES) {
          this.llmRecovery.countRecovery();
          const continuation = Message.user(CONTINUATION_PROMPT);
          this.addMessage(continuation);
          conversation.push(continuation.toChatMessage());
          this.trace(
            `\n↩ 截断续跑（第 ${this.llmRecovery.recoveryCount}/${MAX_RECOVERY_RETRIES} 次）`,
          );
          continue;
        }
        response = result.content ?? "";
        this.trace("\n⏹ 截断续跑已达上限，返回已产出的部分文本");
        await this.traceLog?.emit({
          type: "run_end",
          answer: response,
          durationMs: Date.now() - startedAt,
        });
        return response;
      }
      this.llmRecovery?.resetEscalation();

      if (result.toolCalls.length === 0) {
        // 对齐 s04：assistant 最终响应先进轨迹，再触发 Stop——
        // hook 决定续跑时，模型上一轮说过的话对后续轮次可见
        const assistantMessage = new Message(result.content ?? "", "assistant");
        this.addMessage(assistantMessage);
        conversation.push(assistantMessage.toChatMessage());
        // s04 对齐：循环自然退出前触发 Stop；hook 返回非空 → 注入消息强制续跑
        //（续跑消耗迭代配额，保留有界安全；nudge 强制收尾路径不触发 Stop）
        const force = this.hooks.triggerStop(this.history);
        if (force !== undefined) {
          this.trace(`\n↩ Stop hook 强制续跑: ${force.slice(0, 80)}`);
          const forceMessage = Message.user(force);
          this.addMessage(forceMessage);
          conversation.push(forceMessage.toChatMessage());
          continue;
        }
        // s17 对齐：模型不调工具只代表这轮想停——独立判断器读对话
        // 证据决定整任务是否完成。block → 注入理由续跑（消耗迭代配额）；
        // defer/limit/error → 交还控制权且目标保留；achieved/failed → 目标已清除
        if (this.goalGate) {
          const decision = await this.goalGate.evaluateAfterTurn(
            this.history,
            this.isBackgroundRunning?.() ?? false,
          );
          if (decision.action === "block") {
            this.trace(`\n🎯 goal 未达成，继续: ${(decision.reason ?? "").slice(0, 80)}`);
            const goalMessage = Message.user(
              "[Goal still active]\n" +
                `Condition: ${decision.condition ?? ""}\n` +
                `Evaluator: ${decision.reason ?? ""}\n` +
                "Continue working and surface the missing evidence.",
            );
            this.addMessage(goalMessage);
            conversation.push(goalMessage.toChatMessage());
            continue;
          }
          if (decision.action !== "allow") {
            this.trace(
              `\n🎯 goal gate: ${decision.action}${
                decision.reason ? `: ${decision.reason.slice(0, 100)}` : ""
              }`,
            );
          }
        }
        response = result.content ?? "";
        this.trace(`\n✔ 循环结束：模型未再调用工具（共 ${iteration + 1} 次模型调用）`);
        await this.traceLog?.emit({ type: "loop_end", rounds: iteration + 1 });
        await this.traceLog?.emit({
          type: "run_end",
          answer: response,
          durationMs: Date.now() - startedAt,
        });
        // s09 对齐：回合自然结束后提取记忆（fail-open，不影响已产出的答案）
        if (this.onRunCompleted) {
          try {
            await this.onRunCompleted({
              history: this.history,
              input: input ?? "",
              answer: response,
            });
          } catch (error) {
            console.warn(
              `⚠️ [onRunCompleted] 回合后回调失败（答案不受影响）: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return response;
      }

      // 观察点（对齐 s01/s02 code.py 的轨迹输出）：
      // 每轮打印模型发起的调用数与参数摘要，逐个执行后回显截断结果
      this.trace(
        `\n🔧 第 ${iteration + 1} 轮：模型发起 ${result.toolCalls.length} 个工具调用`,
      );

      // 轨迹双写：conversation 驱动本轮循环，history 持久到下一轮。
      // assistant 消息原样回填（带 toolCalls），tool 结果按 toolCallId 回指
      conversation.push({
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls,
      });
      this.addMessage(
        new Message(result.content ?? "", "assistant", undefined, {
          toolCalls: result.toolCalls,
        }),
      );
      let compactRequested = false;
      for (const call of result.toolCalls) {
        this.trace(`   > ${call.function.name}(${summarizeArgs(call.function.arguments)})`);
        await this.traceLog?.emit({
          type: "tool_call",
          iteration: iteration + 1,
          toolCallId: call.id,
          toolName: call.function.name,
          args: call.function.arguments,
        });
        const toolStartedAt = Date.now();
        // s04 对齐：PreToolUse 软拦截——非空返回值 = 本次执行被阻止，
        // 拦截原因作为 observation 回喂（不抛异常、循环继续，与权限拒绝同语义）
        const blocked = this.hooks.triggerPreToolUse(call);
        let output: string;
        if (blocked !== undefined) {
          output = `⛔ hook 拦截: ${blocked}`;
        } else if (
          this.contextCompactor &&
          call.function.name === COMPACT_TOOL_NAME
        ) {
          // s08 对齐：模型主动请求压缩——确认文案先回喂，
          // compactHistory 等本批全部工具执行完、结果全部回喂后再执行
          output = "Compaction requested after this tool batch.";
          compactRequested = true;
        } else {
          output = await this.executeFunctionCall(call);
          this.hooks.triggerPostToolUse(call, output);
        }
        await this.traceLog?.emit({
          type: "tool_result",
          iteration: iteration + 1,
          toolCallId: call.id,
          toolName: call.function.name,
          output,
          durationMs: Date.now() - toolStartedAt,
        });
        this.trace(`   = ${truncateForTrace(output)}`);
        conversation.push({
          role: "tool",
          content: output,
          toolCallId: call.id,
          name: call.function.name,
        });
        this.addMessage(
          new Message(output, "tool", call.function.name, {
            toolCallId: call.id,
          }),
        );
      }

      // s05 对齐：连续 3 个工具轮未使用 todo_write → 注入 reminder 并清零。
      // lcc 把 reminder 作为 text block 并入本轮 tool_results 的 user 消息；
      // OpenAI 协议下翻译为独立 role:"user" 消息，语义等价（入 history）。
      if (this.toolRegistry.getTool("todo_write")) {
        const usedTodo = result.toolCalls.some(
          (call) => call.function.name === "todo_write",
        );
        this.roundsSinceTodoWrite = usedTodo
          ? 0
          : this.roundsSinceTodoWrite + 1;
        if (this.roundsSinceTodoWrite >= TODO_REMINDER_ROUNDS) {
          this.trace("\n🔔 todo reminder：连续 3 轮未更新计划");
          const reminder = Message.user("<reminder>Update your todos.</reminder>");
          this.addMessage(reminder);
          conversation.push(reminder.toChatMessage());
          this.roundsSinceTodoWrite = 0;
        }
      }

      // s08 对齐：compact 请求在整批工具结果回喂后统一压缩——
      // 不留孤立的 tool 消息，也不丢已发生副作用的执行记录
      if (compactRequested && this.contextCompactor) {
        const compacted = await this.contextCompactor.compactHistory(
          this.history,
          activeRequest,
          this.compactionObserver(),
        );
        this.replaceHistory(compacted);
        conversation.length = 0;
        conversation.push(...this.buildConversation());
        this.trace("\n📦 compact：历史已替换为 [Compacted] 摘要（完整轨迹已归档）");
      }
    }

    // 达到最大轮数：强制收尾（文本模式，禁止再调工具）。
    // nudge 只进本轮 conversation、不入 history——持久化会让下一轮
    // 的模型看到"别再调工具"而不敢使用工具，污染后续任务
    this.trace(`\n⏹ 达到最大轮数（${this.maxToolIterations}），强制文本收尾`);
    await this.traceLog?.emit({ type: "forced_final" });
    conversation.push({
      role: "user",
      content: "请根据以上工具执行结果，直接给出最终回答，不要再调用任何工具。",
    });
    response = await this.llm.invoke(conversation);
    await this.traceLog?.emit({
      type: "run_end",
      answer: response,
      durationMs: Date.now() - startedAt,
    });
    this.addMessage(Message.assistant(response));
    return response;
  }

  /**
   * 由注册表构建 OpenAI 工具 Schema（对应书 _build_tool_schemas）：
   * 工具自带 JSON Schema 优先；纯文本协议工具合成 {input: string} 兜底。
   */
  buildToolSchemas(): ToolSchema[] {
    return this.toolRegistry.listTools().map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters:
          tool.parametersSchema ?? {
            type: "object",
            properties: {
              input: {
                type: "string",
                description: tool.parametersDescription,
              },
            },
            required: ["input"],
          },
      },
    }));
  }

  private async executeFunctionCall(call: ToolCallRequest): Promise<string> {
    try {
      // 结构化工具：模型 JSON 参数直达 executeArgs，零展平损耗（s02 对齐）
      const tool = this.toolRegistry.getTool(call.function.name);
      if (tool?.executeArgs) {
        const args = parseJsonObjectArguments(call.function.arguments);
        return await this.toolRegistry.executeToolArgs(call.function.name, args);
      }
      // 字符串契约工具：保持展平兜底（存量工具兼容）
      const input = flattenArguments(call.function.arguments);
      return await this.toolRegistry.executeTool(call.function.name, input);
    } catch (error) {
      return `❌ ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  /**
   * 带 reactive 补救的模型调用（s08 对齐）：API 明确拒绝超长上下文时，
   * 摘要较早历史并保留最近几条，重试至多 MAX_REACTIVE_RETRIES 次；
   * 无 compactor 或非超长错误原样抛出。
   */
  private async invokeModel(
    conversation: Parameters<NonNullable<ChatLLM["invokeWithTools"]>>[0],
    tools: ReturnType<FunctionCallAgent["buildToolSchemas"]>,
    activeRequest: string,
  ) {
    let retries = 0;
    for (;;) {
      try {
        if (this.llmRecovery) {
          // s15 对齐 lcc call_llm 的 with_retry 包装（429/529 退避 + fallback 切换）
          return await this.llmRecovery.invokeWithRetry((llm, invokeOptions) =>
            llm.invokeWithTools!(conversation, tools, invokeOptions),
          );
        }
        return await this.llm.invokeWithTools?.(conversation, tools);
      } catch (error) {
        if (
          this.contextCompactor &&
          retries < MAX_REACTIVE_RETRIES &&
          isPromptTooLongError(error)
        ) {
          retries += 1;
          const compacted = await this.contextCompactor.reactiveCompact(
            this.history,
            activeRequest,
            this.compactionObserver(),
          );
          this.replaceHistory(compacted);
          conversation.length = 0;
          conversation.push(...this.buildConversation());
          this.trace(`\n⚡ reactive compact：上下文被拒后压缩重试（第 ${retries} 次）`);
          continue;
        }
        throw error;
      }
    }
  }

  /** s15 对齐 lcc 3184 acknowledge_cron_jobs：模型成功后逐个确认本轮排空任务 */
  private async acknowledgePendingScheduled(
    jobs: ScheduledPromptJob[],
  ): Promise<void> {
    for (const job of jobs) {
      await job.acknowledge();
    }
  }

  /** s15 对齐 lcc 3178 restore_cron_jobs：模型最终失败后重入队（至少一次） */
  private restorePendingScheduled(jobs: ScheduledPromptJob[]): void {
    for (const job of jobs) {
      job.restore();
    }
  }

  /** 用压缩结果整体替换 history（history 引用只读、内容可变） */
  private replaceHistory(messages: Message[]): void {
    this.history.length = 0;
    this.history.push(...messages);
  }

  /** systemPromptBuilder 产出的 system 优先生效（s09 召回注入） */
  protected override buildConversation() {
    const conversation = super.buildConversation();
    if (this.activeSystemPrompt !== undefined && conversation[0]?.role === "system") {
      conversation[0] = { role: "system", content: this.activeSystemPrompt };
    }
    return conversation;
  }

  /** 执行轨迹输出（config.verbose 开启时打印；对齐 s01/s02 的控制台 UX） */
  private trace(message: string): void {
    if (!this.config.verbose) return;
    const prefixed =
      this.tracePrefix === undefined
        ? message
        : message.replace(/^(\n?)/, `$1${this.tracePrefix}`);
    console.log(prefixed);
  }

  /**
   * s08 观测桥：机制层的 CompactionOperation 统一转成 traceLog 事件；
   * verbose 模式下再用 [compact]/[sub-compact] 前缀输出当下可见摘要。
   * 与 [HOOK]/[sub-hook] 的分工一致：traceLog 事后查得到，console 当下看得见。
   */
  private compactionObserver(): CompactionObserver | undefined {
    if (!this.traceLog && !this.config.verbose) return undefined;
    return async (operation) => {
      await this.traceLog?.emit({
        type: "compaction",
        compactionStage: operation.stage,
        detail: operation.detail,
        beforeMessages: operation.beforeMessages,
        afterMessages: operation.afterMessages,
        beforeChars: operation.beforeChars,
        afterChars: operation.afterChars,
        durationMs: operation.durationMs,
        ...(operation.artifacts.length > 0
          ? { artifacts: [...operation.artifacts] }
          : {}),
      });

      if (!this.config.verbose) return;
      const tag = this.tracePrefix === undefined ? "compact" : "sub-compact";
      const delta = operation.beforeChars - operation.afterChars;
      const artifacts = operation.artifacts.length
        ? ` · files: ${operation.artifacts
            .map((path) => truncateForTrace(path, 120))
            .join(", ")}`
        : "";
      this.trace(
        `\n📦 [${tag}] ${operation.stage}: ` +
          `${operation.beforeMessages}→${operation.afterMessages} msgs, ` +
          `${operation.beforeChars}→${operation.afterChars} chars ` +
          `(${delta >= 0 ? "-" : "+"}${Math.abs(delta)}) · ` +
          `${operation.durationMs}ms${artifacts}`,
      );
    };
  }
}

/** 轨迹用的参数摘要：单字符串字段直接展示，其余截断 JSON */
function summarizeArgs(argsJson: string): string {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    if (typeof parsed === "string") return truncateForTrace(parsed, 80);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>);
      if (values.length === 1 && typeof values[0] === "string") {
        return truncateForTrace(values[0], 80);
      }
    }
  } catch {
    // 非 JSON 参数原样展示
  }
  return truncateForTrace(argsJson, 80);
}

/** 轨迹截断（对齐 s01/s02 code.py 的 output[:200]） */
function truncateForTrace(text: string, limit = 200): string {
  const flattened = text.replace(/\s+/g, " ").trim();
  return flattened.length > limit ? `${flattened.slice(0, limit)}...` : flattened;
}

/**
 * 参数展平（对应书 _parse_function_call_arguments）：
 * 字符串协议工具吃一个字符串——JSON 参数里的单一字符串值直接取出，
 * 多参数对象序列化回字符串。
 */
export function flattenArguments(argumentsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return argumentsJson; // 模型输出非法 JSON 时按原字符串传给工具
  }

  if (typeof parsed === "string") return parsed;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const values = Object.values(parsed);
    if (values.length === 1 && typeof values[0] === "string") {
      return values[0];
    }
    const named = parsed as Record<string, unknown>;
    for (const key of ["expression", "query", "input", "text"]) {
      if (typeof named[key] === "string") return named[key] as string;
    }
    return JSON.stringify(parsed);
  }
  return JSON.stringify(parsed);
}
