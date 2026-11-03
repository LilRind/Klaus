import { describe, expect, it } from "vitest";
import { AgentConfig } from "../src/core/config";

describe("AgentConfig", () => {
  it("默认值：maxSteps=5, maxToolIterations=3, timeoutMs=60000", () => {
    const config = AgentConfig.default();
    expect(config.maxSteps).toBe(5);
    expect(config.maxToolIterations).toBe(3);
    expect(config.timeoutMs).toBe(60_000);
    expect(config.verbose).toBe(false);
    expect(config.temperature).toBeUndefined();
  });

  it("接受自定义值", () => {
    const config = new AgentConfig({ maxSteps: 10, temperature: 0.2, verbose: true });
    expect(config.maxSteps).toBe(10);
    expect(config.temperature).toBe(0.2);
    expect(config.verbose).toBe(true);
  });

  it("拒绝非正整数", () => {
    expect(() => new AgentConfig({ maxSteps: 0 })).toThrow(/maxSteps/);
    expect(() => new AgentConfig({ maxToolIterations: 1.5 })).toThrow(
      /maxToolIterations/,
    );
  });
});
