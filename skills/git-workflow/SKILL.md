---
name: git-workflow
description: Commit, branch, and push following the project's git conventions
---

# Git Workflow

1. 提交前跑 `typecheck` 与全量测试，绿了才提交；
2. 一个提交只做一件事：feat / fix / chore / docs 前缀 + 祈使句描述；
3. 提交身份用项目内配置（`git config user.name`），不依赖全局；
4. 不强制推送，不改写已推送的历史。
