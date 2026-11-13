/** S18 研判器：schema 硬校验与降级路径（dsh AssessmentSchema 裁剪版）。 */
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_SYSTEM_PROMPT,
  assessTrigger,
  extractJsonObject,
  outcomeFromRaw,
} from "../../src/orchestrator/assessment";
import type { Trigger } from "../../src/orchestrator/model";
import { ScriptedLLM } from "../scripted-llm";

const codeOf = (
  outcome: ReturnType<typeof outcomeFromRaw>,
): string | undefined => (outcome.kind === "ignore" ? outcome.code : undefined);

const trigger: Trigger = {
  id: "in-1",
  text: "帮我修 README 的错别字并补充安装说明",
  at: "2026-11-13T00:00:00.000Z",
  human: true,
  addressed: "direct",
};

const acceptRaw = {
  decision: "accept",
  reason: "两个明确的工作请求",
  intent_evidence: "帮我修 README 的错别字并补充安装说明",
  tickets: [
    { title: "修错别字", scope: "只改 README 错别字" },
    { title: "补安装说明", scope: "补充 README 安装节" },
  ],
};

describe("outcomeFromRaw", () => {
  it("合法 accept 原样通过", () => {
    const outcome = outcomeFromRaw(acceptRaw);
    expect(outcome.kind).toBe("accept");
    if (outcome.kind === "accept") {
      expect(outcome.tickets).toHaveLength(2);
      expect(outcome.tickets[0]?.title).toBe("修错别字");
    }
  });

  it("ignore 通过", () => {
    const outcome = outcomeFromRaw({ decision: "ignore", reason: "闲聊" });
    expect(outcome).toEqual({ kind: "ignore", reason: "闲聊" });
  });

  it("非对象 / 缺 reason → invalidShape", () => {
    expect(codeOf(outcomeFromRaw(null))).toBe("invalidShape");
    expect(codeOf(outcomeFromRaw("accept"))).toBe("invalidShape");
    expect(codeOf(outcomeFromRaw({ decision: "ignore" }))).toBe("invalidShape");
  });

  it("accept 缺 intent_evidence → missingEvidence", () => {
    const { intent_evidence: _drop, ...withoutEvidence } = acceptRaw;
    expect(codeOf(outcomeFromRaw(withoutEvidence))).toBe("missingEvidence");
  });

  it("accept 无子票 → acceptWithoutTickets；超 5 张 → tooManyTickets", () => {
    expect(codeOf(outcomeFromRaw({ ...acceptRaw, tickets: [] }))).toBe("acceptWithoutTickets");
    expect(
      codeOf(
        outcomeFromRaw({
          ...acceptRaw,
          tickets: Array.from({ length: 6 }, (_, i) => ({ title: `t${i}`, scope: "s" })),
        }),
      ),
    ).toBe("tooManyTickets");
  });

  it("子票字段非法 → invalidShape", () => {
    expect(
      codeOf(outcomeFromRaw({ ...acceptRaw, tickets: [{ title: "", scope: "s" }] })),
    ).toBe("invalidShape");
    expect(
      codeOf(outcomeFromRaw({ ...acceptRaw, tickets: [{ title: "t", scope: 42 }] })),
    ).toBe("invalidShape");
  });
});

describe("extractJsonObject", () => {
  it("从前后噪声中提取第一个平衡对象", () => {
    const text = '好的，结果如下：\n{"decision":"ignore","reason":"闲聊"}\n以上。';
    expect(extractJsonObject(text)).toEqual({ decision: "ignore", reason: "闲聊" });
  });

  it("嵌套大括号与字符串内大括号都安全", () => {
    const text = '{"decision":"accept","tickets":[{"title":"a{b}","scope":"s"}]}';
    expect(extractJsonObject(text)).toEqual({
      decision: "accept",
      tickets: [{ title: "a{b}", scope: "s" }],
    });
  });

  it("无 JSON / 损坏 JSON 返回 undefined", () => {
    expect(extractJsonObject("没有对象")).toBeUndefined();
    expect(extractJsonObject("{broken")).toBeUndefined();
  });
});

describe("assessTrigger", () => {
  it("系统提示要求 JSON 输出", async () => {
    const llm = new ScriptedLLM(['{"decision":"ignore","reason":"闲聊"}']);
    await assessTrigger(llm, trigger);
    const system = llm.calls[0]?.messages[0]?.content ?? "";
    expect(system).toContain("研判器");
    expect(system).toContain("intent_evidence");
    expect(ASSESSMENT_SYSTEM_PROMPT).toContain("1-5");
  });

  it("LLM 异常 → 降级 ignore 不抛错", async () => {
    const llm = {
      model: "x",
      invoke: () => {
        throw new Error("network");
      },
    };
    const outcome = await assessTrigger(llm as never, trigger);
    expect(outcome.kind).toBe("ignore");
  });
});
