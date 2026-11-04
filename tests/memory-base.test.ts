import { describe, expect, it } from "vitest";
import {
  MEMORY_TYPES,
  MemoryConfig,
  createMemoryItem,
  isMemoryType,
} from "../src/memory/base";

describe("MemoryItem / MemoryConfig（书 8.1.4 base.py）", () => {
  it("createMemoryItem 填默认值：id/时间戳/重要性/元数据", () => {
    const item = createMemoryItem({ content: "张三在学 Python", memoryType: "working" });
    expect(item.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(item.importance).toBe(0.5);
    expect(item.metadata).toEqual({});
    expect(Date.parse(item.timestamp)).not.toBeNaN();
  });

  it("空内容与非法定重要性/类型会被拒绝", () => {
    expect(() => createMemoryItem({ content: "  ", memoryType: "working" })).toThrow();
    expect(() =>
      createMemoryItem({ content: "x", memoryType: "working", importance: 1.5 }),
    ).toThrow(/importance/);
  });

  it("MemoryConfig 默认值与覆盖", () => {
    const defaults = new MemoryConfig();
    expect(defaults.workingMemoryCapacity).toBe(50);
    expect(defaults.workingMemoryTtlMinutes).toBe(60);
    expect(defaults.databasePath).toBe("./memory_data/memory.db");
    // 不设默认：undefined 时嵌入工厂回落 EMBED_MODEL_TYPE 环境变量
    expect(defaults.embedModelType).toBeUndefined();

    const custom = new MemoryConfig({ workingMemoryCapacity: 10, workingMemoryTtlMinutes: 5 });
    expect(custom.workingMemoryCapacity).toBe(10);
    expect(custom.workingMemoryTtlMinutes).toBe(5);
    expect(() => new MemoryConfig({ workingMemoryCapacity: 0 })).toThrow();
  });

  it("四种记忆类型枚举与类型守卫", () => {
    expect(MEMORY_TYPES).toEqual(["working", "episodic", "semantic", "perceptual"]);
    expect(isMemoryType("episodic")).toBe(true);
    expect(isMemoryType("unknown")).toBe(false);
  });
});
