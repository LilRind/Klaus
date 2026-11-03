import { describe, expect, it } from "vitest";
import { Message } from "../src/core/message";

describe("Message", () => {
  it("默认角色是 user", () => {
    const message = new Message("你好");
    expect(message.role).toBe("user");
    expect(message.content).toBe("你好");
    expect(message.timestamp).toBeInstanceOf(Date);
  });

  it("工厂方法生成对应角色", () => {
    expect(Message.user("u").role).toBe("user");
    expect(Message.assistant("a").role).toBe("assistant");
    expect(Message.system("s").role).toBe("system");
    expect(Message.tool("t", "calculator").role).toBe("tool");
    expect(Message.tool("t", "calculator").name).toBe("calculator");
  });

  it("toChatMessage 无 name 时省略 name 字段", () => {
    expect(Message.user("hi").toChatMessage()).toEqual({
      role: "user",
      content: "hi",
    });
    expect(Message.tool("42", "calc").toChatMessage()).toEqual({
      role: "tool",
      content: "42",
      name: "calc",
    });
  });

  it("运行期拒绝非法角色（防反序列化脏数据）", () => {
    expect(() => new Message("x", "admin" as never)).toThrow(/非法消息角色/);
  });
});
