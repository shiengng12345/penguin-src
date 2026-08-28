# Penguin index-quality quiz — questions

> Self-contained: reading this is enough to start.
> Repo: `FPMS-NT` (`/Users/shieng/Desktop/Projects/fpmsnt`) · 12 questions · 2026-08-28
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

In FPMS-NT, which functions call `CMSGenBaseResponse` (defined in apps/promotion/src/budget/budget-base-response.ts)? List every caller with its file.


## Q2 · callers

In FPMS-NT, which functions call `addPlayerFreeSpin` (defined in apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts)? List every caller with its file.


## Q3 · callers

In FPMS-NT, which functions call `addPlayerMudDisbursement` (defined in apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts)? List every caller with its file.


## Q4 · callers

In FPMS-NT, which functions call `catchGrpcError` (defined in libs/tools/src/client-grpc/promotion-client-grpc.ts)? List every caller with its file.


## Q5 · callees

In FPMS-NT, what does `accumulatePlayerDeposit` (apps/riskControl/src/antiAddiction/deposit-limit.service.ts) call? Name each callee and where it lives.


## Q6 · callees

In FPMS-NT, what does `applyOpenPromoCode` (apps/promotion/src/promo-code/promo-code.processor.ts) call? Name each callee and where it lives.


## Q7 · callees

In FPMS-NT, what does `createLeaderBoardRewardProposal` (apps/promotion/src/leaderboard/leaderboard.processor.ts) call? Name each callee and where it lives.


## Q8 · endpoint

In FPMS-NT, trace the endpoint `GET /healthcheck`: which handler serves it, and what does that handler call next?


## Q9 · endpoint

In FPMS-NT, trace the endpoint `POST /internal/vip-cohort/retention-risk`: which handler serves it, and what does that handler call next?


## Q10 · endpoint

In FPMS-NT, trace the endpoint `POST /promotion/GetPlayerFreeSpinInfo`: which handler serves it, and what does that handler call next?


## Q11 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts.


## Q12 · file_symbols

In FPMS-NT, list every function/class/method defined in apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts.

