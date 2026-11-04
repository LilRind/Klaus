/**
 * 智能文档问答助手 Web UI（书 8.4 gradio 助手的 Web 等价，方案 B）
 *
 * 零新增依赖（node:http 内置）：
 * - GET  /            → qa-web.html 单页界面
 * - POST /api/command → 与 REPL 完全同源的 /命令 引擎（qa-assistant.ts）
 * - POST /api/upload  → base64 上传落盘 + 自动建库（pdf/docx/md/...）
 * 启动: npm run example:qa-web → http://localhost:3000
 */

import "dotenv/config";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { QAAssistant } from "./qa-assistant";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number.parseInt(process.env.QA_WEB_PORT ?? "3000", 10);

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(response: import("node:http").ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function main() {
  const assistant = new QAAssistant();
  const page = await readFile(join(__dirname, "qa-web.html"), "utf-8");

  const server = createServer(async (request, response) => {
    const url = request.url ?? "/";
    try {
      if (request.method === "GET" && (url === "/" || url === "/index.html")) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(page);
        return;
      }

      if (request.method === "POST" && url === "/api/command") {
        const body = JSON.parse(await readBody(request)) as { text?: string };
        const output = await assistant.executeCommand(String(body.text ?? ""));
        sendJson(response, { output });
        return;
      }

      if (request.method === "POST" && url === "/api/upload") {
        const body = JSON.parse(await readBody(request)) as {
          name?: string;
          contentBase64?: string;
        };
        if (!body.name || !body.contentBase64) {
          sendJson(response, { output: "❌ 上传缺少 name 或 contentBase64" }, 400);
          return;
        }
        const output = await assistant.uploadAndLoad(body.name, body.contentBase64);
        sendJson(response, { output });
        return;
      }

      sendJson(response, { error: "Not Found" }, 404);
    } catch (error) {
      sendJson(
        response,
        { output: `❌ 服务器处理失败: ${error instanceof Error ? error.message : String(error)}` },
        500,
      );
    }
  });

  server.listen(PORT, () => {
    console.log("═══ 智能文档问答助手 Web UI（第8章 8.4 TS 版）═══");
    console.log(`➜ http://localhost:${PORT}`);
    console.log("页面操作: 输入 /init <user_id> → 📎 上传文档 → 直接提问");
    console.log("停止: Ctrl+C\n");
  });

  const shutdown = async () => {
    await assistant.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("启动失败:", error);
  process.exitCode = 1;
});
