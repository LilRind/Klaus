/**
 * MCP 工具接入（对齐 learn-claude-code s14）
 *
 * 两个角色：server 提供工具列表（tools/list）与调用入口（tools/call）；
 * Harness 负责连接、命名（mcp__server__tool）、宿主侧权限检查，并把发现
 * 的工具加入每轮组装的工具池。课程用进程内 mock server 展示协议边界；
 * 真实 MCP transport（stdio JSON-RPC）见方案文档"改进项"。
 *
 * 授权只来自宿主配置（MCP_HOST_POLICY），server 自述的 readOnlyHint /
 * destructiveHint 不是授权依据；未配置的外部工具默认需要确认。
 */

import { Tool, tryParseJsonObject } from "../tools/tool";
import {
  PermissionChecker,
  type ApprovalPrompt,
  type PermissionCheckerOptions,
} from "../security/permission";

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

/** server 侧工具定义（对齐 MCP tools/list 条目形状） */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

type McpHandler = (args: Record<string, unknown>) => string | Promise<string>;

/** 进程内 MCP server 替身：保存发现结果与调用入口 */
export class MCPClient {
  readonly tools: McpToolDefinition[] = [];
  private readonly handlers = new Map<string, McpHandler>();

  constructor(readonly name: string) {}

  /** 工具发现结果注册（对齐 lcc MCPClient.register 的三重校验） */
  register(
    toolDefs: McpToolDefinition[],
    handlers: Record<string, McpHandler>,
  ): void {
    const names = toolDefs.map((tool) => tool.name);
    if (names.some((name) => typeof name !== "string" || !name)) {
      throw new Error("Every MCP tool needs a non-empty name");
    }
    if (new Set(names).size !== names.length) {
      throw new Error(`Duplicate MCP tool name on server '${this.name}'`);
    }
    const missing = names.filter((name) => !(name in handlers));
    if (missing.length > 0) {
      throw new Error(`Missing MCP handlers: ${missing.join(", ")}`);
    }
    this.tools.length = 0;
    this.handlers.clear();
    this.tools.push(...toolDefs);
    for (const [name, handler] of Object.entries(handlers)) {
      this.handlers.set(name, handler);
    }
  }

  /** 调用入口：错误留在工具边界（回喂模型，不炸循环） */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const handler = this.handlers.get(toolName);
    if (!handler) {
      return `MCP error: unknown tool '${toolName}'`;
    }
    try {
      return String(await handler(args));
    } catch (error: unknown) {
      const name = error instanceof Error ? error.constructor.name : "Error";
      const message = error instanceof Error ? error.message : String(error);
      return `MCP error: ${name}: ${message}`;
    }
  }
}

const DISALLOWED = /[^a-zA-Z0-9_-]/g;

/** 模型工具名以外的字符替换为下划线（对齐 lcc normalize_mcp_name） */
export function normalizeMcpName(name: string): string {
  const normalized = name.replace(DISALLOWED, "_");
  if (!normalized) {
    throw new Error("MCP names cannot normalize to an empty string");
  }
  return normalized;
}

export function createMockDocsServer(): MCPClient {
  const server = new MCPClient("docs");
  server.register(
    [
      {
        name: "search",
        description: "Search the documentation.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: "get_version",
        description: "Get the documentation API version.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ],
    {
      search: (args) => `[docs] Found 3 results for '${String(args.query)}'`,
      get_version: () => "[docs] API v2.1.0",
    },
  );
  return server;
}

export function createMockDeployServer(): MCPClient {
  const server = new MCPClient("deploy");
  server.register(
    [
      {
        name: "trigger",
        description: "Trigger a deployment.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
        annotations: { destructiveHint: true },
      },
      {
        name: "status",
        description: "Check deployment status.",
        inputSchema: {
          type: "object",
          properties: { service: { type: "string" } },
          required: ["service"],
        },
        annotations: { readOnlyHint: true },
      },
    ],
    {
      trigger: (args) => `[deploy] Triggered: ${String(args.service)}`,
      status: (args) => `[deploy] ${String(args.service)}: running (v1.4.2)`,
    },
  );
  return server;
}

export type McpPolicy = "allow" | "confirm";

/** 宿主侧授权策略：只来自配置，与 server 描述无关 */
export const MCP_HOST_POLICY: ReadonlyMap<string, McpPolicy> = new Map([
  ["docs:search", "allow"],
  ["docs:get_version", "allow"],
  ["deploy:status", "allow"],
  ["deploy:trigger", "confirm"],
]);

const MAX_TOOL_NAME_LENGTH = 64;

/** 组装出的 MCP 桥接工具：模型见前缀名，handler 用 server 原始名调用 */
export class McpTool extends Tool {
  override get name(): string {
    return this.prefixedName;
  }

  override get description(): string {
    return this.definition.description;
  }

  override get parametersDescription(): string {
    return `MCP tool ${this.serverName}/${this.definition.name}`;
  }

  override get parametersSchema(): Record<string, unknown> {
    return this.definition.inputSchema;
  }

  constructor(
    private readonly client: MCPClient,
    private readonly serverName: string,
    private readonly definition: McpToolDefinition,
    private readonly prefixedName: string,
  ) {
    super();
  }

  override async execute(input: string): Promise<string> {
    const args = tryParseJsonObject(input.trim());
    return this.executeArgs(args ?? { input });
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    return await this.client.callTool(this.definition.name, args);
  }
}

export interface McpConnectionManagerOptions {
  /** server 工厂表（默认 docs/deploy 两个 mock） */
  servers?: Record<string, () => MCPClient>;
  /** 宿主策略覆盖（键 "server:tool"） */
  hostPolicy?: Record<string, McpPolicy>;
}

/** 连接管理 + 工具池组装 + 策略查询（翻译 lcc 的模块级全局） */
export class McpConnectionManager {
  readonly clients = new Map<string, MCPClient>();
  /** 已连接 MCP 工具的前缀名（活引用，供权限规则 includes 查询） */
  readonly mcpToolNames: string[] = [];
  private readonly policies = new Map<string, McpPolicy>();
  private readonly servers: Record<string, () => MCPClient>;
  private readonly hostPolicy: Record<string, McpPolicy>;

  constructor(options: McpConnectionManagerOptions = {}) {
    this.servers = options.servers ?? {
      docs: createMockDocsServer,
      deploy: createMockDeployServer,
    };
    this.hostPolicy = options.hostPolicy ?? Object.fromEntries(MCP_HOST_POLICY);
  }

  /** 可连接的 server 名单（connect_mcp 工具的 enum 用） */
  serverNames(): string[] {
    return Object.keys(this.servers);
  }

  /** 已连接的 server 名单（s15 system prompt 的 Connected MCP servers 段用） */
  connectedNames(): string[] {
    return [...this.clients.keys()];
  }

  /** 连接并发现工具（对齐 lcc connect_mcp 文案） */
  connect(name: string): string {
    if (this.clients.has(name)) {
      return `MCP server '${name}' already connected`;
    }
    const factory = this.servers[name];
    if (!factory) {
      const available = Object.keys(this.servers).join(", ");
      return `Unknown server '${name}'. Available: ${available}`;
    }
    const server = factory();
    this.clients.set(name, server);
    this.rebuildPolicies();
    const names = server.tools.map((tool) => tool.name).join(", ");
    return `Connected to MCP server '${name}'. Discovered ${server.tools.length} tools: ${names}`;
  }

  private rebuildPolicies(): void {
    this.policies.clear();
    this.mcpToolNames.length = 0;
    for (const [serverName, server] of this.clients) {
      for (const tool of server.tools) {
        const prefixed = this.prefixedName(serverName, tool.name);
        this.policies.set(
          prefixed,
          this.hostPolicy[`${serverName}:${tool.name}`] ?? "confirm",
        );
        this.mcpToolNames.push(prefixed);
      }
    }
  }

  private prefixedName(serverName: string, rawToolName: string): string {
    return `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(rawToolName)}`;
  }

  /** 宿主策略查询：未配置默认 confirm（对齐 lcc mcp_tool_policies） */
  getPolicy(prefixedName: string): McpPolicy {
    return this.policies.get(prefixedName) ?? "confirm";
  }

  /**
   * 组装当前已连接 server 的桥接工具（对齐 lcc assemble_tool_pool 的 MCP 部分）。
   * builtinNames 用于规范化后与内置工具的冲突检测；冲突/超长/schema 非法抛错。
   */
  assembleTools(builtinNames: string[]): McpTool[] {
    const origins = new Map<string, string>(
      builtinNames.map((name) => [name, `built-in tool '${name}'`]),
    );
    const tools: McpTool[] = [];
    for (const [serverName, server] of this.clients) {
      const safeServer = normalizeMcpName(serverName);
      for (const toolDef of server.tools) {
        const rawName = toolDef.name;
        const safeTool = normalizeMcpName(rawName);
        const prefixed = `mcp__${safeServer}__${safeTool}`;
        if (prefixed.length > MAX_TOOL_NAME_LENGTH) {
          throw new Error(
            `MCP tool name is longer than ${MAX_TOOL_NAME_LENGTH} characters: ${prefixed}`,
          );
        }
        const origin = `MCP tool '${serverName}'/'${rawName}'`;
        const existing = origins.get(prefixed);
        if (existing) {
          throw new Error(
            `MCP tool name collision after normalization: '${prefixed}' maps both ${existing} and ${origin}`,
          );
        }
        const schema = toolDef.inputSchema;
        if (
          typeof schema !== "object" ||
          schema === null ||
          (schema.type ?? "object") !== "object"
        ) {
          throw new Error(`Invalid input schema for ${origin}`);
        }
        origins.set(prefixed, origin);
        tools.push(new McpTool(server, serverName, toolDef, prefixed));
      }
    }
    return tools;
  }
}

export interface McpPermissionOptions {
  manager: McpConnectionManager;
  /** 基础权限配置（如 createStandardPermissionRules 的产物） */
  base?: PermissionCheckerOptions;
  /** 审批器；未配置时 confirm 策略安全默认拒绝 */
  prompt?: ApprovalPrompt;
}

/**
 * MCP 宿主权限检查器：在基础规则之上追加"外部工具默认需确认"闸门。
 * ask 规则的 tools 数组是 manager.mcpToolNames 的活引用——
 * server 连接/断开后无需重建 checker。
 */
export function createMcpPermissionChecker(
  options: McpPermissionOptions,
): PermissionChecker {
  const base = options.base ?? {};
  const mcpAskRule = {
    tools: options.manager.mcpToolNames,
    test(request: { toolName: string }): string | null {
      if (options.manager.getPolicy(request.toolName) === "allow") {
        return null;
      }
      return `外部 MCP 工具 ${request.toolName} 需要宿主确认`;
    },
  };
  return new PermissionChecker({
    denyRules: [...(base.denyRules ?? [])],
    askRules: [...(base.askRules ?? []), mcpAskRule],
    prompt: options.prompt ?? base.prompt,
  });
}
