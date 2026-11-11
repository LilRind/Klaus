# Klaus

Klaus 是一个从零构建的 TypeScript 智能体框架：五种 Agent 范式、工具系统、
权限管线、钩子、持久记忆与 RAG、上下文工程、后台任务与调度、团队协作、
MCP 动态工具池，直到集成宿主 / Workflow 运行时 / Goal Loop 的完整 Agentic 主线。

用 vitest + 可注入的 LLM 桩实现全离线测试（500+ 个用例，跑测试不需要 API Key）；
LLM 依赖路径另有零 mock 真实模型验证脚本（`npm run verify:9-real`）。

## 特性总览

### 框架核心

| 模块 | 说明 |
|---|---|
| `src/core/llm.ts` | `ChatLLM` 接口 + `OpenAICompatLLM` 默认实现，多提供商 `detectProvider()` 自动检测 |
| `examples/7/streaming.ts` | LLM 裸流式 + Agent 级 `streamRun`，逐字输出 |
| `src/core/message.ts` | 角色联合类型的编译期约束，运行期再兜底校验 |
| `src/core/config.ts` | 循环上限 / 超时 / 温度集中管理 |
| `src/core/agent.ts` | 身份 + llm 依赖 + 跨轮 history，`run()` 留给子类 |
| `src/agents/simple-agent.ts` | `[TOOL_CALL:name:params]` 文本协议 + 多轮工具循环 + 超限强制收尾 |
| `src/agents/react-agent.ts` | `Thought/Action: tool[input]` 协议，Observation 回填 `{history}` 区块 |
| `src/agents/reflection-agent.ts` | Memory 轨迹模块 + 生成→反思→修改循环，双语停止条件，`customPrompts` 部分覆盖 |
| `src/agents/plan-solve-agent.ts` | Planner/Executor 分离组合；计划解析失败优雅终止 |
| `src/agents/function-call-agent.ts` | OpenAI 原生函数调用：`invokeWithTools` + JSON Schema 构建 + toolCallId 回指 |
| `src/tools/*` | Tool 基类 / ToolRegistry / 手写递归下降计算器（白名单语法安全求值） |
| `src/tools/builtin/search.ts` | Tavily/SerpApi 双源降级，fetch 与 env 可注入（测试零网络） |
| `src/tools/chain.ts` `src/tools/async-executor.ts` | 输出键传递数据的 ToolChain + 有界并行 AsyncToolExecutor |

### 认知记忆与 RAG

| 模块 | 说明 |
|---|---|
| `src/memory/base.ts` | MemoryItem / MemoryConfig / BaseMemory 四层架构地基 |
| `RAGTool save_to_memory` | 检索结果按 chunk 去重后存为语义记忆（元数据带检索出处） |
| `examples/8/memory-basic.ts` | MemoryTool 九个 action 全链路（add/search/summary/stats/update/remove/forget/consolidate/clear_all） |
| `src/tools/builtin/memory-tool.ts` | JSON 统一入口 + 会话 ID 自动管理 + 感知模态推断；`auto_classify` LLM 四分类，未配置降级规则分类器 |
| `src/memory/manager.ts` | 四类型统一调度、三种遗忘策略、记忆固化（working→episodic→semantic） |
| `src/memory/types/working.ts` | 纯内存 + TTL + 容量淘汰 + TF-IDF/关键词混合检索 |
| `src/memory/types/episodic.ts` | SQLite 文档库 + 向量库混合，评分 `(向量×0.8+近因×0.2)×重要性权重` |
| `src/memory/types/semantic.ts` | 向量 + 图谱混合 `(向量×0.7+图×0.3)×重要性权重`；规则实体抽取器可换 LLM 抽取 |
| `src/memory/types/perceptual.ts` | 多模态元数据 + 模态过滤；描述文本统一嵌入 |
| `src/memory/rag/pipeline.ts` `document.ts` | Markdown 结构感知分块（标题层级/Token 预算/重叠）+ 摄取 + 检索 + LLM 问答 |
| `RAGPipeline.search` | MQE 多查询扩展 + HyDE 假设文档，"扩展-检索-合并"三步 + memory_id 去重 |
| `examples/8/memory-rag-agent.ts` | SimpleAgent + ToolRegistry 注册 MemoryTool/RAGTool，Agent 自主调用 |
| `src/memory/storage/qdrant-store.ts` `neo4j-store.ts` | Qdrant 与 Neo4j 真实后端，与内存版同接口 |
| `loadDocument` + pdf-parse/mammoth | PDF/DOCX/MD/TXT/JSON/CSV/HTML 多格式摄取 |
| `LLMEntityExtractor` | opt-in LLM 实体抽取 + 运行时开关；规则抽取器为默认 |

### 上下文工程

| 模块 | 说明 |
|---|---|
| `src/context/builder.ts` `types.ts` | GSSC 四阶段（Gather→Select→Structure→Compress）；相关性×时近性×优先级加权、token 预算贪心、截断式压缩 |
| `src/context/types.ts` | ContextPacket / ContextConfig（maxTokens=4000、reserveRatio=0.15、minRelevance=0.2）+ 记忆/RAG 源类型安全契约 |
| `src/tools/builtin/note-tool.ts` | 七 action 笔记工具；Markdown+YAML frontmatter 手写解析；中文 CJK 单字展开搜索 |
| `src/tools/builtin/terminal-tool.ts` | 17 条白名单命令全部 Node fs 内置实现（Windows 无需 bash）；路径逃逸拦截 + 10MB 截断 + 30s 超时 |
| `examples/9/codebase-maintainer.ts` | 仓库版 Agentic 主线：FunctionCallAgent + 工具自选（terminal/note/memory） |
| `examples/9/06-three-day-workflow.ts` | 探索→分析→规划→复盘，跨会话笔记连贯性 |
| `examples/9/verify-real-llm.ts` | 零 mock 硬断言：上下文注入生效、笔记被引用、Agentic 工具循环真实落盘 |

### Agent 化增强

| 模块 | 说明 |
|---|---|
| `src/security/` | 三道闸门权限管线（读取→评估→执行，含子 agent 输出细分前缀） |
| `src/hooks/` | UserPromptSubmit / PreToolUse / PostToolUse / Stop 四挂点注册表 |
| `src/todo/` | TodoManager 计划状态 + 提醒注入 |
| `src/skills/` | SkillLoader 技能目录扫描与按需加载 |
| `src/context/`（Compactor） | 四步上下文压缩 + reactive 补救，逐阶段可观测（见设计决策 7） |
| `src/persistent-memory/` | 文件式持久记忆：store / recall / extract / consolidate |
| `src/tasks/` | 持久任务图 + Git worktree 隔离执行 |
| `src/background/` | 后台任务管理器（完成自动唤醒主循环） |
| `src/scheduler/` | cron 五段解析 + durable 调度（失败恢复后未 ack 任务回滚） |
| `src/teams/` | 任务板 / teammate / 团队协作协议 |
| `src/mcp/` | MCP 连接管理 + 动态工具池 |
| `src/harness/` | 集成宿主：轮次串行化 + 轮级 cron 注入 + 异步轮权限 + LLM 错误恢复重试 |
| `src/workflow/` | Workflow 运行时：journal 断点续跑 + 稳定语义键 + pipeline/parallel + 预算上限 |
| `src/goal/` | Goal Loop：会话级目标 + 无工具独立完成度判断器 + block/defer/limit 状态机 |

## 目录结构

```
klaus/
├── src/
│   ├── core/                    # 核心框架层（agent/llm/message/config/memory/exceptions/trace-log 含 compaction 事件）
│   ├── agents/                  # 五种 Agent 范式（Simple/ReAct/Reflection/PlanSolve/FunctionCall）
│   ├── tools/                   # 工具系统（registry + builtin：calculator/search/file/bash/todo/task/skill/compact/cron/team…）
│   ├── security/                # 三道闸门权限管线
│   ├── hooks/                   # 四挂点 Hook 注册表
│   ├── todo/                    # TodoManager 计划状态
│   ├── skills/                  # SkillLoader 技能目录扫描
│   ├── context/                 # GSSC 上下文构建 + ContextCompactor 四步压缩（逐阶段可观测）
│   ├── persistent-memory/       # 文件式持久记忆：store/recall/extract/consolidate
│   ├── tasks/                   # 持久任务图 + worktree
│   ├── background/              # 后台任务管理器
│   ├── scheduler/               # cron 五段解析 + durable 调度
│   ├── teams/                   # 任务板 / teammate / 团队协议
│   ├── mcp/                     # MCP 连接管理 + 动态工具池
│   ├── harness/                 # 集成宿主：轮次串行化 + 自动唤醒 + LLM 错误恢复
│   ├── workflow/                # Workflow 运行时：journal 断点续跑 + pipeline/parallel
│   ├── goal/                    # Goal Loop：会话级目标 + 独立完成度判断器
│   └── memory/                  # 认知记忆 + RAG（types/storage/rag）
├── skills/                      # 技能目录（code-review / git-workflow / api-design）
├── tests/                       # vitest 全离线（ScriptedLLM 桩，500+ 用例）
├── examples/                    # 7|8|9 分主题示例；alignment/ 分阶段验证 REPL + 批量
└── vitest.config.ts
```

## 快速开始

```bash
npm install

# 全部单元测试（无需 API Key）
npm test
npm run typecheck

# 真实 LLM 示例（需先配置 .env）
cp .env.example .env   # 填入 LLM_MODEL_ID / LLM_API_KEY / LLM_BASE_URL
npm run example:basic        # 最小 LLM 调用
npm run example:simple       # SimpleAgent + 计算器
npm run example:react        # ReAct 循环（Thought/Action/Observation）
npm run check:config         # 只验证 .env 检测，不调 API
npm run example:memory-basic # MemoryTool 九操作（离线可跑）
npm run example:memory-types # 四种记忆类型深度演示（离线可跑）
npm run example:rag          # RAG 管道（检索离线可跑，问答需 LLM）
npm run example:memory-rag-agent # Agent 集成记忆+RAG（需 LLM）
npm run example:memory-live  # Qdrant/Neo4j/SQLite 真实三库联机验证
npm run example:qa-repl      # REPL 问答助手（需 LLM）
npm run example:qa-web       # Web 问答助手 → http://localhost:3000
```

记忆/RAG 存储走**默认装配工厂**（`storage/factories.ts`）：`.env` 配了
`QDRANT_URL` / `NEO4J_URI` 就自动连真实数据库，什么都没配就退化成进程内实现
（零配置离线跑通，重启即失）。本地 Docker 起法：

```bash
# Qdrant（向量库，数据挂载到本机目录持久化）
docker run -d --name klaus-qdrant -p 6333:6333 -v klaus-qdrant-data:/qdrant/storage qdrant/qdrant

# Neo4j（图数据库，同样挂 volume）
docker run -d --name klaus-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/klaus-password \
  -v klaus-neo4j-data:/data neo4j
```

然后在 `.env` 打开 `QDRANT_URL=http://localhost:6333` 与
`NEO4J_URI=bolt://localhost:7687` / `NEO4J_PASSWORD=klaus-password`。
注意向量维度必须与嵌入模型一致（`QDRANT_VECTOR_SIZE`，
TFIDF=512 / MiniLM=384 / dashscope v3=1024）。

### 最小示例

```ts
import { OpenAICompatLLM, SimpleAgent, ToolRegistry, CalculatorTool } from "./src";

const llm = new OpenAICompatLLM();            // 按 .env 自动检测 provider
const tools = new ToolRegistry().register(new CalculatorTool());
const agent = new SimpleAgent("计算助手", llm, "你是计算助手", undefined, tools);

const answer = await agent.run("请帮我计算 (12+8)*3");
```

## 关键设计决策

1. **Agent 只依赖 `ChatLLM` 接口，不依赖具体实现**——测试注入 `ScriptedLLM`
   即可离线验证全部循环逻辑（工具协议解析、超限收尾、Observation 回填），
   可测试性是第一优先级。
2. **工具契约保持"字符串进、字符串出"**——LLM 只需按
   `[TOOL_CALL:name:params]` / `tool[input]` 格式输出，
   框架层不做 Function Calling 的强类型绑定；需要原生函数调用时走 FunctionCallAgent。
3. **计算器用手写递归下降解析器**——语法层面只接受数字/四则/括号/sqrt/pi，
   代码注入在解析阶段即被拒绝（有对应测试），不依赖语言自带 eval。
4. **Provider 自动检测优先级**：baseUrl 关键字 > 模型名前缀 > provider 专属
   环境变量 > 默认 openai；统一变量 `LLM_MODEL_ID/LLM_API_KEY/LLM_BASE_URL` 全兼容。
5. **Reflection/PlanAndSolve 保留记忆轨迹内核**：Memory 记录执行/反思交替轨迹
   （`getLastExecution`/`getTrajectory`），PlanAndSolve 由独立 Planner + Executor 组合而成，
   计划解析失败优雅终止。
6. **思考型模型适配**：glm-5.3 等思考型模型写长文时会生成大量隐藏推理，
   非流式调用容易超时；`OpenAICompatLLM.extraBody` 可透传
   `thinking: {type:"disabled"}` 等厂商参数，`.env` 的 `LLM_TIMEOUT` 控制超时。
7. **上下文压缩逐阶段可观测**：`ContextCompactor` 每执行一步（toolResultBudget /
   activeRequestRestore / snipCompact / microCompact / fitToolResults /
   compactHistory / reactiveCompact）都通过 `CompactionObserver` 上报
   `CompactionOperation` 事件——压缩前后的消息数与字符估算、耗时、以及本次新增的
   落盘产物（transcript / full output 文件）。观察者由 FunctionCallAgent 接到
   `TraceLog`，md 转录里渲染为 `🗜 compaction · <阶段>` 段落，事后可直接从转录判断
   每步压缩的触发强度与效果。字符数是 JSON 估算口径（与服务端 token 数不同），
   因此 reactive 补救仍然不可省略——观测是取证，不是保险。
8. **Agentic 增强能力不污染五种基础范式**：对齐增强全部落在 FunctionCallAgent
   主线，其余范式保持最小实现；验证入口 `npm run example:alignment`
   （交互式逐条验证 `npm run example:alignment:repl -- --stage s07` 累积装配，
   REPL 支持 `/goal <条件>` / `/goal` 查状态 / `/goal clear`）。

## 状态

- [x] core 层（message / config / exceptions / llm / agent 基类）
- [x] tools 层（Tool / ToolRegistry / 计算器 / 多源搜索 / 工具链 / 异步执行器）
- [x] 五种 Agent 范式（Simple / ReAct / Reflection / PlanAndSolve / FunctionCall）
- [x] 结构化工具分发 / 三道闸门权限 / 会话级全轨迹
- [x] hooks 四挂点 / todo_write + reminder / task 子 agent
- [x] skill 按需加载 / 四步上下文压缩 / 文件式持久记忆
- [x] 持久任务图 / 后台任务 / cron 调度 / 任务板与 teammate / MCP 动态工具池
- [x] 集成宿主：轮级 cron 注入 / 异步轮权限 / 自动唤醒 / LLM 错误恢复
- [x] Workflow 运行时 journal 续跑 / Goal Loop 独立判断器
- [x] 认知记忆四类型 + RAG 管道 + Qdrant/Neo4j/SQLite 真实后端
- [x] GSSC 上下文工程 + 笔记/终端工具 + 代码库维护助手
