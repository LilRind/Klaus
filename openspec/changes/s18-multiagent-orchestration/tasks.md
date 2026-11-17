# Tasks

## 1. 批1 地基：类型 / 分解 / 路由 / 执行模式 / 综合 / 组装

- [ ] 1.1 新建 `src/multiagent/model.ts`（计划/子任务/AgentResult/Worker 5-Action/Lead 12-Action/4 类事件/P2P 5 类型契约），验证：typecheck 通过且类型可被后续模块 import
- [ ] 1.2 实现 `decompose.ts`（LLM 一次输出 plan + 手写校验：id 唯一/依赖引用存在/无自依赖；失败降级 simple 带错误码），验证：decompose 测试覆盖正常/环引用/降级码全绿
- [ ] 1.3 实现 `router.ts`（mode=swarm 早路由跳分解；isSimple 三条件；其余一律 DAG；DAG 内部选 hybrid/sequential/parallel），验证：router 测试含"有依赖且 6 子任务仍走 DAG-hybrid"回归用例全绿
- [ ] 1.4 实现 `patterns/parallel.ts`（复用 s16 Semaphore，默认并发 5，结果按原序汇总），验证：假 LLM 延迟断言并发峰值≤5 且 8 任务全部返回
- [ ] 1.5 实现 `patterns/sequential.ts`（previous_results 注入 + numericValue 正则提取），验证：sequential 测试断言后继上下文含 numericValue 15.3
- [ ] 1.6 实现 `patterns/hybrid.ts`（拓扑分层 + 依赖完成事件唤醒 + dependency_results 注入），验证：hybrid 测试断言 C 在依赖完成同轮次启动且无轮询等待
- [ ] 1.7 实现 `synthesis.ts`（Hash 精确去重→Jaccard>0.85→无信息过滤→LLM 综合），验证：synthesis 测试覆盖 Jaccard 边界与"无法访问"过滤全绿
- [ ] 1.8 实现 `orchestrator.ts` 组装 simple/dag 线 + run 级 journal 落盘 `.multiagent/<runId>/events.jsonl`，验证：e2e 测试跑通 simple 与 dag 两条链路并断言 journal 事件序列
- [ ] 1.9 新建 `examples/s18-multiagent/repl.ts` 骨架（mode 命令解析 + 输入提交）并加 `example:s18` 脚本，验证：`npm run typecheck` 绿且 REPL 骨架可启动

## 2. 批2 协作设施：校验完善 / Workspace / Mailbox / 协商

- [ ] 2.1 补全计划校验（Kahn 环检测 + produces 集合覆盖 consumes），验证：校验测试覆盖"A→B→A 环"与"consumes 无 producer"两个拒绝场景
- [ ] 2.2 实现 `workspace.ts`（Topic 广播 + 全局 seq 递增 + entry 1MB 上限 + sinceSeq 增量读 + journal 记录），验证：workspace 测试覆盖 seq 单调、超限拒绝不耗 seq、增量不重复
- [ ] 2.3 实现 `mailbox.ts`（5 类型点对点 + per-box seq + 读取即消费），验证：mailbox 测试覆盖读取即消费与非法类型拒绝
- [ ] 2.4 实现 `negotiation.ts`（request→offer(置信度)→accept 三步），验证：协商测试断言最高置信度中标且未中标方收到通知

## 3. 批3 Swarm：角色 / Worker / Lead / HITL

- [ ] 3.1 实现 `swarm/roles.ts`（6 角色方法论 prompt + small/medium/large 分档回落主 llm），验证：roles 测试断言未配置档位回落并记录事件
- [ ] 3.2 实现 `swarm/worker.ts` 单 Action 迭代（六项上下文注入 + 5 Action 分发 + 工具越界拒绝 + 收敛检测强制 idle 附 key_findings），验证：worker 测试覆盖五类 Action、迭代上限强制 idle、越界路径被拒
- [ ] 3.3 实现 idle→reassign（Running Notes 保留 keepLastN=5 + 预算 +15 + 重派上限 2），验证：reassign 测试断言 T2 首轮含 Notes 摘要且第 3 次重派被拒
- [ ] 3.4 实现 `swarm/lead.ts` 决策层（无工具 LLM → 12+3 Action 校验，非法降级 noop 记原因），验证：lead 测试覆盖非法动作 "delete_agent" 降级 noop
- [ ] 3.5 实现 Lead 事件循环（Promise 竞争驻留点 + 四类事件 + 空 checkpoint 跳过 LLM + interim 节流 60s + 连续 2 轮强制收尾），验证：循环测试用注入假钟断言三重防护栏各生效一次
- [ ] 3.6 实现 file_read 零成本验收（ACCEPT/RETRY）与 human_input 注入（下一轮响应 + interim 回执），验证：测试覆盖"三行占位产物被 RETRY"与"中途输入定价关注点被响应"
- [ ] 3.7 swarm e2e：initial_plan→spawn→publish→idle→验收→assign→human_input→closing 全链路，验证：ScriptedLLM 剧本断言最终回复与 journal 完整时间线

## 4. 批4 收尾：REPL 完善 / 文档 / 回归

- [ ] 4.1 REPL 完善命令集（agents/tasks/workspace/msg/replay），验证：replay 一个已完成 run 输出按序时间线
- [ ] 4.2 更新 README 模块表（s18 新轨道 + 与 s13/s16/s19 边界说明），验证：README 中命令可照跑
- [ ] 4.3 全仓回归（vitest 全量 + typecheck）零失败，验证：命令输出全绿
- [ ] 4.4 落盘《s18多Agent编排-功能与验证指南.md》与《s18剩余事项.md》到 Needs_improvement/lcc-ts/（gitignored），验证：指南含真实模型 V1-V6 冒烟步骤

## Workflow follow-up

- 用户审阅规范并明确"冻结"后创建 `.spec-frozen` 空标记，方可进入 apply。
- `/opsx:apply` 全自动 TDD 实现本任务清单（不改冻结 spec）。
- `/opsx:verify` 生成 verify-report.md；全过后按 2-3 commit 节奏推送、合并 main。
- 合并后 `/opsx:archive s18-multiagent-orchestration`；真实模型人工冒烟按功能与验证指南执行。
