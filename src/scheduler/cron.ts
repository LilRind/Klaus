/**
 * 五段式 cron 表达式（对齐 learn-claude-code s12）
 *
 * 支持通配、步长（星号/N）、固定值、区间、逗号列表五种形式。
 * 日(day-of-month)与星期(day-of-week)同时为具体值时取 OR（标准 cron 语义）。
 * lcc 用 Python weekday()+1 换算成 cron 的周日=0；JS Date.getDay()
 * 天然就是周日=0，直接使用。
 */

/** 单字段是否匹配当前值 */
export function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.startsWith("*/")) {
    return value % Number(field.slice(2)) === 0;
  }
  if (field.includes(",")) {
    return field
      .split(",")
      .some((part) => cronFieldMatches(part.trim(), value));
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-", 2);
    return (
      Number(start ?? NaN) <= value && value <= Number(end ?? NaN)
    );
  }
  return value === Number(field);
}

/** 完整表达式是否匹配指定时刻（分钟/小时/月 AND；日/星期 OR） */
export function cronMatches(cronExpr: string, moment: Date): boolean {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const minute = fields[0] ?? "";
  const hour = fields[1] ?? "";
  const day = fields[2] ?? "";
  const month = fields[3] ?? "";
  const weekday = fields[4] ?? "";
  if (
    !(
      cronFieldMatches(minute, moment.getMinutes()) &&
      cronFieldMatches(hour, moment.getHours()) &&
      cronFieldMatches(month, moment.getMonth() + 1)
    )
  ) {
    return false;
  }
  const dayMatches = cronFieldMatches(day, moment.getDate());
  const weekdayMatches = cronFieldMatches(weekday, moment.getDay());
  if (day === "*" && weekday === "*") return true;
  if (day === "*") return weekdayMatches;
  if (weekday === "*") return dayMatches;
  return dayMatches || weekdayMatches;
}

const FIELD_RULES: readonly [string, number, number][] = [
  ["minute", 0, 59],
  ["hour", 0, 23],
  ["day-of-month", 1, 31],
  ["month", 1, 12],
  ["day-of-week", 0, 6],
];

/** 单字段校验（返回错误文案或 null，对齐 lcc _validate_cron_field） */
function validateCronField(
  field: string,
  minimum: number,
  maximum: number,
): string | null {
  if (field === "*") return null;
  if (field.startsWith("*/")) {
    const step = field.slice(2);
    if (!/^\d+$/.test(step) || Number(step) <= 0) {
      return `Invalid step: ${field}`;
    }
    return null;
  }
  if (field.includes(",")) {
    for (const part of field.split(",")) {
      const error = validateCronField(part.trim(), minimum, maximum);
      if (error) return error;
    }
    return null;
  }
  if (field.includes("-")) {
    const [start, end] = field.split("-", 2);
    if (!/^\d+$/.test(start ?? "") || !/^\d+$/.test(end ?? "")) {
      return `Invalid range: ${field}`;
    }
    const startValue = Number(start);
    const endValue = Number(end);
    if (startValue > endValue) {
      return `Range start is greater than end: ${field}`;
    }
    if (startValue < minimum || endValue > maximum) {
      return `Range ${field} is outside [${minimum}-${maximum}]`;
    }
    return null;
  }
  if (!/^\d+$/.test(field)) {
    return `Invalid field: ${field}`;
  }
  const value = Number(field);
  if (value < minimum || value > maximum) {
    return `Value ${value} is outside [${minimum}-${maximum}]`;
  }
  return null;
}

/** 表达式校验（返回首个错误文案或 null，对齐 lcc validate_cron） */
export function validateCron(cronExpr: string): string | null {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return `Expected 5 fields, got ${fields.length}`;
  }
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    const rule = FIELD_RULES[index];
    if (!rule) continue;
    const [name, minimum, maximum] = rule;
    const error = validateCronField(field, minimum, maximum);
    if (error) {
      return `${name}: ${error}`;
    }
  }
  return null;
}
