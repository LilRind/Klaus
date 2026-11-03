import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry";
import { Tool } from "../src/tools/tool";
import { CalculatorTool } from "../src/tools/builtin/calculator";
import { ToolExecutionError, ToolNotFoundError } from "../src/core/exceptions";

class EchoTool extends Tool {
  get name() { return "echo"; }
  get description() { return "原样返回输入"; }
  get parametersDescription() { return "text: 任意文本"; }
  execute(input: string): string { return `echo: ${input}`; }
}

class BoomTool extends Tool {
  get name() { return "boom"; }
  get description() { return "总是抛错"; }
  get parametersDescription() { return "-"; }
  override execute(): string { throw new Error("内部炸了"); }
}

describe("ToolRegistry", () => {
  it("注册/查找/列举工具", () => {
    const registry = new ToolRegistry().register(new EchoTool()).register(new CalculatorTool());
    expect(registry.size).toBe(2);
    expect(registry.getTool("echo")?.name).toBe("echo");
    expect(registry.listTools().map((t) => t.name)).toEqual(["echo", "calculator"]);
    expect(registry.unregister("echo")).toBe(true);
    expect(registry.size).toBe(1);
  });

  it("生成编号式工具菜单，空注册表返回占位文案", () => {
    const registry = new ToolRegistry().register(new EchoTool());
    const description = registry.getToolsDescription();
    expect(description).toContain("1. echo: 原样返回输入");
    expect(description).toContain("text: 任意文本");
    expect(new ToolRegistry().getToolsDescription()).toBe("暂无可用工具");
  });

  it("registerFunction 快速包装普通函数", async () => {
    const registry = new ToolRegistry().registerFunction({
      name: "upper",
      description: "转大写",
      func: (input: string) => input.toUpperCase(),
    });
    await expect(registry.executeTool("upper", "abc")).resolves.toBe("ABC");
  });

  it("executeTool 找不到工具抛 ToolNotFoundError", async () => {
    const registry = new ToolRegistry().register(new EchoTool());
    await expect(registry.executeTool("ghost", "1")).rejects.toThrow(
      /未找到工具 'ghost'，可用工具: echo/,
    );
    await expect(
      new ToolRegistry().executeTool("ghost", "1"),
    ).rejects.toMatchObject({ toolName: "ghost", availableTools: [] });
  });

  it("工具内部异常统一包装为 ToolExecutionError（保留 cause）", async () => {
    const registry = new ToolRegistry().register(new BoomTool());
    const action = registry.executeTool("boom", "");
    await expect(action).rejects.toThrow(ToolExecutionError);
    await expect(action).rejects.toMatchObject({ toolName: "boom" });
  });
});
