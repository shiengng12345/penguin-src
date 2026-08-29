# Penguin index evaluation — Opus 5, round 3

**Evaluator:** Claude Opus 5 (1M context), via Claude Code CLI
**Date:** 2026-08-29
**Repo under test:** `FPMS-NT` @ `brazil-v2` `3f0f198` (live, worktree clean, `alignment: aligned`)
**Interface used:** `penguin` CLI on PATH (`/Users/shieng/.local/bin/penguin`). The
`penguin` MCP server was configured in this session, but per the brief I used the CLI
throughout so every claim below is reproducible from a shell.
**Ground rules honoured:** no grep, no `cat` of source files, no reading `index-quality-answers.md`.
Every source line quoted below came out of `explore --json`'s `sources[]` or `search`'s `snippet`.

---

## 1. Summary

Yes, with two hard conditions. Penguin answered 13 of 14 quiz questions correctly and
fast, and on the questions it is built for — "who calls this", "what does this call",
"what does this endpoint reach" — it beat what I could have done with grep, especially
on the cross-service gRPC hop in Q14 that no text search would have found. The two
conditions: **(a) always use `explore --json`, never the specialised `callers` /
`impact` / `context` commands**, because those silently truncate at 100 results, drop
`file:line`, or disagree with `explore` about the same graph; and **(b) treat every
negative result as unproven**, because `deadcode` and `affected` ignore the `imports`
edges that `context` happily reports, which makes them produce confident false
negatives on any class wired by DI or a decorator — I found a live, imported-by-two-
controllers NestJS interceptor listed as dead code.

The honest one-line verdict: the *graph* is good; the *query surface on top of it* is
inconsistent enough that a careful user has to know which three commands to trust.

---

## 2. Part A answers

> Scope note for every answer: `FPMS-NT @ brazil-v2`, indexed commit `3f0f1984b9e4`,
> `worktreeState: clean`, `stale: false`. `penguin status` text prints
> `FPMS-NT brazil-v2(live,stale=725)` which reads as "725 stale", but the JSON is
> `{"staleSymbols": 725, "stale": false, "staleReason": null}` — see §5.1.

### Q1
```
answer:
- apps/promotion/src/budget/budget-base-response.ts:26 — success
- apps/promotion/src/budget/budget-base-response.ts:34 — forbidden
- apps/promotion/src/budget/budget-base-response.ts:42 — internalError
- apps/promotion/src/budget/budget-base-response.ts:50 — notFound
- apps/promotion/src/budget/budget-base-response.ts:58 — unauthorized
- apps/promotion/src/budget/budget-base-response.ts:66 — statusUnspecified
- apps/promotion/src/budget/budget-base-response.ts:74 — illegalArgs
- apps/promotion/src/budget/budget-base-response.ts:82 — alreadyExists
tool used: penguin explore CMSGenBaseResponse --repo FPMS-NT   (→ ambiguous, 2 matches)
          penguin explore node_e8e51538-1f09-436e-92f1-bac9e5221eb5 --json
confidence: high — evidence.incomingByType = {"calls": 8, "defines": 1}; 8 caller
nodes returned, count matches. All 8 are the sibling helpers in the same file.
```
Effort: 2 commands. `--repo FPMS-NT` did **not** disambiguate, because the second
`CMSGenBaseResponse` is *also* in FPMS-NT (`libs/common/base-response.ts:452` — itself
a duplicate-implementation smell). The ambiguity payload did give both candidates with
`filePath` + `startLine`, so the second call was mechanical.

### Q2
```
answer:
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:191 — getRuntimeContext
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:59  — evaluateStateAndResetIfPeriodExpired
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:324       — shouldSkipAccumulate
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:74  — accumulatePlayerDeposit
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:21  — evaluateState
- apps/riskControl/src/antiAddiction/deposit-limit-config.service.ts:122 — isNotConfigured
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:241       — flushStateSnapshot
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:314       — isLimitReached
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:276       — recordDepositLimitChange
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:157 — notifyStateChanged
tool used: penguin explore accumulatePlayerDeposit --repo FPMS-NT   (→ ambiguous, 6 matches)
          penguin explore node_cf76d4d7-08e2-410a-bc9c-04175f5929fb --json
confidence: medium-high for what is listed; the index itself says the list is a
LOWER BOUND. completeness = {"status":"lower_bound"}: constructor calls, interface
dispatch, static calls and calls inside callbacks are not modelled.
```
Effort: 2 commands + one `penguin node` to work out what three of the six "candidates"
were. See §5.2 — three of the six had `filePath: null` and turned out to be `field`
nodes, and the payload simultaneously claimed `resolutionStatus: "resolved"` pointing at
a *seventh* node (the endpoint `DepositLimitService.AccumulatePlayerDeposit`) that was
not in the candidate list at all.

### Q3
```
answer: TWO handlers are registered for GET /healthcheck, not one.
- apps/livechat/src/http-health-check/http-health-check.controller.ts:12 — check
    ↳ calls apps/livechat/src/http-health-check/http-health-check.service.ts:20 — check
      ↳ (index resolves NO further callees; see note)
- libs/tools/src/http-health-check/http-health-check.controller.ts:12 — check
    ↳ calls libs/tools/src/http-health-check/http-health-check.service.ts:35 — check
      ↳ calls libs/common/base-redis.service.ts:717 — ping
      ↳ calls libs/common/base-redis.service.ts:721 — getConnectionStr
tool used: penguin flow "GET /healthcheck" --repo FPMS-NT [--json]
          penguin explore node_e5a33b40-… / node_e271da17-… --json
confidence: high on the two-handler fact and on the libs/tools chain.
LOW on the livechat branch being a leaf — it is not. See below.
```
The index reports `calls: []` and `completeness: "lower_bound"` for the livechat
`check()`. Its own `sources[].code` shows it makes five calls:
`this.mongooseHealth.pingCheck(...)`, `this.typeOrmHealth.pingCheck('postgres')`,
`this.healthCheck.check(checks)`, `redisInstance.ping()`,
`redisInstance.getConnectionStr()`. Two are inside a `.map()` callback (documented
gap), but `this.healthCheck.check(checks)` and the two inside the `for…of` loop are
plain method calls on injected fields. The near-identical `libs/tools` twin *does*
resolve `ping` and `getConnectionStr`. So resolution of `this.<injected>.method()` is
inconsistent between two structurally similar files. Credit where due: the response
did not claim completeness — `lower_bound` was the honest label.

### Q4
```
answer: 12 symbols in apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts
- :10  — LiveChatBotProcessor (class)
- :20  — constructor (method)
- :34  — _initializeChatBotClient (method)
- :41  — create (method)
- :60  — destroy (method)
- :73  — _getChatbotClient (method)
- :83  — _releaseChatbotClient (method)
- :87  — _initBot (method)
- :97  — updateBotAccessToken (method)
- :103 — _getBotMatrixClient (method)
- :110 — delay (function)
- :156 — updateNewAccessToken (method)
tool used: penguin filesymbols brazil-v2 apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts --repo FPMS-NT
confidence: high — all 12 returned status "fresh". One command, no workaround.
```
All 12 are `status: "fresh"`. Note the index returns them **flat with no nesting
information**: from the `--json` line ranges, `LiveChatBotProcessor` spans 10–185, and
`create` (41–59) is nested inside `_initializeChatBotClient` (34–71) while `delay`
(110–111) is nested inside `_getBotMatrixClient` (103–154). There is no `parent` field,
so "list every function/class/method defined in this file" and "list this class's
methods" are indistinguishable in the output — I report them flat as the index does.

### Q5
```
answer: 6 calls leave the repo.
- class-validator — IsEnum        (line 16)
- class-validator — IsArray       (line 19)
- class-validator — ArrayMinSize  (line 20)
- class-validator — ArrayMaxSize  (line 21)
- class-validator — ValidateNested(line 22)
- class-transformer — Type        (line 23)

Is the calls list COMPLETE? NO — and the index says so itself.
completeness = {"status": "partial", "externalCallCount": 6,
  "note": "6 call(s) go to external packages and have no in-repo target — see
   externalCalls. Beyond those, the calls list is a lower bound: constructor calls,
   interface dispatch, static-method calls and calls inside callback bodies are not
   modelled."}
diagnostics = ["6 call(s) go to external packages and cannot be resolved to repo
   symbols — see externalCalls; the calls list is incomplete"]
tool used: penguin explore DynamicThresholdVipConfigDto --repo FPMS-NT --json
confidence: high on the six names/packages/lines; high on "not complete", because
the tool states the exhaustive-ness limit rather than implying completeness.
```
How I know it is incomplete without reading the file: `completeness.status` is the
answer, and `externalCallCount: 6` is reconciled against `externalCalls[]` — 6 entries,
matches. What `partial` cannot tell me is *how much* is missing.

### Q6
```
answer: 77 dead-code CANDIDATES under apps/admin/ (complete list, from --json;
the text renderer stops at 41 and says "… 37 more not shown").
apps/admin/inteceptor/external.module.ts:14 — useFactory
apps/admin/inteceptor/external.module.ts:48 — ExternalModule
apps/admin/inteceptor/payment-external.service.ts:18 — constructor
apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19 — GameRepositoryModule
apps/admin/libs/repositories/fpms/admin/game/game-repository.ts:9 — constructor
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.module.ts:19 — PlatformAnnouncementRepositoryModule
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:8 — constructor
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13 — findById
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:25 — findOne
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:29 — find
apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:36 — update
apps/admin/libs/repositories/fpms/schemas/game.schema.ts:166 — GameDocument
apps/admin/libs/repositories/fpms/schemas/platform-announcement.schema.ts:44 — PlatformAnnouncementDocument
apps/admin/libs/spi/address/sites/base/base-address.provider.ts:12 — BaseAddressProvider
apps/admin/libs/spi/address/sites/base/base-address.provider.ts:13 — getAddressDetail
apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:14 — BpAddressProvider
apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:15 — getAddressDetail
apps/admin/src/address/address.controller.ts:6 — AddressController
apps/admin/src/address/address.controller.ts:7 — constructor
apps/admin/src/address/address.module.ts:11 — AddressModule
apps/admin/src/address/address.service.ts:10 — constructor
apps/admin/src/admin/admin.controller.ts:11 — AdminController
apps/admin/src/admin/admin.controller.ts:12 — constructor
apps/admin/src/admin/admin.module.ts:80 — AdminModule
apps/admin/src/admin/admin.service.ts:31 — constructor
apps/admin/src/admin/admin.service.ts:48 — onModuleInit
apps/admin/src/admin/admin.service.ts:263 — onModuleDestroy
apps/admin/src/admin/admin.service.ts:267 — onApplicationShutdown
apps/admin/src/admin/dto/check-has-permission.dto.ts:21 — constructor
apps/admin/src/admin/dto/update-platform-config.dto.ts:148 — constructor
apps/admin/src/config/config.controller.ts:13 — ConfigController
apps/admin/src/config/config.controller.ts:14 — constructor
apps/admin/src/config/config.module.ts:27 — ConfigModule
apps/admin/src/config/config.service.ts:17 — constructor
apps/admin/src/config/dto/get-config.dto.ts:13 — constructor
apps/admin/src/config/dto/get-eid-config-by-eid.dto.ts:12 — constructor
apps/admin/src/config/dto/get-platform-config-by-platform-id.dto.ts:8 — constructor
apps/admin/src/http-health-check/http-health-check.module.ts:27 — useFactory
apps/admin/src/http-health-check/http-health-check.module.ts:51 — HttpHealthCheckModule
apps/admin/src/jackpot/dto/update-live-jackpot-config.dto.ts:20 — JackpotConfigItemDto
apps/admin/src/jackpot/executors/jackpot.executor.ts:41 — constructor
apps/admin/src/jackpot/executors/jackpot.executor.ts:48 — onModuleInit
apps/admin/src/jackpot/executors/jackpot.executor.ts:150 — executeSuccess
apps/admin/src/jackpot/executors/jackpot.executor.ts:157 — executeReject
apps/admin/src/jackpot/jackpot-executor.module.ts:18 — useFactory
apps/admin/src/jackpot/jackpot-executor.module.ts:54 — JackpotExecutorModule
apps/admin/src/jackpot/jackpot.controller.ts:11 — JackpotController
apps/admin/src/jackpot/jackpot.controller.ts:12 — constructor
apps/admin/src/jackpot/jackpot.module.ts:20 — useFactory
apps/admin/src/jackpot/jackpot.module.ts:28 — JackpotModule
apps/admin/src/jackpot/jackpot.service.ts:21 — CreateAdminProposalResponse
apps/admin/src/jackpot/jackpot.service.ts:31 — constructor
apps/admin/src/jackpot/jackpot.service.ts:37 — checkPendingProposal
apps/admin/src/main.ts:31 — bootstrap
apps/admin/src/platform-announcement/dto/delete-player-mail.dto.ts:13 — constructor
apps/admin/src/platform-announcement/dto/read-player-mail.dto.ts:11 — constructor
apps/admin/src/platform-announcement/platform-announcement.controller.ts:10 — PlatformAnnouncementController
apps/admin/src/platform-announcement/platform-announcement.controller.ts:11 — constructor
apps/admin/src/platform-announcement/platform-announcement.module.ts:17 — PlatformAnnouncementModule
apps/admin/src/platform-announcement/platform-announcement.service.ts:12 — constructor
apps/admin/src/platform/dto/get-platform-country.dto.ts:9 — constructor
apps/admin/src/platform/platform-cache.manager.ts:37 — constructor
apps/admin/src/platform/platform.controller.ts:10 — PlatformController
apps/admin/src/platform/platform.controller.ts:11 — constructor
apps/admin/src/platform/platform.module.ts:13 — PlatformModule
apps/admin/src/platform/platform.service.ts:14 — constructor
apps/admin/src/player/admin-player.controller.ts:11 — constructor
apps/admin/src/player/admin-player.module.ts:11 — AdminPlayerModule
apps/admin/src/player/admin-player.service.spec.ts:11 — PlayerClientGrpcMock
apps/admin/src/player/admin-player.service.spec.ts:16 — createDto
apps/admin/src/player/admin-player.service.spec.ts:20 — createBaseResponse
apps/admin/src/player/admin-player.service.ts:14 — constructor
apps/admin/src/player/dto/unbind-player-phone-number.dto.ts:3 — UnbindPlayerPhoneNumberDto
apps/admin/test/e2e/setup-jest-e2e.ts:3 — initEnv
apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule
apps/admin/test/unit/admin/admin.service.spec.ts:64 — createUpdatePlatformConfigRequest
apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — countryResult

scope covered: repo FPMS-NT, branch brazil-v2, path prefix apps/admin.
Definition used by the tool: "no inbound calls/references/handles/tests".
tool used: penguin deadcode --repo FPMS-NT --path apps/admin --json
confidence: high that these 77 have no inbound call/reference/handles/tests edge.
LOW that any of them is actually dead. This list is dominated by framework-managed
symbols and I would not act on a single entry without verification.
```
Breakdown of the 77 by why they are almost certainly false positives:
~24 `constructor`s (called by `new`, which the index documents as unmodelled),
11 NestJS `@Module` classes, 6 `@Controller` classes, 4 `useFactory` providers,
4 lifecycle hooks (`onModuleInit` / `onModuleDestroy` / `onApplicationShutdown`),
`apps/admin/src/main.ts:31 bootstrap` (the process entry point), 6 helpers defined
inside `*.spec.ts` files, and 2 Mongoose `…Document` type aliases. The tool's own note
lists exactly these hazards ("verify: DI, reflection, framework magic, dynamic import,
and public entry points are false positives"), which is honest — but a list where the
warning applies to roughly 70 of 77 rows is not a usable signal. See §5.4.

### Q7
```
answer:
- apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:19 — addPlayerFreeSpin
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:182 — dispatchFreeSpin
- apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:30 — dispatch
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:65 — grantFreeSpin
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — dispatchReward
- apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88 — redeemPhysicalGift
- apps/promotion/src/special-event/services/special-event-mission.service.ts:1731 — claimTaskReward
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:457 — grantFreeSpin
tool used: penguin explore addPlayerFreeSpin --repo FPMS-NT   (→ ambiguous, 10 matches)
          penguin node <8 candidate ids>   (to discard the 8 pathless ones)
          penguin explore node_c628b4a7-1f02-4608-a8f7-75236f29d1a0 --json
confidence: high on the list — evidence.incomingByType = {"calls": 8, "defines": 1},
8 callers returned, counts reconcile, truncated = [].
```
Effort: **10 commands.** Eight of the ten "candidates" had `filePath: null` and every
one turned out to be a `field` node named `addPlayerFreeSpin`. I had to run
`penguin node` on each to discard it. See §5.2.

Also flagged: `confidence.level: "low"`. That is misleading here — `provenance` shows
the *only* non-EXTRACTED edge is a single `reads_field` INFERRED at 0.45 out of 118
edges. All 14 `calls` edges are `EXTRACTED / confidence 1`. See §5.3.

### Q8
```
answer (in-repo callees, 10):
- libs/tools/src/repositories/player/fpms/logs2/open-promo-code-template/open-promo-code-template-repository.ts:16 — findActiveOpenTemplate
- libs/tools/src/clickhouse/pcr-clickhouse.service.ts:54 — query
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:16 — findByProposalId
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:190 — getPlayerLevelWithPlayerLevelObjId
- libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:195 — DeductPlayerCredit
- apps/promotion/src/event-bus/producer.routes.ts:31 — emitEvent
- libs/common/common.ts:1399 — warn
- libs/tools/src/fpms-internal-server/fpms-internal-server.service.ts:173 — createProposal
- libs/common/common.ts:1397 — log
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:27 — addUsedEvent
plus 4 calls that leave the repo (@snsoft/proposal-sdk):
- proposalSDK.getProposalTypeList (line 1317)
- proposalSDK.getProposalData     (line 1332)
- proposalSDK.getProposalData     (line 1338)
- proposalSDK.getProposalData     (line 1407)
tool used: penguin explore applyOpenPromoCode --repo FPMS-NT --json
          penguin calls node_1ea2bee8-96d9-4550-a9ba-9c4a6e74d10b --json (cross-check)
confidence: high on the 10 named; completeness = "partial" (lower bound beyond the
4 external calls).
```
One reconciliation note: `evidence.outgoingByType.calls = 11` but the list has 10
entries. `penguin calls` returns the same 10 distinct nodes. So `evidence` counts
*edges* and the list is *deduplicated nodes* — a symbol called twice from two lines
appears once. Not wrong, but the two numbers being in the same payload without a label
made me spend a command proving it.

### Q9
```
answer:
handler:
- apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:45 — triggerRetentionRisk
what it calls next (depth 2):
- apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101 — run
  (plus a `references` edge to apps/promotion/src/modules/vip-cohort/interfaces/vip-cohort.interface.ts:133 — VipCohortRunResult, the return type)
then run() reaches (depth 3):
- vip-cohort-runner.service.ts:314 — isDisabledBySwitch
- vip-cohort-run.repository.ts:43  — finishRun
- vip-cohort.constants.ts:219      — vipCohortRunLockKey
- vip-cohort-config.service.ts:52  — load
- vip-cohort-runner.service.ts:80  — isWithinWindow
- vip-cohort-run.repository.ts:25  — startRun
- vip-cohort.constants.ts:78       — emptyDropCounters
- vip-cohort.constants.ts:381      — isVipCohortTraceEnabled
- vip-cohort-runner.service.ts:334 — drainPages
(all under apps/promotion/src/modules/vip-cohort/)
tool used: penguin flow "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT --json
confidence: high on handler and on run(); high on the depth-3 set as a lower bound.
```
Caveat that matters: the **text** rendering of this flow is wrong. It prints the
depth-3 calls indented under `VipCohortRunResult` (the last depth-2 line, a *type
reference*), producing nonsense such as `VipCohortRunResult ↳ calls → isDisabledBySwitch`.
The `--json` `steps[]` is a flat depth list with no parent pointer; the text renderer
indents by depth and thereby invents parentage. See §5.6.

### Q10
```
answer: 12 symbols in apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts
- :18  — LiveChatConvoProcessor (class)      [fresh]
- :20  — constructor (method)                [fresh]
- :35  — updateConversationReview (method)   [fresh]
- :62  — updateConversationTag (method)      [fresh]
- :97  — getConversationTag (method)         [fresh]
- :113 — _endConversation (method)           [fresh]
- :213 — storeConversationData (method)      [fresh]
- :300 — _createConversation (method)        [fresh]
- :466 — getConversationList (method)        [fresh]
- :527 — data (function)                     ** STALE **
- :553 — updateConversationTagList (method)  [fresh]
- :563 — tagObjects (function)               ** STALE **
tool used: penguin filesymbols brazil-v2 apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts --repo FPMS-NT --json
confidence: high for the 10 fresh ones. For `data` and `tagObjects` I am passing on
the staleness rather than presenting them as current — the index labels them
"status": "stale", so I cannot say they exist in the working tree today.
```
Note the two stale entries sit *inside* fresh methods by line range
(`data` 527–536 ⊂ `getConversationList` 466–551; `tagObjects` 563–566 ⊂
`updateConversationTagList` 553–588), i.e. they are nested arrow functions from an
older parser pass. See §5.1 — the branch-level `trust.stale` is `false` while 725
symbols in this repo carry `status: "stale"`.

### Q11
```
answer: the index reports 6 external calls —
- @nestjs/common — ExecutionContext (line 20)
- @nestjs/common — CallHandler      (line 20)
- rxjs          — Observable        (line 20)
- rxjs          — map               (line 24)
- rxjs          — catchError        (line 31)
- rxjs          — of                (line 35)

Correction from the index's OWN source payload: the first three are NOT calls.
sources[].code line 20 is the signature:
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
ExecutionContext / CallHandler / Observable are TYPE ANNOTATIONS. Only map,
catchError and of are call expressions.

Is the calls list COMPLETE? NO, in both directions.
- Over-reports: 3 of the 6 "external calls" are type positions (above).
- Under-reports: the same source shows context.getHandler(), next.handle(), .pipe(),
  this.logger.error(...) and new CommonPb.BaseResponse({...}) — none appear in
  externalCalls or calls. calls = [] entirely.
- The index says as much: completeness = {"status":"partial","externalCallCount":6}.
tool used: penguin explore intercept --repo FPMS-NT --json  (→ ambiguous, 14 matches)
          penguin explore GrpcBaseResponseInterceptor.intercept --json
          penguin explore node_a39de83e-e269-470b-a4e8-aa451ec598ba --json
confidence: high on the six entries as reported; high on "not complete"; high on the
type-annotation misclassification because the index handed me the source that proves it.
```
Also on this one response, two contradictory diagnostics ship together:
`"6 call(s) go to external packages … the calls list is incomplete"` **and**
`"\"intercept\" is indexed but has no outgoing calls/references — it may be a
terminal/leaf symbol, or its callees aren't indexed."` It cannot be both. See §5.5.

### Q12
```
answer:
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66 — dispatchMud
- apps/promotion/src/mud/controllers/mud.internal.controller.ts:18 — addPlayerMud
- apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:155 — addPlayerMudToRewardRecordBatch
- apps/promotion/src/reward-grant/adapters/mud-grant.adapter.ts:24 — dispatch
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:107 — grantMud
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — dispatchReward
- apps/promotion/src/special-event/services/special-event-mission.service.ts:2323 — claimTaskRewardByTaskId
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:504 — grantMud
tool used: penguin explore addPlayerMudDisbursement --repo FPMS-NT --json
confidence: high — resolved on the first try (unique name), confidence.level "high",
evidence.incomingByType {"calls": 8, "defines": 1, "tests": 1}, truncated [].
```
The single cleanest question of the fourteen: one command, unambiguous, self-consistent.

### Q13
```
answer (in-repo callees, 10):
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1404 — incrementMessageDedup
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1415 — checkAndAddEventSession
- libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:36 — getPlatformByPlatformId
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:242 — getPlayerInfoInternal
- libs/tools/src/manager/player-level-cache/player-level-cache-manager.ts:41 — getPlayerLevelByPlayerLevelObjId
- libs/tools/src/repositories/common/proposal-type/proposal-type-repository.ts:18 — getProposalTypeByName
- libs/common/common.ts:258 — getStartAndEndDate
- apps/promotion/src/leaderboard/leaderboard.service.ts:365 — getTotalRewardCountForDay
- libs/common/common.ts:1236 — createGrpcMetadataWithTrace
- libs/common/common.ts:1399 — warn
plus 2 calls that leave the repo (@snsoft/proposal-sdk):
- proposalSDK.getProposalData  (line 693)
- proposalSDK.createProposal   (line 756)
tool used: penguin explore createLeaderBoardRewardProposal --repo FPMS-NT --json
confidence: high on the 12 named; completeness = "partial" so the list is a lower bound.
```
`evidence.outgoingByType.calls = 11` vs 10 listed — same edge-vs-node dedup as Q8.

### Q14
```
answer:
- apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20 — getPlayerFreeSpinInfoRestful  (handler)
  ↳ apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117 — execute
  ↳ apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11 — transformRestfulReqToNt
then execute() reaches:
  ↳ libs/tools/src/redis2/redis2.service.ts:986 — getPlayerFreeSpinClaimed
  ↳ libs/common/transformer.util.ts:7 — transformUnknownToNt
  ↳ get-player-free-spin-info.processor.ts:177 — buildVerifyFreeSpinPlayerData
  ↳ .../strategies/verify-free-spin-strategy.factory.ts:12 — createStrategy
  ↳ libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206 — getFreeSpinPlayerInfo
then getFreeSpinPlayerInfo() reaches:
  ↳ libs/common/base-redis.service.ts:300 — smembers
  ↳ player-client-grpc.ts:160 — catchGrpcError
  ↳ player-client-grpc.transformer.ts:8 — transformGetFreeSpinPlayerInfoResPbToNt
  ↳ invokes → gRPC PlayerService.GetFreeSpinPlayerInfo  (CROSS-SERVICE HOP)
     ↳ apps/player/src/player/controllers/player-internal.controller.ts:49 — getFreeSpinPlayerInfoRes
tool used: penguin flow "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
confidence: high. This is the index at its best — the `invokes` edge from the gRPC
client stub into the server-side handler in a different app is something grep cannot
give you.
```
Two blemishes in the same payload: at depth 5 the steps include `player` and `proto`
with `filePath: null` and `via: "handles"` (junk nodes), and
`apps/player/src/player/controllers/player-internal.controller.ts` appears three times
at :49, :70 and :95 all titled `getFreeSpinPlayerInfoRes` — the index does not tell me
which of the three actually handles this route.

---

## 3. Part B write-ups

### B1 · Onboarding to FPMS-NT

**First move — the purpose-built command is empty.**
```
$ penguin onboarding FPMS-NT
# Penguin Onboarding
## 1. 系统边界
- FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt
## 2. 主要 actor 和术语
- 术语来自已索引的 service、endpoint、entity 和 notes。
## 3. 关键请求/事件流程
- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。
...
## 8. 推荐阅读顺序
- Search → Context → Graph → Evidence
```
Every section except the repo path is a static instruction to run a different command.
Running `penguin onboarding FPMS-CCMS` returns the identical document with one line
changed. This is a template, not generated onboarding. See §5.7.

**What I actually assembled, and how.**

```
$ penguin architecture --repo FPMS-NT
repos: FPMS-NT(1br)
nodes: field 102009 · symbol 14435 · file 3306 · log_site 3027 · topic 438 ·
       entity 80 · service 18 · websocket_event 11 · endpoint 6
edges: writes_field 110431 · reads_field 99587 · defines 13710 · imports 11272 ·
       calls 10650 · references 7976 · emits_log 2903 · passes_field 1796 ·
       tests 1620 · publishes 1167 · throws 1046 · uses 258 · invokes 127 ·
       subscribes 68 · handles 7
hubs: IsRequired, getSecret, VaultFetcher, async, PromotionRedisService, …
entrypoints: 6
```

```
$ penguin files FPMS-NT --json   # 3333 files, bucketed by top-two path segments
 1686  apps/promotion       589  libs/tools        293  apps/payment
  127  apps/user-engagement 102  apps/livechat      66  apps/admin
   66  libs/common           55  apps/riskControl   48  apps/push
   46  apps/provider         41  apps/offline-casino 29  apps/cms
   23  apps/promotion-scheduler  22  apps/recommend  15  apps/card-system
   13  apps/promotion-event-scheduler  10  apps/auth  10  apps/internal
    8  apps/livechat_scheduler   5  apps/{cms,recommend,user-engagement}_scheduler
    4  apps/live-draw-event-scheduler  4  apps/player  3  apps/scraper-schedule
```

**The orientation I would write for day one:**

> FPMS-NT is a NestJS monorepo, ~3,300 indexed TypeScript files, one branch indexed
> (`brazil-v2`). It is *not* evenly weighted: **`apps/promotion` is half the repo**
> (1,686 of 3,333 files, 51%). Everything else is a rounding error by comparison —
> `apps/payment` (293) and `apps/user-engagement` (127) are the only other apps above
> 100 files.
>
> Two shared libraries carry the whole estate: `libs/tools` (589 files — gRPC clients,
> repositories, Vault, Redis, guards, tracing) and `libs/common` (66 files, but
> `libs/common/common.ts` and `libs/common/base-redis.service.ts` are the two most
> connected files in the repo). If you break something in `libs/tools`, you break
> every app.
>
> The three symbols with the highest graph degree, i.e. the things you cannot avoid:
> `libs/tools/src/validators/is-required.ts:20 IsRequired` (degree 339),
> `libs/tools/src/vault/vault-fetcher.ts:126 getSecret` (300, **299 inbound call
> edges**) and its class `VaultFetcher` (287). Practical consequence: config comes from
> Vault everywhere, so `getSecret` is the seam every service passes through.
> Next tier: `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:46
> PromotionRedisService` (90) and `libs/common/base-redis.service.ts:357 expire` (73).
>
> Where I would start reading, in order:
> 1. `libs/tools/src/vault/vault-fetcher.ts` — how anything is configured.
> 2. `libs/common/base-redis.service.ts` + `apps/promotion/libs/redis/promotion-redis/`
>    — Redis is the shared state layer; both healthcheck chains end here.
> 3. One complete promotion vertical, top to bottom. `apps/promotion/src/mud/` is the
>    right size: `mud.internal.controller.ts` → `processors/add-mud/add-mud-processor.ts`
>    → `dividend`, `promotion-redis`, `disbursement-client-grpc`, and it has a spec file.
>    `penguin affected apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts`
>    prints `changed 7 · impacted 29 · tests 4 · routes 3` with the three gRPC routes
>    named — that one command is the best 10-second map of a vertical Penguin gives you.
> 4. `libs/tools/src/client-grpc/` — this repo talks to sibling services (Player,
>    Payment, Provider) exclusively through these stubs, and Penguin models the hop.

**Confidence: medium.** The file census and the hub ranking are solid and I would
stand behind them. The subsystem *narrative* is inference from file counts and degree,
not from anything the index asserts.

**What the index did not tell me that I wanted:**

1. **The entry points.** This is the biggest gap for onboarding, and the brief's own
   question ("which are the busiest entry points") is the one I cannot answer.
   `architecture --repo FPMS-NT` reports `endpoint 6` and `handles 7`. That is wrong by
   at least two orders of magnitude. `BudgetController` alone has 16 handler methods,
   and I confirmed three of them individually carry routes:
   ```
   $ penguin explore "BudgetController.createCampaignBudgetPool" --json
     routes: [{"route":"gRPC BudgetAdminService.CreateCampaignBudgetPool","via":"direct"}]
     incoming: {"defines":1,"handles":1,"tests":1}
   $ penguin explore "BudgetController.listCampaignBudgetPools" --json
     routes: [{"route":"gRPC BudgetAdminService.ListCampaignBudgetPools","via":"direct"}]
   $ penguin explore "BudgetController.exportCampaignDispatchRecords" --json
     routes: [{"route":"gRPC BudgetAdminService.ExportCampaignDispatchRecords","via":"direct"}]
   ```
   So `handles` edges exist in bulk; the repo-scoped aggregate counts them as 7.
   And there is **no command that lists a repo's endpoints at all** — `flow` needs the
   exact route string, and `search` cannot find endpoint nodes:
   ```
   $ penguin search "FrontendColorLandService" --repo FPMS-NT --json
     Counter({'source_occurrence': 1})     # source lane only; no endpoint/service hit
   ```
   To find an endpoint you must already know its name. For a new joiner that is exactly
   backwards.
2. **Ownership and churn.** `penguin recent --repo FPMS-NT` → `(no results)`;
   `penguin timeline 5 --repo FPMS-NT` → `(no commits indexed)`. The global graph has
   6,790 `commit` nodes, so other repos have history — FPMS-NT does not. No "what
   changed lately", no "who touched this".
3. **Module clustering.** `penguin communities` is the obvious tool for "what are the
   subsystems" and it is unusable here — see §5.8, it ignores `--repo` entirely.
4. **Anything about *why*.** No architecture decisions, no service responsibilities.
   Fair — that is a notes feature, and this repo has no notes.

### B2 · Trace a request

I traced two, because the first one broke and the second one is where Penguin shines.

**Trace 1 — `GET /healthcheck` (the chain broke).**
```
$ penguin flow "GET /healthcheck" --repo FPMS-NT
`GET /healthcheck` _(endpoint)_
  ↳ handles → `check`
  ↳ handles → `check`
    ↳ calls → `check`
    ↳ calls → `check`
      ↳ calls → `getConnectionStr`
      ↳ calls → `ping`
```
Six identically-named nodes, no paths. The text output is unreadable. `--json` resolves it:
```
1 check apps/livechat/src/http-health-check/http-health-check.controller.ts 12 handles
1 check libs/tools/src/http-health-check/http-health-check.controller.ts    12 handles
2 check apps/livechat/src/http-health-check/http-health-check.service.ts    20 calls
2 check libs/tools/src/http-health-check/http-health-check.service.ts       35 calls
3 getConnectionStr libs/common/base-redis.service.ts 721 calls
3 ping             libs/common/base-redis.service.ts 717 calls
```
Two independent controllers both mount `@Controller('healthcheck')`; `flow` merges them
into one tree. I had to run `explore` on each of the four nodes to learn which
controller pairs with which service:
```
$ penguin explore node_2d0fdeda-… --json   # livechat controller
  CALLS (1): apps/livechat/src/http-health-check/http-health-check.service.ts:20 — check
$ penguin explore node_52f87080-… --json   # libs/tools controller
  CALLS (1): libs/tools/src/http-health-check/http-health-check.service.ts:35 — check
```

**Where it broke, and how I noticed.** The `libs/tools` service resolves two callees
(`ping`, `getConnectionStr` on `base-redis.service.ts`). The `apps/livechat` service
resolves **zero**:
```
$ penguin explore node_e5a33b40-96eb-42ff-a4c8-45a3f11baeb1 --json
  CALLS (0)
  externalCalls: []
  completeness: {"status":"lower_bound", "externalCallCount":0}
  evidence.outgoingByType: {"emits_log":2,"passes_field":1,"reads_field":15,"writes_field":5}
```
I noticed because a `check()` with zero callees cannot be doing a health check. The
index's own `sources[].code` for that node shows five calls:
`this.mongooseHealth.pingCheck(...)`, `this.typeOrmHealth.pingCheck('postgres')`,
`this.healthCheck.check(checks)`, `redisInstance.ping()`, `redisInstance.getConnectionStr()`.

Two are inside a `.map()` callback, which `completeness` explicitly documents as
unmodelled. But `this.healthCheck.check(checks)` sits at statement level, and
`redisInstance.ping()` / `.getConnectionStr()` are inside a plain `for…of` — and the
*twin file* resolves exactly those two method names against `base-redis.service.ts`.
So the failure is not a documented category: resolution of `this.<injectedField>.method()`
works in one file and not in a near-identical one. If I had trusted the graph I would
have concluded this healthcheck touches nothing.

To Penguin's credit: it said `lower_bound` rather than claiming completeness. That
label is what let me catch it. This is the "what changed since last round" fix earning
its keep.

**Trace 2 — `POST /promotion/GetPlayerFreeSpinInfo` (the chain held, across services).**
```
$ penguin flow "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
1 getPlayerFreeSpinInfoRestful  apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20  handles
2 execute                       apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117  calls
2 transformRestfulReqToNt       .../get-player-free-spin-info.transformer.ts:11  calls
3 getPlayerFreeSpinClaimed      libs/tools/src/redis2/redis2.service.ts:986  calls
3 buildVerifyFreeSpinPlayerData .../get-player-free-spin-info.processor.ts:177  calls
3 createStrategy                .../strategies/verify-free-spin-strategy.factory.ts:12  calls
3 getFreeSpinPlayerInfo         libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206  calls
4 smembers                      libs/common/base-redis.service.ts:300  calls
4 catchGrpcError                player-client-grpc.ts:160  calls
4 gRPC PlayerService.GetFreeSpinPlayerInfo   —   invokes      ← cross-service hop
5 getFreeSpinPlayerInfoRes      apps/player/src/player/controllers/player-internal.controller.ts:49  handles
```
**What happens on the request:** the REST controller in `apps/promotion` normalises the
request DTO, the processor reads the player's already-claimed free-spin set out of
Redis (`redis2.service.ts:986 getPlayerFreeSpinClaimed`, and `base-redis.service.ts:300
smembers` underneath, so it is a Redis SET), picks a verification strategy through a
factory, then calls the Player service over gRPC via the generated client stub — and
Penguin follows that hop into `apps/player`'s internal controller, a different NestJS
app. That last edge is the thing I could not have gotten from grep in one step, and it
is the strongest argument for the tool.

**Where this one wobbled:** depth 5 includes two junk steps (`player` and `proto`, both
`filePath: null`, `via: "handles"`), and `getFreeSpinPlayerInfoRes` appears three times
in `player-internal.controller.ts` at :49, :70 and :95 with nothing distinguishing which
handles this route.

### B3 · Change impact

**Target:** `addPlayerMudDisbursement` — `apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts`
(node `node_15366be1-1abc-43ff-9106-acc3e496a4c2`), signature
`async addPlayerMudDisbursement(payload: AddMudDto)`.

**If I change its signature, these break (direct callers, 8):**
```
apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66   — dispatchMud
apps/promotion/src/mud/controllers/mud.internal.controller.ts:18                  — addPlayerMud
apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:155                — addPlayerMudToRewardRecordBatch
apps/promotion/src/reward-grant/adapters/mud-grant.adapter.ts:24                  — dispatch
apps/promotion/src/winsday-billion/services/reward-grant.service.ts:107           — grantMud
apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47    — dispatchReward
apps/promotion/src/special-event/services/special-event-mission.service.ts:2323   — claimTaskRewardByTaskId
apps/promotion/src/winsday-billion/services/post-win-share.service.ts:504         — grantMud
```
**Transitive blast radius, 20 symbols** (`penguin impact … --json`; the 8 above plus):
```
apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:149                        — addPlayerMudToRewardRecord
apps/promotion/src/pulsar/reward-dispatch-mud/reward-dispatch-mud.consumer.ts:60          — handleBatch
apps/promotion/src/winsday-billion/services/reward-grant.service.ts:50                    — grant
apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts:34 — claimColorLandTaskReward
apps/promotion/src/modules/color-land/processors/dice.processor.ts:51                     — playDice
apps/promotion/src/special-event/services/special-event-mission.service.ts:2309           — claimReward
apps/promotion/src/winsday-billion/services/post-win-share.service.ts:432                 — grant
apps/promotion/src/winsday-billion/services/boost-claim.service.ts:281                    — grantAndCache
apps/promotion/src/modules/color-land/controllers/color-land.controller.ts:155            — claimColorLandTaskReward
apps/promotion/src/modules/color-land/controllers/color-land.controller.ts:103            — rollColorLandDice
apps/promotion/src/special-event/processors/special-event-mission.processor.ts:25         — claimTaskReward
apps/promotion/src/winsday-billion/services/post-win-share.service.ts:212                 — claim
```
**Routes and tests at risk** (`penguin affected`):
```
$ penguin affected apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts --repo FPMS-NT
changed 7 · impacted 29 · tests 4 · routes 3
  route: gRPC MudInternalService.AddPlayerMud
  route: gRPC promotion.v1.FrontendColorLandService.RollColorLandDice
  route: gRPC promotion.v1.FrontendColorLandService.ClaimColorLandTaskReward
```

**How much would I trust this list before actually making the change? Partially — I
would use it as a starting set, never as the stopping condition.** Three concrete
reasons, all measured in this session:

1. **It is not a list of call sites.** The question asks for `file:line` of every call
   site; Penguin gives the *declaration* line of every calling symbol. For
   `special-event-mission.service.ts:2323` that tells me `claimTaskRewardByTaskId`
   starts at line 2323 — the actual call could be 200 lines later, and if it calls
   `addPlayerMudDisbursement` twice I get one row. No command in the CLI exposes
   call-site offsets. For a signature change, that is the number you actually need.
2. **`callers` silently truncates at 100 and ignores `--limit`.** I proved this on the
   repo's biggest seam:
   ```
   $ penguin callers "VaultFetcher.getSecret" --repo FPMS-NT --json
     N = 100    evidence.incomingByType = {"calls": 299, "defines": 1}
     resultStatus: "has_results"     warnings: [FALLBACK_LIVE_BRANCH only]
   $ penguin callers "VaultFetcher.getSecret" --repo FPMS-NT --limit 200 --json   → N = 100
   $ penguin callers "VaultFetcher.getSecret" --repo FPMS-NT --limit 500 --json   → N = 100
   ```
   199 callers dropped, no `truncated` flag, no warning. `penguin impact` behaves the
   same (also caps at 100). `addPlayerMudDisbursement` has only 8 callers so my answer
   above is unaffected — but I only know that because I cross-checked
   `evidence.incomingByType.calls == len(callers)`. **On any hub symbol the `callers`
   command lies by omission.** `explore` does better: it caps callers at 25 but sets
   `truncated: ["callers"]` and `blastRadius` at 100. So the *specialised* command is
   less trustworthy than the general one.
3. **Anything reached by DI or a decorator is invisible.** See B4 — `affected` reports
   `impacted 0` for a file that two controllers import. If `addPlayerMudDisbursement`
   were consumed through a provider token or an interceptor, it would not show up.

What I *would* trust: the 8 direct callers, because `evidence.incomingByType.calls = 8`
reconciles exactly with 8 returned nodes, `truncated` is empty, `confidence.level` is
`high` with zero inferred edges, and `provenance` says all edges are
`origin: parser, method: EXTRACTED, confidence: 1`. That reconciliation ritual —
compare the list length against `evidence` — is the single most useful habit I formed
in this evaluation, and it should not be necessary.

### B4 · Find something wrong

**Finding: `GrpcResponseInterceptor` is duplicated byte-for-byte across two library
roots, both copies are live in production paths, and Penguin's `deadcode` reports both
as dead while `context` reports both as imported.**

This is one code smell and two index defects in the same object, so I am reporting it
as one finding.

**Step 1 — two identical implementations.**
```
$ penguin filesymbols brazil-v2 apps/promotion/libs/interceptor/GrpcResponseInterceptor.ts --repo FPMS-NT
interface StandardResponse         :11
class     GrpcResponseInterceptor   :18
method    intercept                 :21

$ penguin filesymbols brazil-v2 libs/common/interceptor/GrpcResponseInterceptor.ts --repo FPMS-NT
interface StandardResponse         :11
class     GrpcResponseInterceptor   :18
method    intercept                 :21
```
Same symbols, same lines. `explore --json` on both returns identical `sources[].code`:
```ts
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse<T>> {
    return next.handle().pipe(
      map((data) => {
        // Wraps the return value standard fields
        return { status: 200, message: 'Success', data } as StandardResponse<T>;
      }),
    );
  }
```
Identical down to the comment. Both have identical edge profiles too:
`{"incomingByType":{"defines":1},"outgoingByType":{"reads_field":1,"references":2,"writes_field":4}}`.

**Step 2 — both copies are actually used, by different apps.**
```
$ penguin context node_702a2cc8-…        # apps/promotion copy
### Imported by (files)
- apps/promotion/src/modules/growth-task/controllers/frontend-growth-task.controller.ts
- apps/promotion/src/modules/palayok-blast/controllers/frontend-palayok-blast.controller.ts

$ penguin context node_95e8a786-…        # libs/common copy
### Imported by (files)
- apps/user-engagement/src/callback/controllers/callback.controller.ts
```
`penguin search` confirms the import specifiers differ, which is why nobody has noticed:
```
apps/promotion/src/modules/growth-task/controllers/frontend-growth-task.controller.ts:9
  import { GrpcResponseInterceptor } from '../../../../libs/interceptor/GrpcResponseInterceptor';
apps/promotion/src/modules/palayok-blast/controllers/frontend-palayok-blast.controller.ts:12
  import { GrpcResponseInterceptor } from '../../../../libs/interceptor/GrpcResponseInterceptor';
apps/user-engagement/src/callback/controllers/callback.controller.ts:11
  import { GrpcResponseInterceptor } from '../../../../../libs/common/interceptor/GrpcResponseInterceptor';
```
and that both are wired as real NestJS interceptors on real gRPC methods:
```
apps/promotion/src/modules/palayok-blast/controllers/frontend-palayok-blast.controller.ts:78
  @AuthGuard() @UseGuards(CheckDevice) @UseInterceptors(GrpcResponseInterceptor) …
apps/user-engagement/src/callback/controllers/callback.controller.ts:23
  @GrpcMethod(CallbackController.RECAPTCHA_SERVICE, 'CallbackToUser')
  @UseInterceptors(GrpcResponseInterceptor) …
```
**The real-code problem:** the `{status, message, data}` response envelope for
`apps/promotion` and for `apps/user-engagement` is defined in two places that must stay
in sync by hand. Change the envelope shape in `libs/common` and the promotion frontend
endpoints silently keep the old shape. Given that `frontend-growth-task.controller.ts:54`
already documents an exception ("ClaimTaskReward is NOT wrapped by GrpcResponseInterceptor
and returns the full `{status, message, data}` envelope itself"), envelope drift here is
not hypothetical. `libs/common/interceptor/` is the natural home; the
`apps/promotion/libs/interceptor/` copy should be deleted and its two importers repointed.

**The two index defects this exposes:**
```
$ penguin deadcode --repo FPMS-NT --path apps/promotion/libs/interceptor --json
apps/promotion/libs/interceptor/GrpcResponseInterceptor.ts 18 GrpcResponseInterceptor
apps/promotion/libs/interceptor/GrpcResponseInterceptor.ts 21 intercept

$ penguin deadcode --repo FPMS-NT --path libs/common/interceptor --json
libs/common/interceptor/GrpcResponseInterceptor.ts 18 GrpcResponseInterceptor
libs/common/interceptor/GrpcResponseInterceptor.ts 21 intercept
libs/common/interceptor/PaginationInterceptor.ts 23 PaginationInterceptor
libs/common/interceptor/PaginationInterceptor.ts 27 intercept

$ penguin affected apps/promotion/libs/interceptor/GrpcResponseInterceptor.ts --repo FPMS-NT
changed 3 · impacted 0 · tests 0 · routes 0
$ penguin affected libs/common/interceptor/GrpcResponseInterceptor.ts --repo FPMS-NT
changed 3 · impacted 0 · tests 0 · routes 0
```
Four false-positive dead-code rows and two `impacted 0` verdicts on files that the
**same database** knows are imported — `context` printed the importers from the
`imports` edges (11,272 of them in this repo). `affected` clearly does traverse
something, because on a normal file it works well:
```
$ penguin affected libs/tools/src/vault/vault-fetcher.ts --repo FPMS-NT
changed 6 · impacted 287 · tests 1 · routes 0
```
So `deadcode` and `affected` are call-graph-only and skip `imports`, while `context`
uses `imports`. Same graph, three commands, contradictory answers. See §5.9.

---

## 4. What worked well

**Cross-service gRPC tracing.** The single most valuable thing here. In Q14
`flow` walked `apps/promotion`'s generated client stub
(`libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206
getFreeSpinPlayerInfo`) across an `invokes` edge to
`gRPC PlayerService.GetFreeSpinPlayerInfo` and landed on
`apps/player/src/player/controllers/player-internal.controller.ts:49`. Nothing about
those two files shares a string a grep would connect. 127 `invokes` edges exist in
FPMS-NT; that is a genuine capability, not a nicety.

**Route attribution on a file.** `penguin affected <file>` naming the reachable routes
is the highest information-per-token command in the tool:
```
$ penguin affected apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts --repo FPMS-NT
changed 7 · impacted 29 · tests 4 · routes 3
  route: gRPC MudInternalService.AddPlayerMud
  route: gRPC promotion.v1.FrontendColorLandService.RollColorLandDice
  route: gRPC promotion.v1.FrontendColorLandService.ClaimColorLandTaskReward
```
"If I touch this file, three gRPC endpoints and four test files are in scope" is exactly
the sentence you want before a change.

**The `completeness` field is the round's best fix, and it caught a real error.** In B2
the livechat `check()` returned `calls: []`. With a bare empty list I would have
concluded "leaf node". `completeness: {"status":"lower_bound"}` told me not to, and the
source in the same payload proved five unresolved calls. Confirmed working as described:
I saw `lower_bound`, `partial` and `unknown`, never `complete`.

**`explore --json` bundles enough to self-audit.** Getting `callers`, `calls`,
`sources[].code`, `provenance` (per-edge-type `origin`/`method`/`confidence`/`count`),
`evidence.incomingByType`, `truncated` and `completeness` in one payload is what let me
catch most of the defects in §5 — including the `intercept` type-annotation
misclassification, which I found only because the response handed me the source line
that contradicted its own `externalCalls`. A tool that ships the evidence to disprove
itself is a good tool.

**`Class.method` resolution.** `penguin explore "BudgetController.createCampaignBudgetPool"`
and `"GrpcBaseResponseInterceptor.intercept"` both resolved first try. This turns the
14-way `intercept` ambiguity into a one-liner. It is not in `penguin help` and the
ambiguity error does not suggest it — I found it by guessing.

**Freshness plumbing is real.** `trust` carries `indexedCommit` vs `headCommit`,
`worktreeState`, `dirtyFiles`, `parserVersion`, `schemaVersion`, `reusePercent`, and
every command footers `scope: FPMS-NT@brazil-v2 3f0f198 (aligned)`. On the other repos
in `status --json` I could see `"staleReason": "worktree_dirty"` with the dirty file
named. That is more provenance than most commercial tools give.

**Regression checks from the brief — all four confirmed fixed:**
`completeness.status` never said `complete`; unresolved targets returned
`confidence: low`; `penguin callers` said `(no results)` for a genuinely empty result
(`node_702a2cc8`) and `cannot answer callers for "X"` for a failed lookup;
`--repo` narrowed `explore`, `context`, `flow`, `callers`, `calls`, `impact`,
`filesymbols`, `deadcode` and `architecture`. One command that still ignores it in §5.8.

---

## 5. What did not work

Ordered by how much damage it would do to someone relying on the answer.

### 5.1 `penguin callers` and `penguin impact` silently truncate at 100, and `--limit` does nothing

```
$ penguin callers "VaultFetcher.getSecret" --repo FPMS-NT --json
  len(nodes) = 100
  diagnostics.resultStatus = "has_results"
  diagnostics.evidence.incomingByType = {"calls": 299, "defines": 1}
  warnings = [{"code":"FALLBACK_LIVE_BRANCH", …}]     ← nothing about truncation
  keys = ['mode','nodes','diagnostics','scopeFallback','warnings']   ← no 'truncated'

$ penguin callers "VaultFetcher.getSecret" --repo FPMS-NT --limit 200 --json  → 100
$ penguin callers "VaultFetcher.getSecret" --repo FPMS-NT --limit 500 --json  → 100
$ penguin impact  "VaultFetcher.getSecret" --repo FPMS-NT --json              → 100
```
199 of 299 callers dropped with no signal. This is the worst defect I found, because
the failure mode is a *confident wrong answer* to the question the tool exists to
answer. Refactor `getSecret`, trust `penguin callers`, ship. The truncation machinery
already exists elsewhere — `deadcode` prints `… 37 more not shown — pass --json` and
sets `"truncated": false`; `explore` sets `truncated: ["callers"]`. These two commands
just don't use it.

Related asymmetry: `explore` caps `callers` at **25** (with the flag) while `callers`
caps at 100 (without). Two different caps, opposite honesty.

### 5.2 Ambiguity candidates are polluted with pathless `field` nodes, and the payload contradicts itself

```
$ penguin explore addPlayerFreeSpin --repo FPMS-NT --json
  diagnostics: ["ambiguous target: 10 matches"]
  ambiguousCandidates:
    node_699662e9-…  filePath: null  startLine: null      ← ×8, all `field` nodes
    …
    node_09ea1ebe-…  apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts  19
    node_c628b4a7-…  apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts  34
```
Eight of ten candidates are `field` nodes (an object property named the same as the
method) with no file, no line, nothing to choose by. I had to run `penguin node` on all
eight to find out. Q2 was the same shape (3 of 6 pathless), Q11 the same (3 of 14).
Across the quiz this cost me roughly 12 extra commands.

Worse, the same payload asserts three incompatible things at once:
```
  diagnostics: ["ambiguous target: 6 matches"]
  confidence:  {"level":"low", …}
  focus:       null
  queryDiagnostics.resolutionStatus: "resolved"
  queryDiagnostics.resultStatus:     "has_results"
  queryDiagnostics.target.resolvedNodeId: "node_0a190236-5b60-4668-8e7b-7ac57ba64426"
```
`resolutionStatus: "resolved"` with `focus: null` and an "ambiguous" diagnostic. And
`node_0a190236` is not in `ambiguousCandidates` at all — `penguin node` says it is
`endpoint DepositLimitService.AccumulatePlayerDeposit`. A machine consumer keying off
`resolutionStatus` would take this as a clean resolution to a node the human never saw.
(Contrast Q1/Q11, where the same situation correctly produced
`resolutionStatus: "ambiguous"`, `resultStatus: "query_error"`. So it is inconsistent,
not uniformly wrong.)

### 5.3 `confidence.level` is computed from the minimum edge confidence, so one guessed `reads_field` poisons an otherwise perfect call graph

```
$ penguin explore node_c628b4a7-…  (addPlayerFreeSpin) --json
  confidence:  {"level":"low", "minimum":0.45, "inferredEdges":1, "totalEdges":118}
  provenance:  calls        parser EXTRACTED 1.0   count 14
               defines      parser EXTRACTED 1.0   count 1
               emits_log    parser EXTRACTED 1.0   count 2
               reads_field  parser EXTRACTED 1.0   count 58
               reads_field  parser INFERRED  0.45  count 1     ← the culprit
               references   parser EXTRACTED 1.0   count 1
               writes_field parser EXTRACTED 1.0   count 41
```
Every `calls` edge is EXTRACTED at 1.0. The headline confidence for a *callers* question
is `low` because of one inferred *field read*. Same on `applyOpenPromoCode`:
`{"level":"low","minimum":0.45,"inferredEdges":1,"totalEdges":318}` — 1/318. A signal
that says "low" on a perfect call graph trains users to ignore it, which then also
destroys its value on the cases that are genuinely low.

### 5.4 `deadcode` is unusable at its default settings — ~90% framework false positives

77 candidates under `apps/admin`, of which roughly 70 are structurally impossible to
be dead: ~24 `constructor`s, 11 `@Module` classes, 6 `@Controller` classes, 4
`useFactory` providers, 4 NestJS lifecycle hooks, `main.ts:31 bootstrap`, 6 helpers
declared inside `*.spec.ts`, 2 Mongoose `…Document` type aliases. And per §5.9 the
remaining rows can *also* be false positives for a different reason.

The note ("verify: DI, reflection, framework magic, dynamic import, and public entry
points are false positives") is honest but names hazards that apply to nearly every
row. A list where the caveat covers 90% of the output is not a finding, it is a
worklist for the tool.

### 5.5 Contradictory diagnostics in one response

```
$ penguin explore node_a39de83e-…  (grpc-base-response.interceptor intercept) --json
  diagnostics: [
    "6 call(s) go to external packages and cannot be resolved to repo symbols — see
     externalCalls; the calls list is incomplete",
    "\"intercept\" is indexed but has no outgoing calls/references — it may be a
     terminal/leaf symbol, or its callees aren't indexed."
  ]
```
"It has 6 external calls" and "it has no outgoing calls" in the same array. The second
message is generated from `calls.length == 0` without checking `externalCalls`.

### 5.6 `externalCalls` counts type annotations as calls (and misses real calls)

Same symbol. Reported:
```
  @nestjs/common: ExecutionContext (line 20), CallHandler (line 20)
  rxjs:           Observable (line 20), map (24), catchError (31), of (35)
```
`sources[].code` line 20, from the same response:
```ts
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
```
Three of six are type positions. Meanwhile the visible real calls —
`context.getHandler()`, `next.handle()`, `.pipe(...)`, `this.logger.error(...)`,
`new CommonPb.BaseResponse({...})` — appear in neither `calls` nor `externalCalls`.
So `externalCallCount: 6` is 3 false positives and ~5 false negatives, and it is the
number `completeness.status: "partial"` is computed from. Q5 is unaffected (all six
there are genuine decorator invocations), so this is not uniform — but a
type-annotation-vs-call-expression distinction is not a hard problem for a tree-sitter
pass, and getting it wrong inflates the one number users are told to trust.

### 5.7 `flow`'s text renderer invents parentage

```
$ penguin flow "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT
`POST /internal/vip-cohort/retention-risk` _(endpoint)_
  ↳ handles → `triggerRetentionRisk`
    ↳ calls → `run`
    ↳ references → `VipCohortRunResult`
      ↳ calls → `isDisabledBySwitch`
      ↳ calls → `finishRun`
      …
```
`isDisabledBySwitch` is called by `run`, not by `VipCohortRunResult` — which is an
*interface*, at `vip-cohort.interface.ts:133`. The JSON `steps[]` is a flat list of
`{depth, via}` with no parent id; the renderer indents by depth, so whichever depth-2
node happens to be printed last becomes the apparent parent of every depth-3 node. On
`GET /healthcheck` the same bug merges two independent controller→service chains into
one tree. Anyone reading the text output — which is the default — gets a wrong call
graph. Either emit real parent edges or stop drawing a tree.

Also no `file:line` anywhere in `flow`'s text output, and six nodes named `check` in the
healthcheck rendering. `--json` is mandatory, which makes the readable format the
unusable one.

### 5.8 `penguin communities` ignores `--repo` completely

```
$ penguin communities 5 --repo FPMS-NT   ┐
$ penguin communities 5 --repo FPMS-CCMS ├─ byte-identical output, all three
$ penguin communities 5                  ┘
7130 communities across 119895 connected nodes; top 5:
  #1 (7211) FPMS-NT-Auth-Player — libs/common/enum.ts, libs/common/common.ts, …
  #3 (4948) casino-plus-app — src/utils/index.ts, src/constants/index.ts, …
```
The brief said finding one would be useful — this is it. Asking for FPMS-CCMS's modules
returns a React app's Redux store. Beyond scoping, the clusters are not useful anyway:
7,130 communities where #1 has 7,211 members, labelled only by repo name plus four
member files. For the "what are this repo's subsystems" question this answers nothing.

`penguin onboarding <repo>` has the same shape of problem for a different reason — it
accepts the repo argument, prints its path, and every other section is a static
instruction telling you to run another command. Two of the three commands aimed
squarely at onboarding are non-functional for it.

### 5.9 `deadcode` and `affected` ignore `imports` edges that `context` reports

Full evidence in B4. Summary:
```
context  node_702a2cc8 → "Imported by (files): frontend-growth-task.controller.ts,
                          frontend-palayok-blast.controller.ts"
deadcode --path apps/promotion/libs/interceptor → lists that same class+method as dead
affected apps/promotion/libs/interceptor/GrpcResponseInterceptor.ts → "impacted 0"
```
The repo has 11,272 `imports` edges. `affected` is otherwise good (287 impacted for
`vault-fetcher.ts`), so this is a traversal gap, not a data gap. Consequence: **any
class consumed only via `@UseInterceptors` / `@UseGuards` / `@UseFilters` / a provider
token — which in NestJS is a large fraction of the codebase — reads as dead and as
having zero blast radius.**

### 5.10 `staleSymbols` is reported two contradictory ways, and stale nodes are served as results

```
$ penguin status
FPMS-NT   brazil-v2(live,stale=725)
$ penguin status --json → FPMS-NT.branches[0]
  "staleSymbols": 725,
  "trust": {"stale": false, "staleReason": null, "worktreeState": "clean",
            "indexedCommit": "3f0f198…", "headCommit": "3f0f198…", "changedFiles": 0}
```
The text says `stale=725`; the JSON says not stale. Both are "true" under different
definitions of the word, printed 20 characters apart. Then those 725 orphans get served:
```
$ penguin filesymbols brazil-v2 apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts --json
  {"title":"data","kind":"function","startLine":527,"endLine":536,"status":"stale"}
  {"title":"tagObjects","kind":"function","startLine":563,"endLine":566,"status":"stale"}
  (10 others: "fresh")
```
2 of 12 answers to "list every function defined in this file" are phantoms from an older
parser pass, on a branch whose `trust` says clean and aligned. The text renderer marks
them `(stale)`, which is good — but they should not be in a `filesymbols` result at all
when the file itself was re-parsed at the current commit.

### 5.11 Smaller things, each of which cost me a command

- **`penguin repograph` and `penguin graph` print nothing usable in text mode.**
  `penguin repograph FPMS-NT` → `150 nodes, 224 edges`. `penguin graph <node> 1` →
  `focus + 2 neighbours, 2 edges`. The `--json` for repograph is genuinely useful (top
  150 hubs with degree and `file:line`) — it is simply not rendered.
- **`penguin impact` text mode drops file paths entirely.** Twenty rows of
  `symbol\t<name>` including two `grantMud`, two `grant` and two `claimColorLandTaskReward`
  with no way to tell them apart. `--json` has the paths.
- **`penguin context` drops `file:line` from "Called by" / "Calls".** Bare names only.
  The markdown pack is the most human-readable output and the least actionable.
- **Exit codes are inconsistent on failed lookups.** `no_match` exits 1; `ambiguous`
  exits 0. Both are "I could not answer".
- **The `no_match` message is the ambiguity message.**
  ```
  $ penguin callers ZzzNotARealSymbol --repo FPMS-NT
  cannot answer callers for "ZzzNotARealSymbol": no_match
    the name matches more than one symbol inside FPMS-NT — pass a node id from `penguin search`
  ```
  It matches zero symbols. The hint text is picked without looking at the status code.
- **`callers` / `impact` refuse ambiguous targets without listing the candidates.**
  `explore` returns a structured `ambiguousCandidates[]`; `callers` just says
  `: ambiguous` and tells you to run `penguin search`. You cannot disambiguate from the
  command's own output.
- **`explore` without `--repo` can fail with a nonsense scope error depending on your cwd.**
  ```
  $ cd ~ && penguin explore "VaultFetcher.getSecret" --json
  {"scopeError":{"code":"SCOPE_NOT_FOUND","message":"no live branch is available; pass
   --branch or --commit","candidates":[{"branchName":"(workdir)","commitSha":"(worktree)"}]}}
  ```
  Meanwhile `penguin explore "GrpcBaseResponseInterceptor.intercept"` from the same cwd
  works fine. The message should say "ambiguous across repos, pass --repo", not "no live
  branch is available".
- **`penguin search` returns duplicate hits.** 15 hits for `GrpcResponseInterceptor`,
  12 unique `file:line`. Three exact duplicates.
- **`search --json` puts `filePath`/`startLine` under `locator`**, while every other
  command puts them at the top level of the node. Cost me one round-trip to discover.
- **`explore` default (non-`--json`) output is JSON plus a trailing
  `scope: FPMS-NT@brazil-v2 3f0f198 (aligned)` line**, so it looks parseable and isn't.
  `--json` is clean. Anyone piping the default to `jq` gets `Extra data`.
- **`routes[]` uses `{route, via}` while every other node array uses
  `{nodeId, title, filePath, startLine}`.** A generic renderer over `explore`'s arrays
  prints `None:None — None` for routes.
- **`evidence.*ByType` counts edges; the lists are deduplicated nodes.** Q8 shows
  `calls: 11` next to 10 entries. Both correct, neither labelled — and since the
  list-vs-evidence comparison is the only truncation check available (§5.1), the two
  numbers not being comparable undermines the one workaround users have.
- **`penguin recent` / `penguin timeline` return nothing for FPMS-NT** (`(no results)` /
  `(no commits indexed)`) although the global graph holds 6,790 commit nodes.

---

## 6. Pros and cons

Judged as a daily driver against "grep + read the files", on this estate.

| | Penguin | grep + reading files |
|---|---|---|
| **Who calls X (small symbol)** | ✅ One `explore --json`, complete, with `evidence` to reconcile against | ⚠️ Doable; misses aliased/re-exported call sites |
| **Who calls X (hub symbol)** | ❌ `callers` silently returns 100 of 299 (§5.1) | ✅ `rg -n` gets all 299 with line numbers |
| **Exact call-site line** | ❌ Not modelled anywhere — only the caller's declaration line | ✅ This is grep's home turf |
| **Cross-service gRPC hop** | ✅ The killer feature; `invokes` edges walk into another app | ❌ Effectively impossible |
| **Endpoint → handler → db chain** | ✅ `flow --json` in one call | ⚠️ Several greps, and decorator-based routing is painful |
| **Reading that chain** | ❌ Text renderer invents parentage (§5.7); `--json` mandatory | — |
| **"What routes does this file affect"** | ✅ `affected` names them. Nothing else does this | ❌ |
| **Repo shape / file census** | ✅ `files --json` + `architecture` in seconds | ⚠️ `find`/`tokei`, no graph |
| **Entry-point inventory** | ❌ `endpoint 6` for the whole monorepo; no list-endpoints command | ✅ `rg '@(Get\|Post\|GrpcMethod)'` |
| **Dead code** | ❌ ~90% framework false positives, plus `imports`-blind (§5.4, §5.9) | ⚠️ Manual but at least you see the imports |
| **Module/subsystem clustering** | ❌ `communities` ignores `--repo` (§5.8) | ⚠️ Directory structure, which is honestly fine |
| **Onboarding doc** | ❌ `onboarding` is a static template (§5.7) | — |
| **Freshness / provenance** | ✅ Best-in-class: commit, worktree, parser version, per-edge `origin`/`method`/`confidence` | ❌ You are reading HEAD and hoping |
| **Knowing when it doesn't know** | ✅ `completeness` genuinely saved me in B2 | ❌ Absence of a grep hit tells you nothing |
| **Ambiguous names** | ⚠️ `Class.method` works well; raw names return `field`-node noise (§5.2) | ✅ Path-scoped grep is trivially precise |
| **Token cost** | ✅ Far cheaper than reading 3,300 files | ❌ |
| **Consistency across commands** | ❌ `context`, `deadcode`, `affected`, `explore`, `callers` disagree about the same graph | ✅ One tool, one semantics |

**Net:** I would use Penguin daily *for orientation and for cross-service tracing*, and I
would verify anything load-bearing. Right now the honest usage rule is "use
`explore --json`, `flow --json`, `affected`, `files --json`, and ignore the rest",
which is not a great thing to have to tell a new user about a ten-verb CLI.

---

## 7. Suggestions

Ordered by difference made.

**1. Never truncate silently. (§5.1)** Add `truncated: true` + `totalAvailable: N` to
`callers`, `calls` and `impact`, honour `--limit`, and print
`… 199 more — pass --limit` in text mode. `deadcode` and `explore` already do this;
copy them. *Problem solved:* the one failure mode that produces a confidently wrong
answer to the tool's core question. *Cost:* hours. Do this first, ahead of everything
else on this list.

**2. Teach `deadcode` and `affected` about `imports`. (§5.9, §5.4)** Add `imports` to
the reachability traversal in both, and add a default `--exclude-framework` that drops
`constructor`, `@Module`/`@Controller`/`@Injectable`-decorated classes, `useFactory`
providers, NestJS lifecycle hooks, `main.ts` entry points and symbols declared inside
`*.spec.ts`. Report the excluded count so it is auditable. *Problem solved:* `deadcode`
goes from 77 unusable rows to a handful worth reading, and `affected` stops returning
`impacted 0` for live files. *Cost:* a day, mostly the decorator allowlist.

**3. Store call-site offsets on `calls` edges. (B3)** Every `calls` edge should carry
`{callSiteLine, callSiteCol}`, and `callers`/`explore` should surface them. Today the
answer to "where is it called" is the caller's *declaration* line, which for a method
starting at `special-event-mission.service.ts:2323` is useless. Without this, Penguin
cannot answer the single most common refactoring question. *Cost:* a schema field plus
a re-index; tree-sitter already has the node position.

**4. Fix `confidence.level` to be proportional and edge-type-aware. (§5.3)** Compute it
over the edge types relevant to the query — a `callers` question should not be
downgraded by an inferred `reads_field`. At minimum expose
`confidenceByEdgeType: {calls: 1.0, reads_field: 0.45}` so consumers can pick. *Cost:*
small. *Payoff:* the signal becomes usable instead of noise.

**5. Give `flow` real parent edges. (§5.7)** Add `parentNodeId` to each step and render
the actual tree; drop `references` (type) edges from the default view or put them in a
separate `types[]` array. Print `file:line` in text mode. Right now the default,
human-readable output of the flagship command shows a wrong call graph. *Cost:* small;
the data exists.

**6. Add `penguin endpoints [--repo R]`. (B1, missing capability)** List every endpoint
node with route, handler `file:line`, and inbound-caller count so "busiest entry points"
is answerable. Also make endpoint/service/entity nodes reachable from `penguin search` —
today `search` is source-lane-only, so you cannot find an endpoint unless you already
know its exact route string. And fix `architecture --repo`'s `endpoint`/`handles`
counts, which report 6 and 7 for a monorepo where one controller alone has 16 routed
methods. *Cost:* a day. *Payoff:* the single biggest onboarding gap.

**7. Make disambiguation not cost eight commands. (§5.2)** Three parts: exclude `field`
nodes from `ambiguousCandidates` unless nothing else matches; give every candidate a
`filePath`/`startLine`/`kind`; and make the error text suggest `Class.method`, which
already works and is undocumented. Then make `callers`/`impact` return the same
structured candidate list `explore` does instead of "run `penguin search`". *Cost:*
hours. *Payoff:* this was the largest single tax across the quiz.

**8. Separate type references from call expressions in `externalCalls`. (§5.6)** A
parameter's type annotation is not a call. Either drop them or emit them as
`externalTypes[]`. As it stands `externalCallCount` — the number feeding
`completeness.status` — is inflated. While there, resolve method calls on
externally-typed receivers (`next.handle()`, `.pipe()`) into `externalCalls` instead of
dropping them entirely. *Cost:* a parser pass; medium.

**9. Make one JSON node shape, and make text mode print it. (§5.11)** Every node array
should be `{nodeId, title, kind, filePath, startLine, endLine}` — including `routes[]`
and `search`'s hits (currently nested under `locator`). Every text renderer should print
`path:line — name`. `impact`, `context`, `flow`, `repograph` and `graph` all drop paths
today; `repograph` and `graph` print only counts. Also remove the `scope:` trailer from
non-`--json` `explore` output, or make it a comment. *Cost:* a day of plumbing.
*Payoff:* `--json` stops being mandatory, which halves token cost for agent consumers.

**10. Reconcile the two meanings of "stale". (§5.10)** Print
`brazil-v2(live, aligned, 725 orphaned symbols)` instead of `brazil-v2(live,stale=725)`,
and stop returning `status: "stale"` nodes from `filesymbols` when the file was
re-parsed at the current commit — or at least garbage-collect orphans on re-index.
*Cost:* small.

**11. Make `penguin onboarding` generate something, or delete it. (§5.7)** Everything
needed is already queryable: file census by app, top hubs with degree, endpoint list
(after #6), the shared-library dependency direction, and the biggest verticals. If that
is more work than it is worth, removing the command is better than shipping a template
that tells the user to run four other commands. Same call for `communities` — either
scope it by `--repo` (§5.8) and produce meaningful clusters, or drop it. *Cost:* a day
for a real generator, ten minutes to delete.

**12. Small correctness/ergonomics batch.** Consistent exit codes (`ambiguous` should
not exit 0); use the `no_match` message for `no_match`; drop the "no outgoing calls"
diagnostic when `externalCalls` is non-empty (§5.5); dedupe `search` hits; index git
history for FPMS-NT so `recent`/`timeline` work; label `evidence.*ByType` as edge counts
vs. the deduplicated node lists. *Cost:* an afternoon in aggregate.

**Things I wanted and could not find at all:**
- Call-site line numbers (see #3).
- A repo endpoint inventory (see #6).
- **A "who provides this DI token" query.** In NestJS the real dependency graph runs
  through `@Module` providers and injection tokens, and Penguin models none of it. This
  is why B4's interceptor looks dead. It is also the difference between "usable on a
  NestJS estate" and "usable on TypeScript".
- **A diff-scoped query.** `penguin affected <file>` exists, but not "given my current
  working-tree diff, what is at risk" — which is the actual question before a commit.
- **A path/glob filter on `explore`.** `--repo` is too coarse when a name repeats
  within one repo (Q1). `--path apps/promotion` would have removed most of the
  ambiguity tax.

---

## 8. How it felt to use

The first ten minutes were the best. `penguin status`, `penguin architecture --repo
FPMS-NT`, `penguin files FPMS-NT --json` — and I had the shape of a 3,300-file
monorepo, knew `apps/promotion` was half of it, and knew that `getSecret` and
`VaultFetcher` were the seams everything runs through. Doing that by reading files
would have taken an hour and cost a hundred times the tokens.

Then Q14 happened and I was genuinely impressed. Watching `flow` step off
`player-client-grpc.ts:206` across an `invokes` edge into
`apps/player/src/player/controllers/player-internal.controller.ts:49` is the moment the
tool justifies itself. I would not have found that hop by hand without knowing the proto
service name in advance. That single capability is worth more than everything on my
complaints list.

The frustration is that the good core is wrapped in a command surface that does not
agree with itself. I ended up with a private rulebook — always `--json`; always `--repo`;
never `callers`, use `explore`; never trust text `flow`, read `steps[]`; always compare
`len(callers)` against `evidence.incomingByType.calls`. Every one of those rules is
scar tissue from a specific wrong or unreadable answer. A user who does not build that
rulebook will get 100 of 299 callers and never know.

Where I actually got stuck: the ambiguity loop. `explore addPlayerFreeSpin` returning
ten candidates of which eight are pathless `field` nodes, forcing eight `penguin node`
calls to discard them, is a genuinely bad experience and it happened on four of fourteen
questions. Finding out by accident that `Class.method` resolves cleanly felt like
discovering a hidden door — and it is not in `--help`, and the ambiguity error does not
mention it.

What surprised me, in a good way: `completeness`. I expected the usual empty-array
shrug and instead got `lower_bound` on a `check()` that obviously did something, which
is what made me look at the source and find five unresolved calls. An index that tells
you where its own vision stops is rarer than an index that is complete, and more useful.
The same instinct shows up in `provenance` (per-edge `origin`/`method`/`confidence`) and
in the `scope: … (aligned)` footer. Whoever designed the trust layer was thinking about
the right problem.

What surprised me the other way: `penguin onboarding` printing a template with
instructions to run other commands, and `penguin communities --repo FPMS-CCMS` returning
a React app's Redux store. Both are commands aimed exactly at the "understand unfamiliar
code" claim, and both are currently no-ops.

Would I reach for it again? Yes — for tracing a request across services, for
`affected <file>` before touching something, and for the first hour on an unfamiliar
repo. Not yet for anything where a missing caller means a production incident. Fix the
silent truncation and teach `deadcode`/`affected` about `imports`, and that second
sentence changes.

---

### Appendix — environment

```
$ penguin status
FPMS-NT   brazil-v2(live,stale=725)
  trust: indexedCommit 3f0f1984b9e4337668529a13bad5264501729908 == headCommit
         worktreeState clean · dirtyFiles [] · changedFiles 0 · reusePercent 100
         parserVersion tree-sitter-wasm-v8-wrapper-allowlist · schemaVersion 14
         stale false · staleReason null · staleSymbols 725
$ penguin coverage --repo FPMS-NT
coverage: 3333 admitted · 7 excluded · 0 failed
```
All Part A and Part B answers were taken against this revision. `penguin search` footers
carried `warnings: COVERAGE_INCOMPLETE` (`coverage 3333/3340`), which I am passing on:
7 files are excluded, so no negative result in this report is proof of absence.
