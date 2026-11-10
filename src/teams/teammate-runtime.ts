/**
 * s13 TeammateRuntime：一个持久 teammate 的 WORK/IDLE 状态机。
 *
 * 与 FunctionCallAgent 的差异是刻意保留的：普通 Agent 是“一次 prompt 一个答案”，
 * teammate 是长生命周期协作者——最终 result / idle / error 全部走 MessageBus，
 * Lead 在下一次模型调用前统一收集；工具回合后可以继续，也可以空闲等待新任务。
 */

import type { ChatLLM, ToolInvocationResult } from "../core/llm";
import type { ChatMessage, ToolCallRequest } from "../core/message";
import { parseJsonObjectArguments } from "../tools/tool";
import { ToolRegistry } from "../tools/registry";
import type { PermissionChecker } from "../security/permission";
import type { Tool } from "../tools/tool";
import { FunctionTool } from "../tools/tool";
import { ListTasksTool } from "../tools/builtin/task-tools";
import type { TaskBoard } from "./task-board";
import type { MessageBus, TeamMessage } from "./message-bus";
import type { TeamManager } from "./team-manager";

export type TeammateStatus = "working" | "waiting_approval" | "idle" | "stopping";
export type WorkOutcome = "continue" | "idle" | "stop";

export interface TeammateRuntimeOptions {
  name: string;
  role: string;
  prompt: string;
  taskId?: string | null;
  requirePlan?: boolean;
  llm: ChatLLM;
  board: TaskBoard;
  bus: MessageBus;
  manager: TeamManager;
  workspaceTools: (cwd: string) => Tool[];
  permissionChecker?: PermissionChecker;
  idleScanIntervalMs?: number;
}

const CHANGING_TOOLS = new Set(["bash", "write_file", "edit_file"]);

export class TeammateRuntime {
  readonly name: string;
  readonly system: string;
  readonly messages: ChatMessage[] = [];
  private readonly llm: ChatLLM;
  private readonly board: TaskBoard;
  private readonly bus: MessageBus;
  private readonly manager: TeamManager;
  private readonly workspaceTools: (cwd: string) => Tool[];
  private readonly permissionChecker?: PermissionChecker;
  private readonly idleScanIntervalMs: number;

  constructor(options: TeammateRuntimeOptions) {
    this.name = options.name;
    this.llm = options.llm;
    this.board = options.board;
    this.bus = options.bus;
    this.manager = options.manager;
    this.workspaceTools = options.workspaceTools;
    this.permissionChecker = options.permissionChecker;
    this.idleScanIntervalMs = options.idleScanIntervalMs ?? 2_000;

    this.system =
      `You are '${this.name}', a ${options.role}. Use tools to complete the assigned ` +
      "Task, then call complete_task and report a concise result. If the first user " +
      "message contains [Assigned task], that Task is already claimed; do not call " +
      "claim_task for it again. When asked for a plan, call submit_plan and wait for " +
      "approval before bash or file changes. File and shell tools use the Task's " +
      "working directory; that directory is not a sandbox. The runtime delivers your " +
      "final text to Lead. Use send_message only for intermediate coordination, and " +
      "address the coordinator as 'lead'.";
    const firstMessage: ChatMessage = { role: "user", content: options.prompt };
    this.messages.push(firstMessage);
    if (options.requirePlan) {
      firstMessage.content +=
        "\n\n[Plan required] Submit a plan and wait for Lead approval before changing files or using bash.";
    }
  }

  async initialize(options: { taskId?: string | null } = {}): Promise<void> {
    if (!options.taskId) return;
    const task = await this.board.store.load(options.taskId);
    const cwd = await this.board.assignmentCwd(this.name);
    const first = this.messages[0];
    if (first) {
      first.content +=
      `\n\n[Assigned task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`;
    }
  }

  private async currentCwd(): Promise<string> {
    const assignment = this.manager.currentAssignment(this.name);
    if (!assignment) {
      throw new Error("Error: Claim a Task before using workspace tools.");
    }
    return this.board.assignmentCwd(this.name);
  }

  private buildRegistry(): { registry: ToolRegistry; workspaceToolNames: Set<string> } {
    const cwd = this.manager.currentAssignment(this.name)?.cwd ?? process.cwd();
    const workspace = this.workspaceTools(cwd);
    const registry = new ToolRegistry();
    for (const tool of workspace) registry.register(tool);
    registry
      .register(this.sendMessageTool())
      .register(this.submitPlanTool())
      .register(new ListTasksTool(this.board.store))
      .register(this.claimTool())
      .register(this.completeTool());
    return { registry, workspaceToolNames: new Set(workspace.map((tool) => tool.name)) };
  }

  private sendMessageTool(): Tool {
    const send = async (input: string) => {
      const args = safeJson(input);
      return this.manager.sendFromTeammate(
        this.name,
        String(args.to ?? ""),
        String(args.content ?? ""),
      );
    };
    return new FunctionTool(async (input) => {
      const args = safeJson(input);
      return this.manager.sendFromTeammate(
        this.name,
        String(args.to ?? ""),
        String(args.content ?? ""),
      );
    }, {
      func: send,
      name: "send_message",
      description: "Send an intermediate message to 'lead' or an active teammate.",
      parametersDescription: "JSON: {to, content}",
      parametersSchema: {
        type: "object",
        properties: { to: { type: "string" }, content: { type: "string" } },
        required: ["to", "content"],
      },
      argsFunc: (args) => this.manager.sendFromTeammate(
        this.name,
        String(args.to ?? ""),
        String(args.content ?? ""),
      ),
    });
  }

  private submitPlanTool(): Tool {
    const submit = (raw: string) => this.manager.submitPlan(this.name, raw);
    return new FunctionTool(submit, {
      func: submit,
      name: "submit_plan",
      description: "Submit a work plan for Lead approval.",
      parametersDescription: "JSON: {plan}",
      parametersSchema: {
        type: "object",
        properties: { plan: { type: "string" } },
        required: ["plan"],
      },
      argsFunc: (args) => this.manager.submitPlan(this.name, String(args.plan ?? "")),
    });
  }

  private claimTool(): Tool {
    const claim = async (raw: string) => {
      const taskId = typeof raw === "string" && raw.startsWith("{")
        ? String(safeJson(raw).task_id ?? "")
        : raw;
      return this.board.claim(taskId, this.name);
    };
    return new FunctionTool(claim, {
      func: claim,
      name: "claim_task",
      description: "Claim a ready task.",
      parametersDescription: "JSON: {task_id}",
      parametersSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
      argsFunc: (args) => this.board.claim(String(args.task_id ?? ""), this.name),
    });
  }

  private completeTool(): Tool {
    const complete = async (raw: string) => {
      const taskId = typeof raw === "string" && raw.startsWith("{")
        ? String(safeJson(raw).task_id ?? "")
        : raw;
      const gate = this.manager.planGate(this.name);
      if (["required", "pending", "rejected"].includes(gate)) {
        return `Task ${taskId} cannot complete while plan status is ${gate}`;
      }
      return this.board.complete(taskId, this.name, gate);
    };
    return new FunctionTool(complete, {
      func: complete,
      name: "complete_task",
      description: "Complete an owned task.",
      parametersDescription: "JSON: {task_id}",
      parametersSchema: {
        type: "object",
        properties: { task_id: { type: "string" } },
        required: ["task_id"],
      },
      argsFunc: async (args) => {
        const taskId = String(args.task_id ?? "");
        const gate = this.manager.planGate(this.name);
        if (["required", "pending", "rejected"].includes(gate)) {
          return `Task ${taskId} cannot complete while plan status is ${gate}`;
        }
        return this.board.complete(taskId, this.name, gate);
      },
    });
  }

  async handleInbox(inbox: TeamMessage[]): Promise<boolean> {
    const workMessages: string[] = [];
    for (const message of inbox) {
      if (message.type === "shutdown_request") {
        const accepted = this.manager.applyShutdownRequest(this.name, message);
        if (!accepted) {
          workMessages.push("[Ignored shutdown request: request mismatch]");
          continue;
        }
        await this.bus.send(this.name, "lead", "Shutdown acknowledged.", "shutdown_response", {
          request_id: accepted,
          approve: true,
        });
        return true;
      }
      if (message.type === "plan_approval_response") {
        workMessages.push(this.manager.applyPlanResponse(this.name, message));
        continue;
      }
      if (message.type === "plan_request") {
        workMessages.push(`[Plan required] ${message.content}`);
        continue;
      }
      workMessages.push(`[Message from ${message.from}] ${message.content}`);
    }
    if (workMessages.length > 0) {
      this.messages.push({ role: "user", content: workMessages.join("\n") });
    }
    return false;
  }

  async work(): Promise<WorkOutcome> {
    if (await this.handleInbox(await this.bus.readInbox(this.name))) return "stop";
    this.manager.setStatus(this.name, "working");
    let result: ToolInvocationResult | undefined;
    try {
      const { registry, workspaceToolNames } = this.buildRegistry();
      const tools = registry.listTools().map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parametersSchema ?? {
            type: "object",
            properties: { input: { type: "string" } },
          },
        },
      }));
      result = await this.llm.invokeWithTools?.(
        [{ role: "system", content: this.system }, ...this.messages],
        tools,
      );
    } catch (error) {
      await this.bus.send(
        this.name,
        "lead",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        "error",
      );
      return "stop";
    }
    if (!result || result.toolCalls.length === 0) {
      const summary = (result?.content ?? "").trim();
      const gate = this.manager.planGate(this.name);
      if (gate !== "pending" && summary) {
        await this.bus.send(this.name, "lead", summary, "result");
      }
      if (gate === "pending") {
        this.manager.setStatus(this.name, "waiting_approval");
      } else {
        await this.manager.releaseCompletedAssignment(this.name);
        this.manager.setStatus(this.name, "idle");
        await this.bus.send(this.name, "lead", "Waiting for more work.", "idle_notification");
      }
      return "idle";
    }

    this.messages.push({
      role: "assistant",
      content: result.content,
      toolCalls: result.toolCalls,
    });
    const { registry, workspaceToolNames } = this.buildRegistry();
    for (const toolCall of result.toolCalls) {
      const output = await this.executeTeammateTool(registry, workspaceToolNames, toolCall);
      this.messages.push({
        role: "tool",
        content: output,
        toolCallId: toolCall.id,
        name: toolCall.function.name,
      });
    }
    return "continue";
  }

  private async executeTeammateTool(
    registry: ToolRegistry,
    workspaceToolNames: Set<string>,
    toolCall: ToolCallRequest,
  ): Promise<string> {
    const name = toolCall.function.name;
    const gate = this.manager.planGate(this.name);
    if (workspaceToolNames.has(name)) {
      if (CHANGING_TOOLS.has(name) && gate !== "approved") {
        if (gate !== "not_required") {
          return (
            `Blocked: plan status is ${gate}. Submit or revise the plan and wait ` +
            "for approval before changing the workspace."
          );
        }
        if (this.permissionChecker) {
          const outcome = await this.permissionChecker.check({
            toolName: name,
            args: parseJsonObjectArguments(toolCall.function.arguments),
          });
          if (!outcome.allowed) {
            return `⛔ 权限已拒绝: ${outcome.reason ?? "未说明原因"}`;
          }
        }
      }
      try {
        await this.currentCwd();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
    try {
      const args = parseJsonObjectArguments(toolCall.function.arguments);
      const tool = registry.getTool(name);
      if (tool?.executeArgs) return await registry.executeToolArgs(name, args);
      return await registry.executeTool(name, toolCall.function.arguments);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async waitForWorkOnce(): Promise<boolean> {
    for (;;) {
      const inbox = await this.bus.waitForMessages(this.name, this.idleScanIntervalMs);
      if (inbox.length > 0) {
        const before = this.messages.length;
        if (await this.handleInbox(inbox)) return false;
        if (this.messages.length > before) return true;
        continue;
      }
      const task = await this.board.claimNext(this.name);
      if (!task) continue;
      const cwd = await this.board.assignmentCwd(this.name);
      this.messages.push({
        role: "user",
        content:
          `[Auto-claimed task ${task.id}] ${task.subject}\n${task.description}\nWork directory: ${cwd}`,
      });
      this.manager.setStatus(this.name, "working");
      return true;
    }
  }

  async run(): Promise<void> {
    try {
      let state: WorkOutcome = "continue";
      while (state !== "stop") {
        if (state === "idle") {
          if (!(await this.waitForWorkOnce())) break;
          state = "continue";
        }
        state = await this.work();
      }
    } catch (error) {
      await this.bus.send(
        this.name,
        "lead",
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        "error",
      ).catch(() => undefined);
    } finally {
      await this.manager.cleanupTeammate(this.name);
    }
  }
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
