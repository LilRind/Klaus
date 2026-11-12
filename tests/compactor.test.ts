/**
 * s08 Context Compact 离线验收（对齐 README 三个实验的机制层）
 *
 * - 四步管线各自的阈值触发/不触发、落盘产物、边界避让；
 * - prepare 全管线顺序（低成本优先，LLM 摘要只作最后手段）；
 * - Agent 集成：compact 工具批后压缩、reactive 补救重试与限次。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  ContextCompactor,
  isPromptTooLongError,
  SUMMARY_MAX_TOKENS,
} from "../src/context/compactor";
import { CompactTool } from "../src/tools/builtin/compact-tool";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { WriteFileTool } from "../src/tools/builtin/file-tools";
import { AgentTraceLog } from "../src/core/trace-log";
import { AgentConfig } from "../src/core/config";
import type { CompactionOperation } from "../src/context/compactor";
import { Message, type ToolCallRequest } from "../src/core/message";
import type {
  ChatLLM,
  LLMInvokeOptions,
  LLMProvider,
  ToolInvocationResult,
  ToolSchema,
} from "../src/core/llm";
import type { ChatMessage } from "../src/core/message";
import { ScriptedLLM } from "./scripted-llm";

const roots: string[] = [];

async function makeDirs(): Promise<{
  root: string;
  transcripts: string;
  outputs: string;
}> {
  const root = path.join("test_tmp", `compact_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  const transcripts = path.join(root, ".transcripts");
  const outputs = path.join(root, "task-outputs");
  await fs.mkdir(transcripts, { recursive: true });
  await fs.mkdir(outputs, { recursive: true });
  return { root, transcripts, outputs };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

// ---------- 历史构造辅助 ----------

function user(content: string): Message {
  return Message.user(content);
}

function toolResult(content: string, id: string): Message {
  return new Message(content, "tool", "echo", { toolCallId: id });
}

function assistantWithCalls(...ids: string[]): Message {
  const toolCalls: ToolCallRequest[] = ids.map((id) => ({
    id,
    type: "function",
    function: { name: "echo", arguments: "{}" },
  }));
  return new Message("", "assistant", undefined, { toolCalls });
}

function assistant(content: string): Message {
  return Message.assistant(content);
}

describe("isPromptTooLongError", () => {
  it("识别三种超长错误（大小写不敏感），其他错误不匹配", () => {
    expect(isPromptTooLongError(new Error("API Error: prompt_too_long"))).toBe(true);
    expect(isPromptTooLongError(new Error("Prompt is too long"))).toBe(true);
    expect(isPromptTooLongError(new Error("too many tokens requested"))).toBe(true);
    expect(isPromptTooLongError(new Error("network timeout"))).toBe(false);
    expect(isPromptTooLongError("plain prompt_too_long")).toBe(true);
  });
});

describe("第 1 步 toolResultBudget", () => {
  it("未超预算：原样返回（含浅拷贝）", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      batchCharLimit: 1000,
      largeResultCharLimit: 100,
    });
    const history = [
      user("任务"),
      assistantWithCalls("c1"),
      toolResult("short", "c1"),
    ];
    const result = await compactor.toolResultBudget(history);
    expect(result).toHaveLength(3);
    expect(result[2]?.content).toBe("short");
  });

  it("超预算：最大超限结果转存磁盘，上下文留路径+预览，元数据保留", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      batchCharLimit: 1000,
      largeResultCharLimit: 100,
      largeResultPreviewChars: 50,
    });
    const big = "A".repeat(2000);
    const history = [
      user("任务"),
      assistantWithCalls("c1", "c2"),
      toolResult(big, "c1"),
      toolResult("keep me", "c2"),
    ];
    const result = await compactor.toolResultBudget(history);

    const replaced = result[2];
    expect(replaced?.content).toContain("[Full output saved at ");
    expect(replaced?.content).toContain("...");
    expect(replaced?.content.length).toBeLessThan(200);
    // 小结果不动
    expect(result[3]?.content).toBe("keep me");
    // 完整内容落盘可恢复
    const match = /\[Full output saved at ([^\]]+)\]/.exec(replaced?.content ?? "");
    expect(match).not.toBeNull();
    const saved = await fs.readFile(match![1]!, "utf8");
    expect(saved).toBe(big);
  });
});

describe("第 2 步 snipCompact", () => {
  it("未达触发条数：不动", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      triggerMessages: 10,
      targetMessages: 6,
    });
    const history = [user("a"), assistant("b"), user("c")];
    expect(await compactor.snipCompact(history)).toHaveLength(3);
  });

  it("达阈值：头3 + 归档标记 + 尾部，transcript 落盘", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      triggerMessages: 10,
      targetMessages: 6,
    });
    // 12 条消息：0..11
    const history: Message[] = [
      user("m0"),
      assistant("m1"),
      user("m2"),
      ...Array.from({ length: 9 }, (_, i) => user(`tail-${i}`)),
    ];
    const result = await compactor.snipCompact(history);

    // 头 3 + 1 标记 + 尾部（6 - 3 - 1 = 2 条）
    expect(result).toHaveLength(6);
    expect(result[0]?.content).toBe("m0");
    expect(result[2]?.content).toBe("m2");
    const marker = result[3];
    expect(marker?.role).toBe("user");
    expect(marker?.content).toMatch(/^\[\d+ messages archived at .+\]$/);
    expect(result[4]?.content).toBe("tail-7");
    expect(result[5]?.content).toBe("tail-8");
    // transcript 文件存在且含完整历史
    const transcriptPath = marker?.content.match(/archived at (.+)\]/)?.[1];
    const transcript = await fs.readFile(transcriptPath!, "utf8");
    expect(transcript).toContain("tail-0");
  });

  it("头/尾切点避开 assistant(toolCalls) 与其 tool 结果对的边界", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      triggerMessages: 10,
      targetMessages: 6,
    });
    // history[2] = assistant(c9) 且 history[3] = 其 tool 结果 → 头延伸吞掉
    // 尾部起点若落在 tool 结果上且前一条是 assistant(调用) → 前移
    const history: Message[] = [
      user("m0"),
      assistant("m1"),
      assistantWithCalls("c9"),
      toolResult("pair-result", "c9"),
      ...Array.from({ length: 5 }, (_, i) => user(`mid-${i}`)),
      assistantWithCalls("c8"),
      toolResult("tail-pair", "c8"),
      user("last"),
    ];
    const result = await compactor.snipCompact(history);

    // 头 3 扩展后必须包含 c9 的结果（不孤立 assistant）
    expect(result.slice(0, 4).some((m) => m.content === "pair-result")).toBe(true);
    // 尾部不允许出现无对应 assistant 的 tool 消息
    const tail = result.slice(result.findIndex((m) => m.content.includes("archived")) + 1);
    for (const [i, m] of tail.entries()) {
      if (m.role === "tool") {
        const prev = tail[i - 1];
        expect(prev?.role === "assistant" && (prev.toolCalls?.length ?? 0) > 0).toBe(true);
      }
    }
  });
});

describe("ensureActiveRequest", () => {
  it("压缩移走当前请求后补回；可见副本存在时不重复；未变化时不动", () => {
    const compactor = new ContextCompactor(new ScriptedLLM([]));
    const archived = [Message.user("旧上下文")];

    const restored = compactor.ensureActiveRequest(archived, "当前任务", true);
    expect(restored.at(-1)?.content).toBe("当前任务");

    const visible = [Message.user("当前任务")];
    expect(
      compactor.ensureActiveRequest(visible, "当前任务", true),
    ).toHaveLength(1);

    expect(
      compactor.ensureActiveRequest(archived, "当前任务", false),
    ).toHaveLength(1);
  });
});

describe("第 3 步 microCompact / fitToolResults", () => {
  it("已读早期结果替换为落盘引用，保留最近 3 条，未读批次不动", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      keepRecentResults: 3,
      minReplacableChars: 10,
    });
    const long = (s: string) => `${s}-${"X".repeat(200)}`;
    const history: Message[] = [
      user("任务"),
      assistantWithCalls("c1", "c2", "c3", "c4", "c5", "c6"),
      toolResult(long("old1"), "c1"),
      toolResult(long("old2"), "c2"),
      toolResult(long("old3"), "c3"),
      toolResult(long("kept1"), "c4"),
      toolResult(long("kept2"), "c5"),
      toolResult(long("kept3"), "c6"),
      assistant("中间结论"),
      // 未读批次：最后一条 assistant 之后
      assistantWithCalls("c7"),
      toolResult(long("unseen"), "c7"),
    ];
    const result = await compactor.microCompact(history, 0);

    expect(result[2]?.content).toContain("[Earlier tool result saved at ");
    expect(result[3]?.content).toContain("[Earlier tool result saved at ");
    expect(result[4]?.content).toContain("[Earlier tool result saved at ");
    expect(result[5]?.content).toContain("kept1");
    expect(result[6]?.content).toContain("kept2");
    expect(result[7]?.content).toContain("kept3");
    // 未读批次原样
    expect(result[10]?.content).toContain("unseen");
    // 替换前完整内容落盘
    const savedPath = result[2]?.content.match(/saved at (.+)\]/)?.[1];
    const saved = await fs.readFile(savedPath!, "utf8");
    expect(saved).toContain("old1");
  });

  it("fitToolResults：未读批次爆表 → 最大结果转存 + 短预览", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      unseenPreviewChars: 100,
    });
    const history: Message[] = [
      user("任务"),
      assistantWithCalls("c1", "c2"),
      toolResult("B".repeat(5000), "c1"),
      toolResult("S".repeat(100), "c2"),
    ];
    const result = await compactor.fitToolResults(history, 1000);

    expect(result[2]?.content).toContain("[Full output saved at ");
    expect(result[2]?.content.length).toBeLessThan(300);
    expect(result[3]?.content).toBe("S".repeat(100));
  });

  it("fitToolResults 处理全部工具结果，并基于整体估算判断停止", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      unseenPreviewChars: 50,
    });
    const history: Message[] = [
      user("任务"),
      assistantWithCalls("c1", "c2", "c3", "c4"),
      toolResult(`old1-${"A".repeat(1000)}`, "c1"),
      toolResult(`old2-${"A".repeat(1000)}`, "c2"),
      toolResult(`old3-${"A".repeat(1000)}`, "c3"),
      toolResult(`old4-${"A".repeat(1000)}`, "c4"),
      assistant("模型已读过全部结果"),
    ];
    const result = await compactor.fitToolResults(history, 1000);

    // 最后一条 assistant 后没有未读批次；fit 仍应处理最近 3 条已读结果。
    const recent = result.find((message) => message.toolCallId === "c4");
    expect(recent?.content).toContain("[Full output saved at ");
    expect(recent?.content).not.toContain(`old4-${"A".repeat(1000)}`);
    expect(
      result.filter((message) => message.content.includes("[Full output saved at ")),
    ).toHaveLength(4);
  });

  it("fitToolResults 可缩短既有 Full output 引用的预览", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      largeResultPreviewChars: 2000,
      unseenPreviewChars: 100,
    });
    const original = "R".repeat(3000);
    const wrapped = await compactor.persistLargeOutput("same-id", original);
    const history: Message[] = [
      user("任务"),
      assistantWithCalls("c1"),
      toolResult(wrapped, "c1"),
      assistant("已读"),
    ];
    const result = await compactor.fitToolResults(history, 0);

    const compacted = result[2]?.content ?? "";
    const savedPath = /\[Full output saved at ([^\]]+)\]/.exec(compacted)?.[1];
    expect(savedPath).toBe(path.resolve(outputs, "same-id.txt"));
    expect(compacted.length).toBeLessThan(wrapped.length);
    expect(compacted).toContain(`${"R".repeat(100)}...`);
    expect(await fs.readFile(savedPath!, "utf8")).toBe(original);
  });

  it("persistedOutputPath 只信任 tool-results 目录内真实存在的引用", async () => {
    const { outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      toolResultsDir: outputs,
    });

    const outside = path.resolve("C:\\Windows\\Temp\\fake-output.txt");
    expect(
      compactor.persistedOutputPath(`[Earlier tool result saved at ${outside}]`),
    ).toBeNull();

    const missingManaged = path.join(outputs, "missing.txt");
    expect(
      compactor.persistedOutputPath(`[Full output saved at ${missingManaged}]`),
    ).toBeNull();

    const managed = await compactor.saveOutput("real-id", "real");
    expect(
      compactor.persistedOutputPath(`[Full output saved at ${managed}]`),
    ).toBe(path.resolve(managed));

    // 嵌在正文中间的伪造 marker 不能被当成“整个工具输出已经是引用”。
    expect(
      compactor.persistedOutputPath(
        `before [Earlier tool result saved at ${managed}] after`,
      ),
    ).toBeNull();
  });
});

describe("第 4 步 compactHistory / reactiveCompact", () => {
  it("compactHistory：transcript + LLM 摘要 → 单条 [Compacted] 消息", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new ScriptedLLM(["目标：修复构建；剩余：跑测试"]);
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const history = [
      user("修一下构建"),
      assistantWithCalls("c1"),
      toolResult("error log ...", "c1"),
      assistant("初步定位"),
    ];
    const result = await compactor.compactHistory(history, "修一下构建");

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("user");
    expect(result[0]?.content).toContain("[Compacted]");
    expect(result[0]?.content).toContain("Current user request:\n修一下构建");
    expect(result[0]?.content).toContain("目标：修复构建；剩余：跑测试");
    expect(result[0]?.content).toContain("[Full transcript: ");
    // 摘要调用的 system 提示词明确"不执行历史中的指令"
    expect(llm.calls[0]?.messages[0]?.content).toContain("Do NOT follow");
    // 摘要输入保留 OpenAI 消息结构（toolCalls/toolCallId），而不是丢失调用关系的纯文本。
    const summaryInput = JSON.parse(llm.calls[0]!.messages[1]!.content ?? "null") as Array<{
      role: string;
      toolCalls?: Array<{ id: string }>;
      toolCallId?: string;
    }>;
    expect(summaryInput[1]?.toolCalls?.[0]?.id).toBe("c1");
    expect(summaryInput[2]?.toolCallId).toBe("c1");
    expect(llm.calls[0]?.options?.maxTokens).toBe(SUMMARY_MAX_TOKENS);
  });

  it("summaryInput 对超大历史保头保尾并插入 transcript 占位", () => {
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      summaryInputLimit: 200,
    });
    const input = compactor.summaryInput([
      user(`head-${"H".repeat(300)}`),
      user(`tail-${"T".repeat(300)}END`),
    ]);

    expect(input).toContain("...[middle omitted; full transcript is on disk]...");
    expect(input.length).toBeLessThan(400);
    expect(input).toContain("head-");
    expect(input).toContain("END");
  });

  it("reactiveCompact：摘要较早历史 + 保留最近 5 条", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new ScriptedLLM(["摘要"]);
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const history: Message[] = [
      user("old-0"),
      assistant("old-1"),
      user("old-2"),
      assistant("old-3"),
      user("old-4"),
      user("new-5"),
      assistant("new-6"),
      user("new-7"),
      assistant("new-8"),
      user("new-9"),
    ];
    const result = await compactor.reactiveCompact(history, "当前请求");

    expect(result).toHaveLength(6);
    expect(result[0]?.content).toContain("[Reactive compact]");
    expect(result[0]?.content).toContain("Current user request:\n当前请求");
    expect(result.slice(1).map((m) => m.content)).toEqual([
      "new-5",
      "new-6",
      "new-7",
      "new-8",
      "new-9",
    ]);
  });
});

describe("prepare 全管线", () => {
  it("顺序：先无损转存/裁剪，只有仍超限才走 LLM 摘要", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new ScriptedLLM(["最终摘要"]);
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      triggerMessages: 100, // 不触发 snip，专注字符链路
      // 路径引用本身有长度（Windows 绝对路径 ~100+ 字符），
      // 3 条替换后约 1900 字符，阈值取 2000：micro 后应停在限内、不升级摘要
      contextCharLimit: 2000,
      minReplacableChars: 10,
      keepRecentResults: 1,
    });
    const long = (s: string) => `${s}-${"X".repeat(800)}`;
    const history: Message[] = [
      user("大任务"),
      assistantWithCalls("c1", "c2", "c3", "c4"),
      toolResult(long("seen1"), "c1"),
      toolResult(long("seen2"), "c2"),
      toolResult(long("seen3"), "c3"),
      toolResult(long("recent"), "c4"),
      assistant("继续"),
    ];
    const result = await compactor.prepare(history, "大任务");

    // micro 已把早期已读结果换成引用，总量应降到限内 → 不需要 LLM 摘要
    expect(result.some((m) => m.content.includes("[Earlier tool result saved at"))).toBe(true);
    expect(result.some((m) => m.content.includes("[Compacted]"))).toBe(false);
    expect(llm.invokeCount).toBe(0);
  });

  it("micro/fit 仍超限 → compactHistory 兜底（LLM 摘要）", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new ScriptedLLM(["兜底摘要"]);
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      triggerMessages: 100,
      contextCharLimit: 300,
      minReplacableChars: 10,
    });
    const history: Message[] = [
      user("超大任务"),
      assistant("很长的说明".repeat(100)),
    ];
    const result = await compactor.prepare(history, "超大任务");

    expect(result).toHaveLength(1);
    expect(result[0]?.content).toContain("[Compacted]");
    expect(llm.invokeCount).toBe(1);
  });

  it("prepare 只上报真实触发的压缩阶段，并带规模变化与恢复产物", async () => {
    const { transcripts, outputs } = await makeDirs();
    const compactor = new ContextCompactor(new ScriptedLLM([]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
      batchCharLimit: 100,
      largeResultCharLimit: 50,
      largeResultPreviewChars: 10,
      triggerMessages: 100,
      contextCharLimit: 100_000,
    });
    const big = "A".repeat(500);
    const history: Message[] = [
      user("任务"),
      assistantWithCalls("c1", "c2"),
      toolResult(big, "c1"),
      toolResult("short", "c2"),
    ];
    const operations: CompactionOperation[] = [];
    const result = await compactor.prepare(history, "任务", (operation) => {
      operations.push(operation);
    });

    // snip/restore/字符链路均未触发；只有第 1 步真实改写 history
    expect(operations.map((operation) => operation.stage)).toEqual([
      "toolResultBudget",
    ]);
    const operation = operations[0]!;
    expect(operation.detail).toContain("[Full output saved at ");
    expect(operation.detail).toContain("AAAA");
    expect(operation.beforeMessages).toBe(4);
    expect(operation.afterMessages).toBe(4);
    expect(operation.beforeChars).toBeGreaterThan(operation.afterChars);
    expect(operation.artifacts).toHaveLength(1);
    const artifact = operation.artifacts[0]!;
    expect(await fs.readFile(artifact, "utf8")).toBe(big);
    expect(
      result.find((message) => message.content.includes(`saved at ${artifact}`)),
    ).toBeDefined();
  });

  it("compactHistory 与 reactiveCompact 观测事件都暴露 transcript", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new ScriptedLLM(["摘要", "摘要"]);
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const compacted: CompactionOperation[] = [];
    const reactive: CompactionOperation[] = [];
    const history = [user("旧任务"), assistant("旧结论")];
    await compactor.compactHistory(history, "当前请求", (operation) => {
      compacted.push(operation);
    });
    const longHistory = Array.from({ length: 10 }, (_, i) =>
      user(`message-${i}`),
    );
    await compactor.reactiveCompact(longHistory, "当前请求", (operation) => {
      reactive.push(operation);
    });

    expect(compacted.map((operation) => operation.stage)).toEqual([
      "compactHistory",
    ]);
    expect(reactive.map((operation) => operation.stage)).toEqual([
      "reactiveCompact",
    ]);
    expect(compacted[0]!.artifacts[0]).toContain(".transcripts");
    expect(compacted[0]!.detail).toContain("[Compacted]");
    expect(compacted[0]!.detail).toContain("摘要");
    expect(reactive[0]!.afterMessages).toBe(6);
    expect(reactive[0]!.detail).toContain("[Reactive compact]");
    expect(await fs.readFile(compacted[0]!.artifacts[0]!, "utf8")).toContain(
      "旧结论",
    );
  });
});

// ---------- Agent 集成 ----------

/** 可控失败次数的 LLM 桩：前 failTimes 次 invokeWithTools 抛超长错误 */
class FlakyToolsLLM implements ChatLLM {
  readonly model = "flaky";
  readonly provider: LLMProvider = "custom";
  toolCallCount = 0;

  constructor(
    private readonly failTimes: number,
    private readonly result: ToolInvocationResult,
  ) {}

  async invoke(_messages: ChatMessage[], _options?: LLMInvokeOptions): Promise<string> {
    return "摘要占位";
  }

  async *stream(messages: ChatMessage[]): AsyncGenerator<string> {
    yield await this.invoke(messages);
  }

  async invokeWithTools(
    _messages: ChatMessage[],
    _tools: ToolSchema[],
  ): Promise<ToolInvocationResult> {
    this.toolCallCount += 1;
    if (this.toolCallCount <= this.failTimes) {
      throw new Error("API Error: prompt is too long");
    }
    return this.result;
  }
}

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

describe("FunctionCallAgent × compactor（s08 集成）", () => {
  it("compact 工具：整批执行回喂后历史替换为单条 [Compacted]", async () => {
    const { root, transcripts, outputs } = await makeDirs();
    await fs.writeFile(path.join(root, "a.txt"), "old", "utf8");
    const llm = new ScriptedLLM([], [
      {
        content: null,
        toolCalls: [
          call("c1", "write_file", { path: "a.txt", content: "new content" }),
          call("c2", "compact", {}),
        ],
      },
      { content: "阶段完成", toolCalls: [] },
    ]);
    const compactor = new ContextCompactor(new ScriptedLLM(["阶段摘要"]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const registry = new ToolRegistry()
      .register(new WriteFileTool({ workspace: root }))
      .register(new CompactTool());
    const traceLog = new AgentTraceLog("compact-a", path.join(root, "trace"), {
      markdown: false,
    });
    const agent = new FunctionCallAgent("a", llm, registry, {
      contextCompactor: compactor,
      traceLog,
    });

    const answer = await agent.run("更新 a.txt 然后压缩");

    expect(answer).toBe("阶段完成");
    // 写入真实发生（副作用不被压缩吞掉）
    expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("new content");
    // 历史被替换为 [Compacted] 单消息 + 最终回答
    const contents = agent.getHistory().map((m) => m.content);
    expect(contents[0]).toContain("[Compacted]");
    expect(contents[0]).toContain("Current user request:\n更新 a.txt 然后压缩");
    expect(agent.getHistory().at(-1)?.content).toBe("阶段完成");
    // 第二次模型调用看到的是压缩后的对话（无 write_file 轨迹）
    const secondCallMessages = llm.toolCallsList[1]?.messages ?? [];
    expect(secondCallMessages.some((m) => m.role === "tool")).toBe(false);
    expect(secondCallMessages.some((m) => m.content?.includes("[Compacted]"))).toBe(true);
    // transcript 归档存在
    const files = await fs.readdir(transcripts);
    expect(files.length).toBeGreaterThanOrEqual(1);
    // compact 请求的机制层事件进入结构化 traceLog（与 hook 事件同级可审计）
    const events = await traceLog.readDay();
    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction?.compactionStage).toBe("compactHistory");
    expect(compaction?.afterMessages).toBe(1);
    expect(compaction?.detail).toContain("[Compacted]");
  });

  it("reactive：超长错误触发压缩重试一次并成功", async () => {
    const { root, transcripts, outputs } = await makeDirs();
    const llm = new FlakyToolsLLM(1, { content: "恢复后回答", toolCalls: [] });
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const registry = new ToolRegistry().register(new CompactTool());
    const traceLog = new AgentTraceLog("compact-reactive", path.join(root, "trace"), {
      markdown: false,
    });
    const agent = new FunctionCallAgent("a", llm, registry, {
      contextCompactor: compactor,
      traceLog,
    });

    const answer = await agent.run("触发超长的任务");

    expect(answer).toBe("恢复后回答");
    expect(llm.toolCallCount).toBe(2); // 1 次失败 + 1 次重试成功
    expect(agent.getHistory()[0]?.content).toContain("[Reactive compact]");
    expect(agent.getHistory()[0]?.content).toContain("Current user request:\n触发超长的任务");
    // API 超长后的第 1 次补救也可事后审计
    const events = await traceLog.readDay();
    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction?.compactionStage).toBe("reactiveCompact");
    expect(compaction?.beforeMessages).toBe(1);
    expect(compaction?.detail).toContain("[Reactive compact]");
    expect(compaction?.detail).toContain("Current user request:");
  });

  it("reactive 补救保留 cron 注入后的 activeRequest", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new FlakyToolsLLM(1, { content: "恢复后回答", toolCalls: [] });
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const registry = new ToolRegistry().register(new CompactTool());
    const acknowledged: string[] = [];
    const agent = new FunctionCallAgent("scheduled", llm, registry, {
      contextCompactor: compactor,
      collectScheduledPrompts: async () => [
        {
          prompt: "nightly check",
          acknowledge: async () => {
            acknowledged.push("nightly check");
          },
          restore: () => undefined,
        },
      ],
    });

    const answer = await agent.runEventTurn();

    expect(answer).toBe("恢复后回答");
    expect(acknowledged).toEqual(["nightly check"]);
    expect(agent.getHistory()[0]?.content).toContain(
      "Current user request:\nRun scheduled task: nightly check",
    );
  });

  it("reactive 限次：重试后仍超长 → 错误向上抛", async () => {
    const { transcripts, outputs } = await makeDirs();
    const llm = new FlakyToolsLLM(5, { content: "never", toolCalls: [] });
    const compactor = new ContextCompactor(llm, {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const registry = new ToolRegistry().register(new CompactTool());
    const agent = new FunctionCallAgent("a", llm, registry, { contextCompactor: compactor });

    await expect(agent.run("一直超长")).rejects.toThrow(/prompt is too long/);
    expect(llm.toolCallCount).toBe(2); // MAX_REACTIVE_RETRIES = 1
  });

  it("verbose 压缩日志使用 [compact]，子 agent 使用 [sub-compact]", async () => {
    const { transcripts, outputs } = await makeDirs();
    const consoleLogs: unknown[][] = [];
    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation((...args) => consoleLogs.push(args));

    const compactScript = [
      { content: null, toolCalls: [call("c1", "compact", {})] },
      { content: "完成", toolCalls: [] },
    ];
    const compactor = new ContextCompactor(new ScriptedLLM(["摘要", "摘要"]), {
      transcriptDir: transcripts,
      toolResultsDir: outputs,
    });
    const registry = new ToolRegistry().register(new CompactTool());
    const parent = new FunctionCallAgent("parent", new ScriptedLLM([], compactScript), registry, {
      contextCompactor: compactor,
      config: new AgentConfig({ verbose: true }),
    });
    const child = new FunctionCallAgent("child", new ScriptedLLM([], compactScript), registry, {
      contextCompactor: compactor,
      config: new AgentConfig({ verbose: true }),
      tracePrefix: "[sub-tool] ",
    });

    try {
      await parent.run("父任务");
      await child.run("子任务");
    } finally {
      logSpy.mockRestore();
    }

    const output = consoleLogs.flat().join("\n");
    expect(output).toContain("[compact] compactHistory");
    expect(output).toContain("[sub-compact] compactHistory");
  });

  it("无 compactor：compact 工具退化为普通工具（无压缩副作用）", async () => {
    const llm = new ScriptedLLM([], [
      { content: null, toolCalls: [call("c1", "compact", {})] },
      { content: "完成", toolCalls: [] },
    ]);
    const registry = new ToolRegistry().register(new CompactTool());
    const agent = new FunctionCallAgent("a", llm, registry);
    const answer = await agent.run("任务");

    expect(answer).toBe("完成");
    const toolMessage = agent.getHistory().find((m) => m.role === "tool");
    expect(toolMessage?.content).toBe("Compaction requested after this tool batch.");
    // 历史保持完整轨迹（user → assistant → tool → assistant）
    expect(agent.getHistory().map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });
});
