/**
 * s18 真实模型全量冒烟（零 mock）。用法：
 *   npm run verify:s18-real           # 快速档：V1a/V1b/V1c/V2/V7（约 1-2 分钟）
 *   npm run verify:s18-real -- --full # 全量档：追加 V3/V4a/V4b/V4c/V5（约 12-15 分钟）
 * 对应指南 V1-V7；V6（进程强杀）走指南人工 Ctrl+C + 离线回归锁定。
 */

import "dotenv/config";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpenAICompatLLM } from "../../src/core/llm";
import { MultiagentOrchestrator, type RunResult } from "../../src/multiagent/orchestrator";

const full = process.argv.includes("--full");
const apiKey = process.env.LLM_API_KEY ?? "";
if (apiKey.length === 0 || apiKey.startsWith("your-")) {
  console.log("[跳过] 未检测到真实 LLM_API_KEY（.env 为空或模板占位）。");
  process.exit(0);
}

const llm = new OpenAICompatLLM();
const dirs: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "s18verify-"));
  dirs.push(dir);
  return dir;
};

async function attempt(name: string, tries: number, body: () => Promise<string>): Promise<string> {
  let lastError: unknown;
  for (let i = 1; i <= tries; i += 1) {
    try {
      return await body();
    } catch (error) {
      lastError = error;
      console.log(`  … ${name} 第 ${i} 次未达断言：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`${name} ${tries} 次失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

const steps: Array<{ name: string; full?: boolean; run: () => Promise<string> }> = [
  {
    name: "V1a auto 闲聊 → simple",
    run: () =>
      attempt("V1a", 2, async () => {
        const orch = new MultiagentOrchestrator({ llm, journalRoot: tempRoot() });
        const result = await orch.run("你好呀，用一句话介绍一下你自己就行。");
        if (result.line !== "simple") throw new Error(`期望 simple，实际 ${result.line}`);
        return `line=${result.line}`;
      }),
  },
  {
    name: "V1b auto 对比类 → dag + 综合",
    run: () =>
      attempt("V1b", 2, async () => {
        const orch = new MultiagentOrchestrator({ llm, journalRoot: tempRoot() });
        const result = await orch.run("对比特斯拉和比亚迪 2024 年的营收规模，各给一句话结论即可，不用展开。");
        if (!["simple", "dag"].includes(result.line)) throw new Error(`意外 line=${result.line}`);
        if (result.line === "dag" && !result.events.some((e) => e.type === "synthesis.completed")) {
          throw new Error("dag 未走综合");
        }
        return `line=${result.line}`;
      }),
  },
  {
    name: "V1c mode=swarm 早路由完成",
    run: () =>
      attempt("V1c", 2, async () => {
        const orch = new MultiagentOrchestrator({ llm, mode: "swarm", journalRoot: tempRoot() });
        const result = await orch.run("给数字 1、2、3 各配一个 emoji，并用一句话总结它们的顺序。保持轻量，快速完成。");
        if (result.line !== "swarm") throw new Error(`期望 swarm，实际 ${result.line}`);
        if (!result.events.some((e) => e.type === "run.completed")) throw new Error("未正常完成");
        return "完成";
      }),
  },
  {
    name: "V2 依赖型 → 96 传导 + route 落 journal",
    run: () =>
      attempt("V2", 2, async () => {
        const root = tempRoot();
        const orch = new MultiagentOrchestrator({ llm, journalRoot: root, runId: "v2-run" });
        const result = await orch.run("先算 12 乘 8 等于多少，再基于这个结果写一句口号（口号里必须含该数字），最后给一行总结。");
        if (!result.final.includes("96")) throw new Error("最终答案未含 96（依赖传导失败）");
        if (!result.events.some((e) => e.type === "route.decision")) throw new Error("缺 route.decision");
        return "96 已传导";
      }),
  },
  {
    name: "V3 swarm 运行中 snapshot/msg/replay",
    full: true,
    run: () =>
      attempt("V3", 2, async () => {
        const root = tempRoot();
        const orch = new MultiagentOrchestrator({ llm, mode: "swarm", journalRoot: root, runId: "v3-run" });
        const pending = orch.run(
          "调研国产新能源三强的定价策略。w1 请第一步就 publish_data 到主题 findings（写明开始调研），随后继续完成调研并 idle；完成后 Lead 给最终结论。",
        );
        let sawAgents = false;
        let sawTasks = false;
        let sawWorkspace = false;
        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          const snapshot = orch.swarmSnapshot();
          if (snapshot && snapshot.agents.length > 0) sawAgents = true;
          if (snapshot && snapshot.tasks.length > 0) sawTasks = true;
          if (snapshot && snapshot.workspaceEntries.length > 0) sawWorkspace = true;
          if (sawAgents && sawTasks && sawWorkspace) break;
          if (snapshot) orch.humanInput("多关注定价策略");
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
        const result: RunResult = await pending;
        if (!sawAgents || !sawTasks || !sawWorkspace) {
          throw new Error(`snapshot 覆盖 agents=${sawAgents} tasks=${sawTasks} workspace=${sawWorkspace}`);
        }
        if (!result.events.some((e) => e.type === "human.input")) throw new Error("human_input 未入 journal");
        const replayed = MultiagentOrchestrator.replay("v3-run", root);
        if (replayed[0]?.type !== "run.started" || replayed.at(-1)?.type !== "run.completed") {
          throw new Error("replay 首尾事件不完整");
        }
        return "snapshot×3 + msg + replay ✓";
      }),
  },
  {
    name: "V4a worker 迭代上限=3 → 强制收敛",
    full: true,
    run: () =>
      attempt("V4a", 2, async () => {
        const orch = new MultiagentOrchestrator({
          llm,
          mode: "swarm",
          journalRoot: tempRoot(),
          swarmOptions: { workerIterationLimit: 3, timeoutMs: 300_000, checkpointIntervalMs: 15_000 },
        });
        const result = await orch.run(
          "w1 严格遵守：任务是把 20 个国家首都逐轮写入 capitals.md。每一轮只调用一次 write_file，且 content 只允许包含一行文本（第 N 轮写第 N 行）。严禁一次写入多行、严禁跳轮、严禁在未写满 20 行之前 idle 或 done。写满 20 行后才允许 idle。Lead：等 w1 结束后直接 final_reply，简述 capitals.md 的行数即可。",
        );
        const forced = result.events.find(
          (e) => e.type === "agent.idle" && typeof e.keyFindings === "string" && /迭代上限|强制/.test(e.keyFindings),
        );
        if (!forced) throw new Error("未见强制收敛 idle");
        return String(forced.keyFindings);
      }),
  },
  {
    name: "V4b 重派上限 → assign.rejected",
    full: true,
    run: () =>
      attempt("V4b", 2, async () => {
        const orch = new MultiagentOrchestrator({
          llm,
          mode: "swarm",
          journalRoot: tempRoot(),
          swarmOptions: { timeoutMs: 540_000, checkpointIntervalMs: 15_000 },
        });
        const result = await orch.run(
          "Lead 请严格照办：创建 4 个极小任务 t1/t2/t3/t4（t1=回答数字1，t2=回答数字2，t3=回答数字3，t4=回答数字4）；只 spawn 一个 worker w1 做 t1；w1 每次空闲后立即用 assign_task 把下一个任务继续派给 w1（t2→t3→t4 都只派给 w1，不许 spawn 新 worker）；一旦发现某次 assign_task 被拒绝，立即停止派发并用 final_reply 按序列出已拿到的数字后 done。",
        );
        if (!result.events.some((e) => e.type === "swarm.assign.rejected")) throw new Error("未见 assign.rejected");
        return "重派被拒 ✓";
      }),
  },
  {
    name: "V4c interim 节流",
    full: true,
    run: () =>
      attempt("V4c", 2, async () => {
        const orch = new MultiagentOrchestrator({
          llm,
          mode: "swarm",
          journalRoot: tempRoot(),
          swarmOptions: { timeoutMs: 300_000, checkpointIntervalMs: 15_000 },
        });
        const result = await orch.run(
          "Lead 请严格照办：在第一次决策的动作列表里，先输出两条 interim_reply（内容随意、不同），紧接着输出 done 结束。不要创建任务、不要 spawn worker。",
        );
        if (!result.events.some((e) => e.type === "interim.sent")) throw new Error("无 interim.sent");
        if (!result.events.some((e) => e.type === "interim.throttled")) throw new Error("无 interim.throttled");
        return "一发一节流 ✓";
      }),
  },
  {
    name: "V5 file_read 引用第三行",
    full: true,
    run: () =>
      attempt("V5", 2, async () => {
        const orch = new MultiagentOrchestrator({
          llm,
          mode: "swarm",
          journalRoot: tempRoot(),
          swarmOptions: { timeoutMs: 420_000, checkpointIntervalMs: 15_000 },
        });
        const result = await orch.run(
          "w1：第一步用 write_file 在你的工位创建 draft.md，内容固定三行：占位一、占位二、占位三；然后 idle。Lead：等 w1 idle 后，用 file_read 读取 draft.md，并在 final_reply 的第一行原样输出该文件第三行的文字，随后结束。",
        );
        if (!result.events.some((e) => e.type === "lead.file_read")) throw new Error("无 lead.file_read");
        if (!result.final.includes("占位三")) throw new Error("final 未引用第三行");
        return "file_read ✓";
      }),
  },
  {
    name: "V7 真实超时强制收尾",
    run: () =>
      attempt("V7", 2, async () => {
        const orch = new MultiagentOrchestrator({
          llm,
          mode: "swarm",
          journalRoot: tempRoot(),
          swarmOptions: { timeoutMs: 1_500, checkpointIntervalMs: 15_000 },
        });
        const result = await orch.run("请非常深入地慢慢分析一个复杂主题，不要急于结束。");
        if (!result.events.some((e) => e.type === "swarm.timeout")) throw new Error("无 swarm.timeout");
        if (!result.final.includes("超时")) throw new Error("final 未提示超时");
        return "超时收尾 ✓";
      }),
  },
];

let failed = false;
const selected = steps.filter((step) => full || !step.full);
console.log(`模式：${full ? "--full（V1-V5+V7 全量；V6 人工/离线）" : "快速（V1/V2/V7；--full 解锁 V3-V5）"}，共 ${selected.length} 项`);
for (const step of selected) {
  try {
    const detail = await step.run();
    console.log(`✓ ${step.name} —— ${detail}`);
  } catch (error) {
    failed = true;
    console.log(`✗ ${step.name} —— ${error instanceof Error ? error.message : String(error)}`);
  }
}
for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
console.log(failed ? "\n存在失败项" : "\n全部通过");
process.exit(failed ? 1 : 0);
