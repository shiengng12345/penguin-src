# Penguin index-quality quiz — questions

> Self-contained: reading this is enough to start.
> Repo: `FPMS-NT` (`/Users/shieng/Desktop/Projects/fpmsnt`) · 14 questions · 2026-08-29
> The answers are deliberately NOT in this file (see index-quality-answers.md),
> so you cannot check yourself — answer honestly.

## Your task

Measure the quality of a local code index (Penguin). You are not changing code.

**Rules**

1. Answer using Penguin's MCP tools only, `knowledge_explore` first. No grep, no
   reading source files, no filling gaps from general knowledge — that would
   measure something other than the index.
2. Give the COMPLETE list per answer, with `file:line`. No examples-only, no "etc".
3. **If the tools cannot answer, say so.** This matters most: an honest "not in
   the index" is worth more than a lucky guess, because a guess hides the gap
   that is exactly what I am measuring. Leave it blank rather than fill it in.
4. If a tool reports `freshness=stale`, pass that on — do not present stale data
   as current.
5. Answer each question independently; do not infer later answers from earlier patterns.

**Output format** (one block per question)

```
## Q<n>
answer:
- path/to/file.ts:123 — symbolName
- ...
tool used: knowledge_explore("...")
confidence: high / medium / low — if low, say what the index was missing
```

---

## Q1 · callers

In FPMS-NT, which functions call `claimPeriod` (defined in apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts)? List every caller with its file.


## Q2 · callees

In FPMS-NT, what does `updatePlayerProfile` (libs/tools/src/processor/player/player-processor.ts) call? Name each callee and where it lives.


## Q3 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/promotion/src/reward-grant/reward-grant.types.ts.


## Q4 · dead_code

In FPMS-NT, which symbols under `apps/admin/` have NO incoming calls or references — i.e. dead-code candidates? Give file:line for each, and say what scope your answer covers.


## Q5 · callers

In FPMS-NT, which functions call `coercePbIntEnum` (defined in apps/user-engagement/src/app-push/backend-app-push/app-push-pb-mappers.ts)? List every caller with its file.


## Q6 · callees

In FPMS-NT, what does `validateForCreate` (apps/promotion/src/modules/growth-task/services/task-config-validator.ts) call? Name each callee and where it lives.


## Q7 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/promotion/src/skin-fragment/controllers/skin-fragment-admin.controller.ts.


## Q8 · callers

In FPMS-NT, which functions call `deleteMany` (defined in libs/common/base-repository/base-repository.ts)? List every caller with its file.


## Q9 · callees

In FPMS-NT, what does `_findAvailableAgentAndJoinRoom` (apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts) call? Name each callee and where it lives.


## Q10 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/promotion/src/special-event/controllers/special-event-admin.controller.ts.


## Q11 · callers

In FPMS-NT, which functions call `findOneByPlatformId` (defined in libs/tools/src/repositories/player/fpms/admin/platform/platform.repository.ts)? List every caller with its file.


## Q12 · callees

In FPMS-NT, what does `callBackToUser` (apps/user-engagement/src/callback/processors/callback.processor.ts) call? Name each callee and where it lives.


## Q13 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/promotion/src/winsday-billion/services/boost-claim.service.ts.


## Q14 · callers

In FPMS-NT, which functions call `findPlayerProgress` (defined in apps/promotion/src/modules/player-progress/services/player-mission.progress.service.ts)? List every caller with its file.

