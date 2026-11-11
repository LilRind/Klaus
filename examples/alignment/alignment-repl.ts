/**
 * s01–s15 对齐交互式会话（单会话多轮聊天，Claude Code 式体验）
 *
 * 运行：npm run example:alignment:repl（需要 .env 配置真实 LLM）
 * 按章装配：npm run example:alignment:repl -- --stage s05
 *   （lcc 语义：只装配 s01–s05 机制——verbose 不再混入 task/skills/
 *    compact/memory/cron 等超纲工具；缺省 s14 全量）
 * 指定工作区：npm run example:alignment:repl -- --workspace C:\temp\agent-sandbox
 *   （裸位置参数也当工作区，向后兼容：npm run example:alignment:repl -- C:\temp\ws）
 *   （强烈建议用临时目录；默认在当前目录真实读写/执行命令）
 *
 * 用法：
 *   - 输入 prompt 回车发送；同一会话内工具轨迹跨轮保留（s01 会话语义），
 *     模型看得到"之前跑过什么命令、看到什么输出"——这就是多轮聊天的底座；
 *   - help        列出全部章节的参考 prompt
 *   - help s05    只看某一章（s01…s17）
 *   - q / exit    退出（Ctrl+C 也可）
 *   - del/rm 等破坏性命令、越区路径会弹 y/N 人工审批（拒绝安全）
 *   - 装配与批量演示完全同源（agent-assembly.ts）：hooks/todo/task/
 *     skills/compact/memory/任务图/后台任务/cron/teammate/MCP 全量可用
 *   - s17 goal loop：/goal <条件> 设目标后模型自动续跑，直到独立判断器
 *     认定达成；后台任务在跑时 defer 不判断，完成后自动唤醒重入
 *   - s09 跨会话验证：记忆落在工作区 .memory\，**退出重进 REPL 记忆仍在**，
 *     直接问 "What indentation style do I prefer?" 即可验证跨会话召回
 *   - 每次运行的完整轨迹自动落盘 logs/agent-trace/*.jsonl（审计/复现）+ .md
 */

import "dotenv/config";
import { createInterface } from "node:readline";
import type { ApprovalPrompt, PermissionRequest } from "../../src/index";
import { CLEAR_ALIASES } from "../../src/index";
import {
  ALIGNMENT_PROMPTS,
  buildAlignmentAgent,
  parseAlignmentStage,
} from "./agent-assembly";

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

function parseArgs(argv: string[]): { stage?: string; workspace?: string } {
  const out: { stage?: string; workspace?: string } = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--stage") {
      out.stage = argv[++i];
    } else if (arg.startsWith("--stage=")) {
      out.stage = arg.slice("--stage=".length);
    } else if (arg === "--workspace" || arg === "-w") {
      out.workspace = argv[++i];
    } else if (out.workspace === undefined) {
      out.workspace = arg; // 裸位置参数 = 工作区（向后兼容）
    }
  }
  return out;
}

function printHelp(chapter: string | undefined, stageLevel: number): void {
  const filter = chapter?.trim().toLowerCase();
  const stageName = (n: number): string => `s${String(n).padStart(2, "0")}`;
  const visible = ALIGNMENT_PROMPTS.filter(([stage]) =>
    filter
      ? stage === filter
      : Number(stage.slice(1)) <= stageLevel,
  );
  if (filter) {
    const chapterLevel = parseAlignmentStage(filter);
    if (chapterLevel > stageLevel) {
      console.log(
        `\n注意: [${filter}] 超出当前装配层级 ${stageName(stageLevel)}——以下 prompt 仅作参考，` +
          `需要该章机制请用 --stage ${filter} 重启。`,
      );
    }
  }
  if (visible.length === 0) {
    console.log(`\n没有 [${filter}] 章节；可用: s01 … s${String(stageLevel).padStart(2, "0")}`);
    return;
  }
  console.log(
    `\n各章 README 的"试一下"参考 prompt${filter ? `（${filter}）` : `（装配到 ${stageName(stageLevel)}）`}：` +
      `\n${visible.map(([stage, p]) => `  [${stage}] ${p}`).join("\n")}\n`,
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

  const args = parseArgs(process.argv);
  const {
    agent,
    workspace,
    memoryDir,
    stage,
    toolNames,
    features,
    pumpCron,
    harnessLoop,
    asyncEventLoop,
    goal: goalController,
    dispose,
  } =
    await buildAlignmentAgent({
      workspace: args.workspace ?? process.cwd(),
      stage: args.stage,
      prompt: new ReplApprovalPrompt(readLine),
    });

  const stageName = `s${String(stage).padStart(2, "0")}`;
  console.log(`对齐交互式会话（工作区: ${workspace}）`);
  console.log(
    `装配层级: ${stageName}${stage >= 15 ? "（s01–s15 全量）" : `（s01–${stageName} 机制）`}`,
  );
  console.log(`工具(${toolNames.length}): ${toolNames.join(", ")}`);
  if (features.memory) {
    console.log(
      `持久记忆目录: ${memoryDir}（退出重进，记忆仍在——s09 跨会话验证入口）`,
    );
  }
  console.log("输入 prompt 回车发送 | help [s01…s17] 查看参考 prompt | q 退出\n");
  if (goalController) {
    console.log("/goal <条件> 设目标 | /goal 查状态 | /goal clear 清除（s17 goal loop）\n");
  }

  // s15：启动自动唤醒轮询（cron/团队事件/后台完成 → 空闲自动跑一轮）
  asyncEventLoop?.start();
  if (asyncEventLoop) {
    console.log("自动唤醒已启动：空闲时 cron 到期 / 团队事件 / 后台完成会自动触发 agent 轮\n");
  }

  while (true) {
    const raw = await readLine("alignment >> ");
    if (raw === null) break; // Ctrl+C / EOF
    const query = raw.trim();
    if (!query) continue;
    if (["q", "exit", "quit"].includes(query.toLowerCase())) break;
    if (query.toLowerCase() === "help" || query.toLowerCase().startsWith("help ")) {
      printHelp(query.slice(4).trim() || undefined, stage);
      continue;
    }
    try {
      // s17：/goal 命令拦截（对应 lcc session.submit 层）
      let turnInput = query;
      if (goalController && (query === "/goal" || query.startsWith("/goal "))) {
        const argument = query.slice(5).trim();
        if (!argument) {
          console.log(`\n${goalController.status()}\n`);
          continue;
        }
        if (CLEAR_ALIASES.has(argument.toLowerCase())) {
          console.log(`\n${goalController.clear(argument.toLowerCase())}\n`);
          continue;
        }
        goalController.setGoal(argument);
        console.log(`\n🎯 Goal set: ${argument}（立即按新条件开工）`);
        turnInput = argument; // lcc 同款：条件立即作为本轮任务交给主模型
      }
      // s15：用户轮走 HarnessLoop 互斥入口（与自动唤醒事件轮串行化）
      const answer = harnessLoop
        ? await harnessLoop.runUserTurn(turnInput)
        : await agent.run(turnInput);
      console.log(`\n回答: ${answer}\n`);
      // s17：终态回显（达成/失败；未达成的 block 理由已在轨迹里可见）
      if (goalController?.lastStatus?.met) {
        console.log(`[goal] achieved: ${goalController.lastStatus.reason}\n`);
      } else if (goalController?.lastStatus?.failed) {
        console.log(`[goal] failed: ${goalController.lastStatus.reason}\n`);
      }
    } catch (error) {
      console.log(
        `\n执行失败: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    // s12：每轮 prompt 之后轮询到期 cron 并在空闲时交付（至少一次语义）
    await pumpCron();
  }

  rl.close();
  asyncEventLoop?.stop();
  await dispose();
  console.log(
    features.memory
      ? "再见（.memory/ 记忆已保留，重进 REPL 可继续验证跨会话召回）"
      : "再见",
  );
}

await main();
