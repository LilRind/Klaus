# Design

## Context

Klaus 已有 s01-s17 底座（ChatLLM/工具注册/权限/Compactor/Semaphore 等），缺少多 Agent 编排。本设计以 Shannon 当前代码为主参考（详见 interview.md §2 考据：orchestrator_router.go 早路由行 269-312、isSimple 行 888-889、hasDeps 死变量行 1011-1015、Supervisor 恒假分支行 1070），书 13-16 章为辅助导读。约束：本地框架、无 Redis/Temporal、ScriptedLLM 全离线可测、不改动 s10/s13/s16 存量。

## Goals / Non-Goals

**Goals:**
- 一条 `run()` 管线覆盖 分解→路由→执行（simple/DAG/Swarm）→综合，Swarm 具备动态重规划、HITL、零成本验收与 journal 回放。
- 与 Shannon 语义一一对应（图组 v2 已归档于 Needs_improvement/lcc-ts/方案讨论/），所有偏离在本文显式记录。

**Non-Goals:**
- 不实现 SupervisorWorkflow；不做 durable 断点续跑（崩溃=interrupted，续跑留 s19 融合）；不做 SSE/多用户服务化；不收编 s10/s13/s16。

## Decisions

### D1 模块布局：自包含 `src/multiagent/`
`model.ts`（类型契约）、`decompose.ts`、`router.ts`、`patterns/{parallel,sequential,hybrid}.ts`、`synthesis.ts`、`workspace.ts`、`mailbox.ts`、`negotiation.ts`、`swarm/{lead,worker,roles}.ts`、`orchestrator.ts`。
每个文件头注释标注 SN 来源文件；只 import 复用 s02 工具、s03 权限、s08 Compactor、s16 Semaphore/TokenBudget。
**备选**：改造 s13 teams / s10 TaskStore 承载——被否：s13 邮箱是破坏性整读、TeammateRuntime 是多轮工具循环，适配成本≈重写且拖入存量回归面（interview §1 已拍板）。

### D2 路由：早路由 + 二分支，无 Supervisor
实现顺序即判定顺序：`mode` 强制（swarm 跳过分解）→ decompose → isSimple（三条件）→ 其余一律 DAG。DAG 内部按 依赖/LLM 建议/默认 选 hybrid/sequential/parallel（对齐 dag.go selectExecutionStrategy）。**备选**：书 13.3 的 ">5 或有依赖→Supervisor"——被否：SN 当前代码已禁用该路由（case false + 注释），复刻演进前形态无价值。

### D3 协作存储：进程内 Store + run 级 journal
Workspace/Mailbox 用进程内 Map + 计数器实现（seq 单调递增）；全部写入同步 append 到 `.multiagent/<runId>/events.jsonl`；run 结束清理内存态、journal 保留供 replay。
**备选**：SQLite（s19 orchestrator 同款）——留待 durable 升级时替换，v1 无续跑需求时纯内存最简且 journal 已满足观测。

### D4 Lead 事件循环：Promise 竞争唤醒
驻留点 = `Promise.race([idleEvents, completedEvents, checkpointTimer, humanInputQueue])`；每类事件是可 resolve 的 deferred 队列。checkpoint 定时器与节流用可注入时钟（测试假钟 10ms）。防护栏：interim 节流 60s、checkpoint 连续 2 轮无动作强制收尾、无事 checkpoint 跳过 LLM。

### D5 Worker：单 Action JSON 协议
每轮 LLM 输出恰好一个 Action（五选一）+ decision_summary；`{` prefill 保证 JSON；解析失败按 noop 重试一轮，连续失败强制 idle。上下文六项注入（任务/名册/任务板/Workspace 增量/收件箱/Notes+预算）。收敛检测：连续无工具调用 K 轮、动作相似度重复、迭代≥50 → 强制 idle + key_findings。

### D6 工具安全默认（有意严于 SN）
常驻 calculator + 工位内 file 四件套；SearchTool 仅 env 有 key 才注册；无 bash/python/file_delete；权限走 s03 PermissionChecker（默认 AutoAllow，工位内放行，越界拒绝）。
**SN 对照**：swarm_workflow.go:703 给 14 工具含 python_executor/file_delete，无 per-call 权限，靠工作流级审批（middleware_approval.go 阈值 0.8）+ 目录围栏。收紧理由：本地无人值守场景，SN 的审批门禁属服务端中间件、不在本变更范围。

### D7 角色与模型分档
6 角色方法论 prompt 内置于 `swarm/roles.ts`；`{small?, medium?, large?}` 可配 ChatLLM，未配回落主 llm 并记录 journal。SN 12 角色裁剪为 6，差异记录于 interview §9。

### D8 批次与提交
tasks 按批1（地基）→批2（协作设施）→批3（Swarm）→批4（收尾）分组；串行推进、每批独立 commit（LilRind）；README/脚本/指南在批4 收口。

## Risks / Trade-offs

- [Lead 决策质量不稳导致死循环] → 防护栏三重（迭代上限/重派上限/连续空 checkpoint 强制收尾）+ 全事件 journal 便于复盘。
- [纯内存 Store 崩溃即失] → 有意接受（v1 无续跑承诺），journal 保留完整事实；durable 升级路径已预留（D3 备选）。
- [与 s13/s16 概念重复造成混淆] → README 模块表写明分工边界（s18=编排新轨、s13=Lead-teammate 旧轨待收编）；收编另立变更。
- [ScriptedLLM 剧本与真实模型行为漂移] → 批4 产出真实模型人工验证指南，冒烟不过不合并。

## Migration Plan

纯新增轨道：新分支 `codex/s18-multiagent` 开发；回滚 = revert 对应批次 commit 或整分支不合并；不触碰任何既有模块运行路径。
