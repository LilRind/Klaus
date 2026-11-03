/** 工具链 + 并行执行示例（对应书 7.5.4；本示例完全离线） */
import {
  ToolChain,
  ToolChainManager,
  AsyncToolExecutor,
  ToolRegistry,
  CalculatorTool,
} from "../src/index";

const registry = new ToolRegistry()
  .register(new CalculatorTool())
  .registerFunction({
    name: "format",
    description: "格式化数值",
    func: (input) => `计算结果是 ${input}`,
  });

// 1. 工具链：calculator 的输出通过 {mid_result} 流向下一步
const chain = new ToolChain("calc_and_format", "计算并格式化")
  .addStep("calculator", "{input}*6", "mid_result")
  .addStep("format", "{mid_result}", "final");

const manager = new ToolChainManager(registry).registerChain(chain);
const context: Record<string, string> = {};
const result = await manager.executeChain("calc_and_format", "7", context);
console.log(`工具链结果: ${result}`);
console.log(`中间上下文: ${JSON.stringify(context)}\n`);

// 2. 并行执行：多个计算并发跑，结果顺序与任务顺序一致
const executor = new AsyncToolExecutor(registry, 4);
const results = await executor.executeToolsParallel([
  { toolName: "calculator", input: "1+1" },
  { toolName: "calculator", input: "sqrt(81)" },
  { toolName: "calculator", input: "pi*2" },
]);
console.log(`并行结果: ${results.join(", ")}`);
