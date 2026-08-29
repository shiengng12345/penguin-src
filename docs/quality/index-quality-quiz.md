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

In FPMS-NT, which functions call `getColorLandEventConfigByIdFromCache` (defined in apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts)? List every caller with its file.


## Q2 · callees

In FPMS-NT, what does `claimColorLandTaskReward` (apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts) call? Name each callee and where it lives.


## Q3 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts.


## Q4 · dead_code

In FPMS-NT, which symbols under `apps/admin/` have NO incoming calls or references — i.e. dead-code candidates? Give file:line for each, and say what scope your answer covers.


## Q5 · callers

In FPMS-NT, which functions call `getCredit` (defined in apps/payment/libs/utils/cpmsServices.ts)? List every caller with its file.


## Q6 · callees

In FPMS-NT, what does `createGrowthTaskMissionsForPlayer` (apps/promotion/src/special-event/services/special-event-mission.service.ts) call? Name each callee and where it lives.


## Q7 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts.


## Q8 · callers

In FPMS-NT, which functions call `getEventEndTtlSeconds` (defined in apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts)? List every caller with its file.


## Q9 · callees

In FPMS-NT, what does `executeForEventV2` (apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts) call? Name each callee and where it lives.


## Q10 · file_symbols

In FPMS-NT, list every function/class/method defined in libs/tools/src/client-grpc/provider-client-grpc/provider-client-grpc.ts.


## Q11 · callers

In FPMS-NT, which functions call `getGameImageUrl` (defined in libs/tools/src/client-grpc/cms-client-grpc.ts)? List every caller with its file.


## Q12 · callees

In FPMS-NT, what does `executeSuccess` (apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts) call? Name each callee and where it lives.


## Q13 · file_symbols

In FPMS-NT, list every function/class/method defined in libs/tools/src/message-dispatcher/message-dispatcher.ts.


## Q14 · callers

In FPMS-NT, which functions call `getLiveDrawEvents` (defined in apps/promotion/src/repositories/live-draw-events.repository.ts)? List every caller with its file.

