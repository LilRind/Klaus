/**
 * S18 编排 REPL（注意力最小化入口）。
 *
 * 用法：npm run example:orchestrator [-- --db path --workspace path --max-workers n]
 * 命令：status（三问）/ tickets / stop <票id> <原因> / help / exit；其余输入 = 工作请求。
 * 纪律（dsh 000-philosophy 的 REPL 翻译）：worker 静默干活，只有完成/受阻/失败
 * 才出一条消息；问题一次一个（Attention 结构化）；健康状态不占空间。
 */

import readline from "node:readline/promises";
import path from "node:path";
import { OpenAICompatLLM } from "../../src";
import { createOrchestrator, type Orchestrator } from "../../src/orchestrator";

interface CliOptions {
  dbPath: string;
  workspaceRoot: string;
  maxWorkers: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    dbPath: path.resolve("orchestrator_data", "state.db"),
    workspaceRoot: path.resolve("orchestrator_data", "workspaces"),
    maxWorkers: 3,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") options.dbPath = path.resolve(argv[++i] ?? "");
    else if (arg === "--workspace") options.workspaceRoot = path.resolve(argv[++i] ?? "");
    else if (arg === "--max-workers") options.maxWorkers = Number(argv[++i] ?? 3);
  }
  return options;
}

function printStatus(orchestrator: Orchestrator): void {
  const status = orchestrator.engine.status();
  const section = (title: string, lines: string[]): string =>
    lines.length === 0 ? `  （无）` : lines.map((line) => `  - ${line}`).join("\n");
  console.log("── 什么在等你 ──");
  console.log(
    section(
      "waiting",
      status.waitingForYou.map(
        (ticket) => `${ticket.id} ${ticket.title}：${ticket.attention?.question ?? ""}`,
      ),
    ),
  );
  console.log("── 在跑什么 ──");
  console.log(
    section("working", status.working.map((ticket) => `${ticket.id} ${ticket.title}`)),
  );
  console.log("── 哪里坏了 ──");
  const problems = [
    ...status.failedTickets.map((ticket) => `${ticket.id} ${ticket.title}：${ticket.ended?.reason}`),
    ...status.failedEffects.map(
      (effect) => `effect ${effect.kind}/${effect.key} 第 ${effect.attempts} 次失败：${effect.error}`,
    ),
  ];
  console.log(section("problems", problems));
}

function printTickets(orchestrator: Orchestrator): void {
  const tickets = orchestrator.engine.snapshot().tickets;
  if (tickets.length === 0) {
    console.log("（还没有工单）");
    return;
  }
  for (const ticket of tickets) {
    const state = ticket.ended
      ? `已结束(${ticket.ended.outcome})`
      : ticket.attention
        ? "等你决定"
        : "进行中";
    console.log(`  ${ticket.id}  [${state}]  ${ticket.title}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const llm = new OpenAICompatLLM();
  const orchestrator = createOrchestrator({
    dbPath: options.dbPath,
    workspaceRoot: options.workspaceRoot,
    llm,
    maxWorkers: options.maxWorkers,
    onMessage: (message) => {
      console.log(`\n[worker] ${message.text}\n`);
    },
  });

  const timer = setInterval(() => {
    orchestrator.pump().catch((error) => {
      console.error(`[effects] 泵失败：${String(error)}`);
    });
  }, 500);
  timer.unref?.();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log("S18 多 Agent 编排 REPL（输入工作请求，或 status/tickets/stop/exit）");
  while (true) {
    let line: string;
    try {
      line = (await rl.question("> ")).trim();
    } catch {
      break; // stdin 关闭
    }
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    if (line === "status") {
      printStatus(orchestrator);
      continue;
    }
    if (line === "tickets") {
      printTickets(orchestrator);
      continue;
    }
    if (line === "help") {
      console.log("  <任意文本>  提交工作请求（研判→拆票→并发执行）");
      console.log("  status      三问：什么在等你 / 在跑什么 / 哪里坏了");
      console.log("  tickets     工单列表");
      console.log("  stop <id> <原因>  停止一张工单");
      console.log("  exit        退出");
      continue;
    }
    if (line.startsWith("stop ")) {
      const rest = line.slice(5).trim();
      const spaceAt = rest.indexOf(" ");
      const ticketId = spaceAt < 0 ? rest : rest.slice(0, spaceAt);
      const reason = spaceAt < 0 ? "人工停止" : rest.slice(spaceAt + 1).trim();
      try {
        orchestrator.engine.stopTicket(ticketId, reason || "人工停止");
        console.log(`已停止 ${ticketId}`);
        await orchestrator.pump();
      } catch (error) {
        console.error(`停止失败：${String(error)}`);
      }
      continue;
    }

    console.log("研判中…");
    try {
      const result = await orchestrator.submit(line);
      if (result.decision.kind === "accept") {
        console.log(
          `接单：拆为 ${result.decision.ticketIds.length} 张工单（${result.decision.reason}）`,
        );
      } else {
        console.log(`忽略：${result.decision.reason}`);
      }
      await orchestrator.pump();
    } catch (error) {
      console.error(`提交失败：${String(error)}`);
    }
  }

  clearInterval(timer);
  rl.close();
  orchestrator.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
