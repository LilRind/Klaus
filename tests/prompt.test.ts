import { describe, expect, it } from "vitest";
import { fillTemplate, extractTemplateVariables } from "../src/core/prompt";

describe("提示词模板工具", () => {
  it("fillTemplate 只替换已知变量，未知占位符原样保留", () => {
    const result = fillTemplate("任务:{task} 内容:{content} 示例:{raw}", {
      task: "写作",
      content: "初稿",
    });
    expect(result).toBe("任务:写作 内容:初稿 示例:{raw}");
  });

  it("extractTemplateVariables 提取全部变量名", () => {
    expect(extractTemplateVariables("{input} → {search_result}")).toEqual([
      "input",
      "search_result",
    ]);
  });
});
