import { describe, expect, it } from "vitest";
import {
  NO_INFO_PATTERNS,
  preprocessResults,
  synthesizeResults,
} from "../../src/multiagent/synthesis";
import type { AgentResult } from "../../src/multiagent/model";
import { scriptedLlm, type ScriptedInvoke } from "./test-llm";

const r = (taskId: string, response: string, success = true): AgentResult => ({
  taskId, response, tokens: 5, success,
});

describe("preprocessResults", () => {
  it("精确重复被去掉", () => {
    const out = preprocessResults([r("a", "同样内容"), r("b", "同样内容")]);
    expect(out).toHaveLength(1);
  });

  it("Jaccard>0.85 相似去重（边界：刚好 0.85 保留）", () => {
    const tokens = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const base = tokens(20);
    const overlap18 = [...Array.from({ length: 18 }, (_, i) => `w${i}`), "x1", "x2"].join(" ");
    // |A∩B|=18, |A∪B|=22 → 0.818 保留；构造 >0.85：20 共享 + 各 1 独有 → 20/22≈0.909 去重
    const a = tokens(20);
    const b = [...Array.from({ length: 20 }, (_, i) => `w${i}`), "extra"].join(" ");
    const out = preprocessResults([r("a", a), r("s", overlap18), r("b", b)]);
    expect(out.map((x) => x.taskId)).toContain("s");
    expect(out.map((x) => x.taskId)).not.toContain("b");
    expect(out.map((x) => x.taskId)).toContain("a");
  });

  it("失败与无信息结果被过滤", () => {
    const out = preprocessResults([
      r("fail", "半途而废", false),
      r("noinfo", NO_INFO_PATTERNS[0] ?? "无法访问"),
      r("ok", "有效洞察"),
    ]);
    expect(out.map((x) => x.taskId)).toEqual(["ok"]);
  });
});

describe("synthesizeResults", () => {
  it("LLM 综合收到来源块并返回结果", async () => {
    const calls: ScriptedInvoke[] = [];
    const final = await synthesizeResults(
      scriptedLlm(["综合答案"], calls),
      "对比三家营收",
      [r("a", "甲营收 100"), r("b", "乙营收 200")],
    );
    expect(final).toBe("综合答案");
    const user = calls[0]?.messages.at(-1)?.content ?? "";
    expect(user).toContain("对比三家营收");
    expect(user).toContain("甲营收 100");
    expect(user).toContain("乙营收 200");
  });

  it("净化后为空则不调 LLM", async () => {
    const calls: ScriptedInvoke[] = [];
    const final = await synthesizeResults(scriptedLlm([], calls), "q", []);
    expect(calls).toHaveLength(0);
    expect(final).toContain("无可综合");
  });
});
