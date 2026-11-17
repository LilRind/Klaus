/**
 * s18 多Agent编排 领域契约（主参考 Shannon 当前代码；书 13-16 辅助）。
 * 来源标注：Subtask/Plan 对齐 strategies/dag.go；Worker 5-Action 对齐
 * roles/swarm/agent_protocol.py；Lead Action 对齐 lead_protocol.py；
 * P2P 5 类型与 Workspace Entry 对齐 activities/p2p.go。
 */

/** 执行线（v2 路由：swarm 仅早路由进入，无自动 swarm）。 */
export type ExecutionMode = "simple" | "dag" | "swarm";

/** DAG 线内部执行模式（对齐 dag.go selectExecutionStrategy）。 */
export type DagStrategy = "parallel" | "sequential" | "hybrid";

/** 子任务（对齐 SN Subtask：任务依赖 + 数据主题声明）。 */
export interface Subtask {
  id: string;
  description: string;
  /** 任务级依赖：必须等这些 id 完成。 */
  dependencies: string[];
  /** 产出的数据主题。 */
  produces: string[];
  /** 需要的数据主题（批2 生产者集合验证）。 */
  consumes: string[];
  /** 建议工具名（isSimple 判定输入；DAG 线 v1 纯 LLM，工具执行属 Swarm worker）。 */
  suggestedTools: string[];
}

/** 分解计划：分解 LLM 的结构化产物（strategy 仅 parallel/sequential，无 swarm）。 */
export interface TaskPlan {
  complexity: number;
  strategy: "parallel" | "sequential";
  subtasks: Subtask[];
}

/** 子任务执行结果（对齐 SN AgentExecutionResult 裁剪）。 */
export interface AgentResult {
  taskId: string;
  response: string;
  tokens: number;
  success: boolean;
  /** 从 response 提取的首个数值（previous_results 注入用）。 */
  numericValue?: number;
}

/** ---- Worker 单 Action 协议（批3 使用，类型先行） ---- */
export type WorkerAction =
  | { type: "tool_call"; tool: string; params: Record<string, unknown> }
  | { type: "publish_data"; topic: string; data: string }
  | { type: "send_message"; to: string; messageType: P2PMessageType; content: string }
  | { type: "idle"; keyFindings?: string; summary?: string }
  | { type: "done"; summary?: string };

/** ---- Lead Action 词汇表（12 主 + 3 辅助；批3 使用，类型先行） ---- */
export type LeadAction =
  | { type: "spawn_agent"; agentId?: string; role: string; taskId?: string; taskDescription: string; tier?: "small" | "medium" | "large" }
  | { type: "assign_task"; agentId: string; taskId: string; taskDescription?: string }
  | { type: "create_task"; id: string; description: string; dependsOn?: string[] }
  | { type: "cancel_task"; taskId: string }
  | { type: "revise_plan"; create?: Array<{ id: string; description: string; dependsOn?: string[] }>; update?: Array<{ id: string; description: string }>; cancel?: string[] }
  | { type: "send_message"; to: string; content: string; messageType?: P2PMessageType }
  | { type: "broadcast"; content: string }
  | { type: "shutdown_agent"; agentId: string }
  | { type: "interim_reply"; content: string }
  | { type: "final_reply"; content: string }
  | { type: "synthesize" }
  | { type: "done" }
  | { type: "file_read"; path: string }
  | { type: "tool_call"; tool: string; params: Record<string, unknown> }
  | { type: "noop"; reason?: string };

/** Lead 事件循环四类事件（批3 使用，类型先行）。 */
export type LeadEvent =
  | { type: "initial_plan"; input: string }
  | { type: "agent_idle"; agentId: string; keyFindings?: string }
  | { type: "agent_completed"; agentId: string; summary?: string }
  | { type: "checkpoint" }
  | { type: "human_input"; text: string };

/** ---- P2P Mailbox（批2 使用，类型先行） ---- */
export type P2PMessageType = "request" | "offer" | "accept" | "delegation" | "info";

export interface P2PMessage {
  seq: number;
  from: string;
  to: string;
  type: P2PMessageType;
  payload: Record<string, unknown>;
  at: string;
}

/** ---- Workspace（批2 使用，类型先行） ---- */
export interface WorkspaceEntry {
  seq: number;
  topic: string;
  entry: unknown;
  at: string;
}

/** ---- 参数默认值（interview §8，全部可配置） ---- */
export const DEFAULTS = {
  /** 并行/混合并发上限（s16 Semaphore）。 */
  maxConcurrency: 5,
  /** isSimple 复杂度阈值（< 该值才可能 simple）。 */
  simpleComplexityThreshold: 0.3,
  /** Swarm 每 Worker 迭代上限。 */
  iterationLimit: 50,
  /** Lead checkpoint 间隔。 */
  checkpointIntervalMs: 120_000,
  /** interim_reply 节流窗口。 */
  interimThrottleMs: 60_000,
  /** 单 Worker 重派上限。 */
  maxReassigns: 2,
  /** Workspace 单 entry 字节上限。 */
  entryByteLimit: 1024 * 1024,
  /** 增量读取默认 limit。 */
  listLimit: 200,
  /** Swarm 最大 worker 数。 */
  maxWorkers: 6,
} as const;
