/**
 * s16 Workflow Runtime 离线验收（对齐 lcc test_workflow_goal_lessons.py）
 *
 * - meta/runId/schema 校验全分支（不安全产物名、required、enum、类型）；
 * - journal：JSONL 追加 + resume 严格回放（坏行报行号）+ 稳定语义键；
 * - ExecutionState：agent 缓存命中、schema 失败一次重试、budget/cap、
 *   parallel 失败等全部分支落地、pipeline 无屏障、嵌套共享计数；
 * - WorkflowRuntime 全生命周期：snapshot/journal/output/last_run 四件套、
 *   唯一 identity、resume 名字/args 校验、坏 resume 不碰产物、并发 resume 拒绝；
 * - Workflow 工具适配：registry 解析可信代码、JSON 输出、错误转 Error 文案。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SimpleJsonSchema,
  stableStringify,
} from "../src/workflow/workflow-schema";
import {
  RUN_ID_RE,
  WORKFLOW_NAME_RE,
  WorkflowInputError,
  WorkflowJournal,
  createRunId,
  reserveRunId,
  validateRunId,
  workflowSemanticKey,
} from "../src/workflow/workflow-journal";
import {
  LlmWorkflowAgentRunner,
  MockWorkflowAgentRunner,
  type RunnerOutput,
  type WorkflowAgentRunner,
} from "../src/workflow/workflow-runner";
import {
  ExecutionState,
  LocalWorkflowTask,
  TokenBudget,
  WorkflowRuntime,
} from "../src/workflow/workflow-runtime";
import { WorkflowRegistry } from "../src/workflow/workflow-registry";
import { WorkflowTool } from "../src/tools/builtin/workflow-tool";
import { ScriptedLLM } from "./scripted-llm";

let workspace: string;
let storeDir: string;

/** Promise.withResolvers 的 ES2022 等价（tsconfig lib 未到 ES2024） */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s16-"));
  storeDir = path.join(workspace, ".runtime");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** 受控 runner：按 label 出队预设结果（deferred 支持挂起等同步点） */
function controlledRunner(
  script: (label: string, call: number) => Promise<RunnerOutput> | RunnerOutput,
): WorkflowAgentRunner & { calls: string[] } {
  const counts = new Map<string, number>();
  return {
    calls: [],
    async run(_prompt, _schema, label) {
      const n = (counts.get(label ?? "") ?? 0) + 1;
      counts.set(label ?? "", n);
      this.calls.push(`${label}#${n}`);
      return script(label ?? "", n);
    },
  };
}

function okResult(value: unknown, tokens = 1): RunnerOutput {
  return { value, tokens };
}

const OK_SCHEMA = {
  type: "object",
  required: ["ok"],
  properties: { ok: { type: "boolean" } },
};

describe("meta / runId / schema 校验", () => {
  it("不安全产物名拒绝（../、嵌套路径、空名、超长、非法字符）", () => {
    for (const name of ["../escape", "nested/name", "", "a".repeat(65), "空格 name"]) {
      expect(() => WorkflowRegistry.validateMeta({ name, description: "x" })).toThrow(
        WorkflowInputError,
      );
    }
    expect(WORKFLOW_NAME_RE.test("review-changes.v2_1")).toBe(true);
  });

  it("缺 description / phases 类型不对 → 逐字对齐的错误文案", () => {
    expect(() =>
      WorkflowRegistry.validateMeta({ name: "ok-name" } as never),
    ).toThrow("meta requires `name` and `description`");
    expect(() =>
      WorkflowRegistry.validateMeta({
        name: "ok-name",
        description: "d",
        phases: ["a", ""],
      }),
    ).toThrow("meta.phases must be a list of non-empty strings");
  });

  it("runId 正则与 validateRunId", () => {
    expect(RUN_ID_RE.test("wf_review-changes_0123456789abcdef")).toBe(true);
    expect(() => validateRunId("not-a-run-id")).toThrow(
      "invalid workflow runId",
    );
    expect(validateRunId(createRunId("demo"))).toMatch(/^wf_demo_[0-9a-f]{16}$/);
  });

  it("SimpleJsonSchema：enum/object required/array/number 排除 boolean", () => {
    const enumSchema = new SimpleJsonSchema({
      type: "string",
      enum: ["high", "medium", "low"],
    });
    expect(enumSchema.validate("high")).toEqual([true, null]);
    expect(enumSchema.validate("warning")[0]).toBe(false);

    const obj = new SimpleJsonSchema({
      type: "object",
      required: ["a"],
      properties: { a: { type: "number" }, b: { type: "boolean" } },
    });
    expect(obj.validate({})[1]).toContain("missing required key 'a'");
    expect(obj.validate({ a: true })[0]).toBe(false);
    expect(obj.validate({ a: 1, b: true })).toEqual([true, null]);

    const arr = new SimpleJsonSchema({
      type: "array",
      items: { type: "string" },
    });
    expect(arr.validate(["ok", 1])[1]).toContain("[1]");
  });

  it("stableStringify 键序无关 → 语义键稳定、内容不同键不同", () => {
    const s1 = { type: "object", properties: { a: {}, b: {} }, required: ["a"] };
    const s2 = { required: ["a"], properties: { b: {}, a: {} }, type: "object" };
    expect(stableStringify(s1)).toBe(stableStringify(s2));
    const k1 = workflowSemanticKey("agent", "l", "p", s1);
    const k2 = workflowSemanticKey("agent", "l", "p", s2);
    const k3 = workflowSemanticKey("agent", "l", "p2", s1);
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^agent-[0-9]{10}$/);
  });
});

describe("WorkflowJournal", () => {
  it("fresh 截断 + record/cached 往返；close 幂等", async () => {
    const journal = await WorkflowJournal.open(
      "wf_j_fresh_0000000000000000",
      false,
      storeDir,
    );
    journal.record("k1", { v: 1 });
    journal.record("k2", "text");
    expect(journal.cached("k1")).toEqual({ v: 1 });
    expect(journal.cached("missing")).toBeUndefined();
    journal.close();
    journal.close();
  });

  it("resume 回放缓存；坏行报行号；journal 缺失报错", async () => {
    const runId = "wf_j_aaaaaaaaaaaaaaaa";
    const writer = await WorkflowJournal.open(runId, false, storeDir);
    writer.record("k1", [1, 2]);
    writer.close();

    const reader = await WorkflowJournal.open(runId, true, storeDir);
    expect(reader.cached("k1")).toEqual([1, 2]);
    reader.close();

    await writeFile(path.join(storeDir, "wf_j_bbbbbbbbbbbbbbbb.journal.jsonl"), "{not-json}\n");
    await expect(
      WorkflowJournal.open("wf_j_bbbbbbbbbbbbbbbb", true, storeDir),
    ).rejects.toThrow("invalid resume journal record at line 1");

    await expect(
      WorkflowJournal.open("wf_j_cccccccccccccccc", true, storeDir),
    ).rejects.toThrow("resume journal not found");
  });

  it("reserveRunId：排他创建、碰撞重试耗尽报错", async () => {
    await mkdir(storeDir, { recursive: true });
    const a = await reserveRunId("demo", storeDir);
    const b = await reserveRunId("demo", storeDir);
    expect(a).not.toBe(b);

    const fixed = () => "wf_demo_0000000000001a7b";
    const first = await reserveRunId("demo", storeDir, fixed);
    expect(first).toBe("wf_demo_0000000000001a7b");
    await expect(reserveRunId("demo", storeDir, fixed)).rejects.toThrow(
      "could not allocate a unique workflow runId",
    );
  });
});

describe("ExecutionState.agent", () => {
  interface Ctx {
    state: ExecutionState;
    task: LocalWorkflowTask;
    runner: WorkflowAgentRunner & { calls: string[] };
  }

  async function makeCtx(
    runnerScript?: (label: string, call: number) => RunnerOutput,
    budget?: TokenBudget,
    limits?: { agentCap?: number; concurrency?: number },
  ): Promise<Ctx> {
    const runner = controlledRunner(
      runnerScript ?? ((label) => okResult({ label })),
    );
    const task = new LocalWorkflowTask(
      "task-1",
      "wf_ctx_0000000000000001",
      { name: "ctx", description: "test" },
    );
    const journal = await WorkflowJournal.open(task.runId, false, storeDir);
    const state = new ExecutionState({
      task,
      journal,
      runner,
      budget: budget ?? new TokenBudget(null),
      args: {},
      registry: new WorkflowRegistry(),
      limits,
    });
    return { state, task, runner };
  }

  it("无 schema 调用：tokens 计入、journal 落盘、done 进度事件", async () => {
    const { state, task } = await makeCtx((label) => okResult(label, 7));
    const result = await state.agent("hello world", undefined, "greet");
    expect(result).toBe("greet");
    expect(task.usage).toEqual({ agents: 1, tokens: 7 });
    expect(task.progress.some((p) => p.type === "workflow_agent" && p.status === "done")).toBe(true);
  });

  it("label 缺省取 prompt 前 24 字符加省略号", async () => {
    const { state, runner } = await makeCtx();
    await state.agent("this is a very long prompt beyond twentyfour chars");
    expect(runner.calls[0] ?? "").toBe("this is a very long prom...#1");
  });

  it("schema 校验失败一次后重试成功（tokens 累加、agents=1）", async () => {
    const { state, task } = await makeCtx((_label, call) =>
      call === 1 ? okResult("not json", 5) : okResult({ ok: true }, 6),
    );
    const result = await state.agent("Return a result.", OK_SCHEMA, "retry");
    expect(result).toEqual({ ok: true });
    expect(task.usage).toEqual({ agents: 1, tokens: 11 });
  });

  it("重试后仍非法 → agent({schema}) invalid output", async () => {
    const { state } = await makeCtx(() => okResult("still bad", 1));
    await expect(
      state.agent("x", OK_SCHEMA, "bad"),
    ).rejects.toThrow("agent({schema}) invalid output");
  });

  it("resume 缓存命中：runner 不调用、cached 事件；坏缓存值过不了 schema", async () => {
    // 通过正常调用写入 journal（runId 固定，resume 模式可回放）
    const seeded = await makeCtx(() => okResult({ ok: true }, 3));
    await seeded.state.agent("p", OK_SCHEMA, "cached");

    // 第二个 state 复用同一 runId（resume 模式）
    const task2 = new LocalWorkflowTask(
      "task-2",
      "wf_ctx_0000000000000001",
      { name: "ctx", description: "test" },
    );
    const journal2 = await WorkflowJournal.open(task2.runId, true, storeDir);
    const runner2 = controlledRunner(() => okResult("should-not-run"));
    const state2 = new ExecutionState({
      task: task2,
      journal: journal2,
      runner: runner2,
      budget: new TokenBudget(null),
      args: {},
      registry: new WorkflowRegistry(),
    });
    const cached = await state2.agent("p", OK_SCHEMA, "cached");
    expect(cached).toEqual({ ok: true });
    expect(runner2.calls).toHaveLength(0);
    expect(task2.usage).toEqual({ agents: 0, tokens: 0 });
    expect(
      task2.progress.some((p) => p.type === "workflow_agent" && p.status === "cached"),
    ).toBe(true);
    // 缓存值不符合 schema → 拒绝（坏值挂在真实语义键下）
    journal2.record(workflowSemanticKey("agent", "cached-bad", "p2", OK_SCHEMA), { wrong: 1 });
    await expect(
      state2.agent("p2", OK_SCHEMA, "cached-bad"),
    ).rejects.toThrow("cached agent output failed schema validation");
  });

  it("budget：add 超限抛错不记账；remaining 归零后 agent 拒绝", async () => {
    const budget = new TokenBudget(4);
    expect(() => budget.add(5)).toThrow("token budget exceeded (5 > 4)");
    expect(budget.spent()).toBe(0);

    const { state } = await makeCtx(() => okResult("x", 10), new TokenBudget(4));
    await expect(state.agent("x")).rejects.toThrow("token budget exceeded");
  });

  it("agent cap 跨嵌套 workflow 共享", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      { name: "limit-child", description: "child" },
      async (child) => child.agent("second call", undefined, "second"),
    );
    const runner = controlledRunner(() => okResult("r", 1));
    const task = new LocalWorkflowTask("t", "wf_cap_0000000000000001", {
      name: "cap",
      description: "test",
    });
    const journal = await WorkflowJournal.open(task.runId, false, storeDir);
    const state = new ExecutionState({
      task,
      journal,
      runner,
      budget: new TokenBudget(null),
      args: {},
      registry,
      limits: { agentCap: 1 },
    });
    await state.agent("first call", undefined, "first");
    await expect(state.workflow("limit-child")).rejects.toThrow(
      "agent() cap reached (1)",
    );
  });

  it("并发上限：信号量限制同时在跑的 agent 数", async () => {
    let active = 0;
    let maxActive = 0;
    const runner: WorkflowAgentRunner = {
      async run() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return okResult("v", 1);
      },
    };
    const task = new LocalWorkflowTask("t", "wf_conc_0000000000000001", {
      name: "conc",
      description: "test",
    });
    const journal = await WorkflowJournal.open(task.runId, false, storeDir);
    const state = new ExecutionState({
      task,
      journal,
      runner,
      budget: new TokenBudget(null),
      args: {},
      registry: new WorkflowRegistry(),
      limits: { concurrency: 2 },
    });
    await state.parallel([
      () => state.agent("a", undefined, "a"),
      () => state.agent("b", undefined, "b"),
      () => state.agent("c", undefined, "c"),
      () => state.agent("d", undefined, "d"),
    ]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});

describe("parallel / pipeline / phase", () => {
  async function makeState(
    runner: WorkflowAgentRunner,
    registry = new WorkflowRegistry(),
  ) {
    const task = new LocalWorkflowTask("t", "wf_par_0000000000000001", {
      name: "par",
      description: "test",
    });
    const journal = await WorkflowJournal.open(task.runId, false, storeDir);
    return new ExecutionState({
      task,
      journal,
      runner,
      budget: new TokenBudget(null),
      args: {},
      registry,
    });
  }

  it("parallel 按 thunks 顺序返回全部结果", async () => {
    const runner = controlledRunner((label) => okResult({ label }));
    const state = await makeState(runner);
    const results = await state.parallel([
      () => state.agent("1", undefined, "first"),
      () => state.agent("2", undefined, "second"),
    ]);
    expect(results).toEqual([{ label: "first" }, { label: "second" }]);
  });

  it("parallel 一支失败：等全部分支落地后再抛（慢支不被炸掉）", async () => {
    const slowGate = deferred();
    let slowSettled = false;
    const runner = controlledRunner(async (label) => {
      if (label === "slow") {
        // 门开后再拖 30ms 才落地——若实现是 Promise.all 立即中断，
        // 错误浮出时 slowSettled 还没置位
        await slowGate.promise;
        await new Promise((resolve) => setTimeout(resolve, 30));
        slowSettled = true;
        return okResult("slow-done");
      }
      // fail 分支：立刻开门并失败
      slowGate.resolve();
      throw new Error("agent failed");
    });
    const state = await makeState(runner);
    await expect(
      state.parallel([
        () => state.agent("s", undefined, "slow"),
        () => state.agent("f", undefined, "fail"),
      ]),
    ).rejects.toThrow("agent failed");
    expect(slowSettled).toBe(true);
  });

  it("pipeline：每 item 串行过全部 stage，stage 收到 (prev, item, idx)；无屏障", async () => {
    const runner = controlledRunner((label) => okResult(`${label}-ran`));
    const state = await makeState(runner);
    const seen: Array<[unknown, string, number]> = [];
    /** item 间并发导致 seen 顺序不定——stage2 的 prev 按 idx 断言 */
    const stage2Prev = new Map<number, unknown>();
    const results = await state.pipeline(
      ["x", "y"],
      async (prev: unknown, item: string, idx: number) => {
        seen.push([prev, item, idx]);
        return state.agent(`audit:${item}`, undefined, `audit:${item}`);
      },
      async (prev: unknown, item: string, idx: number) => {
        seen.push([prev, item, idx]);
        stage2Prev.set(idx, prev);
        return state.agent(`verify:${prev}`, undefined, `verify:${idx}`);
      },
    );
    expect(results).toEqual(["verify:0-ran", "verify:1-ran"]);
    expect(seen).toHaveLength(4);
    expect(seen).toContainEqual(["x", "x", 0]);
    expect(seen).toContainEqual(["y", "y", 1]);
    expect(stage2Prev.get(0)).toBe("audit:x-ran");
    expect(stage2Prev.get(1)).toBe("audit:y-ran");
  });

  it("phase upsert：同名 phase 只通告一次；log 产出 workflow_log 事件", async () => {
    const runner = controlledRunner((label) => okResult(label));
    const state = await makeState(runner);
    state.phase("Review");
    state.phase("Review");
    state.log("confirmed 2 finding(s)");
    const phases = state.task.progress.filter((p) => p.type === "workflow_phase");
    expect(phases).toHaveLength(1);
    expect(
      state.task.progress.some((p) => p.type === "workflow_log"),
    ).toBe(true);
  });

  it("嵌套 workflow 仅一层；子状态共享 journal/budget/cap", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      { name: "child", description: "child" },
      async (child) => child.agent("child call", undefined, "child"),
    );
    registry.register(
      { name: "parent", description: "p" },
      async (ctx2) => ctx2.workflow("child"),
    );
    registry.register(
      { name: "grand", description: "g" },
      async (ctx2) => ctx2.workflow("parent"),
    );
    const runner = controlledRunner((label) => okResult(label, 2));
    const state = await makeState(runner, registry);
    const childResult = await state.workflow("child", {});
    expect(childResult).toBe("child");
    await expect(state.workflow("grand")).rejects.toThrow(
      "workflow() nesting is one level only",
    );
  });
});

describe("WorkflowRuntime 全生命周期", () => {
  function buildRuntime(
    runner: WorkflowAgentRunner,
    options?: {
      createRunId?: (name: string) => string;
      deny?: string[];
      agentCap?: number;
    },
  ) {
    const registry = new WorkflowRegistry({ deny: options?.deny });
    registry.register(
      {
        name: "review-changes",
        description: "Review changed files across dimensions, verify each finding",
        phases: ["Review", "Verify"],
      },
      async (ctx, args) => {
        ctx.phase("Review");
        const out = await ctx.agent(
          `audit:${String(args.changes ?? "")}`,
          OK_SCHEMA,
          "audit:demo",
          "Review",
        );
        ctx.phase("Verify");
        const verdict = await ctx.agent(
          `verify:${JSON.stringify(out)}`,
          OK_SCHEMA,
          "verify:demo",
          "Verify",
        );
        return { audit: out, verdict };
      },
    );
    return new WorkflowRuntime({
      storeDir,
      registry,
      runner,
      ...(options?.createRunId ? { createRunId: options.createRunId } : {}),
      ...(options?.agentCap !== undefined ? { agentCap: options.agentCap } : {}),
    });
  }

  it("fresh run：envelope/序列化 task/四件套产物齐备", async () => {
    const runtime = buildRuntime(controlledRunner((label) => okResult({ ok: true }, 4)));
    const out = await runtime.run("review-changes", { changes: "diff" });
    expect(out.launched).toMatchObject({
      status: "async_launched",
      taskType: "local_workflow",
      workflowName: "review-changes",
    });
    expect(out.task).toMatchObject({
      taskType: "local_workflow",
      workflowName: "review-changes",
      status: "completed",
      usage: { agents: 2, tokens: 8 },
    });
    expect(out.task.runId).toMatch(/^wf_review-changes_[0-9a-f]{16}$/);
    expect(out.task.taskId).toBe(`local_workflow_${out.task.runId}`);

    const snapshot = JSON.parse(
      await readFile(path.join(storeDir, `${out.task.runId}.json`), "utf8"),
    );
    expect(snapshot).toMatchObject({
      workflowName: "review-changes",
      args: { changes: "diff" },
      task: { status: "completed" },
    });
    const output = JSON.parse(
      await readFile(path.join(storeDir, `${out.task.runId}.output.json`), "utf8"),
    );
    expect(output).toEqual(out.result);
    expect(
      await readFile(path.join(storeDir, "last_run.txt"), "utf8"),
    ).toBe(out.task.runId);
  });

  it("两次 fresh run identity 唯一", async () => {
    const runtime = buildRuntime(controlledRunner(() => okResult("x")));
    const a = await runtime.run("review-changes", {});
    const b = await runtime.run("review-changes", {});
    expect(a.task.runId).not.toBe(b.task.runId);
    expect(a.task.taskId).not.toBe(b.task.taskId);
  });

  it("resume：args 不匹配 / 名字不匹配拒绝；args 缺省回落保存值", async () => {
    const runtime = buildRuntime(controlledRunner(() => okResult({ ok: true })));
    const first = await runtime.run("review-changes", { changes: "d1" });
    await expect(
      runtime.run("review-changes", { changes: "d2" }, first.task.runId),
    ).rejects.toThrow("resume args do not match the original run");
    await expect(
      runtime.run("review-changes", undefined, "wf_other_aaaaaaaaaaaaaaaa"),
    ).rejects.toThrow();
    // args 缺省 → 用保存值；全部命中缓存
    const resumed = await runtime.run("review-changes", undefined, first.task.runId);
    expect(resumed.task.status).toBe("completed");
    expect(resumed.task.usage).toEqual({ agents: 0, tokens: 0 });
    expect(resumed.result).toEqual(first.result);
  });

  it("坏 resume journal：报错且不覆盖已完成产物", async () => {
    const runtime = buildRuntime(controlledRunner(() => okResult({ ok: true })));
    const first = await runtime.run("review-changes", {});
    const runId = first.task.runId;
    const snapshotBefore = await readFile(path.join(storeDir, `${runId}.json`), "utf8");
    const outputBefore = await readFile(path.join(storeDir, `${runId}.output.json`), "utf8");
    await writeFile(path.join(storeDir, `${runId}.journal.jsonl`), "not-json\n");
    await expect(
      runtime.run("review-changes", {}, runId),
    ).rejects.toThrow("invalid resume journal");
    expect(await readFile(path.join(storeDir, `${runId}.json`), "utf8")).toBe(snapshotBefore);
    expect(await readFile(path.join(storeDir, `${runId}.output.json`), "utf8")).toBe(outputBefore);
  });

  it("活跃 run 并发 resume → already active；fresh 撞 identity → 重试耗尽", async () => {
    const gate = deferred();
    let releases = 0;
    const runtime = buildRuntime(
      {
        async run() {
          releases += 1;
          if (releases === 1) await gate.promise;
          return okResult({ ok: true });
        },
      },
      { createRunId: () => "wf_review-changes_ffffffffffffffff" },
    );

    const pending = runtime.run("review-changes", {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    await expect(
      runtime.run("review-changes", {}, "wf_review-changes_ffffffffffffffff"),
    ).rejects.toThrow("already active");
    gate.resolve();
    const done = await pending;
    expect(done.task.status).toBe("completed");

    await expect(runtime.run("review-changes", {})).rejects.toThrow(
      "could not allocate a unique workflow runId",
    );
  });

  it("脚本抛错 → failed + result.error；失败等待已启动 agent 落地", async () => {
    const registry = new WorkflowRegistry();
    registry.register(
      { name: "boom", description: "b" },
      async (ctx) => {
        await ctx.parallel([
          () => ctx.agent("slow", undefined, "slow"),
          async () => {
            throw new Error("stage failed");
          },
        ]);
        return "never";
      },
    );
    let slowSettled = false;
    const runtime = new WorkflowRuntime({
      storeDir,
      registry,
      runner: {
        async run() {
          await new Promise((resolve) => setTimeout(resolve, 30));
          slowSettled = true;
          return okResult("slow");
        },
      },
    });
    const out = await runtime.run("boom");
    expect(out.task.status).toBe("failed");
    expect(out.result).toEqual({ error: "stage failed" });
    expect(slowSettled).toBe(true);
    const snapshot = JSON.parse(
      await readFile(path.join(storeDir, `${out.task.runId}.json`), "utf8"),
    );
    expect(snapshot.task.status).toBe("failed");
  });

  it("unknown workflow / args 类型错误 / deny 名单", async () => {
    const runtime = buildRuntime(controlledRunner(() => okResult("x")), {
      deny: ["review-changes"],
    });
    await expect(runtime.run("nope")).rejects.toThrow("unknown workflow 'nope'");
    await expect(
      runtime.run("review-changes", "not-object" as never),
    ).rejects.toThrow("workflow args must be an object");
    await expect(runtime.run("review-changes", {})).rejects.toThrow(
      "workflow 'review-changes' denied by settings",
    );
  });
});

describe("Workflow 工具适配与 runners", () => {
  it("schema：仅 name/args/resume_from_run_id，required=['name']，禁额外属性", () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "w", description: "d" }, async () => ({}));
    const tool = new WorkflowTool(
      new WorkflowRuntime({ storeDir, registry, runner: controlledRunner(() => okResult("x")) }),
    );
    expect(tool.name).toBe("Workflow");
    expect(tool.parametersSchema).toMatchObject({
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("executeArgs：registry 解析 + JSON 输出；unknown 转 Error 文案", async () => {
    const registry = new WorkflowRegistry();
    registry.register({ name: "echo", description: "e" }, async (_ctx, args) => args);
    const tool = new WorkflowTool(
      new WorkflowRuntime({
        storeDir,
        registry,
        runner: controlledRunner(() => okResult("x")),
      }),
    );
    const raw = await tool.executeArgs({ name: "echo", args: { k: 1 } });
    const parsed = JSON.parse(raw) as {
      launched: { workflowName: string };
      task: { status: string };
    };
    expect(parsed.launched.workflowName).toBe("echo");
    expect(parsed.task.status).toBe("completed");
    expect(JSON.parse(raw)).toHaveProperty("result");

    expect(await tool.executeArgs({ name: "ghost" })).toBe(
      "Error: unknown workflow 'ghost'",
    );
  });

  it("Mock runner：findings/isReal 特化 + 通用 filler 确定性", async () => {
    const mock = new MockWorkflowAgentRunner();
    const findingsSchema = {
      type: "object",
      required: ["findings"],
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["title", "severity"],
            properties: {
              title: { type: "string" },
              severity: { type: "string", enum: ["high", "medium", "low"] },
            },
          },
        },
      },
    };
    const r1 = await mock.run("p", findingsSchema, "audit:x");
    const findings = (r1.value as { findings: unknown[] }).findings;
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(await mock.run("p", findingsSchema, "audit:x")).toEqual(r1);

    const verdict = await mock.run("p", {
      type: "object",
      required: ["isReal", "reason"],
      properties: { isReal: { type: "boolean" }, reason: { type: "string" } },
    }, "verify:x");
    expect(typeof (verdict.value as { isReal: unknown }).isReal).toBe("boolean");

    const filled = await mock.run("p", {
      type: "object",
      required: ["name"],
      properties: { name: { type: "string" } },
    });
    expect(filled.value).toEqual({ name: "name" });

    const plain = await mock.run("hello", undefined, "lbl");
    expect(plain.value).toContain("[mock]");
  });

  it("LLM runner：专注 agent system prompt + schema 追加 + 剥围栏解析；坏 JSON 原样返回触发重试", async () => {
    const llm = new ScriptedLLM([
      '```json\n{"ok": true}\n```',
      "Result:\nnot json at all",
    ]);
    const runner = new LlmWorkflowAgentRunner(llm);
    const parsed = await runner.run("Check this.", OK_SCHEMA, "check");
    expect(parsed.value).toEqual({ ok: true });
    expect(parsed.tokens).toBeGreaterThan(0);
    const firstCall = llm.calls[0]!;
    expect(firstCall.messages[0]?.role).toBe("system");
    expect(firstCall.messages[0]?.content).toContain("focused workflow agent");
    expect(firstCall.messages[1]?.content).toContain("Return only one JSON object");
    expect(firstCall.options?.maxTokens).toBe(2000);

    const raw = await runner.run("Again.", OK_SCHEMA, "bad");
    expect(raw.value).toBe("Result:\nnot json at all");
  });
});
