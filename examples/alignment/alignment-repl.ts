/**
 * s01–s03 对齐交互式会话（复刻三章 code.py 的 REPL 体验）
 *
 * 运行：npm run example:alignment:repl
 * 指定工作区：npm run example:alignment:repl -- C:\temp\agent-sandbox
 *   （强烈建议用临时目录；默认在当前目录真实读写/执行命令）
 *
 * 用法：
 *   - 输入 prompt 回车发送；工具轨迹跨轮保留（s01 会话语义）
 *   - help  列出三章 README 的"试一下"参考 prompt
 *   - q / exit 退出
 *   - del/rm 等破坏性命令、越区路径会弹 y/N 人工审批（拒绝安全）
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import path from "node:path";
import {
  OpenAICompatLLM,
  FunctionCallAgent,
  ToolRegistry,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  GlobTool,
  BashTool,
  AgentConfig,
  createStandardPermissionChecker,
  type ApprovalPrompt,
  type PermissionRequest,
} from "../../src/index";

const workspace = path.resolve(process.argv[2] ?? process.cwd());
const llm = new OpenAICompatLLM();

/**
 * 共享同一个行队列的审批器：主循环与审批提示都从同一个队列取行，
 * 避免两个 readline 消费者抢 stdin（y/N 不会被主循环吃掉）
 */
class ReplApprovalPrompt implements ApprovalPrompt {
  constructor(private readonly readLine: (prompt: string) => Promise<string | null>) {}

  async confirm(request: PermissionRequest, reason: string): Promise<boolean> {
    console.log(`\n⚠️  [权限] ${reason}`);
    console.log(`   工具: ${request.toolName}(${JSON.stringify(request.args).slice(0, 120)})`);
    const answer = ((await this.readLine("   允许执行? [y/N] ")) ?? "n").trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
}

const HELP_PROMPTS = [
  "[s01] Create a file called hello.py that prints \"Hello, World!\"",
  "[s01] List all Python files in this directory",
  "[s01] What is the current git branch?",
  "[s02] Read the file README.md and tell me what this project is about",
  "[s02] Create a file called test.py that prints \"hello\", then read it back",
  "[s02] Find all Python files in this directory",
  "[s02] Read both README.md and requirements.txt, then create a summary file",
  "[s03] Create a file called test.txt in the current directory",
  "[s03] Delete the file test.txt",
  "[s03] What files are in the current directory?",
  "[s03] Try to write a file to /etc/something",
];

async function main(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // 统一行队列：缓存已到达的输入行，主循环 / 审批提示共用同一入口
  const pending: string[] = [];
  let closed = false;
  let wake: (() => void) | null = null;
  rl.on("line", (line) => {
    pending.push(line);
    wake?.();
    wake = null;
  });
  rl.on("close", () => {
    closed = true;
    wake?.();
    wake = null;
  });
  rl.on("SIGINT", () => {
    closed = true;
    rl.close();
  });
  const readLine = async (prompt: string): Promise<string | null> => {
    rl.setPrompt(prompt);
    rl.prompt(true);
    while (pending.length === 0 && !closed) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return pending.shift() ?? null;
  };

  // 演示装配（决策 5）：文件工具放开围栏，越区裁决权交给权限层
  const registry = new ToolRegistry()
    .register(new ReadFileTool({ workspace, allowOutsideWorkspace: true }))
    .register(new WriteFileTool({ workspace, allowOutsideWorkspace: true }))
    .register(new EditFileTool({ workspace, allowOutsideWorkspace: true }))
    .register(new GlobTool({ workspace, allowOutsideWorkspace: true }))
    .register(new BashTool({ cwd: workspace }))
    .setPermissionChecker(
      createStandardPermissionChecker({
        workspaceRoot: workspace,
        prompt: new ReplApprovalPrompt(readLine),
      }),
    );

  const agent = new FunctionCallAgent("alignment-agent", llm, registry, {
    config: new AgentConfig({ verbose: true }),
    systemPrompt:
      `You are a coding agent at ${workspace}. Environment: Windows; the bash tool runs cmd.exe. ` +
      "Use tools to solve tasks. Act, don't explain. " +
      "Do not ask for approval yourself; for risky operations still request the tool call — " +
      "the harness will approve or deny before execution.",
  });

  console.log(`s01–s03 对齐交互式会话（工作区: ${workspace}）`);
  console.log("输入 prompt 回车发送 | help 查看参考 prompt | q 退出\n");

  while (true) {
    const raw = await readLine("alignment >> ");
    if (raw === null) break; // Ctrl+C / EOF
    const query = raw.trim();
    if (!query) {
      continue;
    }
    if (["q", "exit", "quit"].includes(query.toLowerCase())) break;
    if (query.toLowerCase() === "help") {
      console.log(`\n三章 README 的"试一下"参考 prompt：\n${HELP_PROMPTS.map((p) => `  ${p}`).join("\n")}`);
      continue;
    }
    try {
      const answer = await agent.run(query);
      console.log(`\n回答: ${answer}\n`);
    } catch (error) {
      console.log(
        `\n执行失败: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  rl.close();
  console.log("再见");
}

await main();
