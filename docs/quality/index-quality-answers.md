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

**Question**: In FPMS-NT, which functions call `claimPeriod` (defined in apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts)? List every caller with its file.

**Index answer** (7)

- `apps/promotion/src/modules/realtime-task/services/realtime-task-budget.service.ts:checkAndDeductBudget`
- `apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:enroll`
- `apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:findCycleTask`
- `apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:getPlayerTaskBanner`
- `apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:getPlayerTaskView`
- `apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:markTaskBannerSeen`
- `apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:resolveLevelUpMultiplier`

**Independent verification**

```bash
rg -n --no-heading '\bclaimPeriod\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+claimPeriod\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q2 · callees

**Question**: In FPMS-NT, what does `updatePlayerProfile` (libs/tools/src/processor/player/player-processor.ts) call? Name each callee and where it lives.

**Index answer** (9)

- `libs/common/common.ts:isAdult`
- `libs/tools/src/multi-transaction/multi-transaction.service.ts:withTransaction`
- `libs/tools/src/processor/aws/aws-processor.ts:uploadPhotoId`
- `libs/tools/src/processor/phone/phone-processor.ts:encrypt`
- `libs/tools/src/processor/player/player-processor.ts:checkAndUpdateIsCompleteInfo`
- `libs/tools/src/processor/player/player-processor.ts:isPlayerTypeForbidEditProfileFields`
- `libs/tools/src/repositories/player/fpms/player/player-info/player-info-repository.ts:update`
- `libs/tools/src/repositories/player/player-history-update-email/player-history-update-email-repository.ts:bindEmailToPlayer`
- `libs/tools/src/utils/string-utilities/normalize-name.ts:normalizeName`

**Independent verification**

```bash
sed -n '/updatePlayerProfile/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/libs/tools/src/processor/player/player-processor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q3 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/promotion/src/reward-grant/reward-grant.types.ts.

**Index answer** (12)

- `AdapterDispatchResult (interface)`
- `FreeSpinGrantPayload (interface)`
- `GrantBase (interface)`
- `GrantResult (interface)`
- `GrantRewardRequest (type)`
- `GrantStatus (type)`
- `MudGrantPayload (interface)`
- `PlayerLevelMaintainGrantPayload (interface)`
- `PlayerLevelUpGrantPayload (interface)`
- `PromoCodeGrantPayload (interface)`
- `RewardAdapter (interface)`
- `RewardGrantType (type)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/reward-grant/reward-grant.types.ts
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

**Question**: In FPMS-NT, which functions call `coercePbIntEnum` (defined in apps/user-engagement/src/app-push/backend-app-push/app-push-pb-mappers.ts)? List every caller with its file.

**Index answer** (7)

- `apps/user-engagement/src/app-push/backend-app-push/app-push-pb-mappers.ts:requirePbIntEnum`
- `apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:_executeMulticastMission`
- `apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:_executeOneMission`
- `apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:_executeTopicMission`
- `apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:buildScheduleSummary`
- `apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:pauseAppPushMission`
- `apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:retryAppPushMission`

**Independent verification**

```bash
rg -n --no-heading '\bcoercePbIntEnum\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+coercePbIntEnum\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q6 · callees

**Question**: In FPMS-NT, what does `validateForCreate` (apps/promotion/src/modules/growth-task/services/task-config-validator.ts) call? Name each callee and where it lives.

**Index answer** (9)

- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateAudienceXor`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateCreateStatus`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateFreeSpinPlatformId`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateFrequencies`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateNameAndDisplayName`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validatePopupCopy`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateRewards`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateTaskDaysAndSubTasks`
- `apps/promotion/src/modules/growth-task/services/task-config-validator.ts:validateTimeWindow`

**Independent verification**

```bash
sed -n '/validateForCreate/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/modules/growth-task/services/task-config-validator.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q7 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/promotion/src/skin-fragment/controllers/skin-fragment-admin.controller.ts.

**Index answer** (12)

- `SkinFragmentAdminController (class)`
- `constructor (method)`
- `createActivity (method)`
- `flattenCvErrors (function)`
- `getActivity (method)`
- `listActivities (method)`
- `listFragmentLedger (method)`
- `listRedemptions (method)`
- `pbToLedgerSource (function)`
- `runAutoEndJob (method)`
- `toDate (function)`
- `updateActivity (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/skin-fragment/controllers/skin-fragment-admin.controller.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q8 · callers

**Question**: In FPMS-NT, which functions call `deleteMany` (defined in libs/common/base-repository/base-repository.ts)? List every caller with its file.

**Index answer** (7)

- `apps/livechat/src/database/liveChatConversationDB/livechat-convo-repository.ts:removeConversationData`
- `apps/livechat/src/database/liveChatFaqRepoDB/livechat-faq-repository.ts:removeFaq`
- `apps/livechat/src/database/liveChatFaqSubCategoryDB/livechat-faq-subcategory-repository.ts:removeFaqSubCategory`
- `apps/promotion/src/modules/growth-task/repositories/task-user-target-list.repository.ts:bulkDeleteTickets`
- `apps/promotion/src/physical-gift/repositories/hotel-voucher.repository.ts:deleteByCodes`
- `libs/tools/src/repositories/user-engagement/app-push/app-push-token.repository.ts:deleteManyByTokens`
- `libs/tools/src/repositories/user-engagement/pwa-subscription/pwa-subscription-repository.ts:deleteAuthBatch`

**Independent verification**

```bash
rg -n --no-heading '\bdeleteMany\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+deleteMany\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q9 · callees

**Question**: In FPMS-NT, what does `_findAvailableAgentAndJoinRoom` (apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts) call? Name each callee and where it lives.

**Index answer** (8)

- `apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:agentHmget`
- `apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:get`
- `apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:set`
- `apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:zrange`
- `apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts:_agentAutoJoinRoom`
- `apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts:addChatTransferLog`
- `apps/livechat/src/processor/liveChatMatrix/livechat-matrix-processor.ts:_isMemberInRoom`
- `apps/livechat/src/processor/liveChatMatrix/livechat-matrix-processor.ts:inviteUser`

**Independent verification**

```bash
sed -n '/_findAvailableAgentAndJoinRoom/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q10 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/promotion/src/special-event/controllers/special-event-admin.controller.ts.

**Index answer** (12)

- `SpecialEventAdminController (class)`
- `constructor (method)`
- `queryLuckyDealRecords (method)`
- `queryMilyonaryoJackpotReport (method)`
- `queryPalayokRewardRecords (method)`
- `queryPlayerMissionProgress (method)`
- `queryRedPacketRecords (method)`
- `queryRewardRecords (method)`
- `queryRewardTicketRecords (method)`
- `queryWinsdayBillionReport (method)`
- `queryWinsdayBoostRelationReport (method)`
- `sameInitiator (function)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/special-event/controllers/special-event-admin.controller.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q11 · callers

**Question**: In FPMS-NT, which functions call `findOneByPlatformId` (defined in libs/tools/src/repositories/player/fpms/admin/platform/platform.repository.ts)? List every caller with its file.

**Index answer** (7)

- `apps/admin/src/config/config.service.ts:getConfigV2`
- `apps/admin/src/jackpot/jackpot.service.ts:getPlatformObjId`
- `apps/promotion/src/modules/realtime-task/services/realtime-task-config.resolver.ts:findLevel`
- `apps/promotion/src/reward-grant/services/reward-grant-popup.service.ts:platformObjId`
- `apps/promotion/src/special-event/services/special-event-mission.service.ts:sendTaskCompletionNotifications`
- `apps/recommend/src/recommend.service.ts:getPlatform`
- `apps/user-engagement/src/pwa-notification/pwa-notification.service.ts:sendPWANotificationToPulsar`

**Independent verification**

```bash
rg -n --no-heading '\bfindOneByPlatformId\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+findOneByPlatformId\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.

## Q12 · callees

**Question**: In FPMS-NT, what does `callBackToUser` (apps/user-engagement/src/callback/processors/callback.processor.ts) call? Name each callee and where it lives.

**Index answer** (8)

- `apps/user-engagement/src/callback/processors/callback.processor.ts:checkRateLimits`
- `apps/user-engagement/src/callback/processors/callback.processor.ts:logCallbackSuccess`
- `apps/user-engagement/src/callback/services/callback-queue.service.ts:addCallbackToQueue`
- `libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:getPlayerInfoInternal`
- `libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:getPlatformByPlatformId`
- `libs/tools/src/repositories/player/fpms/admin/black-and-white-list/black-and-white-list.repository.ts:getBlacklistCallbackIpAddress`
- `libs/tools/src/repositories/player/fpms/admin/black-and-white-list/black-and-white-list.repository.ts:getBlacklistPhoneNumber`
- `libs/tools/src/services/phone-cipher/phone-cipher.service.ts:encrypt`

**Independent verification**

```bash
sed -n '/callBackToUser/,/^}/p' /Users/shieng/Desktop/Projects/fpmsnt/apps/user-engagement/src/callback/processors/callback.processor.ts
```

**What to look for**: Read the function body in the verify output and confirm each listed callee really is invoked there.

## Q13 · file_symbols

**Question**: In FPMS-NT, list every function/class/method defined in apps/promotion/src/winsday-billion/services/boost-claim.service.ts.

**Index answer** (12)

- `BoostClaimService (class)`
- `ClaimBoostResult (interface)`
- `claim (method)`
- `constructor (method)`
- `fail (function)`
- `grantAndCache (method)`
- `option (function)`
- `option (function)`
- `optionDetail (method)`
- `optionDetailFromConfig (method)`
- `replay (method)`
- `toResult (method)`

**Independent verification**

```bash
rg -n --no-heading '^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\()|^\s*(public|private|protected)?\s*\w+\s*\(' /Users/shieng/Desktop/Projects/fpmsnt/apps/promotion/src/winsday-billion/services/boost-claim.service.ts
```

**What to look for**: A declaration in the file that the index does not list is a missed symbol. This is the check that catches parser gaps in a language.

## Q14 · callers

**Question**: In FPMS-NT, which functions call `findPlayerProgress` (defined in apps/promotion/src/modules/player-progress/services/player-mission.progress.service.ts)? List every caller with its file.

**Index answer** (7)

- `apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:dailyShareMission`
- `apps/promotion/src/modules/color-land/processors/get-player-color-land-rewards-summary.processor.ts:getPlayerColorLandRewardsSummary`
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:getDiceConfigByConditionType`
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:getPlayerColorLandProgress`
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:getPlayerFirstRemainingDiceToday`
- `apps/promotion/src/modules/color-land/services/player-color-land-progress.service.ts:getPlayerCellCurrentLevel`
- `apps/promotion/src/pulsar/colorland/bet-dice-count/bet-dice-count.consumer.ts:handleMessage`

**Independent verification**

```bash
rg -n --no-heading '\bfindPlayerProgress\s*\(' /Users/shieng/Desktop/Projects/fpmsnt | grep -vE '(const|function|export)\s+findPlayerProgress\b'
```

**What to look for**: Every caller the index lists should appear in the ripgrep output, INCLUDING calls inside the defining file. Extra hits are often a same-named symbol in another file — check the path before calling anything a missed edge.
