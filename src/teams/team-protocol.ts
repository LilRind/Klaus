/**
 * s13 类型化 Team 协议。
 *
 * 请求/响应不是普通 message 字符串约定，而是带 request_id 的状态机：
 * pending -> approved/rejected；响应必须类型、方向、request_id、状态全部匹配。
 */

export type TeamRequestType = "shutdown" | "plan_approval";
export type TeamRequestStatus = "pending" | "approved" | "rejected";

export interface ProtocolState {
  request_id: string;
  type: TeamRequestType;
  sender: string;
  target: string;
  status: TeamRequestStatus;
  payload: string;
  work_version?: number;
  task_id?: string | null;
  created_at: number;
}

export interface CreateProtocolRequest
  extends Pick<ProtocolState, "type" | "sender" | "target" | "payload"> {
  workVersion?: number;
  taskId?: string | null;
}

const EXPECTED_RESPONSE: Record<TeamRequestType, string> = {
  shutdown: "shutdown_response",
  plan_approval: "plan_approval_response",
};

export class TeamProtocol {
  private readonly requests = new Map<string, ProtocolState>();
  private counter = 0;

  createRequest(request: CreateProtocolRequest): string {
    let requestId = "";
    do {
      this.counter = (this.counter + Math.floor(Math.random() * 1000) + 1) % 1_000_000;
      requestId = `req_${String(this.counter).padStart(6, "0")}`;
    } while (this.requests.has(requestId));
    this.requests.set(requestId, {
      request_id: requestId,
      type: request.type,
      sender: request.sender,
      target: request.target,
      status: "pending",
      payload: request.payload,
      work_version: request.workVersion,
      task_id: request.taskId,
      created_at: Date.now(),
    });
    return requestId;
  }

  getRequest(requestId: string): ProtocolState | undefined {
    return this.requests.get(requestId);
  }

  setRequest(requestId: string, status: TeamRequestStatus): boolean {
    const state = this.requests.get(requestId);
    if (!state || state.status !== "pending") return false;
    state.status = status;
    return true;
  }

  matchResponse(
    responseType: string,
    requestId: string,
    approve: boolean,
    fromAgent: string,
    toAgent: string,
  ): boolean {
    const state = this.requests.get(requestId);
    if (!state) return false;
    if (responseType !== EXPECTED_RESPONSE[state.type]) return false;
    if (fromAgent !== state.target || toAgent !== state.sender) return false;
    if (state.status !== "pending") return false;
    state.status = approve ? "approved" : "rejected";
    return true;
  }
}

export function formatTeamEvents(messages: { type: string; from: string; content: string; metadata?: Record<string, unknown> }[]): string {
  const lines = messages.map((message) => {
    const requestId = typeof message.metadata?.request_id === "string"
      ? message.metadata.request_id
      : undefined;
    const suffix = requestId ? ` request_id=${requestId}` : "";
    return `[${message.type}${suffix}] ${message.from}: ${message.content}`;
  });
  return `[Team events]\n${lines.join("\n")}`;
}
