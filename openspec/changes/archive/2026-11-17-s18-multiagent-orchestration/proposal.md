# Proposal

## Why

Klaus（hello-agents-ts）已完成 s01-s17 单 Agent 主线与工具/权限/上下文/任务/团队等底座，但缺少真正的多 Agent 编排能力：任务无法自动分解与路由、子任务之间没有依赖调度与产物传递、没有动态团队（Lead/Worker）协作。原 S18 轨道（src/orchestrator，dsh+clowder 事务线）已归入 s19 常驻线，s18 作为新轨道需要一套以 Shannon 当前代码为主参考的多 Agent 编排系统。

## What Changes

- 新建 `src/multiagent/` 自包含编排模块：LLM 任务分解（complexity + subtasks + dependencies/produces/consumes）→ 路由（早路由 mode=swarm / isSimple → simple / 其余一律 DAG）→ 三种执行模式（parallel / sequential / hybrid）→ 结果综合（去重 → 过滤 → LLM 综合）。
- 新增 Swarm 动态协作线：Lead 事件循环（12 Action、file_read 零成本验收、checkpoint、HITL human_input）+ Worker 单 Action 迭代（tool_call/publish_data/send_message/idle/done、收敛检测、idle→reassign）。
- 新增协作设施：Workspace（Topic + 全局 Seq + SinceSeq 增量读）、Mailbox（5 类型点对点、读取即消费）、协商协议（request→offer→accept）。
- 新增 run 级 journal（`.multiagent/<runId>/events.jsonl`）与 replay 回放；新增 REPL 入口 `examples/s18-multiagent/repl.ts` 与 `example:s18` 脚本。
- 明确不做：不实现 SupervisorWorkflow（SN 上游已禁用）；无 ">5 子任务→swarm" 自动路由；无 Redis/Temporal 依赖（进程内 Store + journal）。
- 只 import 复用 s01-s17 底件（s02 工具、s03 权限、s08 Compactor、s16 Semaphore/TokenBudget），不改动 s10/s13/s16 存量。

## Capabilities

### New Capabilities

- `multiagent-orchestration`: 任务分解、路由决策（早路由 + isSimple + 其余一律 DAG）、三种执行模式（parallel/sequential/hybrid）、计划校验（Kahn 环检测、生产者集合验证、降级）与结果综合的完整编排管线。
- `agent-workspace`: 多 Agent 协作共享设施——Workspace 主题广播（全局 Seq、增量读、1MB 上限）、Mailbox 点对点消息（5 类型、读取即消费）与 request→offer→accept 协商协议。
- `swarm-coordination`: Lead/Worker 动态协作——Lead 事件循环（12 Action、file_read 验收、checkpoint、interim 节流、全局终止）、Worker 单 Action 迭代（收敛检测、idle→reassign）、HITL（human_input 运行中改计划）与 run 级 journal/replay。

### Modified Capabilities

（无——项目规格库为空，本变更全部为新增能力，不改既有 spec。）

## Impact

- **新增代码**：`src/multiagent/`（model/decompose/router/patterns/synthesis/workspace/mailbox/negotiation/swarm/orchestrator）、`examples/s18-multiagent/repl.ts`、`tests/multiagent/`、README 模块表、package.json `example:s18` 脚本。
- **零改动**：src/ 既有模块（含 s10/s13/s16 与 s19 线 src/orchestrator）；Needs_improvement 下新增 gitignored 文档（功能与验证指南、剩余事项）。
- **依赖**：无新第三方依赖；LLM 全部走既有 `ChatLLM` 接口（ScriptedLLM 离线可测）。
- **风险与回滚**：纯新增轨道，回滚 = revert 对应 commit 或删除 src/multiagent/；单分支 codex/s18-multiagent 隔离 main。
