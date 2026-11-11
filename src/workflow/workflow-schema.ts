/**
 * s16 极简 JSON Schema 校验器 + 稳定序列化（对齐 lcc SimpleJsonSchema）
 *
 * 只支持 workflow 编排实际用到的子集：object/array/string/boolean/
 * number/integer + required + properties + items + enum。校验返回
 * [ok, error] 二元组（lcc 同款），error 用于回喂 agent 触发一次重试。
 */

import { createHash } from "node:crypto";

/** JSON Schema 记录（弱类型：校验器只读取认识的键） */
export type JsonSchemaRecord = Record<string, unknown>;

/** 校验结果：lcc 返回 (bool, error|None) 的 TS 翻译 */
export type SchemaValidation = [ok: boolean, error: string | null];

export class SimpleJsonSchema {
  private readonly schema: JsonSchemaRecord;

  constructor(schema: JsonSchemaRecord) {
    this.schema = schema;
  }

  validate(value: unknown, schema?: JsonSchemaRecord): SchemaValidation {
    const active = schema ?? this.schema;
    if ("enum" in active && Array.isArray(active.enum)) {
      if (!active.enum.includes(value)) {
        return [false, `expected one of [${active.enum.join(", ")}]`];
      }
    }
    const type = active.type;
    if (type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [false, "expected object"];
      }
      const record = value as Record<string, unknown>;
      for (const key of (active.required as string[] | undefined) ?? []) {
        if (!(key in record)) {
          return [false, `missing required key '${key}'`];
        }
      }
      const properties = (active.properties ?? {}) as Record<
        string,
        JsonSchemaRecord
      >;
      for (const [key, sub] of Object.entries(properties)) {
        if (key in record) {
          const [ok, err] = this.validate(record[key], sub);
          if (!ok) return [false, `${key}: ${err}`];
        }
      }
      return [true, null];
    }
    if (type === "array") {
      if (!Array.isArray(value)) return [false, "expected array"];
      const items = active.items as JsonSchemaRecord | undefined;
      if (items) {
        for (let i = 0; i < value.length; i++) {
          const [ok, err] = this.validate(value[i], items);
          if (!ok) return [false, `[${i}]: ${err}`];
        }
      }
      return [true, null];
    }
    if (type === "string") {
      return [
        typeof value === "string",
        typeof value === "string" ? null : "expected string",
      ];
    }
    if (type === "boolean") {
      return [
        typeof value === "boolean",
        typeof value === "boolean" ? null : "expected boolean",
      ];
    }
    if (type === "number" || type === "integer") {
      // lcc 同款：接受 int/float、显式排除 bool（Python bool 是 int 子类）
      const ok = typeof value === "number" && !Number.isNaN(value);
      return [ok, ok ? null : "expected number"];
    }
    return [true, null];
  }
}

/**
 * 键排序的确定性 JSON 序列化（对齐 lcc json.dumps(sort_keys=True)）：
 * 语义键与 resume args 比较都依赖它——同名 schema 无论键序如何都产生
 * 同一串字节，跨进程、跨轮次稳定。
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** 进程稳定哈希（对齐 lcc _stable_hash：sha256 而非语言内置盐化哈希） */
export function stableSeed(input: string): bigint {
  const hex = createHash("sha256").update(input, "utf8").digest("hex");
  return BigInt(`0x${hex}`);
}

/**
 * Mock runner 的确定性通用 filler（对齐 lcc _fill_schema）：
 * runner 不特化的 schema 用种子哈希填出稳定值，demo/测试可复现。
 */
export function fillSchema(schema: JsonSchemaRecord, seed: string): unknown {
  const type = schema.type;
  if (type === "object") {
    const properties = (schema.properties ?? {}) as Record<string, JsonSchemaRecord>;
    const keys = (schema.required as string[] | undefined) ?? Object.keys(properties);
    return Object.fromEntries(
      keys.map((key) => [
        key,
        fillSchema(properties[key] ?? {}, `${seed}/${key}`),
      ]),
    );
  }
  if (type === "array") {
    return [fillSchema((schema.items ?? {}) as JsonSchemaRecord, `${seed}/0`)];
  }
  if (type === "boolean") {
    return stableSeed(seed) % 4n !== 0n;
  }
  if (type === "number" || type === "integer") {
    return Number(stableSeed(seed) % 5n);
  }
  const lastSlash = seed.lastIndexOf("/");
  return lastSlash === -1 ? seed : seed.slice(lastSlash + 1);
}
