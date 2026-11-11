/**
 * s15 integrated harness 集成语义离线测试：
 * 轮级 cron 注入（[Scheduled] 消息 / 成功 ack / 失败 restore + [Error] 留痕）、
 * runEventTurn 事件轮（无合成用户输入）、异步轮权限文案逐字对齐、
 * hasCompleted 非破坏 peek、截断升级/续跑/放弃、装配 system 的
 * Connected MCP servers 段。
 */

import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptedLLM } from "./scripted-llm";
import {
  BackgroundManager,
  LlmRecovery,
  PermissionChecker,
  ASYNC_TURN_GENERIC_DENY,
  ASYNC_TURN_MCP_DENY,
  ASYNC_TURN_SHELL_DENY,
  CONTINUATION_PROMPT,
  DEFAULT_MAX_TOKENS,
  ESCALATED_MAX_TOKENS,
  type ScheduledPromptJob,
} from "../src/index";
import { buildAlignmentAgent } from "../examples/alignment/agent-assembly";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

async function makeWorkspace(): Promise<string> {
  const root = path.join("test_tmp", `s15_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(path.join(root, "skills"), { recursive: true });
  await fs.mkdir(path.join(root, ".memory"), { recursive: true });
  await fs.writeFile(path.join(root, "README.md"), "# s15 harness\n", "utf8");
  return root;
}

function makeAgent(
  llm: ScriptedLLM,
  options: {
    collectScheduledPrompts?: () => Promise<ScheduledPromptJob[]>;
    llmRecovery?: LlmRecovery;
  } = {},
): FunctionCallAgent {
  return new FunctionCallAgent("s15-test", llm, new ToolRegistry(), {
    maxToolIterations: 8,
    ...options,
  });
}

describe("轮级 cron 注入（对齐 lcc consume_cron_queue / acknowledge / restore）", () => {
  it("到期任务注入 [Scheduled] user 消息，模型成功后 acknowledge", async () => {
    const llm = new ScriptedLLM([], [{ content: "done", toolCalls: [] }]);
    let acked = 0;
    let restored = 0;
    const agent = makeAgent(llm, {
      collectScheduledPrompts: async () => [
        {
          prompt: "Deploy the service",
          acknowledge: async () => {
            acked += 1;
          },
          restore: () => {
            restored += 1;
          },
        },
      ],
    });
    const answer = await agent.run("hello");
    expect(answer).toBe("done");
    expect(acked).toBe(1);
    expect(restored).toBe(0);
    // 注入顺序：[Scheduled] 紧跟用户输入之后（模型调用前排空，对齐轮顶注入）
    const messages = llm.toolCallsList[0]?.messages ?? [];
    const userMessages = messages.filter((message) => message.role === "user");
    expect(userMessages[0]?.content).toBe("hello");
    expect(userMessages[1]?.content).toBe("[Scheduled] Deploy the service");
  });

  it("队列空时不注入", async () => {
    const llm = new ScriptedLLM([], [{ content: "ok", toolCalls: [] }]);
    const agent = makeAgent(llm, { collectScheduledPrompts: async () => [] });
    await agent.run("hello");
    const messages = llm.toolCallsList[0]?.messages ?? [];
    expect(messages.some((message) => String(message.content).startsWith("[Scheduled]"))).toBe(false);
  });

  it("模型最终失败：restore 重入队 + [Error] assistant 留痕进入 history", async () => {
    // 预设队列耗尽 → ScriptedLLM 抛错（fatal，不触发重试）
    const llm = new ScriptedLLM([], []);
    let acked = 0;
    let restored = 0;
    const agent = makeAgent(llm, {
      collectScheduledPrompts: async () => [
        {
          prompt: "nightly build",
          acknowledge: async () => {
            acked += 1;
          },
          restore: () => {
            restored += 1;
          },
        },
      ],
    });
    await expect(agent.run("hello")).rejects.toThrow(/预设.*耗尽|ScriptedLLM/);
    expect(acked).toBe(0);
    expect(restored).toBe(1);
    // 下一轮模型看到上一轮的 [Error] assistant 消息（留痕对齐 lcc 3179-3181）
    llm.pushToolResponse({ content: "recovered", toolCalls: [] });
    const answer = await agent.run("again");
    expect(answer).toBe("recovered");
    const messages = llm.toolCallsList.at(-1)?.messages ?? [];
    expect(
      messages.some(
        (message) =>
          message.role === "assistant" && String(message.content).startsWith("[Error] "),
      ),
    ).toBe(true);
  });
});

describe("runEventTurn（事件轮，无合成用户输入）", () => {
  it("cron 唤醒轮：不添加用户消息，[Scheduled] 注入照常工作", async () => {
    const llm = new ScriptedLLM([], [{ content: "idle done", toolCalls: [] }]);
    const agent = makeAgent(llm, {
      collectScheduledPrompts: async () => [
        {
          prompt: "meeting reminder",
          acknowledge: async () => {},
          restore: () => {},
        },
      ],
    });
    const answer = await agent.runEventTurn();
    expect(answer).toBe("idle done");
    const messages = llm.toolCallsList[0]?.messages ?? [];
    // 无空用户消息（system 之后的非 tool 消息全部来自注入）
    expect(messages.some((message) => message.role === "user" && message.content === "")).toBe(false);
    expect(
      messages.some(
        (message) =>
          message.role === "user" && message.content === "[Scheduled] meeting reminder",
      ),
    ).toBe(true);
  });

  it("团队事件唤醒轮：事件文本本身成为本轮 user 消息", async () => {
    const llm = new ScriptedLLM([], [{ content: "processed", toolCalls: [] }]);
    const agent = makeAgent(llm);
    await agent.runEventTurn("[Team events]\nreviewer: summary ready");
    const messages = llm.toolCallsList[0]?.messages ?? [];
    expect(
      messages.some(
        (message) =>
          message.role === "user" &&
          message.content === "[Team events]\nreviewer: summary ready",
      ),
    ).toBe(true);
  });
});

describe("异步轮权限视图（文案逐字对齐 lcc 1807-1825）", () => {
  function makeChecker(): PermissionChecker {
    return new PermissionChecker({
      denyRules: [
        {
          tools: ["bash"],
          test: (request) =>
            String(request.args.command ?? "").includes("rm -rf")
              ? "deny: catastrophic"
              : null,
        },
      ],
      askRules: [
        {
          tools: ["bash"],
          test: (request) =>
            String(request.args.command ?? "").includes("del")
              ? "destructive command"
              : null,
        },
        { tools: ["mcp__docs__search"], test: () => "external tool" },
        { tools: ["npm_install"], test: () => "package install" },
      ],
      prompt: { confirm: async () => true },
    });
  }

  it("异步轮 bash ask → 直接拒绝（shell 文案逐字）", async () => {
    const view = makeChecker().forAsyncTurns();
    const outcome = await view.check({
      toolName: "bash",
      args: { command: "del test.txt" },
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe(ASYNC_TURN_SHELL_DENY);
  });

  it("异步轮 MCP ask → MCP 文案；其余 ask → 通用文案", async () => {
    const view = makeChecker().forAsyncTurns();
    expect(
      (await view.check({ toolName: "mcp__docs__search", args: {} })).reason,
    ).toBe(ASYNC_TURN_MCP_DENY);
    expect(
      (await view.check({ toolName: "npm_install", args: {} })).reason,
    ).toBe(ASYNC_TURN_GENERIC_DENY);
  });

  it("deny 规则在异步轮照常生效（deny 优先于 ask）", async () => {
    const view = makeChecker().forAsyncTurns();
    const outcome = await view.check({
      toolName: "bash",
      args: { command: "rm -rf /" },
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe("deny: catastrophic");
  });

  it("前台闸门行为不变：ask 命中弹审批并放行", async () => {
    let asked = 0;
    const checker = new PermissionChecker({
      askRules: [{ tools: ["bash"], test: () => "destructive" }],
      prompt: {
        confirm: async () => {
          asked += 1;
          return true;
        },
      },
    });
    const outcome = await checker.check({
      toolName: "bash",
      args: { command: "del test.txt" },
    });
    expect(outcome.allowed).toBe(true);
    expect(asked).toBe(1);
  });
});

describe("BackgroundManager.hasCompleted（非破坏 peek）", () => {
  it("完成后 peek 为真，collect 出队后为假", async () => {
    const background = new BackgroundManager({ cwd: process.cwd() });
    try {
      const taskId = await background.start('node -e "process.stdout.write(\'x\')"');
      await background.waitFor(taskId);
      expect(background.hasCompleted()).toBe(true);
      const notifications = background.collect();
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toContain("<task_notification>");
      expect(background.hasCompleted()).toBe(false);
    } finally {
      await background.dispose();
    }
  });
});

describe("截断升级/续跑/放弃（对齐 lcc 3187-3199）", () => {
  it("首次截断升级 maxTokens 8000→16000，续跑提示注入后完成", async () => {
    const llm = new ScriptedLLM([], [
      { content: "part one", toolCalls: [], finishReason: "length" },
      { content: "part two", toolCalls: [], finishReason: "length" },
      { content: "final", toolCalls: [] },
    ]);
    const recovery = new LlmRecovery({ primary: llm, sleep: async () => {} });
    const agent = makeAgent(llm, { llmRecovery: recovery });
    const answer = await agent.run("hello");
    expect(answer).toBe("final");
    expect(llm.toolCallsList[0]?.options?.maxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(llm.toolCallsList[1]?.options?.maxTokens).toBe(ESCALATED_MAX_TOKENS);
    // 升级重试是"丢弃截断响应重新发起新一轮"——首轮不追加任何消息；
    // 第二轮仍截断 → 追加截断 assistant + CONTINUATION_PROMPT，
    // 二者进入 history，出现在第三轮（最后一次调用）的 conversation 里
    const messages = llm.toolCallsList.at(-1)?.messages ?? [];
    expect(
      messages.some(
        (message) => message.role === "assistant" && message.content === "part two",
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) => message.role === "user" && message.content === CONTINUATION_PROMPT,
      ),
    ).toBe(true);
  });

  it("升级后仍截断：续跑至多 MAX_RECOVERY_RETRIES 次，超限优雅返回部分文本", async () => {
    const llm = new ScriptedLLM([], [
      { content: "a", toolCalls: [], finishReason: "length" },
      { content: "b", toolCalls: [], finishReason: "length" },
      { content: "c", toolCalls: [], finishReason: "length" },
      { content: "d", toolCalls: [], finishReason: "length" },
    ]);
    const recovery = new LlmRecovery({ primary: llm, sleep: async () => {} });
    const agent = makeAgent(llm, { llmRecovery: recovery });
    const answer = await agent.run("hello");
    expect(answer).toBe("d");
    // conversation 跨轮累积：只在最终一轮统计（恰好 2 次续跑提示）
    const continuations = (llm.toolCallsList.at(-1)?.messages ?? []).filter(
      (message) => message.role === "user" && message.content === CONTINUATION_PROMPT,
    ).length;
    expect(continuations).toBe(2);
  });
});

describe("装配层：system prompt 注入 Connected MCP servers（s15）", () => {
  it("connect 后 system 含名单；未连接时不含该段", async () => {
    const workspace = await makeWorkspace();
    const assembly = await buildAlignmentAgent({
      workspace,
      stage: "s15",
      llm: new ScriptedLLM([], []),
    });
    try {
      const before = await assembly.buildSystemPrompt!("hello");
      expect(before).not.toContain("Connected MCP servers:");
      assembly.mcp!.connect("docs");
      const after = await assembly.buildSystemPrompt!("hello");
      expect(after).toContain("Connected MCP servers: docs");
      expect(assembly.features.integratedHarness).toBe(true);
      expect(assembly.harnessLoop).toBeDefined();
      expect(assembly.asyncEventLoop).toBeDefined();
    } finally {
      await assembly.dispose();
    }
  });
});
