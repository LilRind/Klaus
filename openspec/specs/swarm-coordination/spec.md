# swarm-coordination Specification

## Purpose
提供 Lead/Worker 动态协作：Lead 以事件驱动循环协调团队（12 种决策动作、零成本文件验收、人机协同），Worker 以单 Action 协议自主执行并可被重派复用；全程落 run 级 journal 供回放观测。

## Requirements

### Requirement: Lead 决策输出受校验的动作
Lead 决策器 SHALL 通过一次无工具 LLM 调用输出结构化动作列表，动作词汇表限定为：revise_plan（create/update/cancel）、spawn_agent、assign_task、create_task、cancel_task、send_message、broadcast、shutdown_agent、interim_reply、final_reply、synthesize、done，辅以 file_read、tool_call、noop；任何无法解析或不合法的动作 MUST 降级为 noop 并记录原因，不得中断运行。

#### Scenario: 非法动作降级
- **WHEN** Lead 输出含未定义动作 "delete_agent"
- **THEN** 该动作按 noop 处理并记录降级原因，其余合法动作正常执行

### Requirement: Lead 事件循环有驻留点
Lead SHALL 在"等待事件"驻留点上阻塞，直到四类事件之一到达：worker idle、worker completed、checkpoint 定时（默认 2 分钟，可配置）、human_input；处理完事件产生的动作后回到驻留点。checkpoint 到达且无事可做时 MUST 跳过本次 LLM 调用。

#### Scenario: 空转 checkpoint 不调 LLM
- **WHEN** checkpoint 触发时所有 worker 在忙且无 pending 任务
- **THEN** 不发起 Lead 决策 LLM 调用，直接回到驻留点

### Requirement: 中间回复与节奏防护
Lead 的 interim_reply SHALL 受节流约束（默认 60 秒内不重复发送）；checkpoint 连续 2 轮无有效动作时 MUST 进入强制收尾，防止无限循环。

#### Scenario: 节流生效
- **WHEN** Lead 在 60 秒窗口内两次决定发送 interim_reply
- **THEN** 第二次被抑制并记录

### Requirement: Worker 单 Action 迭代
Worker 每轮 SHALL：非阻塞检查 shutdown 信号；组装上下文（当前任务、团队名册、任务板摘要、Workspace 增量、收件箱新消息、Running Notes、预算 i/N）；调用 LLM 输出恰好一个 Action（tool_call/publish_data/send_message/idle/done）；执行该动作后进入收敛检测。

#### Scenario: 工具调用动作
- **WHEN** Worker 输出 action=tool_call 且工具名在注册表中
- **THEN** 工具被调用、结果回填历史，进入下一轮迭代

### Requirement: 收敛检测强制收敛
系统 SHALL 检测 Worker 空转：连续多轮无工具调用、重复高度相似的动作、或达到迭代上限（默认 50）时，强制 Worker 进入 idle 并携带 key_findings 交回 Lead。

#### Scenario: 迭代上限触发
- **WHEN** Worker 连续执行满 50 轮仍未主动 idle
- **THEN** 被强制 idle，其 key_findings 仍随 idle 信号上报

### Requirement: idle 后可重派且保留笔记
Worker idle 后 SHALL 保留 Running Notes 与已写工作区产物等待 Lead 重派；重派时历史截断保留最近 5 条、迭代预算增加 15；单个 Worker 重派次数 MUST 不超过 2 次。

#### Scenario: 重派保留上下文
- **WHEN** Worker 完成任务 T1 后被 assign_task 派往 T2
- **THEN** T2 首轮上下文包含其 Running Notes 摘要且剩余预算增加 15

### Requirement: Lead 零成本文件验收
Lead SHALL 能直接读取 Worker 写入的文件内容（不调用 LLM）：内容满足任务要求时 ACCEPT，否则向该 Worker 发送附带具体改进指示的 RETRY。

#### Scenario: 产物过薄被打回
- **WHEN** Lead file_read 发现交付文件仅有三行占位内容
- **THEN** 向该 Worker 发送 RETRY 并附带补充要求

### Requirement: 运行中接受人类输入
Swarm 运行期间系统 SHALL 接受 human_input：用户输入注入 Lead 事件队列，Lead 在下一轮决策中响应（调整任务、追加要求或回复确认），并以 interim_reply 回执。

#### Scenario: 中途追加关注点
- **WHEN** 用户在运行中输入"多关注定价策略"
- **THEN** Lead 下一轮决策产生相应动作并回执 interim_reply

### Requirement: 全局终止与收尾合成
当全部 Worker idle 且无 pending 任务、或 Lead 发出 done 时，系统 SHALL 进入 closing：Lead 判定可直接作答则 final_reply，否则触发 LLM synthesize 生成最终回答。

#### Scenario: 全员空闲触发收尾
- **WHEN** 最后一个 Worker 进入 idle 且任务板无 pending
- **THEN** 进入 closing 判定并产出最终回复

### Requirement: Worker 工具面安全默认
Worker 默认工具集 SHALL 仅为：计算器、限定在个人工位目录内的文件读/写/编辑/列表四件套；搜索工具仅在检测到搜索凭证环境变量时注册；MUST NOT 提供 shell、代码执行或文件删除工具；全部工具调用经过 s03 权限检查器（默认工位内自动放行）。

#### Scenario: 越界路径被拒
- **WHEN** Worker 的文件写动作目标路径逃逸其工位目录
- **THEN** 工具调用被拒绝且错误回填 Worker 历史

### Requirement: 角色与模型分档
系统 SHALL 提供至少 6 个角色方法论（researcher/analyst/writer/coder/critic/planner），并支持按角色配置 small/medium/large 三档模型，未配置档位回落到主 LLM。

#### Scenario: 未配置档位回落
- **WHEN** spawn 指定 tier=medium 但未配置 medium 档
- **THEN** 该 Worker 使用主 LLM 并在事件中记录回落

### Requirement: run 级 journal 与回放
系统 SHALL 把 run 期间全部关键事件（分解、路由、Lead 决策、Worker 迭代、Workspace 写入、消息、interim、合成）按序追加到 `.multiagent/<runId>/events.jsonl`，并提供 replay 按时间线打印；run 崩溃后 MUST 标记 interrupted 且不自动续跑。

#### Scenario: 回放呈现完整时间线
- **WHEN** 一个完成的 run 执行 replay
- **THEN** 输出按发生顺序覆盖从提交到最终回复的关键事件
