# Penguin index evaluation — Opus 5, round 5

> Model: Claude Opus 5 (1M context). Build `5dfb9a54`, DB schema 14, parser
> `tree-sitter-wasm-v8-wrapper-allowlist`. Date 2026-08-30.
> Every answer below comes from the Penguin CLI. No grep, no file reads, no
> outside knowledge of FPMS-NT. Where the index could not answer, I say so.
> I read `index-quality-quiz.md` and the earlier round reports; I did **not**
> open `index-quality-answers.md`.

`penguin` was on PATH, so commands are written as `penguin <verb>`.

**Scope for every Part A answer:** `FPMS-NT @ brazil-v2`, indexed commit
`3f0f1984`, worktree clean, `indexedCommit == headCommit`, `trust.stale = false`.

**Staleness caveat that applies to all of Part A.** `penguin status` prints
`FPMS-NT brazil-v2(live,stale=725)` while `trust` on the same branch reports
`"stale": false, "staleReason": null` and every per-query `freshness` block
reports `"status": "fresh"`. Round 4 reported this exact contradiction; it is
unchanged. This round I established what at least some of the 725 are — see
§5.5 — and they are parser artifacts, not out-of-date data. Two of them landed
inside quiz answers (Q10, Q13) and I have flagged them there.

---

## 1. Summary and scores

I would rely on this index for one thing and not for the others. **Ask it "who
calls X" or "what does X call" against a node id, and it is excellent** — on
`coercePbIntEnum` the caller set (7 symbols) and the call-site set from `search`
(11 lines) reconciled exactly against `evidence.incomingByType.calls: 11`, in
0.65 s across 3,333 files. **Ask it to narrate anything — a request trace, an
entry-point inventory, an onboarding — and it will confidently tell you things
that are not in its own data.** `penguin flow` draws a call tree whose
parent/child edges the graph never supplied; `penguin architecture` reports six
entry points for a repo whose gRPC endpoints it will happily resolve one at a
time; `penguin onboarding` is an empty template. The condition for relying on it
is therefore mechanical: always pass `--repo`, always resolve to a node id
first, and read the JSON's `completeness`/`confidence`/`truncated` fields rather
than the rendered text — those three fields are genuinely well built.

| Dimension | Score | Why that number |
|---|---|---|
| **Accuracy** — is what it tells you true? | **64**/100 | Edge data is right and self-consistent (11 call edges = 11 search occurrences, twice over). Every wrong answer I found came from a *renderer* asserting structure the data lacks: `flow`'s fabricated tree (§5.1, two endpoints), `architecture`'s 6 entry points (§5.2), `explore`'s `tests: []` (§5.3), a `no_match` printed with the ambiguity explanation (§5.4). |
| **Completeness** — does it find everything, or quietly miss things? | **52**/100 | Calls inside callback bodies are not modelled at all, and the consequences are visible: 3 of `deadcode`'s 8 strong candidates in `apps/admin` are provably live (§5.6), and lines inside `it()`/`beforeEach()` belong to no symbol. `penguin node <name>` caps at 20 candidates and omitted the one correct in-repo definition (§5.7). Against that: `truncated` flags are now real and `deadcode` correctly reported `truncated: false` at 77 and `true` at 100. |
| **Honesty** — when it cannot answer, does it say so? | **63**/100 | The best axis, and the round-1–4 fixes hold: ambiguity refuses instead of guessing, unresolved targets return `confidence: low` + `completeness: unknown`, `deadcode` says "candidates" and names its scope. But the honesty is wired into `explore` only. `callers`, `calls`, `context`, `impact` and `deadcode` all emit bare lists with no `completeness` note, and three verbs give three different freshness verdicts for one node (§5.5). |
| **Usability** — how much work to get an answer you can act on? | **54**/100 | Two quiz questions needed 3 commands each because of the disambiguation dance, and one of those (§5.7) dead-ends. `penguin repograph FPMS-NT` prints `150 nodes, 224 edges` and nothing else. To get a subsystem breakdown for B1 I had to pipe `files --json` through my own Python. `explore` has no text renderer — it prints JSON either way. |
| **Speed vs grep + reading files** | **80**/100 | 0.65–0.73 s for `search`/`explore`, 0.30 s for `deadcode` over `apps/admin`, 2.2 s for `architecture`, 3.2 s for `communities`. A complete cross-file caller set in under a second is something grep cannot do at any speed. Docked for the extra round trips ambiguous names cost. |
| **Overall** — would you install this? | **62**/100 | Yes, as a fast caller/callee oracle and lead generator that sits *beside* grep. Not as the thing I hand an unfamiliar repo to and trust the narrative it comes back with. |

**The single change that would move this ten points:** give `flow`'s `steps[]` a
`parentNodeId` and render the actual tree. The JSON today carries only
`{depth, via, …}` — no parent — so the CLI indents each depth-N node under
whichever depth-(N−1) line it printed last, and on both endpoints I traced that
put a TypeScript interface in the position of calling nine to thirteen
functions. `flow` is the verb the brief itself names for "trace a request" and
the one an agent is most likely to paste into a plan. It is the only place I
found where Penguin states something demonstrably false rather than
incomplete. Round 4 reported this defect at §5.4 with the same endpoint; it is
still there. **Fixing it is a schema field and a render loop.** (Runner-up,
worth another ten on Completeness alone: make gRPC routes first-class endpoint
nodes — see §5.2.)

---

## 2. Part A answers

### Q1 · callers of `claimPeriod`

```
answer:
- apps/promotion/src/modules/realtime-task/services/realtime-task-budget.service.ts:60 — checkAndDeductBudget
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:189 — enroll
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:264 — findCycleTask
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:285 — getPlayerTaskView
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:343 — getPlayerTaskBanner
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:386 — resolveLevelUpMultiplier
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:467 — markTaskBannerSeen

tool used: penguin callers claimPeriod --repo FPMS-NT --json
confidence: high
```

Resolved cleanly to `node_1b148fd1` at `realtime-task.service.ts:57`,
`export function claimPeriod(now: Date): string`. `incomingByType.calls: 7`
matches the 7 nodes returned. Line numbers are each **caller's definition line**,
not the call site — no verb returns call-site lines; I got two of them
(`realtime-task.service.ts:192`, `realtime-task-budget.service.ts:75`) only
incidentally from `penguin search`.

### Q2 · callees of `updatePlayerProfile`

```
answer:
- libs/tools/src/processor/player/player-processor.ts:1540 — isPlayerTypeForbidEditProfileFields
- libs/common/common.ts:156 — isAdult
- libs/tools/src/utils/string-utilities/normalize-name.ts:1 — normalizeName
- libs/tools/src/processor/aws/aws-processor.ts:16 — uploadPhotoId
- libs/tools/src/processor/phone/phone-processor.ts:167 — encrypt
- libs/tools/src/multi-transaction/multi-transaction.service.ts:7 — withTransaction
- libs/tools/src/repositories/player/fpms/player/player-info/player-info-repository.ts:231 — update
- libs/tools/src/repositories/player/player-history-update-email/player-history-update-email-repository.ts:20 — bindEmailToPlayer
- libs/tools/src/processor/player/player-processor.ts:1133 — checkAndUpdateIsCompleteInfo

tool used: penguin calls updatePlayerProfile --repo FPMS-NT --json
confidence: medium — this is a lower bound, and I can prove it is not the whole list
```

Nine distinct callees returned, but `evidence.outgoingByType.calls` on the same
response is **15**. Nine distinct targets over fifteen edges is consistent with
repeat call sites, but I cannot confirm that from the index — `calls` returns no
edge multiplicity. Separately, `penguin explore` on any target reports
`completeness.status: lower_bound` ("constructor calls, interface dispatch,
static-method calls and calls inside callback bodies are not modelled"), and
`calls` does **not** carry that field at all. Marked medium for that reason.

### Q3 · symbols in `apps/promotion/src/reward-grant/reward-grant.types.ts`

```
answer:
- apps/promotion/src/reward-grant/reward-grant.types.ts:25 — RewardGrantType (type)
- apps/promotion/src/reward-grant/reward-grant.types.ts:28 — GrantStatus (type)
- apps/promotion/src/reward-grant/reward-grant.types.ts:34 — GrantResult (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:41 — AdapterDispatchResult (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:53 — GrantBase (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:81 — MudGrantPayload (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:99 — FreeSpinGrantPayload (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:107 — PromoCodeGrantPayload (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:120 — PlayerLevelUpGrantPayload (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:148 — PlayerLevelMaintainGrantPayload (interface)
- apps/promotion/src/reward-grant/reward-grant.types.ts:161 — GrantRewardRequest (type)
- apps/promotion/src/reward-grant/reward-grant.types.ts:178 — RewardAdapter (interface)

tool used: penguin filesymbols branch_10012ad4-067a-4749-aafb-7a9c4f5c133d apps/promotion/src/reward-grant/reward-grant.types.ts --json
confidence: high
```

The question asks for "every function/class/method"; this file defines **none**
— all twelve entries are types and interfaces. All `status: fresh`.

### Q4 · dead-code candidates under `apps/admin/`

```
answer: 77 candidates. Scope, quoted from the tool:
  "no inbound calls/references/handles/tests — verify: DI, reflection,
   framework magic, dynamic import, and public entry points are false
   positives. Scope: repo FPMS-NT, under apps/admin."
  scope.branch = branch_10012ad4-067a-4749-aafb-7a9c4f5c133d, truncated = false

tool used: penguin deadcode --repo FPMS-NT --path apps/admin --json
confidence: high on the list; low on the list meaning anything (see §5.6)
```

69 of the 77 carry `fileImportedBy >= 1` — the round-3 annotation correctly
marks these `[file imported by N — likely wired, not dead]`, i.e. NestJS DI and
decorator wiring. The 8 with `fileImportedBy: 0`:

```
- apps/admin/src/main.ts:31 — bootstrap                                   (process entry point)
- apps/admin/src/player/admin-player.service.spec.ts:11 — PlayerClientGrpcMock
- apps/admin/src/player/admin-player.service.spec.ts:16 — createDto
- apps/admin/src/player/admin-player.service.spec.ts:20 — createBaseResponse
- apps/admin/test/e2e/setup-jest-e2e.ts:3 — initEnv
- apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule
- apps/admin/test/unit/admin/admin.service.spec.ts:64 — createUpdatePlatformConfigRequest
- apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — countryResult
```

**At least three of those eight are provably alive**, and the index can prove it
itself — see §5.6. Net genuine findings from this command: zero.

<details><summary>Full 77 (file:line — symbol [fileImportedBy])</summary>

```
- apps/admin/inteceptor/external.module.ts:14 — useFactory [1]
- apps/admin/inteceptor/external.module.ts:48 — ExternalModule [1]
- apps/admin/inteceptor/payment-external.service.ts:18 — constructor [2]
- apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19 — GameRepositoryModule [2]
- apps/admin/libs/repositories/fpms/admin/game/game-repository.ts:9 — constructor [3]
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.module.ts:19 — PlatformAnnouncementRepositoryModule [2]
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:8 — constructor [3]
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13 — findById [3]
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:25 — findOne [3]
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:29 — find [3]
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:36 — update [3]
- apps/admin/libs/repositories/fpms/schemas/game.schema.ts:166 — GameDocument [2]
- apps/admin/libs/repositories/fpms/schemas/platform-announcement.schema.ts:44 — PlatformAnnouncementDocument [2]
- apps/admin/libs/spi/address/sites/base/base-address.provider.ts:12 — BaseAddressProvider [1]
- apps/admin/libs/spi/address/sites/base/base-address.provider.ts:13 — getAddressDetail [1]
- apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:14 — BpAddressProvider [1]
- apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:15 — getAddressDetail [1]
- apps/admin/src/address/address.controller.ts:6 — AddressController [1]
- apps/admin/src/address/address.controller.ts:7 — constructor [1]
- apps/admin/src/address/address.module.ts:11 — AddressModule [1]
- apps/admin/src/address/address.service.ts:10 — constructor [2]
- apps/admin/src/admin/admin.controller.ts:11 — AdminController [1]
- apps/admin/src/admin/admin.controller.ts:12 — constructor [1]
- apps/admin/src/admin/admin.module.ts:80 — AdminModule [1]
- apps/admin/src/admin/admin.service.ts:31 — constructor [3]
- apps/admin/src/admin/admin.service.ts:48 — onModuleInit [3]
- apps/admin/src/admin/admin.service.ts:263 — onModuleDestroy [3]
- apps/admin/src/admin/admin.service.ts:267 — onApplicationShutdown [3]
- apps/admin/src/admin/dto/check-has-permission.dto.ts:21 — constructor [2]
- apps/admin/src/admin/dto/update-platform-config.dto.ts:148 — constructor [3]
- apps/admin/src/config/config.controller.ts:13 — ConfigController [1]
- apps/admin/src/config/config.controller.ts:14 — constructor [1]
- apps/admin/src/config/config.module.ts:27 — ConfigModule [1]
- apps/admin/src/config/config.service.ts:17 — constructor [2]
- apps/admin/src/config/dto/get-config.dto.ts:13 — constructor [2]
- apps/admin/src/config/dto/get-eid-config-by-eid.dto.ts:12 — constructor [2]
- apps/admin/src/config/dto/get-platform-config-by-platform-id.dto.ts:8 — constructor [2]
- apps/admin/src/http-health-check/http-health-check.module.ts:27 — useFactory [1]
- apps/admin/src/http-health-check/http-health-check.module.ts:51 — HttpHealthCheckModule [1]
- apps/admin/src/jackpot/dto/update-live-jackpot-config.dto.ts:20 — JackpotConfigItemDto [2]
- apps/admin/src/jackpot/executors/jackpot.executor.ts:41 — constructor [1]
- apps/admin/src/jackpot/executors/jackpot.executor.ts:48 — onModuleInit [1]
- apps/admin/src/jackpot/executors/jackpot.executor.ts:150 — executeSuccess [1]
- apps/admin/src/jackpot/executors/jackpot.executor.ts:157 — executeReject [1]
- apps/admin/src/jackpot/jackpot-executor.module.ts:18 — useFactory [1]
- apps/admin/src/jackpot/jackpot-executor.module.ts:54 — JackpotExecutorModule [1]
- apps/admin/src/jackpot/jackpot.controller.ts:11 — JackpotController [1]
- apps/admin/src/jackpot/jackpot.controller.ts:12 — constructor [1]
- apps/admin/src/jackpot/jackpot.module.ts:20 — useFactory [1]
- apps/admin/src/jackpot/jackpot.module.ts:28 — JackpotModule [1]
- apps/admin/src/jackpot/jackpot.service.ts:21 — CreateAdminProposalResponse [2]
- apps/admin/src/jackpot/jackpot.service.ts:31 — constructor [2]
- apps/admin/src/jackpot/jackpot.service.ts:37 — checkPendingProposal [2]
- apps/admin/src/main.ts:31 — bootstrap [0]
- apps/admin/src/platform-announcement/dto/delete-player-mail.dto.ts:13 — constructor [2]
- apps/admin/src/platform-announcement/dto/read-player-mail.dto.ts:11 — constructor [2]
- apps/admin/src/platform-announcement/platform-announcement.controller.ts:10 — PlatformAnnouncementController [1]
- apps/admin/src/platform-announcement/platform-announcement.controller.ts:11 — constructor [1]
- apps/admin/src/platform-announcement/platform-announcement.module.ts:17 — PlatformAnnouncementModule [1]
- apps/admin/src/platform-announcement/platform-announcement.service.ts:12 — constructor [2]
- apps/admin/src/platform/dto/get-platform-country.dto.ts:9 — constructor [1]
- apps/admin/src/platform/platform-cache.manager.ts:37 — constructor [5]
- apps/admin/src/platform/platform.controller.ts:10 — PlatformController [1]
- apps/admin/src/platform/platform.controller.ts:11 — constructor [1]
- apps/admin/src/platform/platform.module.ts:13 — PlatformModule [1]
- apps/admin/src/platform/platform.service.ts:14 — constructor [2]
- apps/admin/src/player/admin-player.controller.ts:11 — constructor [2]
- apps/admin/src/player/admin-player.module.ts:11 — AdminPlayerModule [1]
- apps/admin/src/player/admin-player.service.spec.ts:11 — PlayerClientGrpcMock [0]
- apps/admin/src/player/admin-player.service.spec.ts:16 — createDto [0]
- apps/admin/src/player/admin-player.service.spec.ts:20 — createBaseResponse [0]
- apps/admin/src/player/admin-player.service.ts:14 — constructor [4]
- apps/admin/src/player/dto/unbind-player-phone-number.dto.ts:3 — UnbindPlayerPhoneNumberDto [2]
- apps/admin/test/e2e/setup-jest-e2e.ts:3 — initEnv [0]
- apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule [0]
- apps/admin/test/unit/admin/admin.service.spec.ts:64 — createUpdatePlatformConfigRequest [0]
- apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — countryResult [0]
```
</details>

### Q5 · callers of `coercePbIntEnum`

```
answer:
- apps/user-engagement/src/app-push/backend-app-push/app-push-pb-mappers.ts:52 — requirePbIntEnum
- apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:986 — pauseAppPushMission
- apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:1425 — _executeOneMission
- apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:1559 — _executeTopicMission
- apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:1634 — _executeMulticastMission
- apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:1735 — retryAppPushMission
- apps/user-engagement/src/app-push/backend-app-push/backend-app-push.service.ts:1957 — buildScheduleSummary

tool used: penguin callers coercePbIntEnum --repo FPMS-NT --json
confidence: high
```

`incomingByType.calls: 11` over 7 distinct callers. I confirmed the
multiplicity independently: `penguin search coercePbIntEnum --repo FPMS-NT`
returned 13 hits = 1 definition (`app-push-pb-mappers.ts:39`) + 1 import
(`backend-app-push.service.ts:40`) + **exactly 11 call sites**
(`app-push-pb-mappers.ts:53`; `backend-app-push.service.ts:1020, 1432, 1456,
1503, 1563, 1639, 1758, 1761, 1813, 1958`). Two independent lanes of the index
agreeing to the unit is the best evidence of accuracy I found all round.

### Q6 · callees of `validateForCreate`

```
answer: all nine are in the same file, apps/promotion/src/modules/growth-task/services/task-config-validator.ts
- :133 — validateCreateStatus
- :214 — validateNameAndDisplayName
- :223 — validatePopupCopy
- :232 — validateTimeWindow
- :247 — validateFrequencies
- :261 — validateTaskDaysAndSubTasks
- :305 — validateRewards
- :370 — validateFreeSpinPlatformId
- :387 — validateAudienceXor

tool used: penguin calls validateForCreate --repo FPMS-NT --json
confidence: high
```

`outgoingByType.calls: 9` matches the 9 nodes exactly — no hidden multiplicity
here.

### Q7 · symbols in `apps/promotion/src/skin-fragment/controllers/skin-fragment-admin.controller.ts`

```
answer:
- :39 — pbToLedgerSource (function)
- :58 — toDate (function)
- :64 — flattenCvErrors (function)
- :84 — SkinFragmentAdminController (class)
- :87 — constructor (method)
- :93 — createActivity (method)
- :158 — updateActivity (method)
- :254 — getActivity (method)
- :266 — listActivities (method)
- :295 — listFragmentLedger (method)
- :355 — listRedemptions (method)
- :395 — runAutoEndJob (method)

tool used: penguin filesymbols branch_10012ad4-… <path> --json
confidence: high
```

All `status: fresh`. The class spans 84–402 and the last method ends at 401, so
the list covers the file.

### Q8 · callers of `deleteMany`

```
answer:
- apps/livechat/src/database/liveChatConversationDB/livechat-convo-repository.ts:44 — removeConversationData
- apps/livechat/src/database/liveChatFaqRepoDB/livechat-faq-repository.ts:146 — removeFaq
- apps/livechat/src/database/liveChatFaqSubCategoryDB/livechat-faq-subcategory-repository.ts:19 — removeFaqSubCategory
- apps/promotion/src/physical-gift/repositories/hotel-voucher.repository.ts:57 — deleteByCodes
- apps/promotion/src/modules/growth-task/repositories/task-user-target-list.repository.ts:297 — bulkDeleteTickets
- libs/tools/src/repositories/user-engagement/app-push/app-push-token.repository.ts:64 — deleteManyByTokens
- libs/tools/src/repositories/user-engagement/pwa-subscription/pwa-subscription-repository.ts:73 — deleteAuthBatch

tool used: penguin callers deleteMany --repo FPMS-NT          → refused (ambiguous)
           penguin node    deleteMany --repo FPMS-NT          → 20 candidates, none correct  ← §5.7
           penguin search  deleteMany --repo FPMS-NT --json   → node_aff0cc91 (the right one)
           penguin callers node_aff0cc91-1f97-4975-a214-232e5c7bffed --json
confidence: high on the answer; the path to it is broken — see §5.7
```

`incomingByType.calls: 8` over 7 distinct callers. I verified
`node_aff0cc91`'s identity before using it:
`identityKey = repo_c58d58a2…::libs/common/base-repository/base-repository.ts::deleteMany`,
`startLine 290`, `signature "async deleteMany("` — the symbol the question names.
**The tool's own recommended disambiguation command never offers this node.**

### Q9 · callees of `_findAvailableAgentAndJoinRoom`

```
answer:
- apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:60 — get
- apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:63 — set
- apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:90 — zrange
- apps/livechat/src/liveChatRedis/liveChatRedis.service.ts:123 — agentHmget
- apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts:195 — _agentAutoJoinRoom
- apps/livechat/src/processor/liveChatAgent/livechat-agent-processor.ts:412 — addChatTransferLog
- apps/livechat/src/processor/liveChatMatrix/livechat-matrix-processor.ts:330 — _isMemberInRoom
- apps/livechat/src/processor/liveChatMatrix/livechat-matrix-processor.ts:351 — inviteUser

tool used: penguin calls _findAvailableAgentAndJoinRoom --repo FPMS-NT --json
confidence: high
```

`outgoingByType.calls: 8` matches exactly.

### Q10 · symbols in `apps/promotion/src/special-event/controllers/special-event-admin.controller.ts`

```
answer:
- :26 — SpecialEventAdminController (class)
- :29 — constructor (method)
- :45 — queryRedPacketRecords (method)
- :56 — queryRewardRecords (method)
- :70 — queryLuckyDealRecords (method)
- :85 — queryRewardTicketRecords (method)
- :120 — queryPalayokRewardRecords (method)
- :140 — queryMilyonaryoJackpotReport (method)
- :157 — queryWinsdayBillionReport (method)
- :185 — queryWinsdayBoostRelationReport (method)
- :244 — queryPlayerMissionProgress (method)

  NOT included, though the index returns it as a 12th entry:
- :204 — sameInitiator, reported as kind "function", status "stale"

tool used: penguin filesymbols branch_10012ad4-… <path> --json
confidence: high on the eleven; the twelfth is an index artifact
```

**Staleness flagged per rule 4:** `sameInitiator` is the only entry not marked
`fresh`. I resolved it by node id — `penguin explore node_67ae2b7f… --json` —
and its `source` is
`const sameInitiator = rows.every((r) => r.initiatorPlayerId === …)`. That is a
local `const` inside `queryWinsdayBoostRelationReport` (185–240), not a
function/class/method defined in the file. I have excluded it from the answer
and reported the misclassification at §5.5.

### Q11 · callers of `findOneByPlatformId`

```
answer:
- apps/admin/src/config/config.service.ts:86 — getConfigV2
- apps/admin/src/jackpot/jackpot.service.ts:73 — getPlatformObjId
- apps/promotion/src/modules/realtime-task/services/realtime-task-config.resolver.ts:123 — findLevel
- apps/promotion/src/reward-grant/services/reward-grant-popup.service.ts:235 — platformObjId
- apps/promotion/src/special-event/services/special-event-mission.service.ts:2046 — sendTaskCompletionNotifications
- apps/recommend/src/recommend.service.ts:257 — getPlatform
- apps/user-engagement/src/pwa-notification/pwa-notification.service.ts:51 — sendPWANotificationToPulsar

tool used: penguin callers findOneByPlatformId --repo FPMS-NT   → refused (ambiguous)
           penguin node    findOneByPlatformId --repo FPMS-NT   → candidate #20 is the right one
           penguin callers node_13a3a960-a283-45be-8567-68eff378ded6 --json
confidence: high
```

`incomingByType.calls: 7`, matching. Note the target is
`platform.repository.ts:46`, not `:16` as candidates #4/#10 show — those two are
the same path in a *different* repo (`[email-ue]` / `[(detached)]` branches of
FPMS-NT-Auth-Player), listed despite `--repo FPMS-NT`. Correct answer was #20 of
20; one place further down the list and it would have been cut, exactly as
happened in Q8.

### Q12 · callees of `callBackToUser`

```
answer:
- apps/user-engagement/src/callback/processors/callback.processor.ts:111 — checkRateLimits
- apps/user-engagement/src/callback/processors/callback.processor.ts:148 — logCallbackSuccess
- apps/user-engagement/src/callback/services/callback-queue.service.ts:17 — addCallbackToQueue
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:242 — getPlayerInfoInternal
- libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:36 — getPlatformByPlatformId
- libs/tools/src/repositories/player/fpms/admin/black-and-white-list/black-and-white-list.repository.ts:44 — getBlacklistPhoneNumber
- libs/tools/src/repositories/player/fpms/admin/black-and-white-list/black-and-white-list.repository.ts:63 — getBlacklistCallbackIpAddress
- libs/tools/src/services/phone-cipher/phone-cipher.service.ts:135 — encrypt

tool used: penguin calls callBackToUser --repo FPMS-NT   → refused (ambiguous, 14 candidates)
           penguin node  callBackToUser --repo FPMS-NT   → #12 = node_13bf3307 (processor)
           penguin calls node_13bf3307-3b9f-4c64-b57c-233c526526da --json
confidence: high
```

`outgoingByType.calls: 8`, matching. The candidate list again crossed repos
despite `--repo`: #1 was `Server/db_modules/dbPlatform.js:7957 [newzealand]`,
which is the legacy FPMS Node codebase.

### Q13 · symbols in `apps/promotion/src/winsday-billion/services/boost-claim.service.ts`

```
answer:
- :24 — ClaimBoostResult (interface)
- :38 — BoostClaimService (class)
- :41 — constructor (method)
- :50 — claim (method)
- :52 — fail (function, nested inside claim)
- :240 — replay (method)
- :281 — grantAndCache (method)
- :342 — optionDetail (method)
- :352 — optionDetailFromConfig (method)
- :366 — toResult (method)

  NOT included, though the index returns them:
- :253 — option, kind "function", status "stale", startLine == endLine
- :360 — option, kind "function", status "stale"

tool used: penguin filesymbols branch_10012ad4-… <path> --json
confidence: medium — see below
```

**Staleness flagged per rule 4:** the two `option` entries are the only
non-`fresh` ones. Both are almost certainly the same artifact class as
`sameInitiator` in Q10 — one of them has `startLine == endLine == 253`, which no
function declaration has. I have excluded them. I did **not** verify these two
by node id the way I did `sameInitiator`, so I mark this answer medium rather
than high: if they turn out to be genuine nested helpers the list is short by
two. The index gave me no way to tell a nested arrow-function helper from a
`const` binding except by fetching each one's source individually.

### Q14 · callers of `findPlayerProgress`

```
answer:
- apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:44 — dailyShareMission
- apps/promotion/src/modules/color-land/processors/get-player-color-land-rewards-summary.processor.ts:41 — getPlayerColorLandRewardsSummary
- apps/promotion/src/modules/color-land/services/color-land.service.ts:118 — getPlayerColorLandProgress
- apps/promotion/src/modules/color-land/services/color-land.service.ts:404 — getPlayerFirstRemainingDiceToday
- apps/promotion/src/modules/color-land/services/color-land.service.ts:838 — getDiceConfigByConditionType
- apps/promotion/src/modules/color-land/services/player-color-land-progress.service.ts:84 — getPlayerCellCurrentLevel
- apps/promotion/src/pulsar/colorland/bet-dice-count/bet-dice-count.consumer.ts:81 — handleMessage

tool used: penguin callers findPlayerProgress --repo FPMS-NT --json
confidence: high
```

Every caller is in `color-land`, which looked wrong for a symbol defined in
`player-progress/`, so I checked the resolution rather than trusting it:
`penguin node node_af0e90ba… --json` gives
`identityKey = …::apps/promotion/src/modules/player-progress/services/player-mission.progress.service.ts::PlayerMissionProgressService.findPlayerProgress`,
lines 40–69, and `penguin node findPlayerProgress --repo FPMS-NT` reports
`versions: 1`. Unambiguous and correct. `incomingByType.calls: 7`, matching.

---

## 3. Part B write-ups

### B1 · Onboarding to `FPMS-NT`

**The flagship command produces nothing.**

```sh
penguin onboarding FPMS-NT
```
```
# Penguin Onboarding
## 1. 系统边界
- FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt
## 2. 主要 actor 和术语
- 术语来自已索引的 service、endpoint、entity 和 notes.
## 3. 关键请求/事件流程
- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。
…
## 8. 推荐阅读顺序
- Search → Context → Graph → Evidence
```

Eight headings, zero facts about FPMS-NT beyond its path. Round 4 called this a
stub; it is unchanged. Everything below I had to assemble myself.

**Subsystems.** No verb answers this. I built it from `penguin files
FPMS-NT --json` piped through my own Python (`collections.Counter` over the
first two path segments):

| files | area |
|---:|---|
| 1686 | `apps/promotion` |
| 589 | `libs/tools` |
| 293 | `apps/payment` |
| 127 | `apps/user-engagement` |
| 102 | `apps/livechat` |
| 66 | `apps/admin` · `libs/common` |
| 55 | `apps/riskControl` |
| 48 | `apps/push` |
| 46 | `apps/provider` |
| 41 | `apps/offline-casino` |
| 29 | `apps/cms` |
| 22–23 | `apps/promotion-scheduler`, `apps/recommend` |
| ≤15 | `card-system`, `promotion-event-scheduler`, `auth`, `internal`, `player`, and seven `*_scheduler` apps |

3,333 files total. The shape is immediately legible: this is a NestJS monorepo
whose centre of gravity is `apps/promotion` (51% of all files), with
`libs/tools` as the shared data/gRPC-client layer and roughly twenty small
satellite apps, several of which are cron-style schedulers. That is a genuinely
useful day-one orientation — and Penguin has every byte of it, but no verb that
will say it.

**Where to start reading.** `penguin architecture --repo FPMS-NT` ranks hubs by
degree, and its top four are `IsRequired` (339), `getSecret` (300),
`VaultFetcher` (287), `async` (178) — a validation decorator, a secrets fetcher,
and a tracing wrapper. True, and useless for orientation. Filtering
`penguin repograph FPMS-NT --json` to `apps/**` and dropping tests gives the
list I would actually hand a newcomer:

| degree | symbol | file |
|---:|---|---|
| 90 | `PromotionRedisService` | `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:46` |
| 64 | `redeemPhysicalGift` | `apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88` |
| 51 | `playerDailyShareMissionBoosts` | `apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:108` |
| 37 | `playDice` | `apps/promotion/src/modules/color-land/processors/dice.processor.ts:51` |
| 34 | `dispatchLeaderboardMudAndFreespin` | `apps/promotion/src/leaderboard/leaderboard.processor.ts:104` |
| 33 | `getLoginURL` | `apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts:266` |
| 32 | `triggerActiveCampaign` | `apps/promotion/src/modules/growth-task/services/v2-user-task.service.ts:135` |
| 31 | `claim` | `apps/promotion/src/winsday-billion/services/boost-claim.service.ts:50` |
| 28 | `enrollPlayer` | `apps/promotion/src/modules/realtime-task/controllers/realtime-task-internal.controller.ts:105` |

Read as: the domain is promotions/campaigns — physical gifts, a board game
("color-land"), leaderboards, growth tasks, realtime VIP tasks — all coordinated
through one Redis service. `*.processor.ts` is the unit of business logic;
`*.controller.ts` is the transport edge. I would start at
`redeem-physical-gift.processor.ts` and `realtime-task-internal.controller.ts`.

**Busiest entry points — the index gave me a wrong answer here.**
`penguin architecture --repo FPMS-NT` reports `endpoint 6` and lists all six:

```
GET  /healthcheck
POST /internal/vip-cohort/retention-risk
POST /promotion/GetPlayerFreeSpinInfo
POST /provider/handPayKycInfo
POST /provider/handPayKycSubmit
POST /provider/notifyJackpotPlayer
```

Six entry points for a twenty-app microservice estate is not credible, and it
is not what the index holds — see §5.2. `penguin flow enrollPlayer --repo
FPMS-NT` immediately returns two *endpoint nodes* that this count excludes.

**Confidence: medium-low.** The file census and the hub ranking I would stand
behind. The entry-point inventory I would not repeat to anyone.

**What I wanted and did not get:** (1) a subsystem/app breakdown as a verb;
(2) an endpoint listing verb — there is no way to enumerate endpoint nodes, and
my two attempts at `knowledge_graph_query` both returned bare
`{"error":"GRAPH_QUERY_PROJECT_INVALID"}` with no hint of a valid shape;
(3) any notion of churn or recency per subsystem — `penguin timeline` exists but
is commit-level, not "which of these twenty apps is anyone actually touching",
which is the second question a new joiner asks.

### B2 · Trace a request

I traced `gRPC RealtimeTaskInternalController.EnrollPlayer`.

**Getting to it was the first problem.** `penguin explore enrollPlayer --repo
FPMS-NT --json` reports
`routes: [{"route": "gRPC RealtimeTaskInternalController.EnrollPlayer", "via": "direct"}]`.
Feeding Penguin's own output straight back into Penguin fails:

```sh
penguin flow "gRPC RealtimeTaskInternalController.EnrollPlayer" --repo FPMS-NT
```
```
No symbol found for "gRPC RealtimeTaskInternalController.EnrollPlayer", and no gRPC
endpoint "grpc::gRPC RealtimeTaskInternalController.enrollplayer" is indexed.
Check the service/method spelling, or that the provider repo has been indexed.
```

It prefixed `grpc::` onto a string that already began with `gRPC `. The route
string `explore` prints is not a valid `flow` target. The workaround is to
`penguin flow enrollPlayer --repo FPMS-NT`, take the ambiguity list, and pass a
node id — three commands to trace one request:

```sh
penguin flow node_b770ff6a-fc8b-442a-8230-d3d63f0e9c81
```
```
`gRPC RealtimeTaskInternalController.EnrollPlayer` _(endpoint)_
  ↳ handles → `enrollPlayer`
    ↳ calls → `res`, `baselineFor`, `getPlayerInfoForLevelup`, `checkAndDeductBudget`,
              `normalizeStrategy`, `findCycleTask`, `enroll`, `reject`,
              `windowConfigPeriod`, `getLevelUpSummary`, `toNumber`, `hasActiveGrowthTask`
    ↳ references → `EnrollBlockReason`
      ↳ calls → findOne, claimPeriod, hmget, checkAndDeduct, findByPlayerPeriodGroup,
                enroll, getKey, resolveRewardAmount, strategyTaskGroup, markParticipant,
                maintainBlockedByUpgrade, buildGoals, windowExpiry …
```

**What happens on the request, as far as the index supports it.** The gRPC
handler is `enrollPlayer` at
`apps/promotion/src/modules/realtime-task/controllers/realtime-task-internal.controller.ts:105`.
It resolves the player's level baseline (`baselineFor`,
`getPlayerInfoForLevelup`), normalises the requested strategy
(`normalizeStrategy`), looks up the current cycle task (`findCycleTask` →
`claimPeriod`, which keys everything on an SGT-clock `YYYY-MM` string), checks
and reserves campaign budget (`checkAndDeductBudget` in
`realtime-task-budget.service.ts:60`, which composes the pool name as
`${poolBase}-${claimPeriod(new Date())}`), and on success calls `enroll`
(`realtime-task.service.ts:189`) to write the enrolment, or `reject` with an
`EnrollBlockReason`. Redis (`hmget`, `getKey`) and Mongo
(`findOne`, `findByPlayerPeriodGroup`) are both reached. Tests exist:
`explore` reports `tests: 1`.

**Where the chain broke, and how I noticed.** It broke at depth 3, and I noticed
because the output is semantically impossible: `EnrollBlockReason` is reached by
a `references` edge — it is a type — and it is drawn as the parent of thirteen
`calls`. Types do not call things. Dumping the JSON confirmed the renderer
invents the nesting; §5.1 has the proof. So the depth-2 layer of this trace is
real and everything below it is an unordered bag of symbols reachable from
somewhere in the subtree. That is still useful — but it is not the execution
chain the command claims to print, and nothing in the output says so.

### B3 · Change impact on `coercePbIntEnum`

**If I change the signature of `coercePbIntEnum`
(`apps/user-engagement/src/app-push/backend-app-push/app-push-pb-mappers.ts:39`),
these break.** Eleven call sites, with `file:line`:

```sh
penguin callers coercePbIntEnum --repo FPMS-NT --json    # 7 caller symbols, calls: 11
penguin search  coercePbIntEnum --repo FPMS-NT --json    # 13 hits → 11 call sites
penguin impact  coercePbIntEnum --repo FPMS-NT --json    # 18 transitively affected
```

| call site | enclosing symbol |
|---|---|
| `apps/user-engagement/src/app-push/backend-app-push/app-push-pb-mappers.ts:53` | `requirePbIntEnum` (:52) |
| `…/backend-app-push.service.ts:1020` | `pauseAppPushMission` (:986) |
| `…/backend-app-push.service.ts:1432` | `_executeOneMission` (:1425) |
| `…/backend-app-push.service.ts:1456` | `_executeOneMission` |
| `…/backend-app-push.service.ts:1503` | `_executeOneMission` |
| `…/backend-app-push.service.ts:1563` | `_executeTopicMission` (:1559) |
| `…/backend-app-push.service.ts:1639` | `_executeMulticastMission` (:1634) |
| `…/backend-app-push.service.ts:1758` | `retryAppPushMission` (:1735) |
| `…/backend-app-push.service.ts:1761` | `retryAppPushMission` |
| `…/backend-app-push.service.ts:1813` | `retryAppPushMission` |
| `…/backend-app-push.service.ts:1958` | `buildScheduleSummary` (:1957) |

Plus the import at `backend-app-push.service.ts:40` and the definition at `:39`.
`penguin impact` extends this to 18 symbols, adding the seven controller methods
in `backend-app-push.controller.ts` (`:33, :40, :47, :72, :79, :110`) and
`backend-app-push-scheduler.module.ts:41` that reach the callers transitively.
Everything is inside one module, `apps/user-engagement/src/app-push/`.

**How much would I trust this list before actually making the change? Fairly
high — around 85% — and I can say why in numbers rather than vibes.** Three
independent parts of the index agree: `evidence.incomingByType.calls` says 11,
`callers` returns 7 distinct symbols consistent with 11 edges, and the source
lane returns exactly 11 occurrences that are neither the definition nor the
import. Two lanes converging on the same integer is the strongest signal
Penguin gave me all round, and no `truncated` flag was set on any of the three.

**What keeps it off 100:** the whole call graph is declared a lower bound —
`completeness.status: lower_bound`, "calls inside callback bodies are not
modelled" — and §5.6 shows that is not theoretical. A twelfth call site sitting
inside a `.map()` or an `it()` would be absent from `callers` *and* would appear
in `search` only as a hit with `symbol: null`, which is exactly what the round-4
fix now labels rather than mis-attributes. Here the search count and the edge
count matched, which argues no such site exists — but that argument is mine, not
the tool's. Penguin will not tell you "and I checked for callback call sites";
it will only tell you it does not model them. Before shipping I would still
run a compiler over it, which is the honest summary of the whole product: it
tells you where to look, not that you are done looking.

### B4 · Find something wrong

**Finding: the `callback` subsystem is forked across two repos and the copies
have already diverged.**

FPMS-NT holds `apps/user-engagement/src/callback/**`. A separate registered
repo, FPMS-NT-User-Engagement (`repo_7355a03f`), holds the same subsystem at
`src/modules/callback/**`. `penguin node <id> --json` exposes a `contentHash`
per version, which makes the comparison exact:

| symbol | FPMS-NT | FPMS-NT-User-Engagement |
|---|---|---|
| `CallbackController.callBackToUser` | `controllers/callback.controller.ts:26–34`<br>hash `578e078d43f8e625` | `controllers/callback.controller.ts:26–34`<br>hash `578e078d43f8e625` |
| `CallbackProcessor.callBackToUser` | `processors/callback.processor.ts:29–**108**`<br>hash `232d49d9350f31d0` | `processors/callback.processor.ts:29–**106**`<br>hash `55341478aa578dc6` |

The controller is a byte-identical copy — same hash, same line range. The
processor it delegates to is **not**: different hash, and two lines longer on
the FPMS-NT side. So a fork happened, the transport layer is still in lockstep,
and the business logic underneath has started to drift. A fix applied to one
`callBackToUser` will not reach the other, and nothing in either repo would
flag it. The same pattern shows on `deleteMany`
(`libs/common/base-repository/base-repository.ts:290` vs
`src/libs/common/base-repository/base-repository.ts:290`), so this is the whole
shared base being duplicated, not one file.

This is a finding I could not have got from grep in any reasonable time — it
needs content hashing of the same logical symbol across two independently
indexed repos, which is precisely what a code index is for. It is also the one
place all round where Penguin told me something I would not otherwise have known.

**Secondary finding, same session:** 5 of the 6 HTTP endpoints in FPMS-NT have
no related tests by either verb. `penguin flow <ep> --json` → `relatedTests: []`
for `GET /healthcheck`, `POST /provider/handPayKycInfo`,
`POST /provider/handPayKycSubmit`, `POST /provider/notifyJackpotPlayer`. The two
`handPayKyc*` routes are KYC ingest endpoints from a game provider — untested
compliance surface. (`POST /promotion/GetPlayerFreeSpinInfo` does have tests;
`explore` wrongly says it does not — §5.3.)

---

## 4. What worked well

**The two-lane cross-check on `coercePbIntEnum`.** `evidence.incomingByType.calls: 11`,
seven caller symbols from the graph lane, and eleven call-site lines from the
source lane, agreeing exactly. When the graph and the text index converge on an
integer, I believe the answer. This is what the product is for and it delivers.

**`completeness` is a genuinely good piece of design.** Not the existence of the
field — the wording:

```json
{"status":"lower_bound","externalCallCount":0,
 "note":"The calls list is a lower bound: constructor calls, interface dispatch,
 static-method calls and calls inside callback bodies are not modelled, so a short
 list may mean few calls or few visible calls."}
```

"a short list may mean few calls or few visible calls" is the sentence that
stops an agent concluding something is dead. I have not seen another tool in
this category say it. `partial` with a populated `externalCalls`, and `unknown`
with "Nothing resolved for this target, so there is no calls list to describe",
are equally well judged.

**Refusal on ambiguity.** `penguin callers deleteMany --repo FPMS-NT` →
`cannot answer callers for "deleteMany": ambiguous`. `penguin explore
createActivity` → `confidence: {"level":"low"}`, `completeness.status: unknown`,
`diagnostics: ["ambiguous target: 10 matches"]`. The round-1 and round-2 fixes
hold. A tool that refuses is worth more than one that picks the first match.

**`truncated` is real.** `deadcode --path apps/admin` → 77 results,
`"truncated": false`. `--path apps/promotion/src` → 100 results,
`"truncated": true`. That is the round-3 fix doing exactly its job, and it
changed how I wrote two answers.

**`fileImportedBy` on dead-code candidates.** 69 of 77 came back annotated
`[file imported by N — likely wired, not dead]`, which correctly separates
NestJS DI wiring from real candidates and cut my reading from 77 to 8.

**`penguin context` is the readable verb.** The `claimPeriod` pack — signature,
full source, called-by, calls, imported-by files, and a `scope:
FPMS-NT@brazil-v2 3f0f198 (aligned)` footer — is the right shape for handing to
a model. Its one gap is that "Called by" gives bare symbol names with no paths.

**Speed.** 0.30–0.73 s for the symbol verbs over a 3,333-file repo inside a
26-repo database.

**Round-4 defects confirmed fixed** (one line each, as asked): search hits now
carry `nodeId` + `symbol` for the innermost containing symbol, and correctly
carry `null` when no symbol covers that line; `penguin affected
apps/nonexistent/does-not-exist.ts` now refuses with *"no indexed file matches …
in the repo resolved from the working directory"* instead of `changed 0`;
`architecture --repo X` no longer dumps 26 repos.

---

## 5. What did not work

### 5.1 `flow` renders a tree its own data does not contain — **unfixed since round 4**

This is the same defect round 4 filed at its §5.4, on the same endpoint. It is
not in the eleven-fixed list, and it is still there. I re-derived it
independently before reading that report, and then found it a second time on a
different endpoint.

`penguin flow "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT`:

```
  ↳ handles → `triggerRetentionRisk`
    ↳ calls → `run`
    ↳ references → `VipCohortRunResult`
      ↳ calls → `isDisabledBySwitch`
      ↳ calls → `finishRun`
      ↳ calls → `load`
      ↳ calls → `drainPages`     … nine in total
```

The JSON's `steps[]` keys are
`['depth','endLine','filePath','nodeId','nodeType','source','startLine','title','via']`
— **no parent pointer of any kind.** The renderer indents by `depth`, so every
depth-N node hangs off whichever depth-(N−1) line was printed last. Here that is
`VipCohortRunResult`, an interface at
`apps/promotion/src/modules/vip-cohort/interfaces/vip-cohort.interface.ts:133`.

Ground truth from the same database:

```sh
penguin calls node_b639cda6…  # VipCohortRunResult, the printed parent
→ count 0   []

penguin calls node_a02b3be1…  # run, the real parent
→ count 9   ['isVipCohortTraceEnabled','emptyDropCounters','isDisabledBySwitch',
             'isWithinWindow','vipCohortRunLockKey','load','startRun','drainPages','finishRun']
```

An interface with zero callees is drawn calling nine functions, and those nine
are precisely `run`'s callees. Second instance, `gRPC
RealtimeTaskInternalController.EnrollPlayer`: the enum `EnrollBlockReason` is
drawn as the parent of thirteen calls including `findOne`, `hmget` and
`claimPeriod`.

**This is a fourth instance of the shape you asked about.** The other three were
lookups that failed and printed as successes; this is a *relationship the graph
does not store*, printed as one it does. It is worse than those three in one
respect: `callers` printing `(none)` was at least under-claiming. `flow`
over-claims, in the verb your own brief nominates for "trace a request", and
there is no field in the output — no `confidence`, no `completeness`, no
`inferred: true` — that hints the nesting is synthetic. An agent reading this
will write "the enrolment blocked-reason type performs the budget check" into a
design doc, and be wrong.

### 5.2 `architecture` reports 6 entry points for a repo whose gRPC endpoints it can resolve

```sh
penguin architecture --repo FPMS-NT
→ nodes: … endpoint 6
  entrypoints: 6
→ entryPoints (JSON): ["GET /healthcheck", "POST /internal/vip-cohort/retention-risk",
   "POST /promotion/GetPlayerFreeSpinInfo", "POST /provider/handPayKycInfo",
   "POST /provider/handPayKycSubmit", "POST /provider/notifyJackpotPlayer"]
```

All six are HTTP. But endpoint nodes for gRPC exist in the same scope:

```sh
penguin flow enrollPlayer --repo FPMS-NT
→ Multiple symbols found for "enrollPlayer":
  1. endpoint GrowthTaskInternalService.enrollplayer        node:node_1b7efb5e…
  2. endpoint RealtimeTaskInternalController.enrollplayer   node:node_b770ff6a…
```

Two commands, same `--repo`, same branch: one says the repo has six endpoints,
the other hands me two more that are not among them. `penguin explore
enrollPlayer` independently reports
`routes: [{"route":"gRPC RealtimeTaskInternalController.EnrollPlayer","via":"direct"}]`.

For a twenty-app NestJS estate whose transport is overwhelmingly gRPC, an
entry-point inventory of six is a confident wrong negative on the first question
anyone asks a code index. Worse, I could not measure how wrong: **there is no
verb that lists endpoint nodes.** `penguin help` has no `endpoints`; my two
attempts at `knowledge_graph_query` with `start: {nodeType: "endpoint"}` both
returned `{"error":"GRAPH_QUERY_PROJECT_INVALID"}` — an error code that names
no valid shape and offers no remedy, against a schema whose `project` parameter
is declared as an untyped array.

Related: the route string `explore` prints cannot be fed to `flow`. Passing
`"gRPC RealtimeTaskInternalController.EnrollPlayer"` produces *no gRPC endpoint
`"grpc::gRPC RealtimeTaskInternalController.enrollplayer"` is indexed* — the
resolver prefixed `grpc::` onto a string already starting with `gRPC `. Penguin's
output is not valid Penguin input, and the error text exposes the mangling
rather than fixing it.

### 5.3 `explore` says an endpoint has no tests; `flow` on the same endpoint lists two

```sh
penguin explore "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
→ "tests": []

penguin flow "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
→ "relatedTests": [
    "apps/promotion/src/free-spin/processors/test/get-player-free-spin-info.e2e.spec.ts",
    "libs/tools/src/redis2/test/redis2.e2e.spec.ts"]
```

Same target, same scope, same second. `tests: []` is not "I only looked one hop
from the endpoint node" — it is an empty array, which every consumer reads as
"this endpoint is untested". Test coverage is exactly the sort of claim an agent
acts on immediately ("no tests here, I'll write some"), and this one is false.
Either make `explore` walk the chain the way `flow` does, or emit
`tests: null` with a `coverageGaps` entry — anything other than an empty array
that means "I didn't look".

### 5.4 A `no_match` prints the *ambiguity* explanation

```sh
penguin callers zzzNoSuchSymbolXyz --repo FPMS-NT
```
```
cannot answer callers for "zzzNoSuchSymbolXyz": no_match
  the name matches more than one symbol inside FPMS-NT — pass a node id from `penguin search`
```

The status token is right — `no_match` — and then the human-readable line
underneath says the name matches *more than one* symbol. For a string that
matches zero. The round-1 fix ("`callers` reports a failed lookup instead of
printing `(none)`") is half-landed: the machine-readable half is correct, the
half a human or an agent actually reads is wrong, and it sends you off to
disambiguate something that does not exist. Looks like one error template
serving two `resolutionStatus` values.

### 5.5 One node, three verbs, three different verdicts — and the 725

`sameInitiator`, `apps/promotion/src/special-event/controllers/special-event-admin.controller.ts:204`:

| command | verdict |
|---|---|
| `filesymbols <branch> <path> --json` | exists, `kind: "function"`, **`status: "stale"`** |
| `explore sameInitiator --repo FPMS-NT --json` | `focus: null`, **`freshness.stale: true`**, `reason: "trust_unavailable"`, `confidence: low` |
| `explore node_67ae2b7f… --json` | exists, **`freshness.stale: false`**, `reason: null`, `confidence: high` |

Stale, unresolvable, and fresh — for one node, in one scope, in three
consecutive commands. Whichever is right, two of these are wrong.

The node-id lookup also gives the source, and it settles what the "725 stale
symbols" actually are:

```
"signature": "sameInitiator = rows.every(",
"source": "      const sameInitiator = rows.every(\n        (r) =>\n          r.initiatorPlayerId === first.initiatorPlayerId && …"
```

That is a **local `const` binding an arrow callback**, recorded as
`kind: "function"` at file scope. In Q13 the same pattern produced an entry with
`startLine == endLine == 253`. So `penguin status`'s `stale=725` is not 725
out-of-date symbols — it is a population of parser artifacts that the freshness
machinery cannot resolve, and the word "stale" on the status line is actively
misleading against `trust.stale: false` on the same branch. Round 4 reported the
`725 vs false` contradiction; this round adds what the 725 are.

The practical damage: `filesymbols` is the verb behind "list every
function/class/method in this file", and it returns non-functions typed as
`function` and non-resolvable handles. Three of the four Part A `file_symbols`
questions were clean; the other two each carried artifacts I had to fetch
individually, by node id, to exclude.

### 5.6 `deadcode`'s false positives have a cause it does not name, and the index can prove it

`deadcode --repo FPMS-NT --path apps/admin` flags
`apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule
[importedBy=0]` as having no inbound calls or references. Penguin's own search
lane disagrees:

```sh
penguin search createAdminTestingModule --repo FPMS-NT --json
→ admin.service.spec.ts:37  symbol=createAdminTestingModule   (the definition)
→ admin.service.spec.ts:84  symbol=None
→ admin.service.spec.ts:152 symbol=None
```

Two uses, in the same file, and `symbol: null` on both — meaning no symbol node
covers those lines, i.e. they sit inside `describe`/`beforeEach`/`it` callback
bodies. Same for `createUpdatePlatformConfigRequest` (used at :168, :192) and
`PlayerClientGrpcMock` (used at :28). Three of the eight `importedBy=0`
candidates are provably alive; a fourth is `main.ts:31 — bootstrap`, a process
entry point. The command's genuine yield on `apps/admin` is zero, and I only
found that out by running a second command per candidate.

The note `deadcode` prints names "DI, reflection, framework magic, dynamic
import, and public entry points" as the false-positive classes. **It does not
name callbacks**, which is the one that actually fired here — and `explore`'s
`completeness` note names it explicitly. The honesty exists in the codebase; it
just is not wired into the verb that needs it. Adding *"and calls inside
callback bodies (test blocks, `.map()`, promise handlers) are not modelled"* to
that note is a one-line change.

The deeper issue is structural: an entire class of code — everything inside a
callback — belongs to no symbol node. That is most of a spec file, and a
substantial share of any NestJS `useFactory` or array-pipeline code.

### 5.7 The disambiguation path dead-ends — `penguin node` caps at 20, ignores `--repo`, and dropped the right answer

Q8 asked for callers of `deleteMany` in
`libs/common/base-repository/base-repository.ts`. Penguin refuses, correctly,
and tells you what to do:

```
cannot answer callers for "deleteMany": ambiguous
  the name matches more than one symbol inside FPMS-NT — pass a node id from `penguin search`
```

Following that:

```sh
penguin node deleteMany --repo FPMS-NT
→ Multiple symbols found for "deleteMany":
  1.  symbol libs/common/base-repository/base-repository.ts::deleteMany  :299  [email-ue]
  4.  field  Server/const/constMongoMethod.js::<object>::DELETEMANY
  5.  field  Server/db_common/dbOperations.js::model::deleteMany
  7.  symbol libs/common/base-repository/base-repository.ts::deleteMany  :299  [(detached)]
  14. symbol src/libs/common/base-repository/base-repository.ts::deleteMany :290  [brazil-v2]
  … 20 entries, then: "Next step: pick one and re-run with its node id"
```

Three things wrong at once:

1. **`--repo FPMS-NT` is ignored.** `Server/*.js` is the legacy FPMS Node
   codebase; `[email-ue]` and `[(detached)]` are FPMS-NT-Auth-Player branches;
   `src/libs/...` is a third repo's layout. (Same on `findOneByPlatformId` and
   `callBackToUser`, where entry #1 was `Server/db_modules/dbPlatform.js:7957
   [newzealand]`.) `node` is not in the brief's list of verbs `--repo` was fixed
   for, so this is a known gap — but it is the gap sitting directly behind every
   ambiguity refusal.
2. **The list is capped at exactly 20** with no `truncated` marker, no count, and
   a "Next step" line that reads as though the twenty are the candidate set.
3. **The correct answer is not in the twenty.** FPMS-NT's own
   `libs/common/base-repository/base-repository.ts::deleteMany` is
   `node_aff0cc91-1f97-4975-a214-232e5c7bffed` (verified:
   `identityKey = repo_c58d58a2…::libs/common/base-repository/base-repository.ts::deleteMany`,
   line 290, `signature "async deleteMany("`). Twenty other-repo `field` nodes
   crowded it out. I found it only via `penguin search --json`.

So: the tool refuses honestly, tells you exactly which command to run next, and
that command silently omits the thing you asked for. On Q11 the correct
candidate was #20 of 20 — one position from being cut the same way.

Note the irony against round 4: it complained that `search` was a dead end and
that the error message pointed there wrongly. `search` was fixed. **The error
message still points at `search`** — which now works, but is not the
disambiguation verb — while `node`, which is, was left broken.

### 5.8 The honesty fields are wired into one verb only

`completeness` and `confidence` exist on `explore`. They do not exist on
`callers`, `calls`, `impact`, `context` or `deadcode` — the verbs I actually
used for eleven of fourteen quiz questions. `penguin calls updatePlayerProfile`
returns a bare nine-item list; nothing in it says "this is a lower bound". The
best-designed thing in the product is reachable from one command.

Related, `penguin affected --json` carries **no scope information at all**:

```sh
penguin affected src/modules/callback/processors/callback.processor.ts --json
→ keys: ['files','changed','impacted','tests','routes']    # no trust, no scope, no warnings
```

The text output prints `scope: FPMS-NT@brazil-v2 3f0f198 (aligned)` — but only
when you pass `--repo`. Run it without `--repo` and you get
`changed 10 · impacted 6 · tests 3 · routes 1` and no indication of which of 26
repos that refers to. The scope line is printed exactly when you already know
the scope, and withheld exactly when you do not.

### 5.9 Smaller things

- **`penguin repograph FPMS-NT` prints `150 nodes, 224 edges`.** That is the
  entire text output. The `--json` is genuinely good (degree-ranked, no
  `.spec.ts` at the top — the round-2 fix landed). Render three lines of it.
- **`penguin explore` has no text renderer** — it prints JSON with or without
  `--json`. `context` is the readable one. Worth saying so in `help`.
- **`context`'s "Called by" list has no file paths**, only bare symbol names.
  Fine for `claimPeriod`; useless for `claim`, `update`, `get`.
- **Hub lists show unqualified titles.** `architecture --repo FPMS-NT` ranks
  `async` fourth at degree 178. It is real —
  `ExecuteWithSpan.async` in `libs/common/common.ts` — but the display gives you
  `async`, `field`, `expire`, `get`, `set`. Qualify them.
- **`callers`/`calls` return the *caller's definition line*, not the call site.**
  For "what breaks if I change this signature" the call-site line is the useful
  one, and it exists — `search` has it. B3 needed two verbs to assemble what one
  should return.
- **No verb gives a per-app/subsystem breakdown**, though `files --json` has
  every byte needed. I wrote a `collections.Counter` to get B1's table.
- **`communities` ignores `--repo`.** `penguin communities 12 --repo FPMS-NT`
  returns clusters from FPMS-NT-Auth-Player, casino-plus-app, FPMS and
  FPMS-NT-User-Engagement; only 4 of the top 12 are FPMS-NT. Round 4 filed this;
  unchanged. It is the closest thing to a "what are the subsystems" verb, so it
  is the one that most needs scoping.
- **`status`/`architecture` list `FPMS-NT-Auth-Player` three times and
  `FPMS-NT-Shared` twice** as separate repos. Worktrees or duplicate
  registrations, but it makes repo-level counts unreliable and inflates the
  cross-repo candidate lists in §5.7.

### 5.10 On the round-3 rejected claim (`deadcode` and symbol-level `imports` edges)

I think the rejection was correct and I would not reopen it. `architecture`
confirms the edge inventory is file-level: `imports 86745` repo-wide against
`defines 166011`, and `context`'s own section is headed **"Imported by (files)"**
with `(file)` on every entry. There is no symbol-level import edge to count, so
`deadcode` cannot be ignoring one. The real defect in `deadcode` is §5.6, and it
is a different mechanism entirely — missing *call* edges inside callbacks, not
missing *import* edges.

---

## 6. Pros and cons

| | Penguin | grep + reading files |
|---|---|---|
| **Complete caller/callee set** | Sub-second, cross-file, cross-app; edge counts cross-check against a second lane | Hours, and you never know when to stop |
| **Answering "is this the right symbol"** | Ambiguity refusal + `identityKey` + `contentHash` — decisive | Guesswork across 26 repos with repeated names |
| **Cross-repo fork detection** | `contentHash` comparison, two commands (§B4) | Effectively impossible |
| **Knowing what it does not know** | `completeness`, `confidence`, `truncated`, `coverageGaps` — best-in-class *where wired* (§5.8) | You know exactly what you read |
| **Tracing a request** | `flow` prints a tree whose edges are invented (§5.1) | Slow, but the call is on the line in front of you |
| **Entry-point inventory** | Confidently wrong for gRPC (§5.2) | Grep for `@GrpcMethod` — 5 seconds, correct |
| **Dead code** | Zero genuine findings on `apps/admin`; false positives from unmodelled callbacks (§5.6) | Also bad, but you are not misled about why |
| **Onboarding** | An empty template (§B1) | Reading the directory tree beats it |
| **Code inside callbacks** | Belongs to no symbol; invisible to the graph | Visible |
| **Staying current** | `trust` compares indexed vs HEAD commit and says `aligned` | Always current |
| **Cost of a wrong answer** | High — it is formatted like a fact | Low — you are looking at the source |

Net: it replaces grep for *"who touches X"* and adds two capabilities grep does
not have (identity resolution, cross-repo content hashing). It does not yet
replace reading files for *"what happens when this request arrives"*, and the
place it fails at that is the place it is least honest about failing.

---

## 7. Suggestions

Ordered by how much difference they would make.

1. **Put a `parentNodeId` on `flow`'s `steps[]` and render the real tree.**
   *Problem:* §5.1 — the only place Penguin states something demonstrably false,
   in the verb your brief names for tracing requests, unfixed since round 4.
   *Cost:* one field in the traversal result plus a render loop. If the traversal
   genuinely does not know the parent, then say so — print the depth layers as
   flat bulleted groups ("depth 3 · reached from depth 2: …"). A flat list that
   admits it is flat is strictly better than a tree that is wrong.

2. **Make gRPC routes first-class endpoint nodes, and add `penguin endpoints [--repo]`.**
   *Problem:* §5.2 — `architecture` reports six entry points for a repo whose
   surface is gRPC, `flow` cannot accept the route string `explore` prints, and
   nothing can enumerate endpoints to measure the gap. This single change fixes
   B1's first question and B2's addressability at once.
   *Cost:* medium — the endpoint nodes already exist; the counting, the
   `entryPoints` list, and the `grpc::` key normalisation all need to agree.

3. **Fix `penguin node`: honour `--repo`, report the candidate count, set
   `truncated`, and rank in-scope definitions above out-of-scope fields.**
   *Problem:* §5.7 — every ambiguity refusal points at a disambiguation path
   that silently omitted the correct answer. Also change the refusal text to
   point at `penguin node`, not `penguin search`.
   *Cost:* small. A scope predicate, a rank key, and one string.

4. **Wire `completeness` into `callers`, `calls`, `impact`, `context` and
   `deadcode`; add "calls inside callback bodies" to `deadcode`'s note.**
   *Problem:* §5.8, §5.6 — the best-designed feature in the product is reachable
   from one verb, and the verb whose false positives it explains does not carry it.
   *Cost:* small. The text already exists.

5. **Never emit an empty array for something not looked for.** `explore`'s
   `tests: []` on an endpoint that `flow` finds two tests for (§5.3) is the same
   class of defect as `callers` printing `(none)`. Use `null` plus a
   `coverageGaps` entry, or walk the chain.

6. **Return call-site lines from `callers`/`calls`.** *Problem:* §5.9 — "what
   breaks if I change this signature" needs the call site, and B3 took two verbs
   to assemble what one should return. The data is in the source lane already.
   *Cost:* small; add `callSites: [{filePath, line}]` per caller.

7. **Fix the `no_match` message template** (§5.4) and **make `communities`
   honour `--repo`** (§5.9). Both are one-liners with outsized annoyance value.

8. **Add `penguin subsystems <repo>`** — the `files --json` census I built by
   hand in B1. *Problem:* the single most useful onboarding output in this
   report was one I had to compute myself. *Cost:* trivial; the data is already
   in `files`. Fold it into `penguin onboarding` and that command stops being a
   stub.

9. **Model callback bodies.** *Problem:* §5.6 — an entire class of code belongs
   to no symbol, which produces false dead code, missing call edges, and
   `symbol: null` search hits. *Cost:* large, parser-level. Listed last because
   of that, not because it matters least — it is the root of the completeness
   score.

**Wanted and could not find at all:** a way to list endpoints; a way to list
symbols by `kind` or by `status` (I could not enumerate the 725 stale symbols
that `status` advertises); churn or recency per subsystem; and a documented
schema for `knowledge_graph_query`, whose `GRAPH_QUERY_PROJECT_INVALID` names no
valid shape.

---

## 8. How it felt to use

The first ten minutes were genuinely impressive. `penguin callers claimPeriod
--repo FPMS-NT` came back in under a second with seven callers and file paths,
and my instinct to check it — comparing `incomingByType.calls` against the
count, then against `search` occurrences — kept coming back clean. By Q6 I had
stopped double-checking the arithmetic. That is the product working.

Then Q8 asked for `deleteMany` and the experience inverted. The refusal was the
good kind: it told me the name was ambiguous and named the next command. I ran
the next command. Twenty candidates came back, from four different repositories,
despite `--repo FPMS-NT`, and the one I wanted was not among them. I did not
discover that by being clever — I discovered it because I check identity before
using a node id, and none of the twenty had the right path. Recovering meant
going to `search`, reading raw JSON, and matching a `nodeId` off a source
occurrence. Four commands and a detour to answer "who calls this method". The
worst part is that the tool was *helpful* the whole way down; it just pointed at
the wrong door.

The thing I keep turning over is `flow`. It is the prettiest output the tool
produces and the only one I would call dangerous. I noticed it because
`VipCohortRunResult` is obviously a type and types do not call `drainPages` —
but that is domain knowledge doing the work, exactly what the ground rules
forbid me from using. Someone genuinely new to this codebase, which is the
stated use case, has no such alarm. Round 4 filed it. The eleven-fixed list
opens with `completeness.status` and closes with search node ids — real,
careful work on honesty — and this sits outside that list, still printing a tree
it invented. If I were deciding where the next week goes, it would go here and
nowhere else.

What surprised me, in a good way, was `contentHash`. I went looking for a B4
finding expecting to grind through dead code, got nothing from `deadcode`, and
then found the forked-and-drifting `callback` subsystem in two commands because
`penguin node --json` exposes a content hash per symbol version. Same logical
symbol, two repos, one hash identical and one not. That is a class of question I
have no other way to ask, and it is the one moment all round where the index
told me something I could not have got otherwise. It is also, tellingly, not a
feature — it is a field I noticed and repurposed.

What I expected and did not find: `penguin onboarding FPMS-NT`. I ran it first,
because it is the command whose name matches the task, and got eight headings
telling me to run other commands. Everything useful in B1 I assembled from
`files --json` and `repograph --json` with my own Python. The data is all there.

Would I reach for it again? For "who calls this" and "what does this call",
immediately and without hesitation — it is faster and more complete than
anything I would do by hand, and the `completeness` note means I know what I am
holding. For "explain this repo to me" or "trace this request", not yet, and not
because it is incomplete — incomplete is fine and it says so — but because in
those two modes it stops flagging its gaps and starts filling them in.

---

**Written to:** `/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-opus-5-round5.md`
