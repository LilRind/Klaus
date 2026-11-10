/**
 * s07 Skill Loading 离线验收（对齐 README"试一下"观察点）
 *
 * - frontmatter 解析与两级 fallback（name←目录名 / description←正文首行）；
 * - catalog 只含名称与描述（全文不进 system prompt）；
 * - load 命中返回全文；未命中列出可用技能；name 绝不当路径用；
 * - Agent 集成：目录在 system prompt，全文经 load_skill 的 tool_result 回喂。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  SkillLoader,
  parseFrontmatter,
  buildSkillSystemPrompt,
} from "../src/skills/skill-loader";
import { SkillTool } from "../src/tools/builtin/skill-tool";
import { FunctionCallAgent } from "../src/agents/function-call-agent";
import { ToolRegistry } from "../src/tools/registry";
import { ScriptedLLM } from "./scripted-llm";
import type { ToolCallRequest } from "../src/core/message";
import type { ToolInvocationResult } from "../src/core/llm";

afterEach(() => {
  vi.restoreAllMocks();
});

const roots: string[] = [];

async function makeSkillsDir(): Promise<string> {
  const root = path.join("test_tmp", `skills_${Math.random().toString(36).slice(2)}`);
  roots.push(root);
  await fs.mkdir(path.join(root, "full-skill"), { recursive: true });
  await fs.writeFile(
    path.join(root, "full-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: A complete skill with frontmatter\n---\n\n# My Skill\nFull body here.\n",
    "utf8",
  );
  // 无 frontmatter：name ← 目录名，description ← 正文首行（去 # 前缀）
  await fs.mkdir(path.join(root, "bare-skill"), { recursive: true });
  await fs.writeFile(
    path.join(root, "bare-skill", "SKILL.md"),
    "# Bare Skill Heading\nBody line.\n",
    "utf8",
  );
  // 子目录无 SKILL.md：不是技能
  await fs.mkdir(path.join(root, "not-a-skill"), { recursive: true });
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("parseFrontmatter", () => {
  it("提取 name/description 并剥离引号；正文保留", () => {
    const { metadata, body } = parseFrontmatter(
      '---\nname: "quoted"\ndescription: \'single\'\nother: value\n---\n\n# Title\nBody',
    );
    expect(metadata.name).toBe("quoted");
    expect(metadata.description).toBe("single");
    expect(metadata.other).toBe("value");
    expect(body).toContain("# Title");
  });

  it("无 frontmatter：metadata 为空，全文都是正文", () => {
    const { metadata, body } = parseFrontmatter("# Just markdown\n");
    expect(metadata).toEqual({});
    expect(body).toBe("# Just markdown\n");
  });
});

describe("SkillLoader（s07 对齐）", () => {
  it("扫描：frontmatter 技能 + 两级 fallback；无 SKILL.md 的目录被跳过", async () => {
    const root = await makeSkillsDir();
    const loader = await new SkillLoader(root).scan();

    expect(loader.size).toBe(2);
    expect(loader.listNames()).toEqual(["bare-skill", "my-skill"]);
    const full = loader.load("my-skill");
    expect(full).toContain("A complete skill with frontmatter");
    expect(full).toContain("Full body here.");
    const bare = loader.load("bare-skill");
    expect(bare).toContain("# Bare Skill Heading");
  });

  it("catalog 只含名称与描述，不含正文", async () => {
    const root = await makeSkillsDir();
    const loader = await new SkillLoader(root).scan();
    const catalog = loader.catalog();

    expect(catalog).toContain("- my-skill: A complete skill with frontmatter");
    expect(catalog).toContain("- bare-skill: Bare Skill Heading");
    expect(catalog).not.toContain("Full body here.");
  });

  it("load 未命中：错误信息列出可用技能；name 不当路径用", async () => {
    const root = await makeSkillsDir();
    const loader = await new SkillLoader(root).scan();

    expect(loader.load("ghost")).toBe(
      "Error: Unknown skill 'ghost'. Available: bare-skill, my-skill",
    );
    // 路径样式输入也只是查注册表，不会触发文件读取
    expect(loader.load("../secrets")).toContain("Unknown skill");
  });

  it("目录不存在：空目录占位", async () => {
    const loader = await new SkillLoader(path.join("test_tmp", "no_such_skills")).scan();
    expect(loader.size).toBe(0);
    expect(loader.catalog()).toBe("(no skills available)");
  });

  it("仓库自带 skills/ 目录可扫描出三个技能", async () => {
    const loader = await new SkillLoader("skills").scan();
    expect(loader.listNames()).toEqual(["api-design", "code-review", "git-workflow"]);
  });
});

describe("buildSkillSystemPrompt + SkillTool + Agent 集成", () => {
  it("system prompt 含目录与引导语，不含全文", async () => {
    const root = await makeSkillsDir();
    const loader = await new SkillLoader(root).scan();
    const prompt = buildSkillSystemPrompt("You are a coding agent.", loader);

    expect(prompt).toContain("You are a coding agent.");
    expect(prompt).toContain("Skills available:");
    expect(prompt).toContain("- my-skill:");
    expect(prompt).toContain("Use load_skill to read the full instructions");
    expect(prompt).not.toContain("Full body here.");
  });

  it("SkillTool：命中返回全文，未命中返回错误文案", async () => {
    const root = await makeSkillsDir();
    const loader = await new SkillLoader(root).scan();
    const tool = new SkillTool(loader);

    expect(await tool.executeArgs({ name: "my-skill" })).toContain("Full body here.");
    expect(await tool.executeArgs({ name: "ghost" })).toContain("Unknown skill");
    expect(await tool.executeArgs({})).toContain("需要非空 name");
    // 裸字符串（文本协议入口）= 技能名
    expect(await tool.execute("my-skill")).toContain("Full body here.");
  });

  it("Agent 集成：模型经 load_skill 拿到全文 tool_result", async () => {
    const root = await makeSkillsDir();
    const loader = await new SkillLoader(root).scan();
    const registry = new ToolRegistry().register(new SkillTool(loader));

    const toolCall: ToolCallRequest = {
      id: "c1",
      type: "function",
      function: { name: "load_skill", arguments: '{"name":"my-skill"}' },
    };
    const llm = new ScriptedLLM([], [
      { content: null, toolCalls: [toolCall] },
      { content: "已加载技能", toolCalls: [] },
    ]);
    const agent = new FunctionCallAgent("a", llm, registry, {
      systemPrompt: buildSkillSystemPrompt("You are a coding agent.", loader),
    });
    const answer = await agent.run("What skills are available?");

    expect(answer).toBe("已加载技能");
    // system prompt 里只有目录
    const system = llm.toolCallsList[0]?.messages[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("- my-skill:");
    expect(system?.content).not.toContain("Full body here.");
    // 全文经 tool_result 回喂
    const toolMessage = llm.toolCallsList[1]?.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("Full body here.");
  });
});
