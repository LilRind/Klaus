# agent-workspace Specification

## Purpose
提供多 Agent 协作的共享数据设施：Workspace 主题广播（全局序列号与增量读取）、Mailbox 点对点消息（五种类型、读取即消费）与 request→offer→accept 协商协议，均以进程内存储实现并在 run 结束后清理。

## Requirements

### Requirement: Workspace 按主题广播写入
Workspace SHALL 接受带主题名的写入（publish），每条 entry 获得跨主题全局递增的序列号；单条 entry 超过 1MB 时拒绝写入并返回错误。

#### Scenario: 序列号全局递增
- **WHEN** 先后向主题 "a" 与主题 "b" 各写入一条
- **THEN** 两条 entry 的序列号严格递增且不重复

#### Scenario: 超大 entry 被拒绝
- **WHEN** 写入超过 1MB 的 entry
- **THEN** 写入失败并返回明确错误，序列号不被消耗

### Requirement: Workspace 支持按序列号增量读取
读取接口 SHALL 接受主题名与 sinceSeq，仅返回该主题中序列号大于 sinceSeq 的新条目；再次读取以最新序列号续读，不重复注入历史数据。

#### Scenario: 增量读取不重复
- **WHEN** Agent 以 sinceSeq=0 读得 seq=1，写入 seq=2 后再以 sinceSeq=1 读取
- **THEN** 只返回 seq=2 的条目

### Requirement: Mailbox 五类型点对点投递
Mailbox SHALL 支持五种消息类型（request/offer/accept/delegation/info）的点对点投递：每收件人独立队列与序列号，消息异步入队，接收方在下轮迭代读取；读取 MUST 是消费语义——同一条消息不会被读取两次。

#### Scenario: 读取即消费
- **WHEN** 收件人读取邮箱一次后再次读取
- **THEN** 第二次读取不返回已读消息

#### Scenario: 非法类型被拒绝
- **WHEN** 以未定义类型 "urgent" 发送消息
- **THEN** 发送失败并返回支持的类型列表

### Requirement: 三步协商协议
协商设施 SHALL 基于 Mailbox 提供三步委派：发起方广播 TaskRequest（任务+技能要求）→ 有意愿 Agent 回 TaskOffer（附完成置信度）→ 发起方回 TaskAccept 确认唯一接单者。

#### Scenario: 完整协商链
- **WHEN** 发起 request 后收到两个 offer（置信度 0.9 与 0.5）
- **THEN** 发起方 accept 置信度最高者，另一 Agent 收到未中标通知
