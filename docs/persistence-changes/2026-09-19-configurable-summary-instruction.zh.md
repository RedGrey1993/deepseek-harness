---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-19-configurable-summary-instruction

[English](2026-09-19-configurable-summary-instruction.md) | 中文

## 概述

为 compaction/summary 增加可选的自定义 summaryInstruction 记录。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-configurable-summary-instruction
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-16-session-format-v4"
    after: "3ee7d7f3f55d79f601b568476209f30730d28d7c6e9cf0d4550aa59aee3ed084"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有记录仍然有效。缺失字段表示内置摘要指令；新增审计字段不改变回放内容、模型路由或 Session 格式。

<a id="verification"></a>
## 验证

Compaction-basic 定向测试 136 项通过，覆盖按模型策略保留自定义指令及检查点记录。

<a id="dev-note"></a>
## 开发备注

无。
