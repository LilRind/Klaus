/**
 * 内置计算器工具（对应书 7.5.2 my_calculator_tool.py）
 *
 * 书里用 Python 的 ast.parse 做安全求值；TS 没有 AST 解释器可白嫖，
 * 于是手写递归下降解析器——反而更能讲清楚"为什么不 eval"：
 * 语法树只接受白名单节点（数字/四则/括号/sqrt/pi），任意代码注入在解析阶段就被拒绝。
 */

import { Tool } from "../tool";

export class CalculatorError extends Error {}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" | "(" | ")" | "," };

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  sqrt: Math.sqrt,
};

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

export class CalculatorTool extends Tool {
  override get name(): string {
    return "calculator";
  }

  override get description(): string {
    return "数学计算工具，支持基本运算(+,-,*,/)、括号、sqrt 函数和 pi/e 常量";
  }

  override get parametersDescription(): string {
    return "expression: 数学表达式字符串，例如 (12+8)*3 或 sqrt(144)+pi";
  }

  override get parametersSchema(): Record<string, unknown> {
    return {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "数学表达式，支持 + - * / 括号 sqrt 和 pi/e 常量",
        },
      },
      required: ["expression"],
    };
  }

  override execute(input: string): string {
    if (!input.trim()) return "计算表达式不能为空";
    try {
      const value = evaluateExpression(input);
      return formatNumber(value);
    } catch (error) {
      if (error instanceof CalculatorError) {
        return `计算失败: ${error.message}`;
      }
      return "计算失败，请检查表达式格式";
    }
  }
}

/** 纯函数求值入口（测试直接断言数值，不经过字符串转换） */
export function evaluateExpression(expression: string): number {
  const tokens = tokenize(expression);
  const parser = new Parser(tokens);
  const value = parser.parseExpression();
  parser.expectEnd();
  if (!Number.isFinite(value)) {
    throw new CalculatorError("结果不是有限数字（可能除以了 0）");
  }
  return value;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    // 循环条件保证 i < length，非空断言安全
    const char = source[i]!;
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const start = i;
      while (i < source.length && /[0-9.]/.test(source[i]!)) i += 1;
      const text = source.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) {
        throw new CalculatorError(`非法数字 '${text}'`);
      }
      tokens.push({ kind: "number", value });
      continue;
    }
    if (/[a-zA-Z_]/.test(char)) {
      const start = i;
      while (i < source.length && /[a-zA-Z_0-9]/.test(source[i]!)) i += 1;
      tokens.push({ kind: "identifier", value: source.slice(start, i) });
      continue;
    }
    if ("+-*/(),".includes(char)) {
      tokens.push({ kind: "op", value: char as Token extends { kind: "op"; value: infer V } ? V : never });
      i += 1;
      continue;
    }
    throw new CalculatorError(`不支持的字符 '${char}'`);
  }
  if (tokens.length === 0) throw new CalculatorError("表达式为空");
  return tokens;
}

/** 递归下降解析器：expr = term (('+'|'-') term)*；term = unary (('*'|'/') unary)* */
class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parseExpression(): number {
    let left = this.parseTerm();
    while (this.matchOp("+") || this.matchOp("-")) {
      const op = this.previous() as { kind: "op"; value: "+" | "-" };
      const right = this.parseTerm();
      left = op.value === "+" ? left + right : left - right;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseUnary();
    while (this.matchOp("*") || this.matchOp("/")) {
      const op = this.previous() as { kind: "op"; value: "*" | "/" };
      const right = this.parseUnary();
      if (op.value === "*") {
        left *= right;
      } else {
        if (right === 0) throw new CalculatorError("除数不能为 0");
        left /= right;
      }
    }
    return left;
  }

  private parseUnary(): number {
    if (this.matchOp("-")) return -this.parseUnary();
    if (this.matchOp("+")) return this.parseUnary();
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.peek();
    if (!token) throw new CalculatorError("表达式意外结束");

    if (token.kind === "number") {
      this.advance();
      return token.value;
    }

    if (token.kind === "identifier") {
      this.advance();
      const lower = token.value.toLowerCase();
      if (lower in CONSTANTS) {
        return CONSTANTS[lower]!;
      }
      const func = FUNCTIONS[lower];
      if (!func) throw new CalculatorError(`未知标识符 '${token.value}'`);
      this.expectOp("(");
      const args: number[] = [this.parseExpression()];
      while (this.matchOp(",")) args.push(this.parseExpression());
      this.expectOp(")");
      return func(...args);
    }

    if (token.kind === "op" && token.value === "(") {
      this.advance();
      const value = this.parseExpression();
      this.expectOp(")");
      return value;
    }

    throw new CalculatorError(`意外的符号 '${String(token.value)}'`);
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private advance(): Token | undefined {
    return this.tokens[this.pos++];
  }

  private previous(): Token | undefined {
    return this.tokens[this.pos - 1];
  }

  private matchOp(value: "+" | "-" | "*" | "/" | "(" | ")" | ","): boolean {
    const token = this.peek();
    if (token?.kind === "op" && token.value === value) {
      this.advance();
      return true;
    }
    return false;
  }

  private expectOp(value: "(" | ")"): void {
    if (!this.matchOp(value)) {
      throw new CalculatorError(`期望 '${value}'`);
    }
  }

  expectEnd(): void {
    if (this.pos < this.tokens.length) {
      throw new CalculatorError(`多余的内容 '${String(this.tokens[this.pos]?.value)}'`);
    }
  }
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(10)));
}
