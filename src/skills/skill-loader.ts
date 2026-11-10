/**
 * SkillLoader（对齐 learn-claude-code s07）
 *
 * "用到时再加载"：技能名称和描述进 system prompt（启动时扫描目录），
 * 完整 SKILL.md 只在模型调用 load_skill 时作为 tool_result 返回——
 * 上下文里常驻的是目录，不是全文。
 *
 * 每个技能 = 一个目录 + SKILL.md（YAML frontmatter 的 name/description；
 * name 缺省回退目录名，description 缺省回退正文第一行）。
 * name 只用于查注册表，不会被当作文件路径——与 l07 一致的安全语义。
 */

import { promises as fs, type Dirent } from "node:fs";
import path from "node:path";

export interface SkillRecord {
  name: string;
  description: string;
  /** SKILL.md 全文（load_skill 时返回） */
  content: string;
}

export interface Frontmatter {
  metadata: Record<string, string>;
  body: string;
}

/**
 * 解析 YAML frontmatter 子集（--- 包裹的 `key: value` 单行标量）。
 * 教学实现：不引 YAML 依赖，多行/嵌套值不解析（lcc 的 parse_frontmatter 同样只取简单值）。
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { metadata: {}, body: text };
  }
  const metadata: Record<string, string> = {};
  let index = 1;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.trim() === "---") {
      index += 1;
      break;
    }
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      metadata[match[1]] = unquote(match[2].trim());
    }
  }
  return { metadata, body: lines.slice(index).join("\n") };
}

export class SkillLoader {
  readonly skillsDir: string;
  private readonly skills = new Map<string, SkillRecord>();

  constructor(skillsDir: string) {
    this.skillsDir = path.resolve(skillsDir);
  }

  /** 扫描各子目录下的 SKILL.md（只认直接子目录，resolve 防越区/符号链接逃逸） */
  async scan(): Promise<this> {
    this.skills.clear();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.skillsDir, { withFileTypes: true });
    } catch {
    return this; // 目录不存在 → 空目录（对齐 lcc：无技能可用）
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const manifest = path.join(this.skillsDir, entry.name, "SKILL.md");
      if (!isInside(this.skillsDir, manifest)) continue;
      let content: string;
      try {
        content = await fs.readFile(manifest, "utf8");
      } catch {
        continue; // 子目录无 SKILL.md → 不是技能，跳过
      }
      const { metadata, body } = parseFrontmatter(content);
      const name = (metadata.name ?? "").trim() || entry.name;
      let description = (metadata.description ?? "").trim();
      if (!description) {
        description = body.split("\n", 1)[0] ?? "";
      }
      description = description.replace(/^#+\s*/, "").trim();
      this.skills.set(name, { name, description, content });
    }
    return this;
  }

  /** 目录（进 system prompt）：每行 `- name: description`，只含名称与描述 */
  catalog(): string {
    if (this.skills.size === 0) return "(no skills available)";
    return [...this.skills.values()]
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join("\n");
  }

  /** 加载完整 SKILL.md；name 只查注册表，绝不当路径用（对齐 s07 load） */
  load(name: string): string {
    const skill = this.skills.get(name.trim());
    if (skill) return skill.content;
    const available = [...this.skills.keys()].join(", ") || "none";
    return `Error: Unknown skill '${name}'. Available: ${available}`;
  }

  listNames(): string[] {
    return [...this.skills.keys()];
  }

  get size(): number {
    return this.skills.size;
  }
}

/** 组装 system prompt：固定指令 + 技能目录（全文走 load_skill 工具） */
export function buildSkillSystemPrompt(
  basePrompt: string,
  loader: SkillLoader,
): string {
  return (
    `${basePrompt}\n\nSkills available:\n${loader.catalog()}\n\n` +
    "Use load_skill to read the full instructions when a skill applies."
  );
}

// ---------- 内部辅助 ----------

function isInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
