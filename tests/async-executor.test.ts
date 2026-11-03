import { describe, expect, it } from "vitest";
import { AsyncToolExecutor } from "../src/tools/async-executor";
import { ToolRegistry } from "../src/tools/registry";

describe("AsyncToolExecutor 异步执行器（对应书 7.5.4）", () => {
  it("并行执行且结果顺序与任务顺序一致", async () => {
    let concurrent = 0;
    let peak = 0;
    const registry = new ToolRegistry().registerFunction({
      name: "delay_echo",
      description: "延迟回声",
      func: async (input: string) => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, Number(input.split(":")[1])));
        concurrent -= 1;
        return input.split(":")[0] ?? input;
      },
    });
    const executor = new AsyncToolExecutor(registry, 4);

    const results = await executor.executeToolsParallel([
      { toolName: "delay_echo", input: "a:30" },
      { toolName: "delay_echo", input: "b:5" },
      { toolName: "delay_echo", input: "c:20" },
      { toolName: "delay_echo", input: "d:1" },
    ]);

    expect(results).toEqual(["a", "b", "c", "d"]); // 顺序一致，不按完成时间
    expect(peak).toBeGreaterThan(1); // 确实并行了
  });

  it("并发数受 maxConcurrency 限制", async () => {
    let concurrent = 0;
    let peak = 0;
    const registry = new ToolRegistry().registerFunction({
      name: "slow",
      description: "慢工具",
      func: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((r) => setTimeout(r, 15));
        concurrent -= 1;
        return "ok";
      },
    });
    const executor = new AsyncToolExecutor(registry, 2);

    const tasks = Array.from({ length: 6 }, () => ({
      toolName: "slow",
      input: "",
    }));
    const results = await executor.executeToolsParallel(tasks);

    expect(results).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
    expect(executor.lastPeakConcurrency).toBeLessThanOrEqual(2);
  });

  it("单个工具直通执行 + 异常传播", async () => {
    const registry = new ToolRegistry()
      .registerFunction({ name: "ok", description: "", func: () => "good" })
      .registerFunction({
        name: "boom",
        description: "",
        func: () => {
          throw new Error("炸了");
        },
      });
    const executor = new AsyncToolExecutor(registry);

    await expect(executor.executeToolAsync("ok", "x")).resolves.toBe("good");
    await expect(
      executor.executeToolsParallel([
        { toolName: "ok", input: "x" },
        { toolName: "boom", input: "" },
      ]),
    ).rejects.toThrow(/炸了/);
  });

  it("空任务列表返回空数组", async () => {
    const executor = new AsyncToolExecutor(new ToolRegistry());
    await expect(executor.executeToolsParallel([])).resolves.toEqual([]);
  });
});
