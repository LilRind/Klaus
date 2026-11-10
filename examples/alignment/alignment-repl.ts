/**
 * s01–s14 对齐交互式会话（单会话多轮聊天，Claude Code 式体验）
 *
 * 运行：npm run example:alignment:repl（需要 .env 配置真实 LLM）
 * 指定工作区：npm run example:alignment:repl -- C:\temp\agent-sandbox
 *   （强烈建议用临时目录；默认在当前目录真实读写/执行命令）
 *
 * 用法：
 *   - 输入 prompt 回车发送；同一会话内工具轨迹跨轮保留（s01 会话语义），
 *     模型看得到"之前跑过什么命令、看到什么输出"——这就是多轮聊天的底座；
 *   - help        列出全部章节的参考 prompt
 *   - help s05    只看某一章（s01…s14）
 *   - q / exit    退出（Ctrl+C 也可）
 *   - del/rm 等破坏性命令、越区路径会弹 y/N 人工审批（拒绝安全）
 *   - 装配与批量演示完全同源（agent-assembly.ts）：hooks/todo/task/
 *     skills/compact/memory/任务图/后台任务/cron/teammate/MCP 全量可用
 *   - s09 跨会话验证：记忆落在工作区 .memory\，**退出重进 REPL 记忆仍在**，
 *     直接问 "What indentation style do I prefer?" 即可验证跨会话召回
 *   - 每次运行的完整轨迹自动落盘 logs/agent-trace/*.jsonl（审计/复现）+ .md
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import type { ApprovalPrompt, PermissionRequest } from "../../src/index";
import { ALIGNMENT_PROMPTS, buildAlignmentAgent } from "./agent-assembly";

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

function printHelp(chapter?: string): void {
  const filter = chapter?.trim().toLowerCase();
  const prompts = filter
    ? ALIGNMENT_PROMPTS.filter(([stage]) => stage === filter)
    : ALIGNMENT_PROMPTS;
  if (prompts.length === 0) {
    console.log(`\n没有 [${filter}] 章节；可用: s01 … s14`);
    return;
  }
  console.log(
    `\n各章 README 的"试一下"参考 prompt${filter ? `（${filter}）` : "（help <章节> 可过滤）"}：` +
      `\n${prompts.map(([stage, p]) => `  [${stage}] ${p}`).join("\n")}\n`,
  );
}

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
    while (pending.length === 0 && !closed) {
      rl.setPrompt(prompt);
      rl.prompt(true);
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    // 优先消费已缓存的输入行（管道 EOF 早于提示符时行已入队）；
    // 无缓存且 stdin 已关闭才判终——不再碰已关闭的 readline
    return pending.shift() ?? null;
  };

  const { agent, workspace, memoryDir, pumpCron, dispose } = await buildAlignmentAgent({
    workspace: process.argv[2] ?? process.cwd(),
    prompt: new ReplApprovalPrompt(readLine),
  });

  console.log(`s01–s14 对齐交互式会话（工作区: ${workspace}）`);
  console.log("输入 prompt 回车发送 | help [s01…s14] 查看参考 prompt | q 退出");
  console.log(`持久记忆目录: ${memoryDir}（退出重进，记忆仍在——s09 跨会话验证入口）\n`);

  while (true) {
    const raw = await readLine("alignment >> ");
    if (raw === null) break; // Ctrl+C / EOF
    const query = raw.trim();
    if (!query) continue;
    if (["q", "exit", "quit"].includes(query.toLowerCase())) break;
    if (query.toLowerCase() === "help" || query.toLowerCase().startsWith("help ")) {
      printHelp(query.slice(4).trim() || undefined);
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
    // s12：每轮 prompt 之后轮询到期 cron 并在空闲时交付（至少一次语义）
    await pumpCron();
  }

  rl.close();
  await dispose();
  console.log("再见（.memory/ 记忆已保留，重进 REPL 可继续验证跨会话召回）");
}

await main();
