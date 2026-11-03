/**
 * 短期记忆模块（对应书第四章 Reflection.py 的模块 1，第七章框架化沿用）
 *
 * 记录任务的"执行/反思"交替轨迹：
 * - execution：每一轮生成的作品（初稿、修订稿……）
 * - reflection：每一轮评审员的反馈
 * ReflectionAgent 靠它拿"最近一次执行"构造反思/修改提示词，
 * getTrajectory() 则把完整轨迹渲染成可读文本（第八章会在此之上扩展 Memory）。
 */

export type MemoryRecordType = "execution" | "reflection";

export interface MemoryRecord {
  type: MemoryRecordType;
  content: string;
}

export class Memory {
  readonly records: MemoryRecord[] = [];

  addRecord(type: MemoryRecordType, content: string): MemoryRecord {
    const record: MemoryRecord = { type, content };
    this.records.push(record);
    return record;
  }

  /** 最近一次执行结果（初稿或最新修订稿），倒序查找 */
  getLastExecution(): string | undefined {
    for (const record of [...this.records].reverse()) {
      if (record.type === "execution") return record.content;
    }
    return undefined;
  }

  /** 全部执行记录（初稿 → 各轮修订稿，顺序） */
  getExecutions(): string[] {
    return this.records
      .filter((r) => r.type === "execution")
      .map((r) => r.content);
  }

  /** 轨迹渲染为连贯文本：执行/反思交替，供提示词或日志使用 */
  getTrajectory(): string {
    return this.records
      .map((record) =>
        record.type === "execution"
          ? `--- 上一轮尝试 ---\n${record.content}`
          : `--- 反思反馈 ---\n${record.content}`,
      )
      .join("\n\n");
  }

  clear(): void {
    this.records.length = 0;
  }
}
