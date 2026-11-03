/**
 * 提示词模板填充（Reflection / PlanAndSolve 共用）
 *
 * 对应书里 Python 的 str.format(**context)：
 * 只替换已知变量、保留未知占位符原样，避免提示词里合法的 JSON 示例被误伤。
 */

export function fillTemplate(
  template: string,
  variables: Record<string, string>,
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/** 提取模板中引用的全部变量名（工具链模板校验用） */
export function extractTemplateVariables(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");
}
