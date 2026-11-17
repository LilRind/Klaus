import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ToolRegistry } from "../../src/tools/registry";
import { FunctionTool } from "../../src/tools/tool";
import { WriteFileTool } from "../../src/tools/builtin/file-tools";
import { MailboxStore } from "../../src/multiagent/mailbox";
import { WorkspaceStore } from "../../src/multiagent/workspace";
import {
  resolveRoleModel,
  rolePrompt,
  SWARM_ROLES,
} from "../../src/multiagent/swarm/roles";
import { SwarmWorker } from "../../src/multiagent/swarm/worker";
import { TaskBoardStore } from "../../src/multiagent/swarm/board";
import { LeadEngine, parseLeadActions } from "../../src/multiagent/swarm/lead";
import { scriptedLlm, type ScriptedInvoke } from "./test-llm";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function echoRegistry(workspaceDir?: string): ToolRegistry {
  const registry = new ToolRegistry().register(
    new FunctionTool(
      async (input) => `ECHO ${input}`,
      {
        func: async (input) => `ECHO ${input}`,
        name: "echo",
        description: "回显参数",
        argsFunc: async (args) => `ECHO ${JSON.stringify(args)}`,
      },
    ),
  );
  if (workspaceDir) {
    registry.register(new WriteFileTool({ workspace: workspaceDir }));
  }
  return registry;
}

function makeWorker(over: {
  replies?: string[];
  invocations?: ScriptedInvoke[];
  workspace?: WorkspaceStore;
  mailbox?: MailboxStore;
  tools?: ToolRegistry;
  iterationLimit?: number;
} = {}) {
  const workspace = over.workspace ?? new WorkspaceStore({ now: () => "t" });
  const mailbox = over.mailbox ?? new MailboxStore({ now: () => "t" });
  const worker = new SwarmWorker({
    agentId: "w1",
    role: "researcher",
    llm: scriptedLlm(over.replies ?? [], over.invocations),
    workspace,
    mailbox,
    tools: over.tools ?? echoRegistry(),
    now: () => "t",
    ...(over.iterationLimit ? { iterationLimit: over.iterationLimit } : {}),
  });
  return { worker, workspace, mailbox };
}

describe("roles（3.1）", () => {
  it("6 个角色且方法论 prompt 非空", () => {
    expect(SWARM_ROLES).toHaveLength(6);
    for (const role of SWARM_ROLES) expect(rolePrompt(role).length).toBeGreaterThan(20);
  });

  it("未配置档位回落主 llm 并标记 fellBack", () => {
    const llm = scriptedLlm([]);
    const fallback = resolveRoleModel("medium", { llm });
    expect(fallback.llm).toBe(llm);
    expect(fallback.fellBack).toBe(true);
    const configured = resolveRoleModel("medium", { llm, medium: scriptedLlm([]) });
    expect(configured.fellBack).toBe(false);
  });
});

describe("SwarmWorker（3.2/3.3）", () => {
  it("五类 Action 分发：tool/publish/send/idle/done", async () => {
    // tool_call + idle
    const invocations: ScriptedInvoke[] = [];
    const first = makeWorker({
      replies: [
        '{"type":"tool_call","tool":"echo","params":{"x":1}}',
        '{"type":"idle","keyFindings":"完成"}',
      ],
      invocations,
    });
    first.worker.assign({ id: "t1", description: "任务一" });
    const idle = await first.worker.runTask();
    expect(idle.type).toBe("idle");
    const userContext = invocations[1]?.messages.at(-1)?.content ?? "";
    expect(userContext).toContain("ECHO");
    expect(userContext).toContain("预算");

    // publish_data
    const second = makeWorker({
      replies: [
        '{"type":"publish_data","topic":"findings","data":"要点A"}',
        '{"type":"idle","keyFindings":"已广播"}',
      ],
    });
    second.worker.assign({ id: "t1", description: "任务二" });
    await second.worker.runTask();
    expect(second.workspace.list("findings")).toHaveLength(1);

    // send_message
    const third = makeWorker({
      replies: [
        '{"type":"send_message","to":"w2","messageType":"info","content":"求助"}',
        '{"type":"idle","keyFindings":"已发送"}',
      ],
    });
    third.worker.assign({ id: "t1", description: "任务三" });
    await third.worker.runTask();
    expect(third.mailbox.readInbox("w2")[0]?.payload.content).toBe("求助");

    // done
    const fourth = makeWorker({ replies: ['{"type":"done","summary":"交付"}'] });
    fourth.worker.assign({ id: "t1", description: "任务四" });
    const done = await fourth.worker.runTask();
    expect(done.type).toBe("done");
  });

  it("越界文件写入被拒并回喂错误", async () => {
    const workspaceDir = mkdtempSync(path.join(tmpdir(), "s18w-"));
    dirs.push(workspaceDir);
    const invocations: ScriptedInvoke[] = [];
    const { worker } = makeWorker({
      replies: [
        '{"type":"tool_call","tool":"write_file","params":{"path":"../evil.txt","content":"x"}}',
        '{"type":"idle","keyFindings":"结束"}',
      ],
      tools: echoRegistry(workspaceDir),
      invocations,
    });
    worker.assign({ id: "t1", description: "写文件" });
    await worker.runTask();
    const observation = invocations[1]?.messages.at(-1)?.content ?? "";
    expect(observation).toMatch(/workspace|工作区|拒绝|越出|越界/i);
  });

  it("连续无工具轮数触发强制 idle；迭代上限触发强制 idle", async () => {
    const invocations: ScriptedInvoke[] = [];
    const { worker } = makeWorker({
      replies: [
        '{"type":"publish_data","topic":"a","data":"1"}',
        '{"type":"publish_data","topic":"a","data":"2"}',
        '{"type":"publish_data","topic":"a","data":"3"}',
      ],
      invocations,
    });
    worker.assign({ id: "t1", description: "空转" });
    const signal = await worker.runTask();
    expect(signal.type).toBe("idle");
    if (signal.type === "idle") expect(signal.keyFindings).toContain("强制");
  });

  it("reassign：Notes 保留、预算+15、上限 2 次", async () => {
    const invocations: ScriptedInvoke[] = [];
    const { worker } = makeWorker({
      replies: [
        '{"type":"idle","keyFindings":"t1 结论：市场要点"}',
        '{"type":"idle","keyFindings":"t2 完成"}',
      ],
      invocations,
    });
    expect(worker.assign({ id: "t1", description: "任务一" })).toBe(true);
    await worker.runTask();
    expect(worker.assign({ id: "t2", description: "任务二" })).toBe(true);
    await worker.runTask();
    expect(worker.assign({ id: "t3", description: "任务三" })).toBe(true);
    const secondContext = invocations[1]?.messages.at(-1)?.content ?? "";
    expect(secondContext).toContain("t1 结论");
    expect(secondContext).toContain("任务二");
    expect(worker.assign({ id: "t4", description: "任务四" })).toBe(false);
  });
});

describe("LeadEngine（3.4-3.6）", () => {
function makeLead(over: {
  replies?: string[];
    invocations?: ScriptedInvoke[];
    workspaceRoot?: string;
    onInterim?: (content: string) => void;
    now?: () => number;
  } = {}) {
    const board = new TaskBoardStore();
    const mailbox = new MailboxStore({ now: () => "t" });
    const workspace = new WorkspaceStore({ now: () => "t" });
    const workers: Array<{
      agentId: string; role: string; status: "running" | "idle" | "done";
      assign: (task: { id: string; description: string }) => boolean;
      requestShutdown: () => void;
    }> = [];
    const events: string[] = [];
    const lead = new LeadEngine({
      llm: scriptedLlm(over.replies ?? [], over.invocations),
      workspace,
      mailbox,
      board,
      spawnWorker: (action) => {
        const handle = {
          agentId: action.agentId ?? `w${workers.length + 1}`,
          role: action.role,
          status: "running" as const,
          assign: () => true,
          requestShutdown: () => undefined,
        };
        workers.push(handle);
        return handle;
      },
      workers: () => workers,
      emit: (type) => events.push(type),
      onInterim: over.onInterim,
      workspaceRoot: over.workspaceRoot,
      ...(over.now ? { now: over.now } : {}),
    });
    return { lead, board, mailbox, workspace, workers, events };
  }

  it("非法动作 delete_agent 降级 noop（3.4）", () => {
    const actions = parseLeadActions('{"actions":[{"type":"delete_agent"},{"type":"noop"}]}');
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => action.type === "noop")).toBe(true);
  });

  it("空 checkpoint 跳过 LLM；连续 2 轮强制 done（3.5）", async () => {
    const invocations: ScriptedInvoke[] = [];
    const { lead, workers } = makeLead({ replies: [], invocations });
    workers.push({ agentId: "w1", role: "researcher", status: "running", assign: () => true, requestShutdown: () => undefined });
    const first = await lead.decide({ type: "checkpoint" });
    expect(first).toEqual([]);
    expect(invocations).toHaveLength(0);
    const second = await lead.decide({ type: "checkpoint" });
    expect(second).toEqual([{ type: "done" }]);
    expect(invocations).toHaveLength(0);
  });

  it("interim 节流：60s 内第二次被抑制（3.5）", async () => {
    const sent: string[] = [];
    let clock = 1_000;
    const { lead, events } = makeLead({
      replies: [],
      onInterim: (content) => sent.push(content),
      now: () => clock,
    });
    await lead.execute([{ type: "interim_reply", content: "第一次" }]);
    clock = 2_000;
    await lead.execute([{ type: "interim_reply", content: "第二次" }]);
    expect(sent).toEqual(["第一次"]);
    expect(events).toContain("interim.throttled");
  });

  it("file_read 直读产物 + RETRY 消息送达 worker（3.6）", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "s18l-"));
    dirs.push(workspaceRoot);
    writeFileSync(path.join(workspaceRoot, "draft.md"), "占位一\n占位二\n占位三\n", "utf-8");
    const { lead, mailbox } = makeLead({ replies: [], workspaceRoot });
    await lead.execute([{ type: "file_read", path: "draft.md" }]);
    expect(lead.lastObservation).toContain("占位三");
    await lead.execute([{ type: "send_message", to: "w1", content: "RETRY：内容过薄，请补充产物" }]);
    const inbox = mailbox.readInbox("w1");
    expect(inbox[0]?.payload.content).toContain("RETRY");
  });

  it("human_input 下一轮响应并 interim 回执（3.6）", async () => {
    const sent: string[] = [];
    const invocations: ScriptedInvoke[] = [];
    const { lead } = makeLead({
      replies: ['{"actions":[{"type":"interim_reply","content":"收到，已关注定价"}]}'],
      invocations,
      onInterim: (content) => sent.push(content),
    });
    const actions = await lead.decide({ type: "human_input", text: "多关注定价策略" });
    await lead.execute(actions);
    const context = invocations[0]?.messages.at(-1)?.content ?? "";
    expect(context).toContain("多关注定价策略");
    expect(sent).toEqual(["收到，已关注定价"]);
  });
});
