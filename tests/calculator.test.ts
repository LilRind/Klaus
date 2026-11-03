import { describe, expect, it } from "vitest";
import {
  CalculatorError,
  CalculatorTool,
  evaluateExpression,
} from "../src/tools/builtin/calculator";

describe("CalculatorTool 求值内核", () => {
  it.each([
    ["2 + 3 * 4", 14],
    ["(1+2)*3", 9],
    ["10/4", 2.5],
    ["sqrt(16)", 4],
    ["-3+5", 2],
    ["2*-3", -6],
    ["sqrt(144)+6*7", 54],
    ["pi", Math.PI],
  ])("%s = %s", (expression, expected) => {
    expect(evaluateExpression(expression)).toBeCloseTo(expected);
  });

  it("除以 0 抛 CalculatorError", () => {
    expect(() => evaluateExpression("1/0")).toThrow(/除数不能为 0/);
  });

  it("拒绝代码注入——白名单之外的输入一律被解析器拒绝", () => {
    expect(() => evaluateExpression("process.exit(1)")).toThrow(CalculatorError);
    expect(() => evaluateExpression("2; delete x")).toThrow(/不支持的字符/);
    expect(() => evaluateExpression("foo(1)")).toThrow(/未知标识符/);
  });
});

describe("CalculatorTool 工具契约", () => {
  const tool = new CalculatorTool();

  it("正常计算返回字符串结果", () => {
    expect(tool.execute("2+3*4")).toBe("14");
    expect(tool.execute("sqrt(16)")).toBe("4");
  });

  it("空表达式与非法表达式返回错误文案而不是抛异常", () => {
    expect(tool.execute("   ")).toBe("计算表达式不能为空");
    expect(tool.execute("2+")).toContain("计算失败");
    expect(tool.execute("1/0")).toContain("除数不能为 0");
  });

  it("元信息完整（name/description/parametersDescription）", () => {
    expect(tool.name).toBe("calculator");
    expect(tool.description).toContain("数学计算");
    expect(tool.parametersDescription).toContain("expression");
  });
});
