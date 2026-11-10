/**
 * s01–s05 对齐演示（真实 LLM 手动验证入口，对应各章 README 的"试一下"）
 *
 * 运行：npm run example:alignment（需要 .env 配置 LLM_API_KEY / LLM_MODEL_ID 等）
 * 分章：npm run example:alignment -- s04（s01…s05 任选，多章用逗号分隔）
 *
 * ⚠️ 注意：
 * - bash 会真实执行 shell 命令、文件工具会真实写盘——建议在临时测试目录运行；
 * - 破坏性命令（del/rm）与越区路径会弹出 y/N 人工审批，拒绝是安全的；
 * - s02 的 prompt 提到 README.md / requirements.txt——在 learn-claude-code
 *   目录下运行可完全复刻；在别处运行时模型会收到"文件不存在"错误回喂，
 *   这本身也是错误 observation 路径的验证。
 * - 单个 Agent 实例跨 prompt 复用：工具轨迹跨轮保留（s01 会话语义）。
 */

import "dotenv/config";
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
  AgentTraceLog,
  ConsoleApprovalPrompt,
  createStandardPermissionChecker,
  HookRegistry,
  logHook,
  largeOutputHook,
  contextInjectHook,
  summaryHook,
  TodoWriteTool,
} from "../../src/index";

const workspace = process.cwd();
const llm = new OpenAICompatLLM();
const traceLog = new AgentTraceLog("alignment-agent");

// s04 对齐：四挂点示例 hook（权限闸门仍在 registry 汇合点，hooks 是扩展层）
const hooks = new HookRegistry()
  .register("UserPromptSubmit", contextInjectHook)
  .register("PreToolUse", logHook)
  .register("PostToolUse", largeOutputHook)
  .register("Stop", summaryHook);

// 演示装配（决策 5）：文件工具放开围栏，越区裁决权交给权限层
const registry = new ToolRegistry()
  .register(new ReadFileTool({ workspace, allowOutsideWorkspace: true }))
  .register(new WriteFileTool({ workspace, allowOutsideWorkspace: true }))
  .register(new EditFileTool({ workspace, allowOutsideWorkspace: true }))
  .register(new GlobTool({ workspace, allowOutsideWorkspace: true }))
  .register(new BashTool({ cwd: workspace }))
  .register(new TodoWriteTool()) // s05：计划工具（只更新状态，不执行工作）
  .setPermissionChecker(
    createStandardPermissionChecker({
      workspaceRoot: workspace,
      prompt: new ConsoleApprovalPrompt(),
    }),
  )
  .assertAllStructured(); // 对齐装配强制校验：全部工具结构化

const agent = new FunctionCallAgent("alignment-agent", llm, registry, {
  config: new AgentConfig({ verbose: true }),
  traceLog,
  hooks,
  systemPrompt:
    `You are a coding agent at ${workspace}. Environment: Windows; the bash tool runs cmd.exe. ` +
    "Use tools to solve tasks. Act, don't explain. " +
    "For multi-step tasks, plan first with todo_write and keep it updated as you work. " +
    "Do not ask for approval yourself; for risky operations still request the tool call — " +
    "the harness will approve or deny before execution.",
});

const prompts: [string, string][] = [
  ["s01", 'Create a file called hello.py that prints "Hello, World!"'],
  ["s01", "List all Python files in this directory"],
  ["s01", "What is the current git branch?"],
  ["s02", "Read the file README.md and tell me what this project is about"],
  ["s02", 'Create a file called test.py that prints "hello", then read it back'],
  ["s02", "Find all Python files in this directory"],
  ["s02", "Read both README.md and requirements.txt, then create a summary file"],
  ["s03", "Create a file called test.txt in the current directory"],
  ["s03", "Delete the file test.txt"],
  ["s03", "What files are in the current directory?"],
  ["s03", "Try to write a file to /etc/something"],
  ["s04", "Read the file README.md（观察 [HOOK] 日志）"],
  ["s04", "Create a file called test.txt（观察 PostToolUse hook）"],
  ["s04", "Delete all temporary files in /tmp（bash + rm 触发权限闸门）"],
  ["s05", "Refactor hello.py: add type hints, docstrings, and a main guard（先列 3 步再执行）"],
  ["s05", "Create a Python package under demo_pkg with __init__.py, utils.py, and tests/test_utils.py"],
  ["s05", "Review Python files in this directory and fix any style issues"],
];

const stages = (process.argv[2] ?? "all")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s !== "all");
const selected = stages.length
  ? prompts.filter(([chapter]) => stages.includes(chapter))
  : prompts;

console.log(`s01–s05 对齐演示（工作区: ${workspace}，章节: ${stages.length ? stages.join(", ") : "全部"}）`);
for (const [chapter, prompt] of selected) {
  console.log(`\n========== [${chapter}] ${prompt} ==========`);
  try {
    const answer = await agent.run(prompt);
    console.log(`回答: ${answer}`);
  } catch (error) {
    console.log(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}
