/**
 * connect_mcp 工具（对齐 learn-claude-code s14）
 *
 * 只负责连接与发现：调用后下一轮 assembleToolPool 会把
 * mcp__server__tool 工具加入模型可见的工具池。
 */

import { Tool, tryParseJsonObject } from "../tool";
import type { McpConnectionManager } from "../../mcp/mcp";

export class ConnectMcpTool extends Tool {
  override get name(): string {
    return "connect_mcp";
  }

  override get description(): string {
    return "Connect to an MCP server and discover its tools";
  }

  override get parametersDescription(): string {
    return 'JSON: {"name": "docs"}';
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        name: {
          type: "string",
          enum: this.manager.serverNames(),
          description: "要连接的 MCP server 名",
        },
      },
      required: ["name"],
    };
  }

  constructor(private readonly manager: McpConnectionManager) {
    super();
  }

  override async execute(input: string): Promise<string> {
    return this.executeArgs(tryParseJsonObject(input.trim()) ?? {});
  }

  override async executeArgs(args: Record<string, unknown>): Promise<string> {
    const name = typeof args.name === "string" ? args.name : "";
    if (!name) return "❌ 缺少必填参数 name";
    return this.manager.connect(name);
  }
}
