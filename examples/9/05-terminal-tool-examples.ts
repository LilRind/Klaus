/**
 * 示例 05：TerminalTool 使用示例（对应书 9.5 code 05，无需 LLM）
 *
 * 探索式导航 / 数据文件分析 / 代码库分析 / 安全特性演示。
 * TerminalTool 是跨平台内置实现（Node fs），Windows 无需 bash。
 */

import path from "node:path";
import { TerminalTool } from "../../src";

async function main() {
  const terminal = new TerminalTool({
    workspace: path.resolve(import.meta.dirname, "assets"),
  });
  const run = async (command: string) => {
    console.log(`\n$ ${command}`);
    console.log(await terminal.execute(JSON.stringify({ command })));
  };

  console.log("========== 1. 探索式导航 ==========");
  await run("pwd");
  await run("ls");
  await run("tree -L 2");
  await run("cd codebase");
  await run("ls");
  await run("cd ..");

  console.log("\n========== 2. 数据文件分析 ==========");
  await run("head -n 5 data/sales_2024.csv");
  await run("wc -l data/sales_2024.csv");
  await run("cut -d , -f 3 data/sales_2024.csv");
  await run("sort data/sales_2024.csv");

  console.log("\n========== 3. 代码库分析 ==========");
  await run("grep -rn TODO codebase");
  await run("grep -rn TODO codebase --include=*.py");
  await run("grep -rn \"def \" codebase");
  await run("find . -name *.py -type f");
  await run("awk '{print $1}' data/sales_2024.csv");

  console.log("\n========== 4. 安全特性 ==========");
  await run("rm -rf /");                    // ❌ 白名单外
  await run("cat ../../package.json");     // ❌ 路径逃逸
  await run("cat C:/Windows/win.ini");     // ❌ 绝对路径越界
}

main().catch((error) => {
  console.error("示例运行失败:", error);
  process.exitCode = 1;
});
