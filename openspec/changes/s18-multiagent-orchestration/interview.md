# s18-multiagent-orchestration · 访谈沉淀（interview.md）

> 来源：2026-11-16 ~ 2026-11-17 多轮方案讨论（用户与 Codex 逐步拍板）。本文是需求的唯一权威输入；proposal/design/specs/tasks 从本文生成。
> 用户规则：访谈与规范阶段禁止修改 src；spec 冻结前禁止编码；冻结后 spec 不可改，verify 失败只修实现/测试。

## 1. 轨道定义（已拍板）

- **轨道重定义**：原 S18（src/orchestrator，dsh+clowder 事务线，已并入 main）归入 **s19 常驻更自主Agent**，代码不动；新 **s18 = 多Agent编排**。
- **主参考** = Shannon 项目**当前代码**（不是书 13 章的旧路由）；书《AI Agent 开发实战》13-16 章作辅助导读。资料存档：`Needs_improvement/lcc-ts/方案讨论/` 下两份 v2 全景图组 md。
- **只基于 s01-s17 复用**，不引入其他待定轨道（s19 等）内容。
- 新建 `src/multiagent/` **自包含模块**；只 import 复用无语义冲突底件（见 §5）；s10 TaskStore / s13 MessageBus / s16 workflow 运行时**不改动**（收编留待后续专项）。

## 2. 路由（v2 定稿，对齐 SN 当前代码 + 考据）

- **早路由**（分解之前）：`mode=swarm`（≡SN force_swarm）→ Swarm 线**跳过分解**，Lead 自主规划；`mode=simple|dag` 直通对应线。
- **分解后**：`isSimple`（complexity<0.3 且 ≤1 子任务且无工具）→ simple 线；**其余一律 DAG 线**（含任意依赖、含 >5 子任务）。
- **DAG 内部选模式**（对齐 dag.go selectExecutionStrategy）：有 Dependencies/Consumes → hybrid；LLM 建议 sequential → sequential；默认 parallel。
- **明确不做**：无 `>5 子任务→swarm` 自动路由（v1 方案的未标注发明，已删除）；无 `strategy=swarm` 分解建议；**不实现 SupervisorWorkflow**。
- **SN 考据**（须写入 design）：orchestrator_router.go 行 269-312 force_swarm 早路由；行 888-889 isSimple 定义；行 1011-1015 hasDeps 死变量；行 1070 `case false:` 恒假分支 + 注释 "Supervisor routing disabled — all multi-task flows use DAGWorkflow"。书 13.3 的 ">5 或有依赖→Supervisor" 是演进前旧路由。
- 分解失败**降级 simple 单 Agent 直跑**并带错误码（对齐 assessment 降级哲学：缺证据的复杂编排在代码层不存在）。

## 3. Worker 与 Swarm（已拍板）

- **Worker = Shannon 单 Action 协议**：每轮 LLM 输出一个 Action JSON（tool_call / publish_data / send_message / idle / done）；不复用 FunctionCallAgent 多轮工具循环。
- 迭代五步：① shutdown 检查 → ② 上下文注入（任务+TeamRoster+TaskBoard 摘要+Workspace 增量 SinceSeq+收件箱+Running Notes+预算 i/N）→ ③ 单 Action LLM 调用 → ④ 执行 → ⑤ 收敛检测（连续无工具/重复 Action/超上限 → 强制 idle）。
- idle 携带 QUALITY SELF-CHECK + key_findings；idle→reassign 保留 Running Notes（keepLastN=5），重派上限 2 次，重派迭代预算 +15。
- **Lead**：LeadDecider = 无工具 LLM 调用 → 结构化 actions 校验（12 种动词：revise_plan(create/update/cancel)/spawn_agent/assign_task/create_task/cancel_task/send_message/broadcast/shutdown_agent/interim_reply/final_reply/synthesize/done + 辅助 file_read/tool_call/noop）；非法 action 降级 noop。
- **Lead 事件循环**：等待事件驻留点（Promise 竞争唤醒，SN 为 workflow.Selector 四路复用）← worker idle/completed + checkpoint 定时（默认 2min，可注入假钟）+ human_input（REPL 运行中输入）；checkpoint 无事可做**跳过 LLM 省钱**；interim_reply 节流 60s；checkpoint 连续 2 轮无动作强制收尾。
- **file_read 零成本验收**：Lead 直接 fs 读工位/workspace 文件（0 token）→ ACCEPT/RETRY。
- **全局终止**：全 idle 且无 pending 任务或 done → closing 判定 → reply 直答或 LLM synthesize。
- **角色**：6 个（researcher/analyst/writer/coder/critic/planner，SN 12 角色裁剪）+ 模型分档 {small?, medium?, large?} 回落主 llm。

## 4. Worker 工具集（安全默认，已拍板）

- 常驻：`CalculatorTool` + 工位内 file 四件套（ReadFile/WriteFile/Edit/Glob，workspace 限界）。
- `SearchTool`（Tavily/SerpApi）**仅当环境配置了搜索 key 才注册**；离线测试零网络。
- **不给**：bash / python / file_delete。
- 权限：s03 `PermissionChecker`，默认 `AutoAllowPrompt`（工位内放行），REPL 可换 `ConsoleApprovalPrompt`。
- **SN 对照**（须写入 design）：SN worker 给 14 工具（swarm_workflow.go:703）含 python_executor 与 file_delete，无 per-call 权限管线，靠工作流级审批中间件（middleware_approval.go，代码默认 ComplexityThreshold=0.8）+ 目录围栏 + 预算约束。本实现是**有意的更严格收紧**。

## 5. 复用底件（导出已核实，只 import 不重写）

| 来源 | 复用件 | 用途 |
|---|---|---|
| s02 | ToolRegistry + builtin CalculatorTool + file 四件套 + SearchTool | Worker 工具 |
| s03 | PermissionChecker + AutoAllowPrompt/ConsoleApprovalPrompt | 工具调用权限 |
| s08 | ContextCompactor（src/context/compactor.ts） | Worker 历史超长压缩 |
| s16 | Semaphore / TokenBudget（src/workflow/workflow-runtime.ts） | 并发控制 / 预算 |
| core | ChatLLM / invokeWithTools | 全部 LLM 调用 |

## 6. 共享设施与 Handoff 三层（已拍板）

- **层1 previous_results**（DAG sequential/hybrid）：注入 {taskId: {response, tokens, success, numericValue}}；numericValue 正则提取。
- **层2 Workspace**（广播）：进程内 Store——Topic + 全局 Seq 递增 + `list(topic, sinceSeq, limit=200)` 增量读；entry ≤1MB；run 结束清理（SN 为 Redis List + 48h TTL，偏差记录）。
- **层3 Mailbox**（点对点）：进程内 per-agent 队列 + per-box seq；5 类型 request/offer/accept/delegation/info；**读取即消费**。
- **协商**：request→offer(置信度)→accept 三步（contract-net 裁剪），基于 mailbox，供 Lead 动态委派。
- **持久化**：run 级 journal `.multiagent/<runId>/events.jsonl`（全部事件：decompose/route/lead 决策/worker 迭代/workspace append/消息/interim/synthesis）；`replay(runId)` 回放时间线；**崩溃=interrupted 不续跑**（durable 留 s19 融合）。

## 7. 模块与批次（tasks 按此分组）

- 批1 地基：`model.ts`（类型契约）/`decompose.ts`/`router.ts`/`patterns/{parallel,sequential,hybrid}.ts`/`synthesis.ts`/`orchestrator.ts`（simple+dag 组装）/REPL 骨架。
- 批2 协作设施：Kahn 环检测+生产者集合验证完善/`workspace.ts`/`mailbox.ts`/`negotiation.ts`。
- 批3 Swarm：`swarm/lead.ts`/`swarm/worker.ts`/`swarm/roles.ts`/HITL（human_input/interim/checkpoint）。
- 批4 收尾：REPL 完善（agents/tasks/workspace/replay 命令）+ journal replay + README 模块表 + `example:s18` 脚本 + 《功能与验证指南》+ 剩余事项（后两者在 Needs_improvement/lcc-ts/，gitignored）。

## 8. 参数默认值（全部可配置）

maxWorkers=6；迭代上限 50/任务；checkpoint 2min；并发 5（Semaphore）；interim 节流 60s；重派上限 2；entry 1MB；complexity 阈值 0.3；mailbox/list 增量 limit=200。

## 9. 与 SN 的差异清单（design 必录）

1. 依赖等待：事件驱动唤醒 vs SN 30s 增量轮询。
2. 协作存储：进程内 Store + run 级 journal vs Redis + 48h TTL + Temporal 重放续跑。
3. 角色：6 vs 12。
4. 入口：REPL `mode` 命令 ≡ context force 旗标。
5. 工具面收紧：无 python_executor/file_delete/bash，有 per-call 权限管线。
6. 无 Temporal：run 级 journal，崩溃不续跑。

## 10. 测试与执行纪律（已拍板）

- 测试：`tests/multiagent/*.test.ts`（vitest 自动纳入 tests/**），ScriptedLLM 全离线；关键回归用例：**有依赖且>5 子任务仍走 DAG-hybrid**（防 v1 错误路由复发）。
- 分支：单分支 `codex/s18-multiagent`（已从 main 切出）；默认**串行**批1→4，每批独立 commit（作者 LilRind <1337476737@qq.com>）；仅用户点名"这批开多 Agent 并行"才派子 Agent；检测并发会话立即 worktree 隔离。
- 合并：verify 全过 → push（2-3 commit/次节奏）→ 可回退保障下合并 main → `/opsx:archive` → 真实模型人工冒烟按指南。
- OpenSpec 环境备注：CLI 1.14.1 无 "expanded" 预设，已用 `profile: custom` + 全部 9 workflow 启用等价达成；项目本地 root 已绑定（规避主目录 openspec 劫持）。
