# HelloAgents-TS

《Hello Agents》第 7 章「构建你的智能体框架」、第 8 章「记忆与检索」与第 9 章「上下文工程」的 TypeScript 从零实现。
练习原书：[datawhalechina/Hello-Agents](https://github.com/datawhalechina/Hello-Agents)（框架原版参考：[jjyaoao/helloagents](https://github.com/jjyaoao/helloagents)）。
不依赖书里的 `hello-agents` Python 包，所有核心层代码按章节架构重写，
用 vitest + 可注入的 LLM 桩实现全离线测试（189 个用例，跑测试不需要 API Key）；
LLM 依赖路径另有零 mock 真实模型验证脚本（`pnpm verify:9-real`）。

## 与书第 7 章的对应关系

| 书章节 | 本项目文件 | 说明 |
|---|---|---|
| 7.2 HelloAgentsLLM / 多提供商 / 自动检测 | `src/core/llm.ts` | `ChatLLM` 接口 + `OpenAICompatLLM` 默认实现，`detectProvider()` 复刻 7.2.3 检测优先级 |
| 7.2 my_main.py 流式验证 | `examples/7/streaming.ts` | LLM 裸流式 + Agent 级 `streamRun`，对标书的 `think` 流式输出 |
| 7.3.1 Message | `src/core/message.ts` | 角色联合类型 = Python `Literal` 的编译期等价物，运行期再兜底校验 |
| 7.3.2 Config | `src/core/config.ts` | 循环上限 / 超时 / 温度集中管理 |
| 7.3.3 Agent ABC | `src/core/agent.ts` | 身份 + llm 依赖 + 跨轮 history，`run()` 留给子类 |
| 7.4.1 SimpleAgent | `src/agents/simple-agent.ts` | `[TOOL_CALL:name:params]` 文本协议 + 多轮工具循环 + 超限强制收尾 |
| 7.4.2 ReActAgent | `src/agents/react-agent.ts` | `Thought/Action: tool[input]` 协议，Observation 回填 `{history}` 区块 |
| 7.4.3 ReflectionAgent | `src/agents/reflection-agent.ts` | 第四章 Memory 轨迹模块 + 生成→反思→修改循环，双语停止条件，`customPrompts` 部分覆盖 |
| 7.4.4 PlanAndSolveAgent | `src/agents/plan-solve-agent.ts` | 第四章 Planner/Executor 分离组合；计划解析失败优雅终止 |
| 7.4.5 FunctionCallAgent | `src/agents/function-call-agent.ts` | OpenAI 原生函数调用：`invokeWithTools` + JSON Schema 构建 + toolCallId 回指 |
| 7.5 工具系统 | `src/tools/*` | Tool 基类 / ToolRegistry / 递归下降计算器（对标书的 `ast.parse` 安全求值） |
| 7.5.3 多源搜索 | `src/tools/builtin/search.ts` | Tavily/SerpApi 双源降级，fetch 与 env 可注入（测试零网络） |
| 7.5.4 工具链/异步执行 | `src/tools/chain.ts` `src/tools/async-executor.ts` | 输出键传递数据的 ToolChain + 有界并行 AsyncToolExecutor |

## 与书第 8 章的对应关系

| 书章节 | 本项目文件 | 说明 |
|---|---|---|
| 8.1.3/8.1.4 记忆与 RAG 架构 | `src/memory/base.ts` | MemoryItem / MemoryConfig / BaseMemory 四层架构的地基 |
| 8.1.3 RAG→记忆联动 | `RAGTool save_to_memory` | 检索结果按 chunk 去重后存为语义记忆（元数据带检索出处） |
| 8.2.2 快速体验 | `examples/8/memory-basic.ts` | MemoryTool 九个 action 全链路（add/search/summary/stats/update/remove/forget/consolidate/clear_all） |
| 8.2.3 MemoryTool | `src/tools/builtin/memory-tool.ts` | JSON 统一入口 + 会话 ID 自动管理 + 感知模态推断 |
| 8.2.3 auto_classify | 同上 `auto_classify: true` | LLM 四分类，未配置时降级规则分类器并提醒 |
| 8.2.4 MemoryManager | `src/memory/manager.ts` | 四类型统一调度、三种遗忘策略、记忆固化（working→episodic→semantic） |
| 8.2.5 工作记忆 | `src/memory/types/working.ts` | 纯内存 + TTL + 容量淘汰 + TF-IDF/关键词混合检索 |
| 8.2.5 情景记忆 | `src/memory/types/episodic.ts` | SQLite 文档库 + 向量库混合，评分 `(向量×0.8+近因×0.2)×重要性权重` |
| 8.2.5 语义记忆 | `src/memory/types/semantic.ts` | 向量 + 图谱混合 `(向量×0.7+图×0.3)×重要性权重`；实体抽取用规则器替代 spaCy（接口可换 LLM 抽取） |
| 8.2.5 感知记忆 | `src/memory/types/perceptual.ts` | 多模态元数据 + 模态过滤；CLIP/CLAP 的 TS 等价物是描述文本统一嵌入（差异已注释） |
| 8.3.4 RAG 管道 | `src/memory/rag/pipeline.ts` `src/memory/rag/document.ts` | Markdown 结构感知分块（标题层级/Token 预算/重叠）+ 摄取 + 检索 + LLM 问答；MarkItDown 的 TS 替代支持 md/txt/json/csv/html |
| 8.3.5 高级检索 | 同上 `RAGPipeline.search` | MQE 多查询扩展 + HyDE 假设文档，"扩展-检索-合并"三步 + memory_id 去重 |
| 8.4 智能问答助手 | `examples/8/memory-rag-agent.ts` `examples/8/rag-pipeline.ts` | SimpleAgent + ToolRegistry 注册 MemoryTool/RAGTool，Agent 自主调用两个工具 |
| 8.1.4 存储后端层 | `src/memory/storage/qdrant-store.ts` `neo4j-store.ts` | Qdrant（`@qdrant/js-client-rest`）与 Neo4j（`neo4j-driver`）真实后端，与内存版同接口 |
| 8.3.4 多格式文档 | `loadDocument` + pdf-parse/mammoth | PDF/DOCX/MD/TXT/JSON/CSV/HTML；OCR/音频约定外部转 Markdown |
| 8.4 问答助手 | `examples/8/qa-repl.ts` `qa-server.ts` `qa-web.html` | 共享命令引擎 /init /load /ask /note /recall /stats /report /extract /record /log /transcript；REPL 与 Web 双形态 |
| （增强）聊天逐字日志 | `examples/8/chat-log.ts` | jsonl 留痕默认开（审计/复盘，/log off 关）；md 可读转录默认关（👤用户/🤖助手，/transcript on 开） |
| （增强）Rerank 精排 | `src/memory/rag/rerank.ts` | opt-in 二级检索（默认关闭，需 RERANK_MODEL_NAME + enable_rerank） |
| （增强）LLM 实体抽取 | `LLMEntityExtractor` | opt-in + 运行时开关；规则抽取器为默认 |

## 与书第 9 章的对应关系

| 书章节 | 本项目文件 | 说明 |
|---|---|---|
| 9.3 ContextBuilder（GSSC） | `src/context/builder.ts` `types.ts` | Gather→Select→Structure→Compress 四阶段；相关性×时近性×优先级加权、token 预算贪心、截断式压缩（对话历史最后砍） |
| 9.3.2 核心数据结构 | `src/context/types.ts` | ContextPacket / ContextConfig（maxTokens=4000、reserveRatio=0.15、minRelevance=0.2 对齐书值）+ 记忆/RAG 源类型安全契约 |
| 9.4 NoteTool | `src/tools/builtin/note-tool.ts` | 七 action（create/read/update/list/search/delete/summary）；Markdown+YAML frontmatter 手写解析；中文 CJK 单字展开搜索 |
| 9.5 TerminalTool | `src/tools/builtin/terminal-tool.ts` | 17 条白名单命令全部 Node fs 内置实现（Windows 无需 bash）；路径逃逸拦截 + 10MB 截断 + 30s 超时 |
| 9.6 代码库维护助手 | `examples/9/codebase-maintainer.ts` | 仓库版 Agentic 主线：FunctionCallAgent + 工具自选（terminal/note/memory） |
| 9.6.4 三天工作流 | `examples/9/06-three-day-workflow.ts` | 探索→分析→规划→复盘，跨会话笔记连贯性；演示资产在 `examples/9/assets/` |
| 01~05 渐进示例 | `examples/9/01..05-*.ts` | 基础/Agent 集成/笔记操作/笔记集成/终端全命令与安全演示 |
| （增强）真实模型验证 | `examples/9/verify-real-llm.ts` | 零 mock 硬断言：上下文注入生效、笔记被引用、Agentic 工具循环真实落盘 |

**与书的技术栈差异**（结构对齐，生态替换）：

| 书（Python） | 本项目（TS） | 说明 |
|---|---|---|
| `hello-agents[all]` pip 包 | 本仓库自带 `src/` | 框架即项目，无需装包 |
| Qdrant（云/Docker） | `VectorStore` 接口 + InMemory 实现 | 接口对齐书里的存储后端层；Qdrant 真实后端接入见下 |
| Neo4j（云/Docker） | `GraphStore` 接口 + InMemory 实现 | 同上 |
| SQLite（Python sqlite3） | `node:sqlite`（Node 24 内置） | 零原生依赖 |
| DashScope/本地模型/TFIDF 三级嵌入 | OpenAI 兼容端点 / TFIDF | Ollama 的 `/v1/embeddings` 走 OpenAI 兼容实现 |
| spaCy 中英文 NER | 规则实体抽取器（可注入） | 确定性规则，测试友好 |
| MarkItDown（PDF/Office/图片） | md/txt/json/csv/html 原生解析 | PDF/DOCX 先转 Markdown 再摄取，管道结构一致 |

## 目录结构

```
hello-agents-ts/
├── src/
│   ├── core/                    # 核心框架层
│   │   ├── agent.ts             # Agent 抽象基类
│   │   ├── llm.ts               # ChatLLM 接口 + OpenAI 兼容实现
│   │   ├── message.ts           # 消息系统
│   │   ├── config.ts            # 配置管理
│   │   ├── memory.ts            # execution/reflection 轨迹记忆
│   │   └── exceptions.ts        # 异常体系
│   ├── agents/                  # Agent 范式层
│   │   ├── simple-agent.ts      # 对话 + 文本协议工具调用
│   │   └── react-agent.ts       # Thought/Action/Observation 循环
│   │   ├── reflection-agent.ts  # 生成→反思→修改
│   │   ├── plan-solve-agent.ts  # 先规划后执行
│   │   └── function-call-agent.ts # 原生函数调用
│   └── tools/                   # 工具系统层
│       ├── tool.ts              # Tool 基类 + FunctionTool
│       ├── registry.ts          # 注册 / 描述生成 / 按名执行
│       ├── builtin/calculator.ts# 安全表达式求值（递归下降，无 eval）
│       ├── builtin/search.ts    # Tavily/SerpApi 多源搜索
│       ├── chain.ts             # 工具链（输出键传递数据）
│       └── async-executor.ts    # 有界并行执行器
├── tests/                       # vitest 全离线（ScriptedLLM 桩）
├── examples/                    # 按章节组织：7/ 第7章示例，8/ 第8章示例
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
npm run example:memory-basic # 第八章（examples/8/）：MemoryTool 九操作（离线可跑）
npm run example:memory-types # 第八章：四种记忆类型深度演示（离线可跑）
npm run example:rag          # 第八章：RAG 管道（检索离线可跑，问答需 LLM）
npm run example:memory-rag-agent # 第八章：Agent 集成记忆+RAG（需 LLM）
npm run example:memory-live  # 第八章：Qdrant/Neo4j/SQLite 真实三库联机验证
npm run example:qa-repl      # 第八章 8.4：REPL 问答助手（需 LLM）
npm run example:qa-web       # 第八章 8.4：Web 问答助手 → http://localhost:3000
```

第八章的存储走**默认装配工厂**（`storage/factories.ts`）：`.env` 配了
`QDRANT_URL` / `NEO4J_URI` 就自动连真实数据库，什么都没配就退化成进程内实现
（零配置离线跑通，重启即失）。本地 Docker 起法：

```bash
# Qdrant（向量库，数据挂载到本机目录持久化）
docker run -d --name hello-agents-qdrant -p 6333:6333 -v hello-agents-qdrant-data:/qdrant/storage qdrant/qdrant

# Neo4j（图数据库，同样挂 volume）
docker run -d --name hello-agents-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/hello-agents-password \
  -v hello-agents-neo4j-data:/data neo4j
```

然后在 `.env` 打开 `QDRANT_URL=http://localhost:6333` 与
`NEO4J_URI=bolt://localhost:7687` / `NEO4J_PASSWORD=hello-agents-password`。
注意向量维度必须与嵌入模型一致（书里同样的坑：`QDRANT_VECTOR_SIZE`，
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
   这是比书里更进一步的可测试性设计。
2. **工具契约保持"字符串进、字符串出"**——对齐书的文本协议理念，
   LLM 只需按 `[TOOL_CALL:name:params]` / `tool[input]` 格式输出，
   框架层不做 Function Calling 的强类型绑定。
3. **计算器用手写递归下降解析器**——对标书里 `ast.parse` 白名单求值的意图：
   语法层面只接受数字/四则/括号/sqrt/pi，代码注入在解析阶段即被拒绝（有对应测试）。
4. **Provider 自动检测优先级**：baseUrl 关键字 > 模型名前缀 > provider 专属
   环境变量 > 默认 openai；统一变量 `LLM_MODEL_ID/LLM_API_KEY/LLM_BASE_URL` 全兼容。
5. **Reflection/PlanAndSolve 保留第四章核心结构**：Memory 记录执行/反思交替轨迹
   （`getLastExecution`/`getTrajectory`），PlanAndSolve 由独立 Planner + Executor 组合而成，
   计划解析失败优雅终止——第七章"框架化"不丢第四章的逻辑内核。
6. **思考型模型适配**：glm-5.3 等思考型模型写长文时会生成大量隐藏推理，
   非流式调用容易超时；`OpenAICompatLLM.extraBody` 可透传
   `thinking: {type:"disabled"}` 等厂商参数，`.env` 的 `LLM_TIMEOUT` 控制超时。

## 状态

- [x] core 层（message / config / exceptions / llm / agent 基类）
- [x] tools 层（Tool / ToolRegistry / 计算器）
- [x] 五种 Agent 范式（Simple / ReAct / Reflection / PlanAndSolve / FunctionCall）
- [x] 工具链 / 多源搜索 / 异步执行器（7.5.3 / 7.5.4）
- [x] 第 7 章全部配套文件（对应 code/chapter7 每个示例与测试）
- [x] learn-claude-code s01–s03 对齐（结构化工具分发 / 三道闸门权限 / 会话级全轨迹）
- [x] learn-claude-code s04–s06 对齐（hooks 四挂点 / todo_write+reminder / task 子 agent）
- [x] learn-claude-code s07–s09 对齐（skill 按需加载 / 四步上下文压缩 / 文件式持久记忆）

> 对齐机制全部落在 FunctionCallAgent 主线（教学线冻结不动）；验证入口
> `npm run example:alignment`（分章 `example:alignment:s04` … `:s09`）。
