/**
 * s13 Lead 侧团队工具：spawn/list/send/shutdown/plan/worktree。
 */

import { Tool, tryParseJsonObject } from "../tool";
import type { TeamManager } from "../../teams/team-manager";

abstract class TeamTool extends Tool {
  override async execute(input: string): Promise<string> {
    return this.executeArgs?.(tryParseJsonObject(input.trim()) ?? {}) ?? "";
  }
}

export class SpawnTeammateTool extends TeamTool {
  override get name() {
    return "spawn_teammate";
  }
  override get description() {
    return "Spawn a persistent teammate";
  }
  override get parametersDescription() {
    return 'JSON: {"name","role","prompt","task_id?","require_plan?"}';
  }
  override get parametersSchema() {
    return {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" },
        role: { type: "string" },
        prompt: { type: "string" },
        task_id: { type: "string" },
        require_plan: { type: "boolean" },
      },
      required: ["name", "role", "prompt"],
    };
  }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs(args: Record<string, unknown>) {
    return this.manager.spawnTeammate(
      stringArg(args.name),
      stringArg(args.role),
      stringArg(args.prompt),
      optionalString(args.task_id),
      args.require_plan === true,
    );
  }
}

export class ListTeammatesTool extends TeamTool {
  override get name() { return "list_teammates"; }
  override get description() { return "List active teammates"; }
  override get parametersDescription() { return "JSON: {}"; }
  override get parametersSchema() { return { type: "object", properties: {} }; }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs() { return this.manager.listTeammates(); }
}

export class SendTeammateMessageTool extends TeamTool {
  override get name() { return "send_message"; }
  override get description() { return "Message a teammate"; }
  override get parametersDescription() { return 'JSON: {"to","content"}'; }
  override get parametersSchema() {
    return {
      type: "object",
      properties: { to: { type: "string" }, content: { type: "string" } },
      required: ["to", "content"],
    };
  }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs(args: Record<string, unknown>) {
    return this.manager.sendFromLead(stringArg(args.to), stringArg(args.content));
  }
}

export class RequestShutdownTool extends TeamTool {
  override get name() { return "request_shutdown"; }
  override get description() { return "Ask a teammate to shut down"; }
  override get parametersDescription() { return 'JSON: {"teammate"}'; }
  override get parametersSchema() {
    return {
      type: "object",
      properties: { teammate: { type: "string" } },
      required: ["teammate"],
    };
  }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs(args: Record<string, unknown>) {
    return (await this.manager.requestShutdown(stringArg(args.teammate))) ??
      `Teammate '${stringArg(args.teammate)}' is not active`;
  }
}

export class RequestPlanTool extends TeamTool {
  override get name() { return "request_plan"; }
  override get description() { return "Require a teammate plan before workspace changes"; }
  override get parametersDescription() { return 'JSON: {"teammate","task"}'; }
  override get parametersSchema() {
    return {
      type: "object",
      properties: { teammate: { type: "string" }, task: { type: "string" } },
      required: ["teammate", "task"],
    };
  }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs(args: Record<string, unknown>) {
    return this.manager.requestPlan(stringArg(args.teammate), stringArg(args.task));
  }
}

export class ReviewPlanTool extends TeamTool {
  override get name() { return "review_plan"; }
  override get description() { return "Approve or reject a teammate plan"; }
  override get parametersDescription() { return 'JSON: {"request_id","approve","feedback?"}'; }
  override get parametersSchema() {
    return {
      type: "object",
      properties: {
        request_id: { type: "string" },
        approve: { type: "boolean" },
        feedback: { type: "string" },
      },
      required: ["request_id", "approve"],
    };
  }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs(args: Record<string, unknown>) {
    return this.manager.reviewPlan(
      stringArg(args.request_id),
      args.approve === true,
      optionalString(args.feedback) ?? "",
    );
  }
}

export class CreateWorktreeTool extends TeamTool {
  override get name() { return "create_worktree"; }
  override get description() { return "Create and bind a task worktree"; }
  override get parametersDescription() { return 'JSON: {"name","task_id"}'; }
  override get parametersSchema() {
    return {
      type: "object",
      properties: { name: { type: "string" }, task_id: { type: "string" } },
      required: ["name", "task_id"],
      additionalProperties: false,
    };
  }
  constructor(private readonly manager: TeamManager) { super(); }
  override async executeArgs(args: Record<string, unknown>) {
    return this.manager.board.worktrees?.create(stringArg(args.name), stringArg(args.task_id)) ??
      "Error: Worktree manager is not configured";
  }
}

export function createTeamTools(manager: TeamManager): Tool[] {
  return [
    new SpawnTeammateTool(manager),
    new ListTeammatesTool(manager),
    new SendTeammateMessageTool(manager),
    new RequestShutdownTool(manager),
    new RequestPlanTool(manager),
    new ReviewPlanTool(manager),
    new CreateWorktreeTool(manager),
  ];
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
