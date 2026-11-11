/**
 * s16 Workflow Journal（对齐 lcc WorkflowJournal + run_id 工具函数）
 *
 * Append-only `<runId>.journal.jsonl`：每条 agent() 结果一行
 * {"key","value"}。resume 模式严格回放——坏行直接报行号拒绝，
 * 绝不静默跳过（坏续跑比失败更危险）。语义键 = kind|label|prompt|
 * 键排序 schema 的 sha256 mod 10^10，与并发完成顺序无关，同名调用
 * 无论第几个完成都拿到同一个键，resume 对位才不会错。
 */

import { randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { stableSeed, stableStringify, type JsonSchemaRecord } from "./workflow-schema";

/** workflow 名 / runId / meta / args 不合法的统一错误（lcc 同名异常） */
export class WorkflowInputError extends Error {}

/** meta.name：1-64 字符 slug（也是本地产物文件名的安全围栏） */
export const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** runId：wf_{name}_{16hex} */
export const RUN_ID_RE = /^wf_[A-Za-z0-9][A-Za-z0-9._-]{0,63}_[0-9a-f]{16}$/;

/** 校验 runId（lcc validate_run_id） */
export function validateRunId(runId: unknown): string {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) {
    throw new WorkflowInputError("invalid workflow runId");
  }
  return runId;
}

/** 生成新 runId（lcc create_run_id：wf_{name}_{secrets 8 字节 hex}） */
export function createRunId(name: string): string {
  return `wf_${name}_${randomBytes(8).toString("hex")}`;
}

/**
 * 排他预留 runId（lcc reserve_run_id）：任何 journal 写入前先占住身份，
 * wx 冲突重试 ≤32 次——fresh run 绝不覆写已存在的运行产物。
 */
export async function reserveRunId(
  name: string,
  storeDir: string,
  createId: (name: string) => string = createRunId,
): Promise<string> {
  await mkdir(storeDir, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt++) {
    const runId = validateRunId(createId(name));
    const snapshotPath = path.join(storeDir, `${runId}.json`);
    let handle;
    try {
      handle = await open(snapshotPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    await handle.close();
    return runId;
  }
  throw new WorkflowInputError("could not allocate a unique workflow runId");
}

/**
 * 稳定语义键（lcc WorkflowJournal.key）：内容寻址而非顺序寻址——
 * parallel/pipeline 里第几个完成不影响 resume 对位。
 */
export function workflowSemanticKey(
  kind: string,
  label: string,
  prompt: string,
  schema: JsonSchemaRecord | undefined,
): string {
  const basis = `${kind}|${label}|${prompt}|${
    schema === undefined ? "null" : stableStringify(schema)
  }`;
  return `${kind}-${(stableSeed(basis) % 10n ** 10n).toString().padStart(10, "0")}`;
}

/** journal 缓存命中的键（cached() 不命中返回 undefined） */
export type JournalCache = Map<string, unknown>;

export class WorkflowJournal {
  readonly path: string;
  private readonly resume: boolean;
  private readonly cache: JournalCache = new Map();
  private closed = false;

  private constructor(
    readonly runId: string,
    storeDir: string,
    resume: boolean,
    cache: JournalCache,
  ) {
    this.resume = resume;
    this.path = path.join(storeDir, `${runId}.journal.jsonl`);
    this.cache = cache;
  }

  /**
   * 打开 journal（lcc 构造函数的 async 工厂翻译）：
   * resume 读入全部记录（坏行报行号）；fresh 截断重建。
   */
  static async open(
    runId: string,
    resume: boolean,
    storeDir: string,
  ): Promise<WorkflowJournal> {
    await mkdir(storeDir, { recursive: true });
    const journalPath = path.join(storeDir, `${runId}.journal.jsonl`);
    const cache: JournalCache = new Map();
    if (resume) {
      let content: string;
      try {
        content = await readFile(journalPath, "utf8");
      } catch {
        throw new WorkflowInputError(`resume journal not found for ${runId}`);
      }
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
        } catch {
          throw new WorkflowInputError(
            `invalid resume journal record at line ${i + 1}`,
          );
        }
        if (
          parsed === null ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          typeof (parsed as Record<string, unknown>).key !== "string" ||
          !("value" in (parsed as Record<string, unknown>))
        ) {
          throw new WorkflowInputError(
            `invalid resume journal record at line ${i + 1}`,
          );
        }
        const record = parsed as { key: string; value: unknown };
        cache.set(record.key, record.value);
      }
    }
    if (!resume) {
      // fresh：截断重建（lcc open("w")）
      const { writeFile } = await import("node:fs/promises");
      await writeFile(journalPath, "", "utf8");
    }
    return new WorkflowJournal(runId, storeDir, resume, cache);
  }

  /** 缓存查询；未命中返回 undefined（value 为 undefined 的记录不缓存） */
  cached(key: string): unknown {
    return this.cache.get(key);
  }

  /** 记录一条结果：追加落盘 + 写缓存（单进程事件循环内顺序安全） */
  record(key: string, value: unknown): void {
    if (this.closed) {
      throw new WorkflowInputError("journal is closed");
    }
    appendFileSync(this.path, `${JSON.stringify({ key, value })}\n`, "utf8");
    this.cache.set(key, value);
  }

  /** lcc close() 的对位 API（TS 逐条 append 无持久句柄，no-op） */
  close(): void {
    this.closed = true;
  }
}
