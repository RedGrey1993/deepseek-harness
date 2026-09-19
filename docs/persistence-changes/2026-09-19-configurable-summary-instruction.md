---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-19-configurable-summary-instruction

English | [中文](2026-09-19-configurable-summary-instruction.zh.md)

## Summary

Adds the optional configured summaryInstruction to compaction/summary.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-19-configurable-summary-instruction
baseline: false
changes:
  - root: "event:compaction/summary"
    previous: "2026-09-14-image-offload"
    after: "5fb91376a6580939452fec2922a545a57406dbb6320753b5d51cf086898164db"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records remain valid. Omission retains the built-in summarizer directive; the added audit field does not alter replayed content, model routing or Session format.

<a id="verification"></a>
## Verification

Compaction-basic focused suite: 136 tests passed, including routed-policy instruction retention and checkpoint recording.

<a id="dev-note"></a>
## Dev Note

None.
