/**
 * s18 多Agent编排 REPL（批4 完整版）。
 * 命令：mode/help/exit/submit；运行中：msg（human_input）/agents/tasks/workspace；
 * 任意时刻：replay <runId> 回放 journal 时间线 / wait 等待后台 run。
 */

import "dotenv/config";
import * as readline from "node:readline/promises";
import { OpenAICompatLLM } from "../../src/core/llm";
import {
  MultiagentError,
  MultiagentOrchestrator,
  type RunResult,
} from "../../src/multiagent/orchestrator";
import type { ExecutionMode } from "../../src/multiagent/model";

const HELP = [
  "命令：",
  "  mode auto|simple|dag|swarm   切换路由模式（默认 auto）",
  "  submit <文本>                提交任务（swarm 后台运行，可继续输入命令）",
  "  msg <文本>                   swarm 运行中注入 human_input",
  "  agents / tasks / workspace   查看运行中 swarm 的 worker/任务板/工作区",
  "  replay <runId>               回放 journal 时间线",
  "  wait                         等待后台 run 完成并打印结果",
  "  help / exit",
  "直接输入非命令文本 = submit（simple/dag 同步等待结果）",
].join("\n");

async function main(): Promise<void> {
  let llm: OpenAICompatLLM;
  try {
    llm = new OpenAICompatLLM();
  } catch (error) {
    console.log("[启动失败] LLM 配置缺失或非法：");
    console.log(`  ${error instanceof Error ? error.message : String(error)}`);
    console.log("请检查 .env（LLM_MODEL_ID / LLM_API_KEY / LLM_BASE_URL），可先跑 npm run check:config 验证。");
    console.log("注意：.env.example 是占位模板；如误用 cp 覆盖了原 .env，请重新填入真实密钥。");
    return;
  }
  let mode: ExecutionMode | "auto" = "auto";
  let swarmTimeoutMs: number | undefined;
  let orchestrator = new MultiagentOrchestrator({ llm, mode, journalRoot: ".multiagent" });
  let pending: Promise<RunResult> | null = null;
  const currentPending = (): Promise<RunResult> | null => pending;

  const printResult = (run: RunResult): void => {
    console.log(`\n[run=${run.runId} line=${run.line}]\n${run.final}\n`);
  };
  const launch = (text: string): void => {
    orchestrator = new MultiagentOrchestrator({
      llm,
      mode,
      journalRoot: ".multiagent",
      ...(swarmTimeoutMs ? { swarmOptions: { timeoutMs: swarmTimeoutMs } } : {}),
    });
    const promise = orchestrator.run(text);
    pending = promise;
    promise
      .then(printResult)
      .catch((error: unknown) => {
        if (error instanceof MultiagentError) console.log(`[编排错误 ${error.code}] ${error.message}`);
        else console.log(`[错误] ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        pending = null;
      });
  };

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
    if (line === "agents" || line === "tasks" || line === "workspace") {
      const snapshot = orchestrator.swarmSnapshot();
      if (!snapshot) {
        console.log("（当前无运行中的 swarm；运行结束后用 replay <runId> 查历史）");
        continue;
      }
      if (line === "agents") {
        console.log(snapshot.agents.map((a) => `${a.agentId}(${a.role})=${a.status}`).join("\n") || "（无 worker）");
      } else if (line === "tasks") {
        console.log(snapshot.tasks.map((t) => `${t.id} [${t.status}] ${t.description}`).join("\n") || "（任务板为空）");
      } else {
        console.log(
          snapshot.workspaceEntries.map((e) => `#${e.seq} [${e.topic}] ${JSON.stringify(e.entry)}`).join("\n") ||
            "（workspace 为空）",
        );
      }
      continue;
    }
    if (line.startsWith("msg ")) {
      const ok = orchestrator.humanInput(line.slice(4).trim());
      console.log(ok ? "已注入 human_input（Lead 下一轮处理）" : "（当前没有运行中的 swarm）");
      continue;
    }
    if (line === "msg") {
      console.log("用法：msg <文本>（swarm 运行中注入 human_input）");
      continue;
    }
    if (line.startsWith("timeout ")) {
      const seconds = Number.parseInt(line.slice(8).trim(), 10);
      if (Number.isFinite(seconds) && seconds > 0) {
        swarmTimeoutMs = seconds * 1_000;
        console.log(`后续 swarm 超时 = ${seconds}s`);
      } else {
        console.log("用法：timeout <正整数秒>");
      }
      continue;
    }
    if (line.startsWith("replay ")) {
      const runId = line.slice(7).trim();
      const events = MultiagentOrchestrator.replay(runId);
      if (events.length === 0) console.log(`（未找到 run=${runId} 的 journal）`);
      else console.log(events.map((e) => `${e.at} ${e.type} ${JSON.stringify(e).slice(0, 160)}`).join("\n"));
      continue;
    }
    if (line === "wait") {
      const current = currentPending();
      if (current) await current.catch(() => undefined);
      else console.log("（没有等待中的 run）");
      continue;
    }
    if (line.startsWith("submit ")) {
      if (pending) {
        console.log("（有 run 进行中，先 wait）");
        continue;
      }
      launch(line.slice(7).trim());
      const current = currentPending();
      if (mode !== "swarm" && current) await current.catch(() => undefined);
      continue;
    }
    if (pending) {
      console.log("（有 run 进行中：可 msg/agents/tasks/workspace/wait）");
      continue;
    }
    launch(line);
    const current = currentPending();
    if (mode !== "swarm" && current) await current.catch(() => undefined);
  }
  rl.close();
}

void main();
