# Penguin index-quality quiz — answer key

> For comparison only. **Do not hand this to the AI** (questions live in
> index-quality-quiz.md). Repo: `FPMS-NT` · 2026-08-29

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

**Question**: In FPMS-NT, which functions call `getColorLandEventConfigByIdFromCache` (defined in apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts)? List every caller with its file.

**Index answer** (7)

- `apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:dailyShareMission`
- `apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:playerDailyShareMissionBoosts`
- `apps/promotion/src/modules/color-land/processors/get-player-color-land-rewards-summary.processor.ts:getPlayerColorLandRewardsSummary`
- `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:getActiveEventConfigByObjId`
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:getDiceConfigByConditionType`
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:getPlayerColorLandProgress`
- `apps/promotion/src/modules/color-land/services/player-color-land-progress.service.ts:getPlayerColorLandEvents`

**Independent verification**

```bash
rg -n --no-heading '\bgetColorLandEventConfigByIdFromCache\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+getColorLandEventConfigByIdFromCache\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q2 · callees

**Question**: In FPMS-NT, what does `claimColorLandTaskReward` (apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts) call? Name each callee and where it lives.

**Index answer** (8)

- `apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts:mapClaimedTicket`
- `apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts:resolveAndAdvanceCellLevel`
- `apps/promotion/src/modules/color-land/redis/color-land-redis.service.ts:decrementPlayerMissionListCount`
- `apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:dispatchReward`
- `apps/promotion/src/modules/color-land/transformers/color-land.transformer.ts:toData`
- `apps/promotion/src/modules/color-land/transformers/color-land.transformer.ts:toError`
- `apps/promotion/src/modules/event-reward-tickets/event-reward-tickets.service.ts:getTicketByObjId`
- `apps/promotion/src/modules/event-reward-tickets/event-reward-tickets.service.ts:updateTicket`

**Independent verification**

```bash
sed -n '/claimColorLandTaskReward/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q3 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts.

**Index answer** (12)

- `FrontendGameProviderProcessor (class)`
- `addFavoriteGame (method)`
- `constructor (method)`
- `deleteFavoriteGame (method)`
- `filteredResult (function)`
- `getFavoriteGames (method)`
- `getLoginURL (method)`
- `getPlatformSpecificProviderStatus (method)`
- `getRecentPlayedGames (method)`
- `transferProm (function)`
- `transferToProvider (method)`
- `verifyInvitationCode (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q4 · dead_code

**Question**: In FPMS-NT, which symbols under `apps/admin/` have NO incoming calls or references — i.e. dead-code candidates? Give file:line for each, and say what scope your answer covers.

**Index answer** (25)

- `apps/admin/inteceptor/external.module.ts:14 — useFactory`
- `apps/admin/inteceptor/external.module.ts:48 — ExternalModule`
- `apps/admin/inteceptor/payment-external.service.ts:18 — constructor`
- `apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19 — GameRepositoryModule`
- `apps/admin/libs/repositories/fpms/admin/game/game-repository.ts:9 — constructor`
- `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.module.ts:19 — PlatformAnnouncementRepositoryModule`
- `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:8 — constructor`
- `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13 — findById`
- `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:25 — findOne`
- `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:29 — find`
- `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:36 — update`
- `apps/admin/libs/repositories/fpms/schemas/game.schema.ts:166 — GameDocument`
- `apps/admin/libs/repositories/fpms/schemas/platform-announcement.schema.ts:44 — PlatformAnnouncementDocument`
- `apps/admin/libs/spi/address/sites/base/base-address.provider.ts:12 — BaseAddressProvider`
- `apps/admin/libs/spi/address/sites/base/base-address.provider.ts:13 — getAddressDetail`
- `apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:14 — BpAddressProvider`
- `apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:15 — getAddressDetail`
- `apps/admin/src/address/address.controller.ts:6 — AddressController`
- `apps/admin/src/address/address.controller.ts:7 — constructor`
- `apps/admin/src/address/address.module.ts:11 — AddressModule`
- `apps/admin/src/address/address.service.ts:10 — constructor`
- `apps/admin/src/admin/admin.controller.ts:11 — AdminController`
- `apps/admin/src/admin/admin.controller.ts:12 — constructor`
- `apps/admin/src/admin/admin.module.ts:80 — AdminModule`
- `apps/admin/src/admin/admin.service.ts:31 — constructor`

**Independent verification**

```bash
# spot-check one: a candidate should have no call sites outside its own definition
rg -n --no-heading '\buseFactory\b' /Users/shieng/Desktop/Projects/fpmsnt | head -10
```

**What to look for**: Candidates are leads, not proof — DI, reflection and public entry points are false positives, so a name appearing in ripgrep is not automatically a wrong answer. What IS wrong: an answer that spans other repos, or one that does not say which scope it covers.

## Q5 · callers

**Question**: In FPMS-NT, which functions call `getCredit` (defined in apps/payment/libs/utils/cpmsServices.ts)? List every caller with its file.

**Index answer** (7)

- `apps/payment/src/mud/processor/internal-processor.ts:getPlayerMud`
- `apps/payment/src/mud/services/mud-admin.service.ts:fetchPlayerMudMap`
- `apps/payment/src/mud/services/mud-admin.service.ts:getPlayerMud`
- `apps/payment/src/mud/services/mud-operation.service.ts:hasAvailableMud`
- `apps/payment/src/mud/services/player-disbursement/player-disbursement-service.ts:getActivePlayerDisbursements`
- `apps/payment/src/mud/services/player-disbursement/player-disbursement-service.ts:getTotalMudRemaining`
- `apps/payment/src/payment/payment.service.ts:getPlayerCredit`

**Independent verification**

```bash
rg -n --no-heading '\bgetCredit\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+getCredit\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q6 · callees

**Question**: In FPMS-NT, what does `createGrowthTaskMissionsForPlayer` (apps/promotion/src/special-event/services/special-event-mission.service.ts) call? Name each callee and where it lives.

**Index answer** (8)

- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:getPlayerVipLevelFromTargetGroup`
- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:hasLoggedInToday`
- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:hasTaskIn30Days`
- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:isTaskEnded`
- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:setLoggedInToday`
- `apps/promotion/src/special-event/services/special-event-mission.service.ts:createNewGrowthTaskForPlayer`
- `apps/promotion/src/special-event/services/special-event-mission.service.ts:setTaskEndedRedisKeyIfDay9OrLater`
- `apps/promotion/src/special-event/services/special-event-mission.service.ts:updateDailyLoginTask`

**Independent verification**

```bash
sed -n '/createGrowthTaskMissionsForPlayer/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/special-event/services/special-event-mission.service.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q7 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts.

**Index answer** (12)

- `DepositLimitStateService (class)`
- `accumulatePlayerDeposit (method)`
- `buildStateEvaluateResult (method)`
- `calculateLimitStatus (method)`
- `constructor (method)`
- `evaluateState (method)`
- `evaluateStateAndResetIfPeriodExpired (method)`
- `getRuntimeContext (method)`
- `mockUpdateLastDepositAmountUpdateTime (method)`
- `notifyStateChanged (method)`
- `resetStateViewIfPeriodExpired (method)`
- `resetStateViewIfSystemDisable (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q8 · callers

**Question**: In FPMS-NT, which functions call `getEventEndTtlSeconds` (defined in apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts)? List every caller with its file.

**Index answer** (7)

- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:bootstrapTotalPrizeIfNeeded`
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:bootstrapWinnerCountIfNeeded`
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:incrementTotalPrize`
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:incrementTotalWinnerCount`
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:refreshRecentWinnersCache`
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:refreshTotalPrizeCache`
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts:refreshTotalWinnerCountCache`

**Independent verification**

```bash
rg -n --no-heading '\bgetEventEndTtlSeconds\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+getEventEndTtlSeconds\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q9 · callees

**Question**: In FPMS-NT, what does `executeForEventV2` (apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts) call? Name each callee and where it lives.

**Index answer** (8)

- `apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts:applyMultiplier`
- `apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts:buildErrorResponse`
- `apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts:fetchGameInfoMap`
- `apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts:generateEventId`
- `apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts:getMultiplier`
- `apps/promotion/src/free-spin/services/create-free-spin-config/create-free-spin-config.service.ts:createFreeSpinConfig`
- `apps/promotion/src/repositories/event-v2.repository.ts:getEventV2s`
- `apps/promotion/src/repositories/event-v2.repository.ts:updateFreeSpinConfig`

**Independent verification**

```bash
sed -n '/executeForEventV2/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q10 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in libs/tools/src/client-grpc/provider-client-grpc/provider-client-grpc.ts.

**Index answer** (12)

- `Game (interface)`
- `GetPlayerRecentGamesWithGroupingRes (interface)`
- `InternalProviderService (interface)`
- `MatchFields (interface)`
- `Pagination (interface)`
- `PaginationBaseResponse (interface)`
- `PlayerRecentGameRecord (interface)`
- `ProviderClientGrpc (class)`
- `catchGrpcError (method)`
- `constructor (method)`
- `getPlayerRecentGamesWithGrouping (method)`
- `onModuleInit (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/libs/tools/src/client-grpc/provider-client-grpc/provider-client-grpc.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q11 · callers

**Question**: In FPMS-NT, which functions call `getGameImageUrl` (defined in libs/tools/src/client-grpc/cms-client-grpc.ts)? List every caller with its file.

**Index answer** (7)

- `apps/promotion/src/ccms-promotion/lucky-deal/lucky-deal.service.ts:fetchGameInfoFromCms`
- `apps/promotion/src/ccms-promotion/promotion.service.ts:fetchGameInfoFromCms`
- `apps/promotion/src/ccms-promotion/promotion.service.ts:resolveFreeBetGameInfo`
- `apps/promotion/src/ccms-promotion/promotion.service.ts:resolveFreeSpinGameInfo`
- `apps/promotion/src/free-spin/processors/create-event-free-spin/create-event-free-spin.service.ts:fetchGameInfoFromCms`
- `apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:fetchAllGameInfoCached`
- `apps/promotion/src/free-spin/v2/processors/get-player-free-spin-info/services/game-info-fetcher.service.ts:fetchAllGameInfoCached`

**Independent verification**

```bash
rg -n --no-heading '\bgetGameImageUrl\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+getGameImageUrl\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q12 · callees

**Question**: In FPMS-NT, what does `executeSuccess` (apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts) call? Name each callee and where it lives.

**Index answer** (8)

- `apps/offline-casino/libs/utils/offline-casino-proposal.constants.ts:isRollingProgramProposalType`
- `apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts:buildSuccessResponse`
- `apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts:executeRollingProgramSuccess`
- `apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts:resolveDirection`
- `libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:AddPlayerCredit`
- `libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:CreateLandbaseProposal`
- `libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:DeductPlayerCredit`
- `libs/tools/src/processor/dos-reward/dos-reward-processor.ts:redeemPlayerLuckyCoins`

**Independent verification**

```bash
sed -n '/executeSuccess/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q13 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in libs/tools/src/message-dispatcher/message-dispatcher.ts.

**Index answer** (12)

- `DispatchMessageData (interface)`
- `MessageDispatcher (class)`
- `MessageDispatcherServiceName (enum)`
- `PlayerMeta (interface)`
- `ProposalData (interface)`
- `constructor (method)`
- `contentModifier (method)`
- `dispatchMessagesForPromoCode (method)`
- `dispatchMessagesInternal (method)`
- `notifyMessage (method)`
- `renderTemplateAndSendMessage (method)`
- `sendMessage (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/libs/tools/src/message-dispatcher/message-dispatcher.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q14 · callers

**Question**: In FPMS-NT, which functions call `getLiveDrawEvents` (defined in apps/promotion/src/repositories/live-draw-events.repository.ts)? List every caller with its file.

**Index answer** (7)

- `apps/promotion/src/modules/live-draw-events/live-draw-events.service.ts:findNextCurrentRoundEvent`
- `apps/promotion/src/modules/live-draw-events/live-draw-events.service.ts:getEventByBetDateAndPrizeTierKey`
- `apps/promotion/src/modules/live-draw-events/live-draw-events.service.ts:getEventByEventId`
- `apps/promotion/src/modules/live-draw-events/live-draw-events.service.ts:getTodayLiveDrawEvents`
- `apps/promotion/src/modules/live-draw-events/live-draw-events.service.ts:getTomorrowLiveDrawEvents`
- `apps/promotion/src/modules/live-draw-tickets/live-draw-tickets.service.ts:buildNotActivatedTickets`
- `apps/promotion/src/modules/live-draw-tickets/live-draw-tickets.service.ts:getLuckyDrawRewardList`

**Independent verification**

```bash
rg -n --no-heading '\bgetLiveDrawEvents\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+getLiveDrawEvents\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.
