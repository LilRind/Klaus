---
name: api-design
description: Design typed tool and function interfaces with schema-validated arguments
---

# API Design

1. 参数一律结构化对象 + JSON Schema，拒绝字符串拼接协议；
2. 校验失败返回可读错误（❌ 前缀 observation），不抛裸异常打断循环；
3. 接口最小化：先覆盖当前章的验收场景，不为想象中的未来扩展加参数；
4. 危险操作不在工具内黑名单，交给权限闸门统一裁决。
