# multiagent-orchestration Specification

## Purpose
为 Klaus 提供多 Agent 编排管线：把一句用户请求分解为带依赖声明的子任务计划，按当前 Shannon 代码的路由规则选择执行线（simple / DAG / swarm 早路由），以三种执行模式调度，并综合成统一回答。

## Requirements

### Requirement: 任务分解输出结构化计划
系统 SHALL 通过一次 LLM 调用把用户输入分解为结构化计划：复杂度评分、子任务列表（每个含 id、description、dependencies、produces、consumes、suggestedTools）与执行策略建议（仅 parallel/sequential 两种合法值）。

#### Scenario: 正常分解
- **WHEN** 用户输入一个多步骤工作请求且 LLM 返回合法 JSON
- **THEN** 系统产出包含 complexity 与至少 1 个子任务的计划对象

#### Scenario: 分解失败降级
- **WHEN** LLM 调用失败、输出不可解析或校验不通过
- **THEN** 系统降级为 simple 单 Agent 直跑并携带错误码，不抛出异常

### Requirement: 计划启动前校验
系统 SHALL 在执行任何子任务前校验计划：子任务 id 唯一、dependencies 引用存在的 id、无自依赖、无循环依赖（Kahn 检测）、每个 consumes 主题都有 produces 生产者。

#### Scenario: 循环依赖被拒绝
- **WHEN** 计划中 A 依赖 B、B 依赖 A
- **THEN** 校验失败并返回明确错误，不启动任何子任务

#### Scenario: 消费无生产者被拒绝
- **WHEN** 某子任务 consumes 主题 "data_x" 但没有任何子任务 produces 它
- **THEN** 校验失败并指出缺失主题，不进入等待

### Requirement: 路由遵循早路由加二分支规则
系统 SHALL 按以下顺序路由：mode=swarm 时跳过分解直入 Swarm 线（Lead 自主规划）；mode=simple 或 mode=dag 时直通对应线；否则分解后判定 isSimple（complexity 低于阈值 且 子任务数≤1 且 无建议工具）走 simple 线，其余情况一律走 DAG 线。系统 MUST NOT 存在"子任务数>5 自动进入 Swarm"的路由，MUST NOT 实现 Supervisor 执行线。

#### Scenario: 强制 swarm 跳过分解
- **WHEN** 用户以 mode=swarm 提交请求
- **THEN** 不调用分解 LLM，直接进入 Swarm 线

#### Scenario: 复杂依赖计划仍走 DAG
- **WHEN** 计划包含 6 个子任务且其中两个声明了 dependencies
- **THEN** 路由结果为 DAG 线（hybrid 模式），不进入 Swarm 线

#### Scenario: 简单请求走单 Agent
- **WHEN** complexity 低于阈值、仅 1 个子任务且无建议工具
- **THEN** 路由结果为 simple 线

### Requirement: 并行执行受并发上限约束
并行模式 SHALL 最多同时执行 5 个子任务（可配置），某子任务完成后等待队列中的下一个立即补位；所有结果按原计划顺序汇总。

#### Scenario: 并发不超过上限
- **WHEN** 8 个无依赖子任务并行执行且每个耗时被人为延迟
- **THEN** 任意时刻同时运行数不超过 5，且 8 个结果全部返回

### Requirement: 串行执行注入前序结果
串行模式 SHALL 把已完成前序子任务的结果注入当前子任务上下文（response/tokens/success/numericValue），numericValue 从文本中自动提取首个数值。

#### Scenario: 后继任务拿到数值
- **WHEN** 前序子任务回答"收入增长率为 15.3%"且串行执行后继子任务
- **THEN** 后继上下文中的前序结果包含 numericValue 15.3

### Requirement: 混合模式按依赖事件唤醒
混合模式 SHALL 按拓扑分层调度：某子任务的全部依赖完成后立即唤醒它（事件驱动，不做周期轮询），并把被依赖子任务的结果以 dependency_results 注入其上下文。

#### Scenario: 依赖满足立即执行
- **WHEN** 子任务 C 依赖 A 与 B，A 先完成、B 随后完成
- **THEN** C 在 B 完成的同一事件轮次内被启动，无需等待固定间隔

### Requirement: 结果综合先净化后整合
系统 SHALL 对全部子任务结果先做精确去重（哈希）、再做相似去重（Jaccard>0.85 视为重复）、再过滤失败与无信息结果（命中"无法访问/未找到/failed to fetch"等模式），最后用 LLM 综合为统一回答（消重、解矛盾、突出洞察、统一格式）。

#### Scenario: 相似结果被合并
- **WHEN** 两个子任务返回内容高度相似（Jaccard>0.85）
- **THEN** 综合输入只保留其中一条

#### Scenario: 无信息结果被过滤
- **WHEN** 某子任务返回"无法访问该页面"
- **THEN** 该结果不进入 LLM 综合输入
