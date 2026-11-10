/**
 * s13 TeamManager：Lead 侧的 teammate 注册表与团队工具装配入口。
 */

import path from "node:path";
import type { ChatLLM } from "../core/llm";
import type { Tool } from "../tools/tool";
import { ReadFileTool, WriteFileTool, EditFileTool, GlobTool } from "../tools/builtin/file-tools";
import { BashTool } from "../tools/builtin/bash-tool";
import type { PermissionChecker } from "../security/permission";
import type { TaskBoard } from "./task-board";
import { MessageBus, type TeamMessage } from "./message-bus";
import { TeamProtocol, formatTeamEvents } from "./team-protocol";
import { TeammateRuntime, type TeammateStatus } from "./teammate-runtime";

export const RESERVED_TEAMMATE_NAMES = new Set(["lead", "agent"]);

export interface TeamManagerOptions {
  llm: ChatLLM;
  board: TaskBoard;
  bus?: MessageBus;
  protocol?: TeamProtocol;
  workspaceRoot?: string;
  workspaceTools?: (cwd: string) => Tool[];
  permissionChecker?: PermissionChecker;
  autoStart?: boolean;
  idleScanIntervalMs?: number;
}

export class TeamManager {
  readonly board: TaskBoard;
  readonly bus: MessageBus;
  readonly protocol: TeamProtocol;
  private readonly llm: ChatLLM;
  private readonly workspaceRoot: string;
  private readonly workspaceTools: (cwd: string) => Tool[];
  private readonly permissionChecker?: PermissionChecker;
  private readonly autoStart: boolean;
  private readonly idleScanIntervalMs: number;
  private readonly runtimes = new Map<string, TeammateRuntime>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly statuses = new Map<string, TeammateStatus>();
  private readonly gates = new Map<string, string>();
  private readonly planRequestIds = new Map<string, string>();

  constructor(options: TeamManagerOptions) {
    this.llm = options.llm;
    if (typeof this.llm.invokeWithTools !== "function") {
      throw new Error("TeamManager 需要支持 invokeWithTools 的 LLM 实现");
    }
    this.board = options.board;
    this.bus = options.bus ?? new MessageBus({
      directory: path.join(options.workspaceRoot ?? process.cwd(), ".mailboxes"),
    });
    this.protocol = options.protocol ?? new TeamProtocol();
    this.workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
    this.workspaceTools = options.workspaceTools ?? defaultWorkspaceTools;
    this.permissionChecker = options.permissionChecker;
    this.autoStart = options.autoStart ?? true;
    this.idleScanIntervalMs = options.idleScanIntervalMs ?? 2_000;
  }

  getRuntime(name: string): TeammateRuntime | undefined {
    return this.runtimes.get(name);
  }

  currentAssignment(name: string) {
    return this.board.getAssignment(name);
  }

  setStatus(name: string, status: TeammateStatus): void {
    if (this.statuses.has(name)) this.statuses.set(name, status);
  }

  planGate(name: string): string {
    return this.gates.get(name) ?? "not_required";
  }

  async releaseCompletedAssignment(name: string): Promise<boolean> {
    const released = await this.board.releaseCompletedAssignment(name);
    if (released && this.planGate(name) !== "not_required") {
      this.gates.set(name, "required");
    }
    return released;
  }

  async spawnRuntime(
    name: string,
    role: string,
    prompt: string,
    options: { taskId?: string | null; requirePlan?: boolean } = {},
  ): Promise<TeammateRuntime> {
    const existing = await this.createTeammate(name, role, prompt, options);
    return existing;
  }

  private async createTeammate(
    name: string,
    role: string,
    prompt: string,
    options: { taskId?: string | null; requirePlan?: boolean },
    registerOnly = false,
  ): Promise<TeammateRuntime> {
    const invalid = teammateNameError(name);
    if (invalid) throw new Error(invalid);
    if ([...this.statuses.keys()].some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Teammate '${name}' already exists`);
    }
    this.statuses.set(name, "working");
    this.gates.set(name, options.requirePlan ? "required" : "not_required");
    if (options.taskId) {
      const claimed = await this.board.claim(options.taskId, name);
      if (!claimed.startsWith("Claimed ")) {
        this.statuses.delete(name);
        this.gates.delete(name);
        throw new Error(claimed);
      }
    }
    const runtime = new TeammateRuntime({
      name,
      role,
      prompt,
      taskId: options.taskId,
      requirePlan: options.requirePlan,
      llm: this.llm,
      board: this.board,
      bus: this.bus,
      manager: this,
      workspaceTools: this.workspaceTools,
      permissionChecker: this.permissionChecker,
      idleScanIntervalMs: this.idleScanIntervalMs,
    });
    await runtime.initialize({ taskId: options.taskId });
    this.runtimes.set(name, runtime);
    if (!registerOnly && this.autoStart) this.start(name, runtime);
    return runtime;
  }

  private start(name: string, runtime: TeammateRuntime): void {
    if (this.running.has(name)) return;
    const promise = runtime.run().finally(() => this.running.delete(name));
    this.running.set(name, promise);
  }

  async spawnTeammate(
    name: string,
    role: string,
    prompt: string,
    taskId?: string,
    requirePlan = false,
  ): Promise<string> {
    const invalid = teammateNameError(name);
    if (invalid) return invalid;
    try {
      await this.createTeammate(name, role, prompt, { taskId, requirePlan }, !this.autoStart);
    } catch (error) {
      return `Cannot spawn teammate '${name}': ${error instanceof Error ? error.message : String(error)}`;
    }
    const assigned = taskId ? ` for ${taskId}` : " without an initial Task";
    return (
      `Teammate '${name}' spawned as ${role}${assigned}. ` +
      "End this turn; the runtime will deliver its events."
    );
  }

  async listTeammates(): Promise<string> {
    if (this.statuses.size === 0) return "No active teammates.";
    return [...this.statuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, status]) => `${name}: ${status}`)
      .join("\n");
  }

  async sendFromLead(to: string, content: string): Promise<string> {
    if (!this.statuses.has(to)) return `Teammate '${to}' is not active`;
    await this.bus.send("lead", to, content);
    return `Sent to ${to}`;
  }

  async sendFromTeammate(from: string, to: string, content: string): Promise<string> {
    if (to !== "lead" && !this.statuses.has(to)) return `Agent '${to}' is not active`;
    await this.bus.send(from, to, content);
    return `Sent to ${to}`;
  }

  async requestShutdown(teammate: string): Promise<string | null> {
    if (!this.statuses.has(teammate)) return null;
    const requestId = this.protocol.createRequest({
      type: "shutdown",
      sender: "lead",
      target: teammate,
      payload: "",
    });
    await this.bus.send("lead", teammate, "Finish the current step and shut down.", "shutdown_request", {
      request_id: requestId,
    });
    return `Shutdown requested from ${teammate} (${requestId})`;
  }

  async requestPlan(teammate: string, task: string): Promise<string> {
    if (!this.statuses.has(teammate)) return `Teammate '${teammate}' is not active`;
    this.gates.set(teammate, "required");
    await this.bus.send("lead", teammate, task, "plan_request");
    return `Plan requested from ${teammate}`;
  }

  async submitPlan(name: string, plan: string): Promise<string> {
    if (this.planGate(name) === "pending") {
      return "A plan is already waiting for review.";
    }
    const identity = this.board.currentWorkIdentity(name);
    const requestId = this.protocol.createRequest({
      type: "plan_approval",
      sender: name,
      target: "lead",
      payload: plan,
      workVersion: identity.version,
      taskId: identity.taskId,
    });
    this.planRequestIds.set(name, requestId);
    this.gates.set(name, "pending");
    this.statuses.set(name, "waiting_approval");
    await this.bus.send(name, "lead", plan, "plan_approval_request", { request_id: requestId });
    return `Plan submitted (${requestId}). Wait for Lead's decision.`;
  }

  async reviewPlan(requestId: string, approve: boolean, feedback = ""): Promise<string> {
    let state = this.protocol.getRequest(requestId);
    if (!state) return `Request ${requestId} not found`;
    const identity = this.board.currentWorkIdentity(state.sender);
    state = this.protocol.getRequest(requestId);
    if (!state) return `Request ${requestId} not found`;
    if (state.type !== "plan_approval") return `Request ${requestId} is not a plan`;
    if (state.status !== "pending") return `Request ${requestId} already ${state.status}`;
    if (state.work_version !== identity.version || state.task_id !== identity.taskId) {
      return `Request ${requestId} belongs to an earlier assignment`;
    }
    if (this.planRequestIds.get(state.sender) !== requestId) {
      return `Request ${requestId} is not the current plan`;
    }
    const status = approve ? "approved" : "rejected";
    this.protocol.setRequest(requestId, status);
    const content = feedback || (approve ? "Plan approved." : "Revise the plan and submit it again.");
    await this.bus.send("lead", state.sender, content, "plan_approval_response", {
      request_id: requestId,
      approve,
    });
    return `Plan ${status} (${requestId})`;
  }

  applyPlanResponse(name: string, message: TeamMessage): string {
    const requestId = String(message.metadata.request_id ?? "");
    const state = this.protocol.getRequest(requestId);
    const identity = this.board.currentWorkIdentity(name);
    const valid =
      message.from === "lead" &&
      message.to === name &&
      requestId === this.planRequestIds.get(name) &&
      state?.type === "plan_approval" &&
      state.sender === name &&
      state.target === "lead" &&
      state.work_version === identity.version &&
      state.task_id === identity.taskId &&
      (state.status === "approved" || state.status === "rejected") &&
      message.metadata.approve === (state.status === "approved");
    if (!valid) return "[Ignored plan response: request mismatch]";
    this.gates.set(name, state.status);
    this.statuses.set(name, "working");
    this.planRequestIds.delete(name);
    return `[Plan ${state.status}] ${message.content}`;
  }

  applyShutdownRequest(name: string, message: TeamMessage): string | null {
    const requestId = String(message.metadata.request_id ?? "");
    const state = this.protocol.getRequest(requestId);
    const valid =
      message.from === "lead" &&
      message.to === name &&
      state?.type === "shutdown" &&
      state.sender === "lead" &&
      state.target === name &&
      state.status === "pending" &&
      this.statuses.get(name) !== "stopping";
    if (!valid) return null;
    this.statuses.set(name, "stopping");
    return requestId;
  }

  async collectLeadEvents(): Promise<string[]> {
    const messages = await this.bus.readInbox("lead");
    for (const message of messages) {
      const requestId = String(message.metadata.request_id ?? "");
      if (requestId && message.type.endsWith("_response")) {
        this.protocol.matchResponse(
          message.type,
          requestId,
          message.metadata.approve === true,
          message.from,
          message.to,
        );
      }
    }
    return messages.length > 0 ? [formatTeamEvents(messages)] : [];
  }

  async cleanupTeammate(name: string): Promise<void> {
    await this.board.releaseOwnerAndRequeue(name);
    this.runtimes.delete(name);
    this.statuses.delete(name);
    this.gates.delete(name);
    this.planRequestIds.delete(name);
  }
}

export function teammateNameError(name: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return "Invalid teammate name: use 1-64 letters, digits, underscores, or dashes";
  }
  if (RESERVED_TEAMMATE_NAMES.has(name.toLowerCase())) {
    return `Invalid teammate name: '${name}' is reserved by the runtime`;
  }
  return null;
}

function defaultWorkspaceTools(cwd: string): Tool[] {
  return [
    new ReadFileTool({ workspace: cwd }),
    new WriteFileTool({ workspace: cwd }),
    new EditFileTool({ workspace: cwd }),
    new GlobTool({ workspace: cwd }),
    new BashTool({ cwd }),
  ];
}
