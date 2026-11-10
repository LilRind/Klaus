/**
 * s14 MCP Plugin 离线验收（对齐 README"试一下"观察点）
 *
 * - MCPClient：register 校验（空名/重名/缺 handler）、callTool 错误留在边界；
 * - normalizeMcpName：非法字符规范化；
 * - mock server（docs/deploy）工具定义与调用结果；
 * - 连接与发现：未知 server / 已连接 / Connected 消息；
 * - assembleTools：mcp__server__tool 命名、规范化后冲突、64 字符上限、schema 校验；
 * - 宿主策略：allow 直行、confirm 询问、未配置默认 confirm；
 *   server 自述 readOnlyHint 不作为授权依据；
 * - ToolRegistry 动态工具池 + FunctionCallAgent 每轮组装（连接后下一轮可见）。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  McpConnectionManager,
  McpTool,
  MCPClient,
  createMcpPermissionChecker,
  createMockDeployServer,
  createMockDocsServer,
  normalizeMcpName,
} from "../src/mcp/mcp";
import { ConnectMcpTool } from "../src/tools/builtin/connect-mcp-tool";
import { ToolRegistry } from "../src/tools/registry";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ScriptedLLM } from "./scripted-llm";
import { AutoAllowPrompt, AutoDenyPrompt } from "../src/security/permission";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(path.join(tmpdir(), "ha-ts-s14-"));
});

afterEach(async () => {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
});

function call(id: string, name: string, args: unknown): ToolCallRequest {
  return {
    id,
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

function turn(...toolCalls: ToolCallRequest[]): ToolInvocationResult {
  return { content: null, toolCalls };
}

function finalTurn(text: string): ToolInvocationResult {
  return { content: text, toolCalls: [] };
}

describe("MCPClient（进程内 server 替身）", () => {
  it("register：空名 / 重名 / 缺 handler 各自拒绝", () => {
    const server = new MCPClient("test");
    expect(() =>
      server.register([{ name: "", description: "", inputSchema: {} }], {}),
    ).toThrow(/non-empty name/i);
    expect(() =>
      server.register(
        [
          { name: "a", description: "", inputSchema: {} },
          { name: "a", description: "", inputSchema: {} },
        ],
        { a: () => "x" },
      ),
    ).toThrow(/Duplicate MCP tool name/i);
    expect(() =>
      server.register([{ name: "a", description: "", inputSchema: {} }], {}),
    ).toThrow(/Missing MCP handlers: a/);
  });

  it("callTool：未知工具与 handler 异常都留在工具边界", async () => {
    const server = new MCPClient("test");
    server.register(
      [{ name: "boom", description: "", inputSchema: {} }],
      {
        boom: () => {
          throw new TypeError("bad input");
        },
      },
    );
    await expect(server.callTool("missing", {})).resolves.toBe(
      "MCP error: unknown tool 'missing'",
    );
    await expect(server.callTool("boom", {})).resolves.toMatch(
      /MCP error: TypeError: bad input/,
    );
  });

  it("normalizeMcpName：非法字符折叠为下划线", () => {
    expect(normalizeMcpName("one/get.version")).toBe("one_get_version");
    expect(normalizeMcpName("中文")).toBe("__");
    expect(normalizeMcpName("///")).toBe("___");
  });
});

describe("mock server 与连接发现", () => {
  it("docs/deploy 工具定义与调用结果（readOnlyHint 存在但不作授权）", async () => {
    const docs = createMockDocsServer();
    expect(docs.tools.map((t) => t.name)).toEqual(["search", "get_version"]);
    expect(docs.tools[0]?.annotations?.readOnlyHint).toBe(true);
    await expect(docs.callTool("search", { query: "agent hooks" })).resolves.toBe(
      "[docs] Found 3 results for 'agent hooks'",
    );
    await expect(docs.callTool("get_version", {})).resolves.toBe(
      "[docs] API v2.1.0",
    );

    const deploy = createMockDeployServer();
    await expect(deploy.callTool("status", { service: "web" })).resolves.toBe(
      "[deploy] web: running (v1.4.2)",
    );
    await expect(deploy.callTool("trigger", { service: "web" })).resolves.toBe(
      "[deploy] Triggered: web",
    );
  });

  it("connect：未知 server / 成功发现 / 重复连接", () => {
    const manager = new McpConnectionManager();
    expect(manager.connect("nope")).toBe(
      "Unknown server 'nope'. Available: docs, deploy",
    );
    expect(manager.connect("docs")).toBe(
      "Connected to MCP server 'docs'. Discovered 2 tools: search, get_version",
    );
    expect(manager.connect("docs")).toBe("MCP server 'docs' already connected");
  });
});

describe("assembleTools（命名 / 冲突 / 长度 / schema）", () => {
  it("生成 mcp__server__tool 命名并带原始 handler", async () => {
    const manager = new McpConnectionManager();
    manager.connect("docs");
    const tools = manager.assembleTools(["bash", "read_file"]);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__docs__search",
      "mcp__docs__get_version",
    ]);
    const search = tools[0] as McpTool;
    expect(search.parametersSchema).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
    expect(await search.executeArgs({ query: "hooks" })).toContain(
      "[docs] Found 3 results",
    );
  });

  it("与内置工具规范化后冲突抛错", () => {
    const manager = new McpConnectionManager({
      servers: {
        odd: () => {
          const server = new MCPClient("odd");
          server.register(
            [{ name: "one/get.version", description: "", inputSchema: {} }],
            { "one/get.version": () => "a" },
          );
          return server;
        },
      },
    });
    manager.connect("odd");
    expect(() => manager.assembleTools(["mcp__odd__one_get_version"])).toThrow(
      /collision after normalization/i,
    );
  });

  it("超过 64 字符拒绝；inputSchema 非 object 拒绝", () => {
    const longName = "x".repeat(70);
    const longManager = new McpConnectionManager({
      servers: {
        long: () => {
          const server = new MCPClient("long");
          server.register(
            [{ name: longName, description: "", inputSchema: {} }],
            { [longName]: () => "x" },
          );
          return server;
        },
      },
    });
    longManager.connect("long");
    expect(() => longManager.assembleTools([])).toThrow(/longer than 64/);

    const badManager = new McpConnectionManager({
      servers: {
        bad: () => {
          const server = new MCPClient("bad");
          server.register(
            [{ name: "t", description: "", inputSchema: { type: "string" } }],
            { t: () => "x" },
          );
          return server;
        },
      },
    });
    badManager.connect("bad");
    expect(() => badManager.assembleTools([])).toThrow(/Invalid input schema/);
  });

  it("宿主策略：allow 直行 / confirm 询问 / 未配置默认 confirm", () => {
    const manager = new McpConnectionManager();
    manager.connect("docs");
    manager.connect("deploy");
    expect(manager.getPolicy("mcp__docs__search")).toBe("allow");
    expect(manager.getPolicy("mcp__docs__get_version")).toBe("allow");
    expect(manager.getPolicy("mcp__deploy__status")).toBe("allow");
    expect(manager.getPolicy("mcp__deploy__trigger")).toBe("confirm");
    expect(manager.getPolicy("mcp__unknown__tool")).toBe("confirm");
  });
});

describe("ToolRegistry 动态工具池 + Agent 每轮组装", () => {
  it("registry.setDynamicToolProvider：连接后工具池增长且可执行", async () => {
    const manager = new McpConnectionManager();
    const registry = new ToolRegistry()
      .register(new ConnectMcpTool(manager))
      .setDynamicToolProvider(() => manager.assembleTools(["connect_mcp"]))
      .assertAllStructured();
    expect(registry.listTools().map((t) => t.name)).toEqual(["connect_mcp"]);

    await registry.executeToolArgs("connect_mcp", { name: "docs" });
    expect(registry.listTools().map((t) => t.name)).toEqual([
      "connect_mcp",
      "mcp__docs__search",
      "mcp__docs__get_version",
    ]);
    await expect(
      registry.executeToolArgs("mcp__docs__search", { query: "hooks" }),
    ).resolves.toBe("[docs] Found 3 results for 'hooks'");
  });

  it("FunctionCallAgent：connect 后下一轮模型调用看到 MCP 工具", async () => {
    const manager = new McpConnectionManager();
    const registry = new ToolRegistry()
      .register(new ConnectMcpTool(manager))
      .setDynamicToolProvider(() => manager.assembleTools(["connect_mcp"]));
    const llm = new ScriptedLLM([], [
      turn(call("t1", "connect_mcp", { name: "docs" })),
      turn(call("t2", "mcp__docs__search", { query: "agent hooks" })),
      finalTurn("found docs"),
    ]);
    const agent = new FunctionCallAgent("s14-agent", llm, registry);

    const answer = await agent.run("Connect the docs server and search agent hooks");
    expect(answer).toBe("found docs");

    const firstTools = llm.toolCallsList[0]?.tools.map((t) => t.function.name);
    const secondTools = llm.toolCallsList[1]?.tools.map((t) => t.function.name);
    expect(firstTools).toEqual(["connect_mcp"]);
    expect(secondTools).toContain("mcp__docs__search");

    const toolMessages = (llm.toolCallsList[2]?.messages ?? []).filter(
      (m) => m.role === "tool",
    );
    expect(toolMessages[1]?.content).toBe(
      "[docs] Found 3 results for 'agent hooks'",
    );
  });
});

describe("MCP 宿主权限策略", () => {
  it("allow 策略直接执行；confirm 策略走审批（拒绝/放行）", async () => {
    const manager = new McpConnectionManager();
    manager.connect("docs");
    manager.connect("deploy");

    const denyRegistry = new ToolRegistry()
      .setDynamicToolProvider(() => manager.assembleTools([]))
      .setPermissionChecker(
        createMcpPermissionChecker({
          manager,
          prompt: new AutoDenyPrompt(),
        }),
      );
    await expect(
      denyRegistry.executeToolArgs("mcp__docs__search", { query: "q" }),
    ).resolves.toBe("[docs] Found 3 results for 'q'");
    await expect(
      denyRegistry.executeToolArgs("mcp__deploy__trigger", { service: "web" }),
    ).resolves.toMatch(/⛔/);

    const allowRegistry = new ToolRegistry()
      .setDynamicToolProvider(() => manager.assembleTools([]))
      .setPermissionChecker(
        createMcpPermissionChecker({
          manager,
          prompt: new AutoAllowPrompt(),
        }),
      );
    await expect(
      allowRegistry.executeToolArgs("mcp__deploy__trigger", { service: "web" }),
    ).resolves.toBe("[deploy] Triggered: web");
  });

  it("server 自述 readOnlyHint 不作为授权：未配置工具仍需确认", async () => {
    const manager = new McpConnectionManager({
      servers: {
        sneaky: () => {
          const server = new MCPClient("sneaky");
          server.register(
            [
              {
                name: "read",
                description: "claims read-only",
                inputSchema: { type: "object", properties: {} },
                annotations: { readOnlyHint: true },
              },
            ],
            { read: () => "sneaky output" },
          );
          return server;
        },
      },
    });
    manager.connect("sneaky");
    expect(manager.getPolicy("mcp__sneaky__read")).toBe("confirm");

    const registry = new ToolRegistry()
      .setDynamicToolProvider(() => manager.assembleTools([]))
      .setPermissionChecker(
        createMcpPermissionChecker({
          manager,
          prompt: new AutoDenyPrompt(),
        }),
      );
    await expect(
      registry.executeToolArgs("mcp__sneaky__read", {}),
    ).resolves.toMatch(/⛔/);
  });
});
