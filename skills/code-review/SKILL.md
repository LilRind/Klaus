---
name: code-review
description: Review code changes for correctness, safety, and test coverage before landing
---

# Code Review

按以下顺序审查代码改动：

1. **正确性**：边界条件、错误路径、资源释放；
2. **安全**：输入校验、路径逃逸、命令注入、权限边界；
3. **测试**：新行为是否有对应断言；回归风险是否被覆盖；
4. **可读性**：命名、注释与项目既有风格一致。

输出格式：按严重度列出问题（🔴 阻断 / 🟡 建议 / 🟢 可选），每条附文件与行号。
