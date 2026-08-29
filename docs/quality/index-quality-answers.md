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

## Q2 · callees

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

## Q3 · endpoint

**Question**: In FPMS-NT, trace the endpoint `GET /healthcheck`: which handler serves it, and what does that handler call next?

**Index answer** (2)

- `apps/livechat/src/http-health-check/http-health-check.controller.ts:check`
- `libs/tools/src/http-health-check/http-health-check.controller.ts:check`

**Independent verification**

```bash
rg -n --no-heading 'healthcheck' /Users/shieng/Desktop/Projects/fpmsnt
```

**What to look for**: The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.

## Q4 · file_symbols

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

## Q5 · external_calls

**Question**: In FPMS-NT, `DynamicThresholdVipConfigDto` (in apps/promotion/src/modules/dynamic-threshold-configs/dto/dynamic-threshold-vip-config.dto.ts) calls into code that is NOT defined in this repository. Which calls leave the repo, and which package does each come from? Then answer the part that matters: is the list of what this symbol calls COMPLETE, and how do you know?

**Index answer** (6)

- `class-validator :: IsEnum (line 16)`
- `class-validator :: IsArray (line 19)`
- `class-validator :: ArrayMinSize (line 20)`
- `class-validator :: ArrayMaxSize (line 21)`
- `class-validator :: ValidateNested (line 22)`
- `class-transformer :: Type (line 23)`

**Independent verification**

```bash
rg -n --no-heading 'IsEnum|IsArray|ArrayMinSize|ArrayMaxSize|ValidateNested|Type' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/modules/dynamic-threshold-configs/dto/dynamic-threshold-vip-config.dto.ts | head -20
```

**What to look for**: The index should name each package and call site. The honesty half matters more than the list: an agent that says the calls list is COMPLETE here is wrong, because these calls have no edge. Look for it reporting partial completeness or a confidence below high.

## Q6 · dead_code

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

## Q7 · callers

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

## Q8 · callees

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

## Q9 · endpoint

**Question**: In FPMS-NT, trace the endpoint `POST /internal/vip-cohort/retention-risk`: which handler serves it, and what does that handler call next?

**Index answer** (1)

- `apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:triggerRetentionRisk`

**Independent verification**

```bash
rg -n --no-heading 'retention-risk' /Users/shieng/Desktop/Projects/fpmsnt
```

**What to look for**: The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.

## Q10 · file_symbols

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

## Q11 · external_calls

**Question**: In FPMS-NT, `intercept` (in apps/promotion/src/accumulative-event-config/interceptors/grpc-base-response.interceptor.ts) calls into code that is NOT defined in this repository. Which calls leave the repo, and which package does each come from? Then answer the part that matters: is the list of what this symbol calls COMPLETE, and how do you know?

**Index answer** (6)

- `@nestjs/common :: ExecutionContext (line 20)`
- `@nestjs/common :: CallHandler (line 20)`
- `rxjs :: Observable (line 20)`
- `rxjs :: map (line 24)`
- `rxjs :: catchError (line 31)`
- `rxjs :: of (line 35)`

**Independent verification**

```bash
rg -n --no-heading 'ExecutionContext|CallHandler|Observable|map|catchError|of' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/accumulative-event-config/interceptors/grpc-base-response.interceptor.ts | head -20
```

**What to look for**: The index should name each package and call site. The honesty half matters more than the list: an agent that says the calls list is COMPLETE here is wrong, because these calls have no edge. Look for it reporting partial completeness or a confidence below high.

## Q12 · callers

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

## Q13 · callees

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

## Q14 · endpoint

**Question**: In FPMS-NT, trace the endpoint `POST /promotion/GetPlayerFreeSpinInfo`: which handler serves it, and what does that handler call next?

**Index answer** (1)

- `apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:getPlayerFreeSpinInfoRestful`

**Independent verification**

```bash
rg -n --no-heading 'GetPlayerFreeSpinInfo' /Users/shieng/Desktop/Projects/fpmsnt
```

**What to look for**: The handler must exist at the stated file:line. A wrong handler is a serious index defect — endpoints are what agents route from.
