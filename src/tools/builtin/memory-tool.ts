/**
 * 记忆工具（对应书 8.2.3 tools/builtin/memory_tool.py）
 *
 * "统一入口，分发处理"：execute 收 JSON 字符串，按 action 分发给 MemoryManager。
 * 遵循第七章确立的设计原则——记忆能力是标准 Tool（字符串进、字符串出），
 * 不新造 Agent 类；Agent（SimpleAgent/FunctionCallAgent）注册即用。
 * 会话 ID 在这里自动管理：add 时补 session_id + timestamp 元数据。
 */

import { Tool } from "../tool";
import { MemoryManager, type MemoryManagerOptions } from "../../memory/manager";
import {
  isMemoryType,
  type MemorySearchResult,
  type MemoryType,
} from "../../memory/base";
import { inferModality } from "../../memory/types/perceptual";
import type { ChatLLM } from "../../core/llm";

export interface MemoryToolOptions extends MemoryManagerOptions {
  /** 启用的记忆类型（默认 working/episodic/semantic，对应书 8.2.4） */
  memoryTypes?: MemoryType[];
  /** auto_classify 用的 LLM；不配置时降级为规则分类器并提醒 */
  llm?: ChatLLM;
}

interface MemoryActionPayload {
  action?: string;
  content?: string;
  memory_type?: string;
  importance?: number;
  metadata?: Record<string, unknown>;
  auto_classify?: boolean;
  file_path?: string;
  modality?: string;
  [key: string]: unknown;
}

export class MemoryTool extends Tool {
  readonly name = "memory";
  readonly description =
    "记忆工具 - 存储和检索对话历史、知识和经验（支持 add/search/summary/stats/update/remove/forget/consolidate/clear_all）";
  readonly parametersDescription =
    'JSON 对象: {"action": "add|search|summary|stats|update|remove|forget|consolidate|clear_all", ...参数}';

  override get parametersSchema(): Record<string, unknown> | undefined {
    return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "add",
          "search",
          "summary",
          "stats",
          "update",
          "remove",
          "forget",
          "consolidate",
          "clear_all",
        ],
        description: "要执行的记忆操作",
      },
      content: { type: "string", description: "add: 记忆内容" },
      query: { type: "string", description: "search: 检索查询" },
      memory_type: {
        type: "string",
        enum: ["working", "episodic", "semantic", "perceptual"],
      },
      importance: { type: "number", description: "add/update: 重要性 0-1" },
      limit: { type: "number", description: "search: 返回条数" },
    },
      required: ["action"],
    };
  }

  readonly memoryManager: MemoryManager;
  readonly memoryTypes: MemoryType[];

  private readonly llm?: ChatLLM;
  private classifyWarned = false;

  private currentSessionId?: string;

  constructor(options: MemoryToolOptions = {}) {
    super();
    this.llm = options.llm;
    const requested = options.memoryTypes ?? [
      "working",
      "episodic",
      "semantic",
    ] as MemoryType[];
    this.memoryTypes = requested;
    this.memoryManager = new MemoryManager({
      ...options,
      enableWorking: requested.includes("working"),
      enableEpisodic: requested.includes("episodic"),
      enableSemantic: requested.includes("semantic"),
      enablePerceptual: requested.includes("perceptual"),
    });
  }

  get session(): string | undefined {
    return this.currentSessionId;
  }

  async execute(input: string): Promise<string> {
    let payload: MemoryActionPayload;
    try {
      payload = JSON.parse(input) as MemoryActionPayload;
    } catch {
      return "❌ 参数必须是合法 JSON 对象，例如 {\"action\": \"add\", \"content\": \"...\"}";
    }

    try {
      switch (payload.action) {
        case "add":
          return await this.addMemory(payload);
        case "search":
          return await this.searchMemory(payload);
        case "summary":
          return await this.memoryManager.getSummary();
        case "stats":
          return await this.stats();
        case "update":
          return await this.updateMemory(payload);
        case "remove":
          return await this.removeMemory(payload);
        case "forget":
          return await this.forget(payload);
        case "consolidate":
          return await this.consolidate(payload);
        case "clear_all":
          await this.memoryManager.clearAll();
          return "🗑️ 已清空全部记忆";
        default:
          return `❌ 未知操作: ${String(payload.action)}，支持 add/search/summary/stats/update/remove/forget/consolidate/clear_all`;
      }
    } catch (error) {
      return `❌ 记忆操作失败: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async addMemory(payload: MemoryActionPayload): Promise<string> {
    const content = payload.content;
    if (!content || content.trim().length === 0) {
      return "❌ add 需要 content 参数";
    }
    // 记忆类型自动分类（书 8.2.3 auto_classify）：LLM 判断 > 规则分类器兜底
    let memoryTypeValue = payload.memory_type;
    if (payload.auto_classify) {
      memoryTypeValue = await this.classifyMemoryType(content);
    }
    if (memoryTypeValue && !isMemoryType(String(memoryTypeValue))) {
      return `❌ 未知记忆类型: ${String(memoryTypeValue)}`;
    }
    const memoryType = (memoryTypeValue as MemoryType | undefined) ?? "working";

    if (!this.currentSessionId) {
      this.currentSessionId = `session_${formatStamp(new Date())}`;
    }

    const metadata: Record<string, unknown> = { ...(payload.metadata ?? {}) };
    // 感知记忆：自动推断模态并记录原始文件路径（对应书 _add_memory）
    if (memoryType === "perceptual" && payload.file_path) {
      metadata.modality ??= payload.modality ?? inferModality(payload.file_path);
      metadata.raw_data ??= payload.file_path;
    }
    metadata.session_id = this.currentSessionId;
    metadata.timestamp = new Date().toISOString();

    for (const [key, value] of Object.entries(payload)) {
      if (
        !["action", "content", "memory_type", "importance", "metadata", "file_path", "modality", "auto_classify"].includes(key)
      ) {
        metadata[key] = value;
      }
    }

    const memoryId = await this.memoryManager.addMemory({
      content,
      memoryType,
      importance: payload.importance,
      metadata,
    });
    return `✅ 记忆已添加 (ID: ${memoryId.slice(0, 8)}..., 类型: ${memoryType})`;
  }

  /**
   * 自动分类（书 8.2.3 auto_classify 参数）：
   * LLM 优先（注入 llm 时），失败或未配置降级为规则分类器并提醒一次。
   */
  private async classifyMemoryType(content: string): Promise<MemoryType> {
    if (this.llm) {
      try {
        const response = await this.llm.invoke([
          {
            role: "system",
            content:
              "把用户内容分类到四种记忆类型之一，只输出类别词，不要解释。" +
              "working=当前任务的临时上下文；episodic=具体事件与经历（含时间/完成/经过）；" +
              "semantic=抽象知识、概念、事实与定义；perceptual=图像/音频/视频等多模态感知数据。",
          },
          { role: "user", content },
        ]);
        const match = response.match(/working|episodic|semantic|perceptual/);
        if (match) return match[0] as MemoryType;
        console.warn(
          `⚠️ [auto_classify] LLM 返回无法解析（${response.slice(0, 40)}…），使用规则分类器`,
        );
      } catch (error) {
        console.warn(
          `⚠️ [auto_classify] LLM 调用失败（${error instanceof Error ? error.message : String(error)}），使用规则分类器`,
        );
      }
    } else if (!this.classifyWarned) {
      this.classifyWarned = true;
      console.warn(
        "⚠️ [auto_classify 降级] 未配置 LLM，使用规则分类器兜底（准确率有限）。" +
          "给 MemoryTool 传入 llm 可启用 LLM 自动分类。",
      );
    }
    return classifyMemoryTypeByRules(content);
  }

  private async searchMemory(payload: MemoryActionPayload): Promise<string> {
    const query = payload.query;
    if (typeof query !== "string" || query.trim().length === 0) {
      return "❌ search 需要 query 参数";
    }
    const limit = numberField(payload.limit) ?? 5;
    const minImportance = numberField(payload.min_importance) ?? 0.1;

    // 单类型 → 类型数组（对应书里参数标准化）
    let memoryTypes: MemoryType[] | undefined;
    if (isMemoryType(String(payload.memory_type ?? ""))) {
      memoryTypes = [payload.memory_type as MemoryType];
    } else if (Array.isArray(payload.memory_types)) {
      memoryTypes = (payload.memory_types as string[]).filter(isMemoryType);
    }

    const results = await this.memoryManager.searchMemories({
      query,
      limit,
      memoryTypes,
      minImportance,
    });
    if (results.length === 0) return "🔍 未找到相关记忆";

    // 诚实提醒：云端嵌入对同语言文本有非零基线相似度，
    // 全部低分时明确提示"可能不相关"，避免用户误以为命中了相关记忆
    const topScore = results[0]?.score ?? 0;
    const lowRelevanceHint =
      topScore < 0.3 ? `⚠️ 最高相关度仅 ${topScore.toFixed(3)}，以下结果可能不相关：\n` : "";

    return (
      lowRelevanceHint +
        `🔍 找到 ${results.length} 条相关记忆：\n` +
      results.map((result, index) => renderResult(index + 1, result)).join("\n")
    );
  }

  private async stats(): Promise<string> {
    const stats = await this.memoryManager.getStats();
    const lines = [
      `📊 记忆统计（用户: ${stats.userId}）`,
      `总计: ${stats.total} 条`,
    ];
    for (const type of this.memoryManager.enabledTypes) {
      lines.push(`  ${type}: ${stats.byType[type]} 条`);
    }
    return lines.join("\n");
  }

  private async updateMemory(payload: MemoryActionPayload): Promise<string> {
    const id = stringField(payload.memory_id) ?? stringField(payload.id);
    if (!id) return "❌ update 需要 memory_id 参数";
    const updates: Record<string, unknown> = {};
    if (payload.content !== undefined) updates.content = payload.content;
    const importance = numberField(payload.importance);
    if (importance !== undefined) updates.importance = importance;
    if (payload.metadata !== undefined) updates.metadata = payload.metadata;
    if (Object.keys(updates).length === 0) {
      return "❌ update 至少提供 content/importance/metadata 之一";
    }
    const ok = await this.memoryManager.updateMemory(id, updates);
    return ok ? `✅ 记忆已更新 (ID: ${id.slice(0, 8)}...)` : `❌ 记忆不存在: ${id}`;
  }

  private async removeMemory(payload: MemoryActionPayload): Promise<string> {
    const id = stringField(payload.memory_id) ?? stringField(payload.id);
    if (!id) return "❌ remove 需要 memory_id 参数";
    const ok = await this.memoryManager.removeMemory(id);
    return ok ? `✅ 记忆已删除 (ID: ${id.slice(0, 8)}...)` : `❌ 记忆不存在: ${id}`;
  }

  private async forget(payload: MemoryActionPayload): Promise<string> {
    const strategy = String(payload.strategy ?? "importance_based");
    if (!["importance_based", "time_based", "capacity_based"].includes(strategy)) {
      return `❌ 未知遗忘策略: ${strategy}`;
    }
    const count = await this.memoryManager.forgetMemories({
      strategy: strategy as "importance_based" | "time_based" | "capacity_based",
      threshold: numberField(payload.threshold),
      maxAgeDays: numberField(payload.max_age_days),
      maxCount: numberField(payload.max_count),
    });
    return `🧹 已遗忘 ${count} 条记忆（策略: ${strategy}）`;
  }

  private async consolidate(payload: MemoryActionPayload): Promise<string> {
    const count = await this.memoryManager.consolidateMemories({
      fromType: stringField(payload.from_type) ?? "working",
      toType: stringField(payload.to_type) ?? "episodic",
      importanceThreshold: numberField(payload.importance_threshold) ?? 0.7,
    });
    const from = stringField(payload.from_type) ?? "working";
    const to = stringField(payload.to_type) ?? "episodic";
    const threshold = numberField(payload.importance_threshold) ?? 0.7;
    return `🔄 已整合 ${count} 条记忆为长期记忆（${from} → ${to}，阈值=${threshold}）`;
  }
}

function renderResult(index: number, result: MemorySearchResult): string {
  const { item, memoryType, score } = result;
  return `${index}. [${memoryType}] (得分 ${score.toFixed(3)}, 重要性 ${item.importance.toFixed(1)}) ${item.content}`;
}

/** 规则分类器（auto_classify 的兜底）：模态线索 > 事件线索 > 知识线索 > 默认 working */
export function classifyMemoryTypeByRules(content: string): MemoryType {
  if (
    /\.(png|jpe?g|gif|webp|bmp|mp3|wav|m4a|flac|ogg|mp4|mov|avi|mkv)\b|截图|图片|照片|音频|录音|视频/i.test(
      content,
    )
  ) {
    return "perceptual";
  }
  if (
    /昨天|今天|刚刚|刚才|完成了|经历了|里程碑|庆祝|纪念|\d{4}\s*年|\d{1,2}\s*月\s*\d{1,2}/.test(
      content,
    )
  ) {
    return "episodic";
  }
  if (/是一种|是指|定义为|所谓的|概念|原理|定理|规律|属于|指的是/.test(content)) {
    return "semantic";
  }
  return "working";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}
