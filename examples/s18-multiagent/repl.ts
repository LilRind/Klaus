/**
 * s18 多Agent编排 REPL 骨架（批1）：mode 命令 + 提交输入。
 * 批3 接入 swarm 线；批4 完善命令集（agents/tasks/workspace/msg/replay）。
 */

import * as readline from "node:readline/promises";
import { OpenAICompatLLM } from "../../src/core/llm";
import {
  MultiagentError,
  MultiagentOrchestrator,
} from "../../src/multiagent/orchestrator";
import type { ExecutionMode } from "../../src/multiagent/model";

const HELP = [
  "命令：",
  "  mode auto|simple|dag|swarm   切换路由模式（默认 auto；swarm 线批3 交付）",
  "  help                         显示本帮助",
  "  exit                         退出",
  "其他输入 = 提交给编排器执行（真实 LLM：OpenAICompatLLM）",
].join("\n");

async function main(): Promise<void> {
  const llm = new OpenAICompatLLM();
  let mode: ExecutionMode | "auto" = "auto";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`s18 multiagent REPL（mode=${mode}）`);
  console.log(HELP);

  while (true) {
    const line = (await rl.question("s18> ")).trim();
    if (line === "") continue;
    if (line === "exit" || line === "quit") break;
    if (line === "help") {
      console.log(HELP);
      continue;
    }
    if (line.startsWith("mode ")) {
      const next = line.slice(5).trim();
      if (next === "auto" || next === "simple" || next === "dag" || next === "swarm") {
        mode = next;
        console.log(`mode = ${mode}`);
      } else {
        console.log("非法 mode，可选：auto | simple | dag | swarm");
      }
      continue;
    }

    const orchestrator = new MultiagentOrchestrator({ llm, mode, journalRoot: ".multiagent" });
    try {
      const run = await orchestrator.run(line);
      console.log(`\n[run=${run.runId} line=${run.line}]\n${run.final}\n`);
    } catch (error) {
      if (error instanceof MultiagentError) {
        console.log(`[编排错误 ${error.code}] ${error.message}`);
      } else {
        console.log(`[错误] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  rl.close();
}

void main();
