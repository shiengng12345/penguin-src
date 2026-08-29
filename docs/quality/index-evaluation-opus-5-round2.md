# Penguin index evaluation — Opus 5, round 2

> Model: Claude Opus 5 (1M context). Run date 2026-08-29.
> All answers below come from the `penguin` CLI only. No grep, no ripgrep, no
> file reads, no prior knowledge of this codebase. Where I could not answer, I
> say so.
> Repo under test: `FPMS-NT` @ `brazil-v2`, indexed commit `3f0f198`,
> `worktreeState=clean`, `trust.stale=false`, `alignment=aligned`.
> (Caveat on that "fresh" claim: see §5.1 — the tool gives four different
> staleness answers for this same repo state.)

---

## 1. Summary

Yes — with conditions. For **"who calls this"**, **"what does this call"**,
**"what's in this file"** and **"trace this endpoint"**, Penguin gave me correct,
complete-looking, file-and-line answers in one or two commands, and it was
genuinely faster and more trustworthy than grep would have been: the endpoint
trace for `POST /promotion/GetPlayerFreeSpinInfo` followed an `invokes` edge
across a gRPC boundary into a second service, which no grep does. The
`completeness` field — which tells you *out loud* that the calls list is a lower
bound and names the six external calls it could not resolve — is the single best
thing in the product and is why I'd trust it at all.

The conditions are real, though. Symbol resolution is the weakest link: seven of
fourteen quiz targets came back `ambiguous`, and the disambiguation list is
polluted with `field` nodes so badly that `context addPlayerFreeSpin` offered ten
candidates of which eight were mock-object properties in spec files. Call edges
carry **no call-site line number**, so "name every call site with `file:line`"
(B3) is not answerable — you get the enclosing function's start line, and for a
211-line method that is not where the call is. And `flow` silently walked out of
`--repo FPMS-NT` into three separate clones of a *different* repo while stamping
FPMS-NT's `revisionId` onto the result (§5.2) — that one is a correctness bug,
not a polish issue.

Where I'd reach for it: unfamiliar code, blast-radius questions, endpoint
tracing, cross-service hops. Where I wouldn't: anything where I need the exact
line I'm about to edit, and any negative conclusion ("nothing else calls this")
without a second check — because the tool prints `COVERAGE_INCOMPLETE` on every
single search whether or not coverage is actually incomplete, which trains you to
ignore the one warning that matters.

---

## 2. Part A answers

### Q1 · callers of `CMSGenBaseResponse` (apps/promotion/src/budget/budget-base-response.ts)

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
           penguin explore node_e8e51538-1f09-436e-92f1-bac9e5221eb5
confidence: high — freshness.stale=false, incomingByType {calls: 8, defines: 1},
            unresolvedReferenceCount=0, confidence.level=high.
```

Note: the name is ambiguous with a byte-identical copy at
`libs/common/base-response.ts:452`. `explore` refused to pick and listed both,
which is the right behaviour. (That duplication is my B4 secondary finding.)

### Q2 · callees of `accumulatePlayerDeposit` (apps/riskControl/src/antiAddiction/deposit-limit.service.ts:163)

```
answer:
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:191 — getRuntimeContext
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:59  — evaluateStateAndResetIfPeriodExpired
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:324       — shouldSkipAccumulate
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:74  — accumulatePlayerDeposit (DepositLimitStateService)
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:21  — evaluateState
- apps/riskControl/src/antiAddiction/deposit-limit-config.service.ts:122 — isNotConfigured
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:241       — flushStateSnapshot
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:314       — isLimitReached
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:276       — recordDepositLimitChange
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:157 — notifyStateChanged
tool used: penguin explore accumulatePlayerDeposit --repo FPMS-NT  (→ "ambiguous target: 6 matches")
           penguin explore node_cf76d4d7-08e2-410a-bc9c-04175f5929fb
confidence: medium-high — the list is right but explicitly a LOWER BOUND.
```

`completeness.status = "lower_bound"`, with: *"constructor calls, interface
dispatch, static-method calls and calls inside callback bodies are not modelled,
so a short list may mean few calls or few visible calls."* `externalCalls` is
empty, which for a NestJS service with an injected logger I read as "the parser
saw no unresolved import-level calls", not "this method touches nothing external".
I am reporting it as incomplete rather than presenting ten as the total.

### Q3 · `GET /healthcheck`

```
answer:
handler(s) — the endpoint node fans out to TWO handlers:
- apps/livechat/src/http-health-check/http-health-check.controller.ts:12 — check
- libs/tools/src/http-health-check/http-health-check.controller.ts:12     — check
then each calls its own service:
- apps/livechat/src/http-health-check/http-health-check.service.ts:20 — check
- libs/tools/src/http-health-check/http-health-check.service.ts:35    — check
which in turn call:
- libs/common/base-redis.service.ts:721 — getConnectionStr
- libs/common/base-redis.service.ts:717 — ping
tool used: penguin flow "GET /healthcheck" --repo FPMS-NT --json
confidence: high on the members of the chain; MEDIUM on the shape.
```

What the index does **not** tell me: which of the two `check` services the
depth-3 `ping`/`getConnectionStr` calls belong to, because `flow` flattens by
depth and does not record parentage. It also collapses two physically distinct
`@Controller('healthcheck')` classes into one endpoint node with no marker that
this is a route collision rather than one handler with two steps. The plain-text
render is worse still — it prints `↳ handles → check` twice with no file paths at
all, so without `--json` you cannot tell the two apart.

`relatedTests: []` — no tests reach this endpoint.

### Q4 · symbols in `apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts`

```
answer:
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
tool used: penguin filesymbols branch_10012ad4-067a-4749-aafb-7a9c4f5c133d \
             apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts
confidence: high — single command, all statuses "fresh", no warnings.
```

Caveat on `delay` at :110: it is emitted as `kind=function` sitting between two
class methods, which is the same shape Penguin uses for `const x = ...` locals
inside a method body (see Q10). I cannot tell from the index whether this is a
real module-level function or an inline binding, and the index does not expose
containment for it.

### Q5 · external calls from `DynamicThresholdVipConfigDto`

```
answer:
class-validator:
- IsEnum          (line 16)
- IsArray         (line 19)
- ArrayMinSize    (line 20)
- ArrayMaxSize    (line 21)
- ValidateNested  (line 22)
class-transformer:
- Type            (line 23)
tool used: penguin explore DynamicThresholdVipConfigDto --repo FPMS-NT
confidence: high on the six listed; the COMPLETENESS answer is NO.
```

**Is the list complete? No, and the index says so itself.**

`completeness.status = "partial"`, `externalCallCount = 6`, with the diagnostic
*"6 call(s) go to external packages and cannot be resolved to repo symbols — see
externalCalls; the calls list is incomplete"* and the standing lower-bound note
that *calls inside callback bodies are not modelled*. That last clause bites
exactly here: `@Type(() => X)` puts its target inside an arrow-function body, so
whatever DTO this nests is invisible. The in-repo side shows only one edge —
`references → DYNAMIC_THRESHOLD_VIP_LEVEL` at
`apps/promotion/src/constants/dynamic-threshold-configs.constants.ts:2`.

How I know it's incomplete: not by inspection — by the tool's own
`completeness` field and `confidence.level = "mixed"`. That is the honest failure
mode I want, and it is Penguin's best feature.

Precision complaint on the same output, though: see §5.4 — several of these
"calls" are type positions, not calls.

### Q6 · dead-code candidates under `apps/admin/`

77 candidates. Full list, `penguin deadcode --repo FPMS-NT --path apps/admin/ --json`:

```
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
```

```
tool used: penguin deadcode --repo FPMS-NT --path apps/admin/ --json
confidence: high that this is the complete candidate set; LOW that any of it is
            actually dead.
```

**Scope, stated plainly.** The definition is *"no inbound calls / references /
handles / tests edges"* within `repo FPMS-NT, under apps/admin/`, on branch
`brazil-v2` only. It says nothing about other branches, other repos, or runtime
reachability, and the tool warns that DI, reflection, framework magic, dynamic
import and public entry points are false positives.

That warning is carrying almost all the weight here. Roughly 30 of the 77 are
`constructor` (NestJS injects those), ~12 are `@Module` classes (registered by
decorator metadata), 8 are `*Controller` classes, `bootstrap` is the process
entry point, and 6 are spec-file helpers. `AdminController` appearing here while
its own methods carry `handles` edges tells me the class node just never receives
an inbound edge by construction. **I would not delete anything from this list on
the index's word.** The one cluster I'd actually go look at by hand is
`platform-announcement-repository.ts` — four query methods (`findById`,
`findOne`, `find`, `update`) plus its module and constructor all appearing
together is the signature of a genuinely orphaned repository rather than a DI
artefact.

### Q7 · callers of `addPlayerFreeSpin` (add-free-spin-processor.ts)

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
tool used: penguin explore addPlayerFreeSpin --repo FPMS-NT  (→ "ambiguous target: 10 matches")
           penguin callers node_c628b4a7-1f02-4608-a8f7-75236f29d1a0 --json
confidence: high — incomingByType {calls: 8, defines: 1}, unresolvedReferenceCount=0.
```

The line numbers are the **enclosing function's** start line, not the call site.
`redeemPhysicalGift` spans 88–952; the actual call is somewhere in those 865
lines and the index will not tell me where. See §5.3.

### Q8 · callees of `applyOpenPromoCode` (promo-code.processor.ts)

```
answer:
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
tool used: penguin calls applyOpenPromoCode --repo FPMS-NT --json
confidence: medium-high — resolved unambiguously first try; still a lower bound
            per completeness.status.
```

Called by exactly one thing: `processPromoCode` at
`apps/promotion/src/promo-code/promo-code.processor.ts:704`.

### Q9 · `POST /internal/vip-cohort/retention-risk`

```
answer:
handler:
- apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:45 — triggerRetentionRisk
it calls:
- apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101 — run
run() then calls (depth 3):
- .../services/vip-cohort-runner.service.ts:314 — isDisabledBySwitch
- .../services/vip-cohort-runner.service.ts:80  — isWithinWindow
- .../services/vip-cohort-runner.service.ts:334 — drainPages
- .../services/vip-cohort-config.service.ts:52  — load
- .../repositories/vip-cohort-run.repository.ts:25 — startRun
- .../repositories/vip-cohort-run.repository.ts:43 — finishRun
- .../constants/vip-cohort.constants.ts:219 — vipCohortRunLockKey
- .../constants/vip-cohort.constants.ts:78  — emptyDropCounters
- .../constants/vip-cohort.constants.ts:381 — isVipCohortTraceEnabled
tool used: penguin flow "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT --json
confidence: high on handler + first hop; MEDIUM on the depth-3 attribution.
```

The interesting structural fact the index surfaced for free: the **HTTP handler
lives in a different app** (`apps/promotion-event-scheduler`) from the service it
drives (`apps/promotion`). Deeper (depth 4–5) it reaches
`vip-cohort-bi.service.ts:40 fetchPage`, `vip-cohort-verify.service.ts:99
verifyBatch`, `dora-enrollment.publisher.ts:41 publish`,
`libs/tools/src/redis4/redis4.service.ts:198 get`, and
`player-client-grpc.ts:286 getPlayersForPromotion`.

Why medium and not high: `flow` mixes `calls` and `references` edges in one tree
and, in the plain-text render, indents depth-3 nodes *under* a type reference
(`VipCohortRunResult`), implying `VipCohortRunResult` calls `isDisabledBySwitch`.
It does not. Only `--json` (which carries a flat `depth` field) makes that
readable. Details in §5.5.

### Q10 · symbols in `apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts`

```
answer:
- :18  — LiveChatConvoProcessor (class, fresh)
- :20  — constructor (method, fresh)
- :35  — updateConversationReview (method, fresh)
- :62  — updateConversationTag (method, fresh)
- :97  — getConversationTag (method, fresh)
- :113 — _endConversation (method, fresh)
- :213 — storeConversationData (method, fresh)
- :300 — _createConversation (method, fresh)
- :466 — getConversationList (method, fresh)
- :527 — data (function, **STALE**)
- :553 — updateConversationTagList (method, fresh)
- :563 — tagObjects (function, **STALE**)
tool used: penguin filesymbols branch_10012ad4-067a-4749-aafb-7a9c4f5c133d \
             apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts
confidence: high on the ten methods; the two STALE entries are reported as the
            tool gave them, per rule 4.
```

Passing on staleness as instructed: `data` (:527) and `tagObjects` (:563) both
carry `status: "stale"`. Both are also, on the index's own source snippet, local
`const` bindings inside method bodies, not file-level functions —
`tagObjects`'s recorded signature is literally
`tagObjects = tagList.map((tag) => ({`. I list them because they are in the
index, and flag them because I do not believe they are file-level definitions.

Whether they are *really* stale I cannot tell, because `explore` on that exact
node id reports `freshness.stale = false`. See §5.1.

### Q11 · external calls from `intercept` (grpc-base-response.interceptor.ts)

```
answer:
rxjs:
- map          (line 24)
- catchError   (line 31)
- of           (line 35)
- Observable   (line 20)   ← type position, see caveat
@nestjs/common:
- ExecutionContext (line 20)  ← type position, see caveat
- CallHandler      (line 20)  ← type position, see caveat
tool used: penguin explore "GrpcBaseResponseInterceptor.intercept" --repo FPMS-NT
confidence: high on what is listed; the COMPLETENESS answer is NO.
```

**Is the list complete? No — and here the index is definitely missing real
calls.** `completeness.status = "partial"`, `externalCallCount = 6`, plus a
second diagnostic that is the giveaway:

> `"intercept" is indexed but has no outgoing calls/references — it may be a terminal/leaf symbol, or its callees aren't indexed.`

An interceptor that has `map`/`catchError`/`of` on lines 24–35 is obviously doing
`next.handle().pipe(...)`. `next` is a `CallHandler` — interface dispatch, which
the lower-bound note says outright is not modelled — so `handle()` and `pipe()`
are missing. How I know: the tool's own `completeness` + the leaf-symbol
diagnostic, not from reading the file.

Caveat I'm obliged to add: three of the six are not calls. `ExecutionContext`,
`CallHandler` and `Observable` all sit at line 20, which is the method signature.
They are parameter and return **types**. Counting them as external calls inflates
`externalCallCount` from 3 to 6. Same pattern in Q5, where `IsEnum` etc. *are*
genuine decorator invocations. §5.4.

### Q12 · callers of `addPlayerMudDisbursement` (add-mud-processor.ts)

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
tool used: penguin callers addPlayerMudDisbursement --repo FPMS-NT --json
           penguin node node_15366be1-1abc-43ff-9106-acc3e496a4c2 --json   (to verify identity)
confidence: high — resolved first try with no ambiguity; verified the resolved
            node's identityKey is AddMudProcessor.addPlayerMudDisbursement at
            add-mud-processor.ts:51.
```

Same call-site-line caveat as Q7.

### Q13 · callees of `createLeaderBoardRewardProposal` (leaderboard.processor.ts)

```
answer:
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
tool used: penguin calls createLeaderBoardRewardProposal --repo FPMS-NT --json
           penguin node node_7d45af43-458b-4f21-a217-be8a4a481c03 --json  (identity check)
confidence: medium-high — verified identity (leaderboard.processor.ts:579–790);
            still a lower bound.
```

A 211-line method resolving to only ten callees is exactly the case the
lower-bound note warns about. I'd treat this as "at least these ten".

### Q14 · `POST /promotion/GetPlayerFreeSpinInfo`

```
answer:
handler:
- apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20 — getPlayerFreeSpinInfoRestful
it calls:
- apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11 — transformRestfulReqToNt
- apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117 — execute
execute() calls:
- libs/tools/src/redis2/redis2.service.ts:986 — getPlayerFreeSpinClaimed
- libs/common/transformer.util.ts:7 — transformUnknownToNt
- .../get-player-free-spin-info.processor.ts:177 — buildVerifyFreeSpinPlayerData
- .../get-player-free-spin-info/strategies/verify-free-spin-strategy.factory.ts:12 — createStrategy
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206 — getFreeSpinPlayerInfo
then it leaves the process:
- getFreeSpinPlayerInfo --invokes--> gRPC PlayerService.GetFreeSpinPlayerInfo
  --handles--> apps/player/src/player/controllers/player-internal.controller.ts:49 —
  getFreeSpinPlayerInfoRes   ** in a DIFFERENT repo — see below **
tool used: penguin flow "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
confidence: HIGH up to the gRPC boundary. LOW past it — the cross-repo hop is
            wrong in a specific, checkable way.
```

Up to `getFreeSpinPlayerInfo` this is the best answer the tool gave me all
session — it modelled a real gRPC hop and named the remote handler. Past the
boundary it is broken; that is B2 and §5.2.

---

## 3. Part B write-ups

### B1 · Onboarding onto FPMS-NT

**First move, and it was a dead end.** The obvious command is the one named after
the task:

```sh
penguin onboarding FPMS-NT
```

It returns a 24-line template containing zero facts about FPMS-NT:

```
## 2. 主要 actor 和术语
- 术语来自已索引的 service、endpoint、entity 和 notes。
## 3. 关键请求/事件流程
- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。
## 5. 本地运行与测试入口
- `penguin status`
- `pnpm run typecheck`
```

Every section is an instruction to run a different command. The only
repo-specific string in the whole document is the root path. If a new hire ran
exactly one Penguin command it would be this one, and it would teach them
nothing.

**Second move, also a dead end.** `penguin architecture --repo FPMS-NT` ignores
`--repo` and dumps the whole 26-repo estate: `nodes: field 825294 · symbol 107474
…`, and hubs like `parseInt`, `isNaN`, `async`. `penguin communities 15 --repo
FPMS-NT` likewise ignores the scope and returns clusters from
`FPMS-NT-Auth-Player`, `casino-plus-app`, `FPMS`. `penguin repograph FPMS-NT
brazil-v2` — documented as "top hubs by degree" — prints `150 nodes, 524 edges`
in text mode, and in `--json` returns 150 nodes of which the first nineteen are
`.spec.ts` files, every one with `degree: null`.

**What actually worked.** `penguin files FPMS-NT brazil-v2 --json`, bucketed by
app:

| app / lib | indexed files |
|---|---|
| `apps/promotion` | 1685 |
| `libs/tools` | 583 |
| `apps/payment` | 293 |
| `apps/user-engagement` | 127 |
| `apps/livechat` | 101 |
| `apps/admin` | 66 |
| `libs/common` | 65 |
| `apps/riskControl` | 55 |
| `apps/push` | 48 |
| `apps/provider` | 46 |
| `apps/offline-casino` | 41 |
| `apps/cms` | 29 |
| `apps/promotion-scheduler` | 23 |
| `apps/recommend` | 22 |
| `apps/card-system` | 15 |
| `apps/promotion-event-scheduler` | 13 |
| others (`auth`, `internal`, `player`, `*_scheduler`, `libs/*`) | ≤10 each |

**The orientation I'd write for myself on day one:**

> FPMS-NT is a NestJS monorepo of ~20 deployable apps sharing two library roots,
> 3298 indexed source files on `brazil-v2`.
>
> **It is one app, really.** `apps/promotion` is 51% of the repo (1685 of 3298
> files). If you are on this team you are working in `apps/promotion` unless told
> otherwise. Everything else is an order of magnitude smaller.
>
> **Two shared layers, and they are not the same thing.** `libs/tools` (583
> files) is where the outbound edges go: gRPC clients
> (`libs/tools/src/client-grpc/*`), Mongo repositories
> (`libs/tools/src/repositories/**`), Redis (`redis2`, `redis4`), ClickHouse,
> Vault. `libs/common` (65 files) is primitives — `common.ts`, `enum.ts`,
> `types.ts`, `base-repository/`, `base-redis.service.ts`. The community
> clustering confirms this: FPMS-NT's largest cluster (3085 nodes) is centred on
> `libs/common/common.ts`, `enum.ts`, `base-repository.ts`, `constants.ts`.
> Read `libs/common` first — it is small and everything imports it.
>
> **Entry points come in three flavours, and you should know which you're
> looking at.** HTTP controllers (`*-http.controller.ts`, e.g.
> `free-spin-http.controller.ts:20`), internal gRPC controllers
> (`*.internal.controller.ts`, e.g. `free-spin.internal.controller.ts:19`), and
> Pulsar consumers (`apps/promotion/src/pulsar/**/*.consumer.ts`). The same
> business processor is typically reachable from all three — `addPlayerFreeSpin`
> is called by an internal controller, a reward-grant adapter, a growth-task
> dispatcher, colour-land, winsday-billion, physical-gift and special-event.
>
> **Read in this order.** (1) `libs/common/common.ts` + `enum.ts`. (2) One full
> vertical slice — I'd use free-spin, because `penguin flow "POST
> /promotion/GetPlayerFreeSpinInfo"` walks it end to end including the gRPC hop
> out to the player service. (3) `apps/promotion/src/free-spin/processors/` to
> see the processor pattern. (4) `libs/tools/src/client-grpc/` to see how this
> repo talks to the rest of the estate. (5) `apps/promotion/src/pulsar/` for the
> async path.
>
> **Busiest things to be careful around.** `add-free-spin-processor.ts` — one
> file change reports `changed 12 · impacted 30 · tests 5 · routes 4`.
> `reward-dispatcher.service.ts` and `reward-grant/adapters/` — two parallel
> reward-dispatch abstractions that both fan into the same processors.
> `special-event-mission.service.ts` — has a method at line 1731 and another at
> 2323, so it is at least 2400 lines.

**Confidence: medium.** The file census and the call graph I'd stand behind. The
narrative above is my inference from shapes and names; Penguin did not tell me
what any of it is *for*.

**What the index did not tell me that I wanted:**

1. **Which apps actually ship.** 20 app directories, no deployment info
   (`deploymentTargets: []` on every branch). `apps/player` has 4 files here but
   the same path is a full service in another repo — is it vestigial? Dead? A
   shared-DTO stub? Can't tell.
2. **Any prose.** No README ingestion, no module-level doc comments, no
   `penguin note` content for this repo. `penguin tags` and the notes system
   exist, but for FPMS-NT they're empty, so all domain meaning has to be guessed
   from identifiers.
3. **Ranked entry points.** `architecture` says `entrypoints: 30` for the whole
   estate and won't scope. There are 1638 endpoint nodes globally and no way I
   found to list *this repo's* endpoints, let alone rank them. "Which are the
   busiest entry points" — the literal B1 question — I answered by proxy (file
   counts, `affected` fan-out), not by asking.
4. **Ownership / recency per subsystem.** `penguin timeline` exists but is
   estate-wide. I wanted "which of these 20 apps was touched this quarter".

---

### B2 · Trace a request: `POST /promotion/GetPlayerFreeSpinInfo`

```sh
penguin flow "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
```

**What happens on the request.** The HTTP handler
`getPlayerFreeSpinInfoRestful` (`free-spin-http.controller.ts:20`) normalises the
REST payload through `transformRestfulReqToNt`
(`get-player-free-spin-info.transformer.ts:11`) into the internal
`GetPlayerFreeSpinInfoReq` shape, then delegates to `execute`
(`get-player-free-spin-info.processor.ts:117`).

`execute` does four things. It reads already-claimed spins from Redis
(`redis2.service.ts:986 getPlayerFreeSpinClaimed`, which bottoms out at
`base-redis.service.ts:300 smembers`). It builds a verification payload
(`buildVerifyFreeSpinPlayerData` at :177, producing `VerifyFreeSpinPlayerData`).
It picks a strategy via a factory —
`verify-free-spin-strategy.factory.ts:12 createStrategy` returning
`IVerifyFreeSpinStrategy` — so the eligibility rules are pluggable and the
concrete strategy is chosen at runtime. And it fetches player state over gRPC:
`player-client-grpc.ts:206 getFreeSpinPlayerInfo`, wrapped by
`catchGrpcError` (:160) and unmarshalled by
`transformGetFreeSpinPlayerInfoResPbToNt`. The response is assembled into
`GetPlayerFreeSpinInfoRes` / `...ResData`.

**Where the chain broke, and how I noticed.** At the gRPC boundary. Penguin
follows an `invokes` edge from `getFreeSpinPlayerInfo` to the endpoint
`gRPC PlayerService.GetFreeSpinPlayerInfo`, and then presents **three** handlers:

```
5 symbol apps/player/src/player/controllers/player-internal.controller.ts 49 getFreeSpinPlayerInfoRes <- handles
5 symbol apps/player/src/player/controllers/player-internal.controller.ts 70 getFreeSpinPlayerInfoRes <- handles
5 symbol apps/player/src/player/controllers/player-internal.controller.ts 95 getFreeSpinPlayerInfoRes <- handles
```

Same file, same method name, three different line numbers. That looked like an
overload set, so I checked whether the file was even in this repo:

```sh
$ penguin filesymbols branch_10012ad4-... apps/player/src/player/controllers/player-internal.controller.ts
(no symbols indexed for apps/player/src/player/controllers/player-internal.controller.ts)

$ penguin files FPMS-NT brazil-v2 --json | grep apps/player
indexed apps/player/libs/utils/constants.ts
indexed apps/player/libs/utils/enum.ts
indexed apps/player/libs/utils/mapping.ts
indexed apps/player/src/player/dto/get-free-spin-player-info.dto.ts
```

The file is not in FPMS-NT at all. Pulling the raw `source` blocks off those
three steps:

```json
{"depth":5,"title":"getFreeSpinPlayerInfoRes","filePath":"apps/player/src/player/controllers/player-internal.controller.ts",
 "source":{"repoId":"repo_aa78f2b5-...","startLine":49,"revisionId":"branch_10012ad4-067a-4749-aafb-7a9c4f5c133d"}}
{"depth":5,... "source":{"repoId":"repo_313f7662-...","startLine":95,"revisionId":"branch_10012ad4-..."}}
{"depth":5,... "source":{"repoId":"repo_b8980b2a-...","startLine":70,"revisionId":"branch_10012ad4-..."}}
```

Three different `repoId`s, which `penguin status --json` resolves to:

| repoId | name | root | branch |
|---|---|---|---|
| `repo_b8980b2a` | FPMS-NT-Auth-Player | `~/Desktop/Projects/auth` | brazil-v2 |
| `repo_313f7662` | FPMS-NT-Auth-Player | `~/Desktop/Projects/auth-penguin-benchmark` | `(detached)`, stale=196 |
| `repo_aa78f2b5` | FPMS-NT-Auth-Player | `~/Desktop/WorkSpace/FPMS-NT-Auth-Player` | `jun-12-1223-master`, stale=136 |

So it is not one remote handler — it is the *same* handler seen through three
separate clones of the same repo, two of which are stale and one of which is a
detached benchmark checkout. And **every one of them carries
`revisionId: branch_10012ad4-…`, which is FPMS-NT@brazil-v2's branch id.** The
revision is being stamped from the query scope rather than read off the node, so
the result claims provenance it does not have.

The plain-text render hides all of this: it shows three identical
`↳ handles → getFreeSpinPlayerInfoRes` lines with no repo, no path, no line, and
`warnings: []`. Passing `--repo FPMS-NT` did not confine the walk, and nothing in
the output says the trace left the repo.

Concretely: **the trace is trustworthy up to `getFreeSpinPlayerInfo` and should
be treated as unsourced past it.** Which is a shame, because the cross-service
hop is the most valuable thing here and is 90% working.

---

### B3 · Change impact: signature of `AddFreeSpinProcessor.addPlayerFreeSpin`

Target: `apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts:34`,
signature `async addPlayerFreeSpin(payload: AddFreeSpinDto)`. Say I want to split
`payload` or add a required field.

```sh
penguin callers node_c628b4a7-1f02-4608-a8f7-75236f29d1a0 --json
penguin impact  node_c628b4a7-1f02-4608-a8f7-75236f29d1a0 --json
penguin affected apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts --json
penguin graph   node_c628b4a7-1f02-4608-a8f7-75236f29d1a0 1 --json
```

**Direct callers — 8, the things that would fail to compile:**

| file:line (enclosing symbol) | symbol |
|---|---|
| `apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:19` | `addPlayerFreeSpin` |
| `apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:182` | `dispatchFreeSpin` |
| `apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:30` | `dispatch` |
| `apps/promotion/src/winsday-billion/services/reward-grant.service.ts:65` | `grantFreeSpin` |
| `apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47` | `dispatchReward` |
| `apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88` | `redeemPhysicalGift` |
| `apps/promotion/src/special-event/services/special-event-mission.service.ts:1731` | `claimTaskReward` |
| `apps/promotion/src/winsday-billion/services/post-win-share.service.ts:457` | `grantFreeSpin` |

**Transitive (19 symbols), 4 routes, 5 test files.** `affected` adds the
behaviourally-affected callers-of-callers: `winsday-billion/services/reward-grant.service.ts:50 grant`,
`color-land/processors/claim-color-land-task-reward.processor.ts:34`,
`color-land/processors/dice.processor.ts:51 playDice`,
`physical-gift/controllers/physical-gift.controller.ts:31`,
`special-event-mission.service.ts:2309 claimReward`,
`post-win-share.service.ts:432 grant` / `:212 claim`,
`winsday-billion/services/boost-claim.service.ts:281 grantAndCache`,
`color-land/controllers/color-land.controller.ts:155` and `:103`,
`special-event/processors/special-event-mission.processor.ts:25`.

Routes at risk: `gRPC FreeSpinInternalService.AddPlayerFreeSpin`,
`gRPC v1.FrontendPhysicalGiftService.RedeemPhysicalGift`,
`gRPC promotion.v1.FrontendColorLandService.RollColorLandDice`,
`gRPC promotion.v1.FrontendColorLandService.ClaimColorLandTaskReward`.

Tests that would need to run:
`physical-gift/processors/redeem-physical-gift-routing.spec.ts`,
`physical-gift/processors/redeem-physical-gift.processor.spec.ts`,
`test/unit/color-land/processors/dice.processor.spec.ts`,
`color-land/processors/claim-color-land-task-reward.processor.spec.ts`,
`test/unit/color-land/controllers/color-land.controller.spec.ts`.

**How much would I trust this list if I were about to make the change?**

The *membership* of the 8: high, and I tested it rather than assuming. The
context pack's "Imported by (files)" listed
`apps/promotion/src/pulsar/reward-dispatch-free-spin/reward-dispatch-free-spin.consumer.ts`,
which is **not** in the callers list — an importer with no call edge is exactly
the shape of a missed dynamic dispatch, so I chased it:

```sh
$ penguin explore "RewardDispatchFreeSpinConsumer.handleBatch" --repo FPMS-NT
calls = [ incrby (promotion-redis.service.ts:215),
          batchAddPlayerFreeSpinToRewardRecord (add-free-spin-processor.ts:314) ]
```

The consumer calls a *different* method on the same class. The graph was right
and my suspicion was wrong. That is the check that moved me from "plausible" to
"I'd act on it".

**But I would not use it as my edit checklist, for three reasons.**

*First — no call-site lines.* This is the big one. `redeemPhysicalGift` spans
lines 88–952 and `claimTaskReward` spans 1731–1912. The index tells me the call
is somewhere inside; it does not tell me where. I confirmed the data simply
isn't there — dumping the raw edges:

```json
{"src":"node_29b398e0-...","dst":"node_c628b4a7-...","edgeType":"calls","sourceType":null}
```

No line, no column, on any `calls` edge. So the honest workflow is
"Penguin gives me the 8 files, then I grep inside each" — which is exactly the
loop Penguin is meant to replace. Galling, because `externalCalls` **does** carry
per-call lines (`Type` line 23, `map` line 24), so the parser has the
information and drops it for in-repo edges.

*Second — `impact` has no depth.* All 19 nodes come back with `depth: null`, so
"compile error" and "behaviour change three hops away" are one undifferentiated
list. `affected`'s `changed` array is worse: bare `{nodeId, title, nodeType}` with
no `filePath` at all.

*Third — the lower bound is real for this shape of code.* Two of the eight
callers (`free-spin-grant.adapter.ts dispatch`, `reward-dispatcher.service.ts
dispatchFreeSpin`) are clearly registry/adapter dispatch. If any *other* call
reaches this processor through an interface handle or a callback body, the note
says plainly it isn't modelled — and `invokes_dynamic` exists as an edge type in
the schema (2658 estate-wide), so someone anticipated this, but none landed here.

Net: I'd use the 8 files as my starting set, expect it to be complete, and still
compile to find the lines.

---

### B4 · Something wrong: `apps/livechat` runs a forked, drifted copy of the shared health check

**The finding.** Ten of FPMS-NT's apps mount the shared health-check controller
from `libs/tools`. `apps/livechat` has its own private copy of the controller
*and* the service, under the same class names and the same route, and the two
implementations have diverged in ways that change behaviour.

**Evidence, step by step.**

It surfaced by accident while answering Q3 — `flow "GET /healthcheck"` returned
two handlers for one route:

```
`GET /healthcheck` _(endpoint)_
  ↳ handles → `check`      apps/livechat/src/http-health-check/http-health-check.controller.ts:12
  ↳ handles → `check`      libs/tools/src/http-health-check/http-health-check.controller.ts:12
```

The file census shows eleven apps with a health-check directory, but only two
apps carry an implementation:

```sh
$ penguin files FPMS-NT brazil-v2 --json | grep http-health-check
apps/admin/src/http-health-check/http-health-check.module.ts
apps/internal/src/http-health-check/http-health-check.module.ts
apps/livechat/src/http-health-check/http-health-check.controller.ts     ← fork
apps/livechat/src/http-health-check/http-health-check.module.ts
apps/livechat/src/http-health-check/http-health-check.service.ts        ← fork
apps/offline-casino/src/http-health-check/http-health-check.module.ts
apps/payment/src/http-health-check/http-health-check.module.ts
apps/promotion/src/health-check/http-health-check.module.ts
apps/provider/src/http-health-check/http-health-check.module.ts
apps/push/src/http-health-check/http-health-check.module.ts
apps/user-engagement/src/http-health-check/http-health-check.module.ts
libs/tools/src/http-health-check/http-health-check.controller.ts        ← shared
libs/tools/src/http-health-check/http-health-check.service.ts           ← shared
```

Everyone else imports the shared one; livechat imports its own:

```sh
$ penguin search "HttpHealthCheckController" --repo FPMS-NT
apps/admin/src/http-health-check/http-health-check.module.ts:9
  import { HttpHealthCheckController } from '../../../../libs/tools/src/http-health-check/http-health-check.controller';
apps/internal/src/http-health-check/http-health-check.module.ts:9
  import { HttpHealthCheckController } from '../../../../libs/tools/src/http-health-check/http-health-check.controller';
apps/offline-casino/src/http-health-check/http-health-check.module.ts:7
  import { HttpHealthCheckController } from '../../../../libs/tools/src/http-health-check/http-health-check.controller';
apps/livechat/src/http-health-check/http-health-check.module.ts:15
  import { HttpHealthCheckController } from './http-health-check.controller';   ← local
```

**They have drifted.** Pulling both `check()` bodies out of the index
(`penguin node <id> --json`):

| | `libs/tools` (shared, :35) | `apps/livechat` (fork, :20) |
|---|---|---|
| health checks | reads precomputed `this.cachedHealthChecks` | rebuilds a `mongoChecks` array from `this.mongodbInstances` **on every request** |
| postgres | not present | hardcodes `this.typeOrmHealth.pingCheck('postgres')` into the check list |
| redis | iterates `this.cachedRedisEntries` | iterates `Object.entries(this.redisInstances ?? {})` |
| logging | `if (details && Object.keys(details).length > 0) console.info(...)` | `console.info('dbConnectionResult: ', details)` unconditionally |

**Why it matters.** This is the liveness probe. Kubernetes hits it on a schedule,
so the fork rebuilds its Mongo check closures and re-enumerates connections on
every probe, and logs on every probe regardless of content. More to the point:
the shared version was clearly *improved* — caching the checks, guarding the
log — and livechat did not get those improvements, because the fork is invisible
to anyone reading `libs/tools`. Any future fix to the shared health check will
silently skip livechat. The class names and route being identical is what makes
it dangerous; nothing at a call site tells you which one you have.

**And it is untested.** `flow "GET /healthcheck"` reports `relatedTests: []`, and
no `*health*.spec.ts` appears anywhere in the FPMS-NT file census. An endpoint
that gates pod restarts, forked into two divergent implementations, with zero
tests on either.

**Secondary finding (same class of problem).** `CMSGenBaseResponse` exists twice,
byte-for-byte identical:

```
apps/promotion/src/budget/budget-base-response.ts:14   — 8 local wrappers
libs/common/base-response.ts:452                       — 6 local wrappers
```

Both bodies from `penguin node --json`:

```ts
const CMSGenBaseResponse = (baseResponse: CMSBaseResponseType, statusCode: CMSStatusCodeType, message: string) => {
  return new baseResponse({ status: statusCode, message });
};
```

The `libs/common` copy has `success / forbidden / internalError / notFound /
unauthorized / statusUnspecified`. The `apps/promotion/src/budget` copy has those
six **plus** `illegalArgs` (:74) and `alreadyExists` (:82). So the budget module
copied the shared helper and extended it locally instead of adding two cases
upstream — every other module in the repo is missing those two status shapes.
This is also why Q1 came back `ambiguous: 2 matches`.

---

## 4. What worked well

**`completeness` is the feature. Keep it, extend it, put it everywhere.** No
other code-intelligence tool I've used tells me its own recall is bad. On Q11:

```json
"completeness": {"status": "partial", "externalCallCount": 6,
  "note": "6 call(s) go to external packages and have no in-repo target — see externalCalls.
           Beyond those, the calls list is a lower bound: constructor calls, interface dispatch,
           static-method calls and calls inside callback bodies are not modelled."},
"diagnostics": ["\"intercept\" is indexed but has no outgoing calls/references — it may be a
                 terminal/leaf symbol, or its callees aren't indexed."]
```

That is the difference between an answer I can reason about and a number I have
to distrust. It is the single reason I'd use this tool.

**Cross-service gRPC tracing.** `flow "POST /promotion/GetPlayerFreeSpinInfo"`
followed `getFreeSpinPlayerInfo` → `invokes` → `gRPC
PlayerService.GetFreeSpinPlayerInfo` → `handles` → the remote controller method.
Grep cannot do that; it requires knowing that a proto method name binds a client
stub to a `@GrpcMethod` in another codebase. Attribution past the boundary is
broken (§5.2), but the *edge* is real and it is the most valuable thing in here.

**Ambiguity is refused, not guessed.** `explore CMSGenBaseResponse` returned
`resultStatus: "query_error"` with both candidates and their `identityKey`s
rather than silently picking one. Given there are two byte-identical definitions,
a guess would have been a wrong answer wearing high confidence. Same for
`totallyNotARealSymbolXyz`:

```
"totallyNotARealSymbolXyz" is not indexed — no symbol, note, or gRPC endpoint matches this name.
```

Clean negative, no hedging, no hallucinated near-match.

**`affected` is the best-designed single command.** One file path in, and out
comes `changed 12 · impacted 30 · tests 5 · routes 4` with the four gRPC routes
named and the five spec files listed. That is a PR checklist. It is what I'd
actually run before touching a file, and it beats grep decisively because grep
cannot tell me `RollColorLandDice` is downstream of a free-spin processor.

**`filesymbols` is exactly right.** One command, all twelve symbols, kinds, line
ranges, per-symbol freshness (Q4, Q10). No ambiguity, no follow-up, no JSON
needed. This is the shape every command should have.

**Per-symbol source retrieval let me verify claims.** `penguin node <id> --json`
returns the actual body. That's how I proved the two health-check `check()`
implementations had diverged, and how I proved the two `CMSGenBaseResponse`
bodies were identical — both without opening a file, which was the rule.

**The call graph held up under an adversarial check.** I found an importer with
no call edge (the Pulsar consumer, §B3), suspected a miss, chased it, and the
graph was right — the consumer calls a sibling method. I went looking for a bug
in the call graph and didn't find one.

---

## 5. What did not work

### 5.1 · "Stale" has four different answers for one repo state

Rule 4 says pass staleness on. I cannot, consistently, because Penguin gives four
different answers for `FPMS-NT@brazil-v2` at commit `3f0f198`:

```sh
$ penguin status
FPMS-NT   brazil-v2(live,stale=725)

$ penguin status --json   # same branch
"staleSymbols": 725,
"trust": {"stale": false, "staleReason": null, "worktreeState": "clean",
          "indexedCommit": "3f0f198…", "headCommit": "3f0f198…"}

$ penguin coverage --repo FPMS-NT --json
{"discovered":3340,"admitted":3333,"excluded":7,"failed":0,"stale":0}
```

The text line reads as "725 stale" to any human. `trust` says not stale.
`coverage` says `stale: 0`. And at symbol level:

```sh
$ penguin filesymbols … livechat-convo-processor.ts --json
{"nodeId":"node_980fb2e8-…","title":"tagObjects","status":"stale"}

$ penguin explore node_980fb2e8-…
freshness = {"stale": false, "reason": null, "indexedAt": "2026-08-29T01:52:16.496Z"}
```

The *same node id*, one command apart: `status: "stale"` from `filesymbols`,
`stale: false` from `explore`. There is no reading of this that lets me follow
the rule honestly.

Related: the resolution path changes the freshness verdict. `explore
CMSGenBaseResponse` (ambiguous) →
`"freshness": {"stale": true, "reason": "trust_unavailable"}`. `explore
node_e8e51538-…` (the same repo, resolved) → `"stale": false`. Failing to resolve
a name is being reported as a staleness problem, which sends you off to re-index
a repo that is perfectly aligned.

Guess at the underlying cause, offered as a lead not a claim: the 725 are
probably orphans from the parser upgrade — FPMS-NT is on
`tree-sitter-wasm-v8-wrapper-allowlist` while other branches in the same DB still
show `v7-jsx-dynamic-edges`. Both stale symbols I found (`data`, `tagObjects`)
are spurious local-`const` nodes the v8 allowlist would no longer emit, so they
never get refreshed and sit marked stale forever while the file they're in is
fresh.

### 5.2 · `flow` walks out of `--repo` scope and stamps the wrong revision

Covered in full in B2. The short version:

- `--repo FPMS-NT` did not confine the walk. Three of the depth-5 handlers are in
  `FPMS-NT-Auth-Player` — in fact in three *separate clones* of it, including a
  `(detached)` benchmark checkout (`stale=196`) and a `jun-12-1223-master`
  worktree (`stale=136`).
- Every one of them carries `revisionId: branch_10012ad4-…`, which is
  **FPMS-NT@brazil-v2's** branch id, not theirs. The revision is being written
  from query scope, not read from the node.
- The plain-text render shows three identical `↳ handles → getFreeSpinPlayerInfoRes`
  lines with no repo, no path, no line. `warnings: []`.

The right output is one remote handler, labelled with its repo and branch, with
the duplicate clones deduplicated or at minimum disclosed. As shipped, the
correct cross-service trace is indistinguishable from stale data pulled out of an
abandoned checkout.

### 5.3 · Call edges carry no line number, so "every call site" is unanswerable

The B3 question — *name every call site with `file:line`* — cannot be answered.
Raw edges:

```json
{"src":"node_29b398e0-…","dst":"node_c628b4a7-…","edgeType":"calls","sourceType":null}
```

`src`/`dst`/`edgeType` and nothing else. What you get instead is the enclosing
symbol's `startLine`, which for `redeemPhysicalGift` (88–952) and
`claimTaskReward` (1731–1912) is not useful for editing.

The frustrating part: `externalCalls` **does** carry lines —
`{"callee":"Type","line":23}`, `{"callee":"map","line":24}`. The parser has the
position for external call sites and drops it for in-repo ones. This is the
single change that would most improve the tool.

### 5.4 · `externalCalls` counts type annotations as calls

Q11, `intercept(context: ExecutionContext, next: CallHandler): Observable<...>`
— all three of those are reported as external calls at line 20:

```json
{"specifier":"@nestjs/common","callees":[{"callee":"ExecutionContext","line":20},
                                          {"callee":"CallHandler","line":20}]},
{"specifier":"rxjs","callees":[{"callee":"Observable","line":20}, {"callee":"map","line":24},
                               {"callee":"catchError","line":31}, {"callee":"of","line":35}]}
```

Three of the six are the method signature. `externalCallCount: 6` should be 3.
This is not cosmetic — `completeness.status` and `confidence.level` are derived
from that count, so a DTO file full of type-only imports gets scored as "partial,
6 external calls" when it makes none. A `kind: "call" | "type"` discriminator
would fix it; the parser already knows which position it matched.

### 5.5 · The `flow` text renderer implies a call tree that doesn't exist

`flow "POST /internal/vip-cohort/retention-risk"`, plain text:

```
  ↳ handles → `triggerRetentionRisk`
    ↳ calls → `run`
    ↳ references → `VipCohortRunResult`
      ↳ calls → `isDisabledBySwitch`
      ↳ calls → `finishRun`
      ↳ calls → `load`
```

Read literally, the type `VipCohortRunResult` calls `isDisabledBySwitch`. It does
not — those are `run`'s callees. The renderer indents by `depth` and attaches
each row to whatever printed last at depth−1, and because `references` edges are
interleaved with `calls` edges, the last thing printed is frequently a type. The
`--json` output is flat and correct (`{"depth":3,…}`), so the data is fine and the
tree drawing is wrong. Anyone reading the text output gets a false model of the
code.

Same command, same problem in Q3: two `↳ handles → check` rows, no paths, no way
to tell them apart without `--json`.

### 5.6 · `field` nodes make disambiguation nearly unusable

```sh
$ penguin context addPlayerFreeSpin --repo FPMS-NT
Multiple symbols found for "addPlayerFreeSpin":
1. field  …redeem-physical-gift-routing.spec.ts::AddFreeSpinProcessor::addPlayerFreeSpin   (no file)
2. field  …redeem-physical-gift-routing.spec.ts::<object>::addPlayerFreeSpin               (no file)
3. field  …redeem-physical-gift-routing.spec.ts::addFreeSpinProcessor::addPlayerFreeSpin   (no file)
4. field  …redeem-physical-gift.processor.spec.ts::<object>::addPlayerFreeSpin             (no file)
5. field  …redeem-physical-gift.processor.spec.ts::addFreeSpinProcessor::addPlayerFreeSpin (no file)
6. field  …reward-dispatcher.service.ts::AddFreeSpinProcessor::addPlayerFreeSpin           (no file)
7. field  …free-spin-grant.adapter.ts::<object>::addPlayerFreeSpin                         (no file)
8. field  …add-free-spin-processor.ts::<object>::addPlayerFreeSpin                         (no file)
9. symbol …free-spin.internal.controller.ts:19                                             ← real
10. symbol …add-free-spin-processor.ts:34                                                  ← real
```

Eight of ten candidates are mock-object properties in `.spec.ts` files, listed
first, all with `(no file)` and no line. Two are what anyone asking the question
means. `field` nodes are 825,294 of the graph's ~1M nodes estate-wide, so this is
the dominant node type drowning the useful one. Sort `symbol` above `field`, or
exclude `field` from name resolution entirely, and seven of my fourteen
`ambiguous` results become one-command answers.

Also visible above: the `(no file)` on every `field` row. The `identityKey`
contains the path — it just isn't parsed out for display.

### 5.7 · `explore` reports "ambiguous" and silently resolves to a seventh thing anyway

```sh
$ penguin explore accumulatePlayerDeposit --repo FPMS-NT
diagnostics: ["ambiguous target: 6 matches"]
ambiguousCandidates: [ 3 field nodes, 3 symbol nodes ]
queryDiagnostics: {"resolutionStatus": "resolved", "resultStatus": "has_results",
                   "resolvedNodeId": "node_0a190236-…"}
callPath: [ {"title": "DepositLimitService.AccumulatePlayerDeposit", "nodeType": "endpoint"} ]
```

It says ambiguous among 6, then resolves to `node_0a190236` — an **endpoint**
node that is not one of the 6 listed candidates — and returns a `callPath` for
it while `callers` and `calls` come back empty. So the diagnostics say "pick
one", the candidate list doesn't contain what it picked, and the payload is
partially populated from the thing it picked. Compare `explore
CMSGenBaseResponse`, which handles the same situation correctly with
`resultStatus: "query_error"` and empty results. Two different behaviours for one
condition.

### 5.8 · `COVERAGE_INCOMPLETE` on every single search, when coverage is fine

Every `penguin search` in this session ended with:

```
warnings: COVERAGE_INCOMPLETE
next: penguin index <repo-path> — refresh stale or failed coverage before relying on a negative result
```

Actual coverage: `{"discovered":3340,"admitted":3333,"excluded":7,"failed":0}`.
Zero failures. Seven excluded files, which `coverage` will not name — so the
warning tells me not to trust a negative result while withholding the one fact
(*which* 7) that would let me judge whether the negative is safe. After the
fourth identical banner I stopped reading it, which is precisely the failure this
warning exists to prevent. Fire it when `failed > 0`, or when an excluded file
matches the query's path scope. Not always.

### 5.9 · `penguin onboarding` produces a contentless template

The whole output for a 3298-file, 20-app monorepo:

```
## 1. 系统边界
- FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt
## 2. 主要 actor 和术语
- 术语来自已索引的 service、endpoint、entity 和 notes。
## 3. 关键请求/事件流程
- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。
…
## 8. 推荐阅读顺序
- Search → Context → Graph → Evidence
```

Zero facts. Every section is a pointer to another command. Everything I needed
for B1 was in the database — `files` gave me the app census, `communities` gave
me the coupling clusters, `flow` gave me a worked vertical slice — but the
command whose entire purpose is to assemble that assembles none of it. It would
be better to delete it than to ship it, because its existence stops you looking
for the commands that work. (Also: it's the only Chinese-language output in the
CLI, which suggests it's a stub nobody circled back to.)

### 5.10 · `--repo` is ignored by `architecture` and `communities`

```sh
$ penguin architecture --repo FPMS-NT
repos: FPMS(4br), FPMS-CCMS(1br), FPMS-NT(1br), … casino-plus(1br), penguin-src(1br), shieng(1br)
nodes: field 825294 · symbol 107474 · …
hubs: genFxStatusMessage, playerDetailController, parseInt, isNaN, async, …

$ penguin communities 15 --repo FPMS-NT
#1 (7211) FPMS-NT-Auth-Player — …
#3 (4948) casino-plus-app — …
#8  (804) FPMS — …
```

Both accept the flag and both ignore it. The help text says `--repo` is a global
scope selector. Estate-wide `hubs` containing `parseInt`, `isNaN` and `async` are
also not useful as "hubs" for anything.

### 5.11 · `repograph` returns spec files with null degree

Documented as "repo/branch graph (top hubs by degree)":

```sh
$ penguin repograph FPMS-NT brazil-v2
150 nodes, 524 edges
```

That's the entire text output. `--json` gives 150 nodes whose first nineteen are
all `.spec.ts` files, every node with `degree: null`. For a repo whose call graph
I'd just demonstrated is dense and correct, this is the least informative view of
it available.

### 5.12 · `search` and `explore` disagree about what exists

```sh
$ penguin search "RewardDispatchFreeSpinConsumer.handleBatch" --repo FPMS-NT
NO_MATCH_INCOMPLETE · 0 hits

$ penguin explore "RewardDispatchFreeSpinConsumer.handleBatch" --repo FPMS-NT
calls = [ incrby …, batchAddPlayerFreeSpinToRewardRecord … ]     ← resolved fine
```

`search` doesn't understand qualified names. Separately, searching for a file's
own name returns its importers but not the file:

```sh
$ penguin search "grpc-base-response.interceptor" --repo FPMS-NT
MATCH · 2 hits
  accumulative-event-config.controller.ts:11   (an import line)
  accumulative-event-config.module.ts:19       (an import line)
```

The defining file — which `filesymbols` happily lists two symbols for — is not in
the results. Search matches import statement text, not definitions.

### 5.13 · Smaller things

- **`penguin node <id>` text mode prints no location.** `symbol
  addPlayerMudDisbursement / versions: 1 / aliases: 0`. No file, no line. You
  must use `--json` to learn anything.
- **`impact` returns `depth: null` on every node.** Direct callers and 3-hop
  consequences arrive as one flat list.
- **`affected --json`'s `changed` array has no `filePath`** — `{"nodeId":…,
  "title":"AddFreeSpinProcessor","nodeType":"symbol"}`. Its `tests` array has
  `title` but the `filePath` key is null, so the path is only there because
  someone put it in `title`.
- **The markdown `context` pack drops file paths from "Called by".** It lists
  ``- `grantFreeSpin` `` twice with no way to tell the two apart. `--json` has
  them.
- **`explore` outputs JSON by default**, unlike every other verb, and the docs
  imply `--json` is opt-in throughout.
- **The disambiguation hint suggests an invalid form** — for a `field` node it
  prints `penguin context symbol:node_699662e9-…`.
- **`penguin files <repo>` returns a bare JSON array** while every other `--json`
  output is an object. Small, but it breaks a uniform parser.

---

## 6. Pros and cons

Judged as a daily tool, against grep + reading files.

| | Penguin | grep + read |
|---|---|---|
| **"Who calls X?"** | 1–2 commands, complete within a stated bound, cross-file and cross-app | many greps; you find the name, not the call; misses re-exports |
| **Call-site precision** | ✗ **none** — enclosing symbol's start line only | ✓ exact `file:line:col`, always |
| **"What does X call?"** | good, and *tells you it's a lower bound* | you read the body; you see everything, slowly |
| **Endpoint → DB trace** | one command, incl. gRPC hops into other services | hours; requires knowing proto↔`@GrpcMethod` binding |
| **Cross-repo/service** | the standout capability — 26 repos in one graph | impossible without knowing all repos exist |
| **Blast radius / test selection** | `affected` gives impacted symbols + routes + specs | ✗ nothing comparable |
| **Honesty about gaps** | ✓✓ best-in-class `completeness` / diagnostics | grep is honest by being literal — no false completeness |
| **Symbol resolution** | ✗ 7/14 ambiguous; `field` nodes drown real symbols | ✓ literal, never ambiguous |
| **Repo orientation** | ✗ `onboarding` empty, `architecture`/`communities` unscoped, `repograph` null | ✗ also bad, but `tree` + READMEs beat the template |
| **Dead-code detection** | candidates with an honest FP warning; ~90% FPs in NestJS | ✗ nothing comparable |
| **Reading actual code** | `node --json` gives exact bodies from the index | ✓ trivially |
| **Freshness/trust model** | ✗ four contradictory answers (§5.1) | ✓ the file on disk is the truth |
| **Scope control** | ✗ `--repo` ignored by 3+ verbs; `flow` escapes it | ✓ you control the path |
| **Text-mode output** | ✗ frequently loses paths or implies wrong structure | ✓ paths always present |
| **Token cost for an agent** | very low for graph questions, high when you must chase node ids | high — every read is a file |

**Where it wins outright:** cross-service tracing, blast radius, test selection,
and — the one nobody else does — telling you when its own answer is incomplete.

**Where it loses outright:** the exact line you are about to edit, orientation on
an unfamiliar repo, and knowing how much to trust the freshness stamp.

**Would I use it daily?** Yes, as the first tool, with grep as the second. It
gets me the right eight files in one command and grep gets me the right eight
lines in eight more. That is still a large net win over grepping blind. It is
not, today, a replacement for reading files.

---

## 7. Suggestions

Ordered by how much difference each would make.

**1. Put line numbers on `calls` edges.** *Problem:* B3 is unanswerable; every
change-impact workflow still ends in grep, which is the loop Penguin exists to
remove. *Cost:* low-to-moderate. The parser already emits positions —
`externalCalls` carries `{"callee":"map","line":24}` — so it's a column on the
edge table, a re-index, and surfacing it in `callers`/`impact`/`graph`. *Biggest
single improvement available.*

**2. Rank `symbol` above `field` in name resolution, or drop `field` from it
entirely.** *Problem:* 7 of 14 quiz targets came back `ambiguous`, and in the
worst case 8 of 10 candidates were mock properties in spec files (§5.6). Almost
every "this took five commands" moment traced to this. *Cost:* very low — an
ORDER BY, or a node-type filter on the resolver. Ship the filter, keep `field`
reachable by explicit id. Also render `filePath` for field rows; it's already
inside `identityKey`.

**3. Make one staleness answer.** *Problem:* §5.1 — `status` text, `status`
JSON, `coverage`, `filesymbols` and `explore` give four different verdicts for
one repo state, and rule 4 becomes impossible to follow. *Cost:* low. Pick
`trust` as authoritative; rename the `status` text column to `staleSymbols=725`
so it stops reading as a boolean; make `coverage.stale` report the same number;
and either refresh or garbage-collect symbols orphaned by a `parserVersion`
change so the count goes to zero. Never report a resolution failure as
`stale: true, reason: trust_unavailable`.

**4. Fix `flow`'s cross-repo attribution.** *Problem:* §5.2 — a correct and
valuable gRPC trace is undermined by stamping the querying repo's `revisionId`
onto nodes from three other clones, silently. *Cost:* low for the honest version.
Carry each node's own `repoId`/`branchId`/`revisionId`; print `[repo@branch]` on
every cross-repo step in text mode; add a `warnings` entry when the walk leaves
`--repo`. Deduplicating multiple registrations of the same logical repo is a
bigger job — disclosing them is not.

**5. Fix the `flow` text renderer.** *Problem:* §5.5 — indentation attaches
callees to whichever type reference printed last, so the plain-text tree asserts
a call structure that doesn't exist; and §5.3's sibling problem, two `check`
rows with no paths. *Cost:* low. Track real parentage (the JSON already has
enough), separate `calls` from `references` into their own sections or suppress
`references` by default, and always print `file:line` on a row.

**6. Distinguish type positions from calls in `externalCalls`.** *Problem:* §5.4
— `ExecutionContext`/`CallHandler`/`Observable` in a signature are counted as
calls, doubling `externalCallCount` and skewing the `completeness` and
`confidence` fields that are the product's best feature. *Cost:* low. Add
`kind: "call" | "type"` to each entry and count only calls.

**7. Make `onboarding` generate the thing it promises.** *Problem:* §5.9 — the
one command a newcomer will run returns a contentless template, while the data
for a real orientation is all in the DB. *Cost:* moderate, but it's assembly, not
new analysis: per-app file counts from `files`; the repo's own top communities
(scoped); its endpoints grouped by app and transport; the highest-fan-out
symbols by `affected` size; one fully-expanded `flow` as a worked example.
That is roughly the B1 write-up above, and I built it from four existing
commands.

**8. Honour `--repo` in `architecture`, `communities`, `repograph`; make
`repograph` compute degree.** *Problem:* §5.10, §5.11 — three of the four
orientation commands are unusable on a single repo. *Cost:* low for the scope
filter (the flag is already parsed and dropped); low for degree (count edges per
node and sort). Excluding `.spec.ts` and `field` nodes from hub ranking would
help too — `parseInt` and `isNaN` are not architecture.

**9. Stop crying wolf with `COVERAGE_INCOMPLETE`.** *Problem:* §5.8 — the banner
fires on every search at 0 failures / 7 excluded, so it gets ignored. *Cost:*
trivial. Fire when `failed > 0`, or when an excluded file is inside the query's
path scope. And make `coverage --json` list the excluded paths — right now it
tells you not to trust negatives while withholding what you'd need to check.

**10. Make `search` understand qualified names, and index definitions not just
import lines.** *Problem:* §5.12 — `search "Class.method"` returns 0 hits for
something `explore` resolves fine; searching a filename returns importers but not
the file. *Cost:* moderate. Route `A.b` through the same resolver `explore` uses.

### Capabilities I wanted and could not find at all

- **List a repo's endpoints.** There are 1638 `endpoint` nodes and no verb that
  enumerates them for one repo. `penguin endpoints --repo X [--transport http|grpc]`
  would answer half of B1 by itself. This is the biggest missing *command*.
- **Untested endpoints.** `flow` reports `relatedTests` per endpoint and
  `affected` maps files→specs, so the join exists. `penguin untested --repo X`
  would have handed me B4 in one command instead of by accident.
- **Duplicate / near-duplicate detection.** I found two genuine forks
  (health-check, `CMSGenBaseResponse`) and both surfaced by luck. `contentHash`
  is already on every symbol version — an exact-duplicate report is close to
  free, and it is exactly the class of problem a whole-estate index should be
  uniquely good at.
- **Reverse flow.** `flow` goes endpoint→down. I repeatedly wanted "what routes
  reach this symbol" — the context pack has a *"HTTP routes reaching this"*
  section, so the traversal exists but has no verb of its own.
- **Filter dead-code by framework awareness.** `deadcode` is ~90% false positives
  on NestJS because constructors, `@Module`s and `@Controller`s are DI-reachable.
  A `--exclude-di` flag using the decorator information already in the graph
  would take 77 candidates down to something a human would actually read.
- **Diff-scoped queries.** `penguin affected` takes file paths; I wanted
  `penguin affected --since HEAD~5` or against a branch. `compare` exists for one
  symbol across branches, which isn't the same thing.

---

## 8. How it felt to use

The first ten minutes were the best part. `penguin flow "POST
/promotion/GetPlayerFreeSpinInfo" --json` came back with a chain that went
controller → transformer → processor → Redis → strategy factory → gRPC client →
*a handler in a different service*, and I remember thinking that I could not have
got that out of grep in an afternoon. Then `completeness` told me, unprompted,
that its own list was a lower bound and named the six calls it couldn't resolve.
That's a tool built by someone who has been burned by a confident wrong answer,
and it changed how I read everything after — I stopped auditing the output for
plausibility and started trusting the diagnostics to flag their own gaps.

The friction was almost entirely in one place: **getting from a name to a node.**
Half my commands were disambiguation. The loop was always the same — run
`explore <name>`, get `ambiguous target: N matches`, scroll past six `field`
nodes that are mock properties in spec files, find the two real symbols, copy a
UUID, re-run. Q2 took three commands to answer a question that is one command's
worth of data. And UUIDs are miserable to work with by hand;
`node_cf76d4d7-08e2-410a-bc9c-04175f5929fb` is not something you type twice.
`penguin explore <repo>:<path>:<symbol>` would have removed most of it.

The thing that genuinely surprised me — the good kind — was how much real code
review I could do without opening a file. I found the forked health-check by
noticing `flow "GET /healthcheck"` returned two handlers, and then confirmed the
fork had *drifted* by pulling both `check()` bodies straight out of the index and
diffing them by eye. Never touched the filesystem. That's the product working
exactly as advertised, and it produced a finding I'd raise in a real review.

The surprise I didn't enjoy was discovering, halfway through B2, that the
beautiful cross-service trace was pointing at a benchmark clone. Three identical
handler lines with no repo label read as an overload set; it took a
`filesymbols` call returning `(no symbols indexed)` for a file the trace had just
named to realise what had happened. That is the failure mode Penguin is otherwise
so careful to avoid — a confident answer with no flag on it — and it stings more
here precisely because the rest of the tool is so scrupulous about admitting
uncertainty. The `--repo` flag being silently ignored by `architecture` and
`communities` has the same shape: quiet non-compliance is worse than an error.

What I expected and didn't find: a way to list a repo's endpoints. It seems like
the most natural question to ask a thing that has indexed 1638 of them, and I
went looking three separate times before accepting it isn't there. I also
expected `penguin onboarding` to be the flagship — it's the command with the most
inviting name — and getting back a form letter with the section headings filled
in and the content left as an exercise was the low point of the session. Ten
minutes with `files`, `communities` and `flow` got me a real orientation; the
command whose only job is to do that got me nothing.

Would I reach for it again? Yes, first, for any question shaped like "who calls
this", "what breaks if I change this", or "where does this request go". It is
faster than grep at those and it tells me when it doesn't know, which grep never
does. I would not reach for it to find the line I'm about to edit, and I'd keep
checking anything it tells me about freshness. Fix call-site lines and the
`field`-node noise and it stops being a tool I supplement with grep and starts
being the one I use instead.
