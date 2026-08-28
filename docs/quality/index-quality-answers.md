# Penguin index-quality quiz — answer key

> For comparison only. **Do not hand this to the AI** (questions live in
> index-quality-quiz.md). Repo: `FPMS-NT` · 2026-08-28

## How to judge

Two different failures, kept apart:

| Comparison | Conclusion |
|---|---|
| AI answer != **index answer** | The agent did not use the tools properly. Its problem, not the index's. |
| **index answer** != **verify output** | A real index defect (missed or phantom edge). This is the one worth fixing. |

Reading verify output: extra ripgrep hits are often same-name symbols in other
scopes. Read them before calling anything a missed edge.

---

## Q1 · callers

**Question**: In FPMS-NT, which functions call `CMSGenBaseResponse` (defined in apps/promotion/src/budget/budget-base-response.ts)? List every caller with its file.

**Index answer** (8)

- `apps/promotion/src/budget/budget-base-response.ts:alreadyExists`
- `apps/promotion/src/budget/budget-base-response.ts:forbidden`
- `apps/promotion/src/budget/budget-base-response.ts:illegalArgs`
- `apps/promotion/src/budget/budget-base-response.ts:internalError`
- `apps/promotion/src/budget/budget-base-response.ts:notFound`
- `apps/promotion/src/budget/budget-base-response.ts:statusUnspecified`
- `apps/promotion/src/budget/budget-base-response.ts:success`
- `apps/promotion/src/budget/budget-base-response.ts:unauthorized`

**Independent verification**

```bash
rg -n --no-heading '\bCMSGenBaseResponse\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+CMSGenBaseResponse\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q2 · callers

**Question**: In FPMS-NT, which functions call `addPlayerFreeSpin` (defined in apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts)? List every caller with its file.

**Index answer** (8)

- `apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:addPlayerFreeSpin`
- `apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:dispatchReward`
- `apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:dispatchFreeSpin`
- `apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:redeemPhysicalGift`
- `apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:dispatch`
- `apps/promotion/src/special-event/services/special-event-mission.service.ts:claimTaskReward`
- `apps/promotion/src/winsday-billion/services/post-win-share.service.ts:grantFreeSpin`
- `apps/promotion/src/winsday-billion/services/reward-grant.service.ts:grantFreeSpin`

**Independent verification**

```bash
rg -n --no-heading '\baddPlayerFreeSpin\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+addPlayerFreeSpin\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q3 · callers

**Question**: In FPMS-NT, which functions call `addPlayerMudDisbursement` (defined in apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts)? List every caller with its file.

**Index answer** (8)

- `apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:dispatchReward`
- `apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:dispatchMud`
- `apps/promotion/src/mud/controllers/mud.internal.controller.ts:addPlayerMud`
- `apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:addPlayerMudToRewardRecordBatch`
- `apps/promotion/src/reward-grant/adapters/mud-grant.adapter.ts:dispatch`
- `apps/promotion/src/special-event/services/special-event-mission.service.ts:claimTaskRewardByTaskId`
- `apps/promotion/src/winsday-billion/services/post-win-share.service.ts:grantMud`
- `apps/promotion/src/winsday-billion/services/reward-grant.service.ts:grantMud`

**Independent verification**

```bash
rg -n --no-heading '\baddPlayerMudDisbursement\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+addPlayerMudDisbursement\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q4 · callers

**Question**: In FPMS-NT, which functions call `catchGrpcError` (defined in libs/tools/src/client-grpc/promotion-client-grpc.ts)? List every caller with its file.

**Index answer** (8)

- `libs/tools/src/client-grpc/promotion-client-grpc.ts:checkAndCreateMission`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:getLuckyCoinTransactionHistoryFromPromotion`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:getOngoingMonthlyDepositBonusRewardEvent`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:giveVoucherToPlayersDto`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:queryDividendRecords`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:redeemPlayerLuckyCoinsFromPromotionInternal`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:transferMachineLuckyCoinsToPlayerFromPromotion`
- `libs/tools/src/client-grpc/promotion-client-grpc.ts:verifyFreeSpinEvent`

**Independent verification**

```bash
rg -n --no-heading '\bcatchGrpcError\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+catchGrpcError\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q5 · callees

**Question**: In FPMS-NT, what does `accumulatePlayerDeposit` (apps/riskControl/src/antiAddiction/deposit-limit.service.ts) call? Name each callee and where it lives.

**Index answer** (10)

- `apps/riskControl/src/antiAddiction/deposit-limit-config.service.ts:isNotConfigured`
- `apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:accumulatePlayerDeposit`
- `apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:evaluateState`
- `apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:evaluateStateAndResetIfPeriodExpired`
- `apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:getRuntimeContext`
- `apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:notifyStateChanged`
- `apps/riskControl/src/antiAddiction/deposit-limit.service.ts:flushStateSnapshot`
- `apps/riskControl/src/antiAddiction/deposit-limit.service.ts:isLimitReached`
- `apps/riskControl/src/antiAddiction/deposit-limit.service.ts:recordDepositLimitChange`
- `apps/riskControl/src/antiAddiction/deposit-limit.service.ts:shouldSkipAccumulate`

**Independent verification**

```bash
sed -n '/accumulatePlayerDeposit/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/riskControl/src/antiAddiction/deposit-limit.service.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q6 · callees

**Question**: In FPMS-NT, what does `applyOpenPromoCode` (apps/promotion/src/promo-code/promo-code.processor.ts) call? Name each callee and where it lives.

**Index answer** (10)

- `apps/promotion/src/event-bus/producer.routes.ts:emitEvent`
- `libs/common/common.ts:log`
- `libs/common/common.ts:warn`
- `libs/tools/src/clickhouse/pcr-clickhouse.service.ts:query`
- `libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:DeductPlayerCredit`
- `libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:getPlayerLevelWithPlayerLevelObjId`
- `libs/tools/src/fpms-internal-server/fpms-internal-server.service.ts:createProposal`
- `libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:addUsedEvent`
- `libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:findByProposalId`
- `libs/tools/src/repositories/player/fpms/logs2/open-promo-code-template/open-promo-code-template-repository.ts:findActiveOpenTemplate`

**Independent verification**

```bash
sed -n '/applyOpenPromoCode/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/promo-code/promo-code.processor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q7 · callees

**Question**: In FPMS-NT, what does `createLeaderBoardRewardProposal` (apps/promotion/src/leaderboard/leaderboard.processor.ts) call? Name each callee and where it lives.

**Index answer** (10)

- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:checkAndAddEventSession`
- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:incrementMessageDedup`
- `apps/promotion/src/leaderboard/leaderboard.service.ts:getTotalRewardCountForDay`
- `libs/common/common.ts:createGrpcMetadataWithTrace`
- `libs/common/common.ts:getStartAndEndDate`
- `libs/common/common.ts:warn`
- `libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:getPlayerInfoInternal`
- `libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:getPlatformByPlatformId`
- `libs/tools/src/manager/player-level-cache/player-level-cache-manager.ts:getPlayerLevelByPlayerLevelObjId`
- `libs/tools/src/repositories/common/proposal-type/proposal-type-repository.ts:getProposalTypeByName`

**Independent verification**

```bash
sed -n '/createLeaderBoardRewardProposal/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/leaderboard/leaderboard.processor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q8 · endpoint

**Question**: In FPMS-NT, trace the endpoint `GET /healthcheck`: which handler serves it, and what does that handler call next?

**Index answer** (2)

- `apps/livechat/src/http-health-check/http-health-check.controller.ts:check`
- `libs/tools/src/http-health-check/http-health-check.controller.ts:check`

**Independent verification**

```bash
rg -n --no-heading 'healthcheck' /Users/shieng/Desktop/Projects/fpmsnt
```

**What to look for**: The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.

## Q9 · endpoint

**Question**: In FPMS-NT, trace the endpoint `POST /internal/vip-cohort/retention-risk`: which handler serves it, and what does that handler call next?

**Index answer** (1)

- `apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:triggerRetentionRisk`

**Independent verification**

```bash
rg -n --no-heading 'retention-risk' /Users/shieng/Desktop/Projects/fpmsnt
```

**What to look for**: The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.

## Q10 · endpoint

**Question**: In FPMS-NT, trace the endpoint `POST /promotion/GetPlayerFreeSpinInfo`: which handler serves it, and what does that handler call next?

**Index answer** (1)

- `apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:getPlayerFreeSpinInfoRestful`

**Independent verification**

```bash
rg -n --no-heading 'GetPlayerFreeSpinInfo' /Users/shieng/Desktop/Projects/fpmsnt
```

**What to look for**: The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.

## Q11 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts.

**Index answer** (12)

- `LiveChatBotProcessor (class)`
- `_getBotMatrixClient (method)`
- `_getChatbotClient (method)`
- `_initBot (method)`
- `_initializeChatBotClient (method)`
- `_releaseChatbotClient (method)`
- `constructor (method)`
- `create (method)`
- `delay (function)`
- `destroy (method)`
- `updateBotAccessToken (method)`
- `updateNewAccessToken (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q12 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts.

**Index answer** (12)

- `LiveChatConvoProcessor (class)`
- `_createConversation (method)`
- `_endConversation (method)`
- `constructor (method)`
- `data (function)`
- `getConversationList (method)`
- `getConversationTag (method)`
- `storeConversationData (method)`
- `tagObjects (function)`
- `updateConversationReview (method)`
- `updateConversationTag (method)`
- `updateConversationTagList (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.
