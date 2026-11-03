import { describe, expect, it } from "vitest";
import { ToolChain, ToolChainManager } from "../src/tools/chain";
import { ToolRegistry } from "../src/tools/registry";
import { CalculatorTool } from "../src/tools/builtin/calculator";

function registry(): ToolRegistry {
  return new ToolRegistry()
    .registerFunction({
      name: "identity",
      description: "原样返回",
      func: (input) => input,
    })
    .register(new CalculatorTool());
}

describe("ToolChain 工具链（对应书 7.5.4）", () => {
  it("步骤间通过输出键传递数据，返回最后一步结果", async () => {
    const chain = new ToolChain("double", "取数后翻倍")
      .addStep("identity", "{input}", "num")
      .addStep("calculator", "{num}*2", "result");
    const context: Record<string, string> = {};

    const final = await chain.execute(registry(), "21", context);

    expect(final).toBe("42");
    expect(context).toMatchObject({ input: "21", num: "21", result: "42" });
  });

  it("未提供输出键时自动命名 step_N_result", async () => {
    const chain = new ToolChain("one", "单步").addStep("identity", "{input}");
    const context: Record<string, string> = {};
    await chain.execute(registry(), "x", context);
    expect(context["step_1_result"]).toBe("x");
  });

  it("模板变量缺失时快速失败", async () => {
    const chain = new ToolChain("bad", "坏链").addStep("identity", "{ghost}");
    await expect(chain.execute(registry(), "x")).resolves.toContain(
      "模板变量 {ghost} 未找到",
    );
  });

  it("空链返回错误提示", async () => {
    const chain = new ToolChain("empty", "空链");
    await expect(chain.execute(registry(), "x")).resolves.toContain(
      "没有任何步骤",
    );
  });
});

describe("ToolChainManager", () => {
  it("注册 / 按名执行 / 列举", async () => {
    const manager = new ToolChainManager(registry());
    manager.registerChain(
      new ToolChain("plus10", "加十").addStep("calculator", "{input}+10"),
    );

    expect(manager.listChains()).toEqual(["plus10"]);
    await expect(manager.executeChain("plus10", "5")).resolves.toBe("15");
  });

  it("执行不存在的链返回错误文案", async () => {
    const manager = new ToolChainManager(registry());
    await expect(manager.executeChain("ghost", "x")).resolves.toContain(
      "工具链 'ghost' 不存在",
    );
  });
});
