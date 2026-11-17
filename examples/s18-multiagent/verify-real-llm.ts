/**
 * s18 真实模型冒烟（零 mock）：V1 路由三态 / V2 依赖+replay / V7 超时常量。
 * 用法：npm run verify:s18-real（需 .env 配置真实 LLM；对应指南人工验证的自动化子集）
 */

import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAICompatLLM } from "../../src/core/llm";
import { MultiagentOrchestrator } from "../../src/multiagent/orchestrator";
import { DEFAULTS } from "../../src/multiagent/model";

const apiKey = process.env.LLM_API_KEY ?? "";
if (apiKey.length === 0 || apiKey.startsWith("your-")) {
  console.log("[跳过] 未检测到真实 LLM_API_KEY（.env 为空或模板占位）。");
  process.exit(0);
}

const llm = new OpenAICompatLLM();
const dirs: string[] = [];
const cleanup = (): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
};
const tempRoot = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "s18real-"));
  dirs.push(dir);
  return dir;
};

const steps: Array<{ name: string; run: () => Promise<string> }> = [
  {
    name: "V1a auto 闲聊 → simple 直答",
    run: async () => {
      const orch = new MultiagentOrchestrator({ llm, journalRoot: tempRoot() });
      const result = await orch.run("你好呀，用一句话介绍一下你自己就行。");
      if (result.line !== "simple") throw new Error(`期望 simple，实际 ${result.line}`);
      return `line=${result.line} final=${result.final.slice(0, 60)}…`;
    },
  },
  {
    name: "V1b auto 对比类 → dag 完成并综合",
    run: async () => {
      const orch = new MultiagentOrchestrator({ llm, journalRoot: tempRoot() });
      const result = await orch.run("对比特斯拉和比亚迪 2024 年的营收规模，各给一句话结论即可，不用展开。");
      if (!["simple", "dag"].includes(result.line)) throw new Error(`意外 line=${result.line}`);
      if (result.line === "dag" && !result.events.some((e) => e.type === "synthesis.completed")) {
        throw new Error("dag 未走综合");
      }
      return `line=${result.line} final=${result.final.slice(0, 60)}…`;
    },
  },
  {
    name: "V1c mode=swarm 早路由 → swarm 完成",
    run: async () => {
      const orch = new MultiagentOrchestrator({ llm, mode: "swarm", journalRoot: tempRoot() });
      const result = await orch.run("给数字 1、2、3 各配一个 emoji，并用一句话总结它们的顺序。保持轻量，快速完成。");
      if (result.line !== "swarm") throw new Error(`期望 swarm，实际 ${result.line}`);
      if (!result.events.some((e) => e.type === "swarm.agent_started")) throw new Error("无 agent_started");
      if (!result.events.some((e) => e.type === "run.completed")) throw new Error("未正常完成");
      return `final=${result.final.slice(0, 60)}…`;
    },
  },
  {
    name: "V2 依赖型任务 → journal/replay 完整",
    run: async () => {
      const root = tempRoot();
      const orch = new MultiagentOrchestrator({ llm, journalRoot: root, runId: "v2-run" });
      const result = await orch.run("先算 12 乘 8 等于多少，再基于这个结果写一句口号，最后给一行总结。");
      const replayed = MultiagentOrchestrator.replay("v2-run", root);
      if (replayed[0]?.type !== "run.started") throw new Error("replay 缺 run.started");
      if (replayed.at(-1)?.type !== "run.completed") throw new Error("replay 缺 run.completed");
      return `line=${result.line} events=${replayed.length}`;
    },
  },
  {
    name: "V7 超时常量 = 10 分钟",
    run: async () => {
      if (DEFAULTS.swarmTimeoutMs !== 600_000) throw new Error(`swarmTimeoutMs=${DEFAULTS.swarmTimeoutMs}`);
      return "600_000ms ✓";
    },
  },
];

let failed = false;
for (const step of steps) {
  try {
    const detail = await step.run();
    console.log(`✓ ${step.name} —— ${detail}`);
  } catch (error) {
    failed = true;
    console.log(`✗ ${step.name} —— ${error instanceof Error ? error.message : String(error)}`);
  }
}
cleanup();
console.log(failed ? "\n存在失败项" : "\n全部通过");
process.exit(failed ? 1 : 0);
