# Penguin index evaluation — Opus 5, round 4

> Model: Claude Opus 5 (1M context). Build `7b6086b9`, DB schema 14, parser
> `tree-sitter-wasm-v8-wrapper-allowlist`. Date 2026-08-29.
> All answers below come from the Penguin CLI only. No grep, no file reads, no
> outside knowledge of FPMS-NT. Where the index could not answer, I say so.

Harness used for every command in this report:

```sh
VN=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
export PENGUIN_WASM_DIR=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm
B=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs
"$VN" "$B" <command> [--json]      # written below as: penguin <command>
```

---

## 1. Summary

Yes — with two hard conditions. Penguin's **call graph is the real thing**: on
every question in Part A where I could resolve a target to a node id, the
callers/callees came back complete, with `file:line`, and the cross-service
trace in Q14 followed a gRPC hop from `apps/promotion` into `apps/player` in a
single call. That is genuinely better than grep. But I would only rely on it if
(a) I **always pass `--repo`** — `penguin affected` silently answered a change-impact
question against the wrong repository and told me "impacted 0 · aligned", and
(b) I **treat `search` as a grep and never as a way into the graph** — it returned
`kind: source_occurrence` for all 41/50/25/21/16 hits on four different queries
and has never once returned a node id, even though `explore`'s own ambiguity
error tells you to "pass a node id from `penguin search`".

The two things that would move this tool the most are unglamorous: make `search`
return graph nodes, and make `affected` refuse to answer when the path it was
given does not exist in the revision it picked. Everything else in section 5 is
smaller than those two.

---

## 2. Part A answers

Repo `FPMS-NT` @ `brazil-v2`, indexed commit `3f0f1984`, worktree clean,
`indexedCommit == headCommit`. **Staleness caveat that applies to every answer
below**: `penguin status` reports `FPMS-NT brazil-v2(live,stale=725)` while
`trust` on the same branch reports `"stale": false, "staleReason": null` and
`penguin coverage --repo FPMS-NT --json` reports `"stale": 0`. Three subsystems
disagree. I have flagged the two individual symbols that surfaced as stale
(Q10) but I cannot enumerate the other 723 — see section 5.

### Q1 · callers of `CMSGenBaseResponse`

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

tool used: penguin callers CMSGenBaseResponse --repo FPMS-NT   → refused (ambiguous)
           penguin explore CMSGenBaseResponse --repo FPMS-NT --json  → ambiguousCandidates
           penguin callers node_e8e51538-1f09-436e-92f1-bac9e5221eb5 --json
confidence: high
```

Two commands were needed because the name is ambiguous with
`libs/common/base-response.ts:452`. The refusal was correct and the candidate
list carried both node ids. `evidence.incomingByType` = `{"calls": 8, "defines": 1}`,
which matches the eight rows exactly. Note the **text** output of `penguin callers`
prints only `symbol<TAB>success` — no file, no line. `--json` is mandatory here.

### Q2 · callees of `accumulatePlayerDeposit` (deposit-limit.service.ts:163)

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

tool used: penguin explore accumulatePlayerDeposit --repo FPMS-NT --json (ambiguous, 6 matches)
           penguin explore node_cf76d4d7-08e2-410a-bc9c-04175f5929fb --json
confidence: high for what is listed; the list is a declared lower bound
```

`completeness.status = "lower_bound"`, `externalCallCount = 0`. Verbatim note:
*"constructor calls, interface dispatch, static-method calls and calls inside
callback bodies are not modelled, so a short list may mean few calls or few
visible calls."* So: ten resolved in-repo callees, zero external, and the index
tells me itself that this is a floor, not a ceiling.

Disambiguation cost: six candidates, of which **three were `nodeType: "field"`
with `filePath: null` and `startLine: null`** — unusable for picking. Only three
were real symbols.

### Q3 · `GET /healthcheck`

```
answer:
handlers (2, both bound to the same endpoint node):
- apps/livechat/src/http-health-check/http-health-check.controller.ts:12 — check
- libs/tools/src/http-health-check/http-health-check.controller.ts:12    — check
each handler calls its own service:
- apps/livechat/src/http-health-check/http-health-check.service.ts:20 — check
- libs/tools/src/http-health-check/http-health-check.service.ts:35   — check
below that (parent attribution not available, see note):
- libs/common/base-redis.service.ts:721 — getConnectionStr
- libs/common/base-redis.service.ts:717 — ping
external: @nestjs/common Res (line 12), express Response (line 12)

tool used: penguin flow "GET /healthcheck" --repo FPMS-NT
           penguin explore "GET /healthcheck" --repo FPMS-NT --json
confidence: medium — see below
```

Medium, not high, for one reason: **the index cannot tell me which of the two
`check` services calls `ping`/`getConnectionStr`.** `callPath` is a flat list of
`{depth, via, …}` with no parent pointer (I checked the keys:
`['depth','endLine','filePath','nodeId','nodeType','source','startLine','title','via']`).
The `flow` renderer indents by depth anyway, which produces a tree that is not
the real tree — see section 5.

`tests: []` — this endpoint has no tests according to the index.

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

tool used: penguin filesymbols brazil-v2 apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts --repo FPMS-NT
confidence: high — all 12 report status "fresh"
```

### Q5 · external calls from `DynamicThresholdVipConfigDto`

```
answer:
- class-validator → IsEnum          (line 16)
- class-validator → IsArray         (line 19)
- class-validator → ArrayMinSize    (line 20)
- class-validator → ArrayMaxSize    (line 21)
- class-validator → ValidateNested  (line 22)
- class-transformer → Type          (line 23)
in-repo calls: none (calls == [])

is the list COMPLETE? NO.
tool used: penguin explore DynamicThresholdVipConfigDto --repo FPMS-NT --json
confidence: high on the six named; the completeness verdict is the index's own
```

How I know it is not complete — the index says so, in a machine-readable field
rather than prose:

```json
"completeness": {
  "status": "partial",
  "externalCallCount": 6,
  "note": "6 call(s) go to external packages and have no in-repo target — see
   externalCalls. Beyond those, the calls list is a lower bound: constructor
   calls, interface dispatch, static-method calls and calls inside callback
   bodies are not modelled."
}
```

`status` is never `"complete"` by construction. So the honest answer is: these
six are the external calls the parser resolved to a package specifier; a
constructor call or a static call to another external package would not appear
here at all. This is the single best-designed thing in the tool.

### Q6 · dead-code candidates under `apps/admin/`

Scope, quoted from the tool: `Scope: repo FPMS-NT, under apps/admin/`, branch
`branch_10012ad4` (= `brazil-v2`), `"truncated": false`. Definition, quoted:
*"no inbound calls/references/handles/tests — verify: DI, reflection, framework
magic, dynamic import, and public entry points are false positives."*

77 candidates. Complete list:

- apps/admin/inteceptor/external.module.ts:14 — useFactory  (fileImportedBy=1)
- apps/admin/inteceptor/external.module.ts:48 — ExternalModule  (fileImportedBy=1)
- apps/admin/inteceptor/payment-external.service.ts:18 — constructor  (fileImportedBy=2)
- apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19 — GameRepositoryModule  (fileImportedBy=2)
- apps/admin/libs/repositories/fpms/admin/game/game-repository.ts:9 — constructor  (fileImportedBy=3)
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.module.ts:19 — PlatformAnnouncementRepositoryModule  (fileImportedBy=2)
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:8 — constructor  (fileImportedBy=3)
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13 — findById  (fileImportedBy=3)
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:25 — findOne  (fileImportedBy=3)
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:29 — find  (fileImportedBy=3)
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:36 — update  (fileImportedBy=3)
- apps/admin/libs/repositories/fpms/schemas/game.schema.ts:166 — GameDocument  (fileImportedBy=2)
- apps/admin/libs/repositories/fpms/schemas/platform-announcement.schema.ts:44 — PlatformAnnouncementDocument  (fileImportedBy=2)
- apps/admin/libs/spi/address/sites/base/base-address.provider.ts:12 — BaseAddressProvider  (fileImportedBy=1)
- apps/admin/libs/spi/address/sites/base/base-address.provider.ts:13 — getAddressDetail  (fileImportedBy=1)
- apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:14 — BpAddressProvider  (fileImportedBy=1)
- apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:15 — getAddressDetail  (fileImportedBy=1)
- apps/admin/src/address/address.controller.ts:6 — AddressController  (fileImportedBy=1)
- apps/admin/src/address/address.controller.ts:7 — constructor  (fileImportedBy=1)
- apps/admin/src/address/address.module.ts:11 — AddressModule  (fileImportedBy=1)
- apps/admin/src/address/address.service.ts:10 — constructor  (fileImportedBy=2)
- apps/admin/src/admin/admin.controller.ts:11 — AdminController  (fileImportedBy=1)
- apps/admin/src/admin/admin.controller.ts:12 — constructor  (fileImportedBy=1)
- apps/admin/src/admin/admin.module.ts:80 — AdminModule  (fileImportedBy=1)
- apps/admin/src/admin/admin.service.ts:31 — constructor  (fileImportedBy=3)
- apps/admin/src/admin/admin.service.ts:48 — onModuleInit  (fileImportedBy=3)
- apps/admin/src/admin/admin.service.ts:263 — onModuleDestroy  (fileImportedBy=3)
- apps/admin/src/admin/admin.service.ts:267 — onApplicationShutdown  (fileImportedBy=3)
- apps/admin/src/admin/dto/check-has-permission.dto.ts:21 — constructor  (fileImportedBy=2)
- apps/admin/src/admin/dto/update-platform-config.dto.ts:148 — constructor  (fileImportedBy=3)
- apps/admin/src/config/config.controller.ts:13 — ConfigController  (fileImportedBy=1)
- apps/admin/src/config/config.controller.ts:14 — constructor  (fileImportedBy=1)
- apps/admin/src/config/config.module.ts:27 — ConfigModule  (fileImportedBy=1)
- apps/admin/src/config/config.service.ts:17 — constructor  (fileImportedBy=2)
- apps/admin/src/config/dto/get-config.dto.ts:13 — constructor  (fileImportedBy=2)
- apps/admin/src/config/dto/get-eid-config-by-eid.dto.ts:12 — constructor  (fileImportedBy=2)
- apps/admin/src/config/dto/get-platform-config-by-platform-id.dto.ts:8 — constructor  (fileImportedBy=2)
- apps/admin/src/http-health-check/http-health-check.module.ts:27 — useFactory  (fileImportedBy=1)
- apps/admin/src/http-health-check/http-health-check.module.ts:51 — HttpHealthCheckModule  (fileImportedBy=1)
- apps/admin/src/jackpot/dto/update-live-jackpot-config.dto.ts:20 — JackpotConfigItemDto  (fileImportedBy=2)
- apps/admin/src/jackpot/executors/jackpot.executor.ts:41 — constructor  (fileImportedBy=1)
- apps/admin/src/jackpot/executors/jackpot.executor.ts:48 — onModuleInit  (fileImportedBy=1)
- apps/admin/src/jackpot/executors/jackpot.executor.ts:150 — executeSuccess  (fileImportedBy=1)
- apps/admin/src/jackpot/executors/jackpot.executor.ts:157 — executeReject  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot-executor.module.ts:18 — useFactory  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot-executor.module.ts:54 — JackpotExecutorModule  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot.controller.ts:11 — JackpotController  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot.controller.ts:12 — constructor  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot.module.ts:20 — useFactory  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot.module.ts:28 — JackpotModule  (fileImportedBy=1)
- apps/admin/src/jackpot/jackpot.service.ts:21 — CreateAdminProposalResponse  (fileImportedBy=2)
- apps/admin/src/jackpot/jackpot.service.ts:31 — constructor  (fileImportedBy=2)
- apps/admin/src/jackpot/jackpot.service.ts:37 — checkPendingProposal  (fileImportedBy=2)
- apps/admin/src/main.ts:31 — bootstrap  (fileImportedBy=0)
- apps/admin/src/platform-announcement/dto/delete-player-mail.dto.ts:13 — constructor  (fileImportedBy=2)
- apps/admin/src/platform-announcement/dto/read-player-mail.dto.ts:11 — constructor  (fileImportedBy=2)
- apps/admin/src/platform-announcement/platform-announcement.controller.ts:10 — PlatformAnnouncementController  (fileImportedBy=1)
- apps/admin/src/platform-announcement/platform-announcement.controller.ts:11 — constructor  (fileImportedBy=1)
- apps/admin/src/platform-announcement/platform-announcement.module.ts:17 — PlatformAnnouncementModule  (fileImportedBy=1)
- apps/admin/src/platform-announcement/platform-announcement.service.ts:12 — constructor  (fileImportedBy=2)
- apps/admin/src/platform/dto/get-platform-country.dto.ts:9 — constructor  (fileImportedBy=1)
- apps/admin/src/platform/platform-cache.manager.ts:37 — constructor  (fileImportedBy=5)
- apps/admin/src/platform/platform.controller.ts:10 — PlatformController  (fileImportedBy=1)
- apps/admin/src/platform/platform.controller.ts:11 — constructor  (fileImportedBy=1)
- apps/admin/src/platform/platform.module.ts:13 — PlatformModule  (fileImportedBy=1)
- apps/admin/src/platform/platform.service.ts:14 — constructor  (fileImportedBy=2)
- apps/admin/src/player/admin-player.controller.ts:11 — constructor  (fileImportedBy=2)
- apps/admin/src/player/admin-player.module.ts:11 — AdminPlayerModule  (fileImportedBy=1)
- apps/admin/src/player/admin-player.service.spec.ts:11 — PlayerClientGrpcMock  (fileImportedBy=0)
- apps/admin/src/player/admin-player.service.spec.ts:16 — createDto  (fileImportedBy=0)
- apps/admin/src/player/admin-player.service.spec.ts:20 — createBaseResponse  (fileImportedBy=0)
- apps/admin/src/player/admin-player.service.ts:14 — constructor  (fileImportedBy=4)
- apps/admin/src/player/dto/unbind-player-phone-number.dto.ts:3 — UnbindPlayerPhoneNumberDto  (fileImportedBy=2)
- apps/admin/test/e2e/setup-jest-e2e.ts:3 — initEnv  (fileImportedBy=0)
- apps/admin/test/unit/admin/admin.service.spec.ts:37 — createAdminTestingModule  (fileImportedBy=0)
- apps/admin/test/unit/admin/admin.service.spec.ts:64 — createUpdatePlatformConfigRequest  (fileImportedBy=0)
- apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — countryResult  (fileImportedBy=0)

```
tool used: penguin deadcode --repo FPMS-NT --path apps/admin/ --json
confidence: high that the query is right; low that the answer is useful — see below
```

**Scope of the answer**: symbols under `apps/admin/` on `brazil-v2` with zero
inbound `calls`/`references`/`handles`/`tests` edges. It does **not** cover
imports (file-to-file `imports` edges exist but are not inbound *calls*), DI
resolution, decorator wiring, or anything invoked reflectively.

The `fileImportedBy` counter added in round 3 works and is reported on every
row. But it does not do the job it was added for. Of 77 candidates, **69 sit in
a file that something imports**, and the 8 that do not are:

```
apps/admin/src/main.ts:31                              — bootstrap                      (entry point)
apps/admin/test/e2e/setup-jest-e2e.ts:3                — initEnv                        (test setup)
apps/admin/test/unit/admin/admin.service.spec.ts:37    — createAdminTestingModule       (spec-local helper)
apps/admin/test/unit/admin/admin.service.spec.ts:64    — createUpdatePlatformConfigRequest (spec-local helper)
apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — countryResult            (spec-local)
apps/admin/src/player/admin-player.service.spec.ts:11  — PlayerClientGrpcMock           (spec-local)
apps/admin/src/player/admin-player.service.spec.ts:16  — createDto                      (spec-local)
apps/admin/src/player/admin-player.service.spec.ts:20  — createBaseResponse             (spec-local)
```

Every one is a file role that by construction has no importer: an app entry
point, a jest setup file, and helpers defined and used inside their own spec.
So `fileImportedBy == 0` does not discriminate dead from live — it discriminates
*leaf files from imported files*. **I would report zero true positives from this
run.** More detail in section 5.

### Q7 · callers of `addPlayerFreeSpin` (add-free-spin-processor.ts:34)

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

tool used: penguin explore addPlayerFreeSpin --repo FPMS-NT --json (ambiguous, 10 matches — 8 of them
           nodeType "field" with null filePath)
           penguin explore node_c628b4a7-1f02-4608-a8f7-75236f29d1a0 --json
confidence: high
```

Route reached: `gRPC FreeSpinInternalService.AddPlayerFreeSpin` (`via: "caller"`).

### Q8 · callees of `applyOpenPromoCode` (promo-code.processor.ts)

```
answer — in repo:
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

answer — leaving the repo (@snsoft/proposal-sdk):
- proposalSDK.getProposalTypeList (line 1317)
- proposalSDK.getProposalData   (lines 1332, 1338, 1407)

tool used: penguin explore applyOpenPromoCode --repo FPMS-NT --json
           penguin explore node_1ea2bee8-96d9-4550-a9ba-9c4a6e74d10b --json
confidence: high for the listed edges; completeness is "partial" (lower bound)
```

One caller: `promo-code.processor.ts:704 — processPromoCode`.
`confidence.level` came back `"low"` on this one despite 318 total edges and
only 1 inferred — see section 5, that grading is broken.

### Q9 · `POST /internal/vip-cohort/retention-risk`

```
answer:
handler:
- apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:45 — triggerRetentionRisk
what it calls next (depth 2):
- apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101 — run   (calls)
- apps/promotion/src/modules/vip-cohort/interfaces/vip-cohort.interface.ts:133 — VipCohortRunResult (references — return type, not a call)
external: @nestjs/common Query (line 46)
tests: apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.spec.ts

tool used: penguin explore "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT --json
           penguin flow "POST /internal/vip-cohort/retention-risk" --repo FPMS-NT
confidence: high for the handler and depth-2; medium below that (see note)
```

The handler's own source came back inline, including its Chinese comments, which
made it immediately obvious that this is a manual/cron trigger rather than a
player-facing route. That is the index at its best.

Below depth 2 the index returned 55 `callPath` entries down to depth 5 —
including the cross-module hop from `apps/promotion-event-scheduler` into
`apps/promotion/src/modules/vip-cohort/…`, the Redis reads
(`libs/tools/src/redis4/redis4.service.ts:198,393`), the BI fetch
(`vip-cohort-bi.service.ts:40`), the gRPC call
(`player-client-grpc.ts:286 getPlayersForPromotion`), and the Pulsar publish
(`dora-enrollment.publisher.ts:41`). That is a genuinely good picture of a
non-trivial batch job. I mark it medium only because the flat depth list cannot
tell me which parent each depth-4/5 node hangs off.

### Q10 · symbols in `apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts`

```
answer:
- :18  — LiveChatConvoProcessor (class)       [fresh]
- :20  — constructor (method)                 [fresh]
- :35  — updateConversationReview (method)    [fresh]
- :62  — updateConversationTag (method)       [fresh]
- :97  — getConversationTag (method)          [fresh]
- :113 — _endConversation (method)            [fresh]
- :213 — storeConversationData (method)       [fresh]
- :300 — _createConversation (method)         [fresh]
- :466 — getConversationList (method)         [fresh]
- :527 — data (function)                      [STALE]
- :553 — updateConversationTagList (method)   [fresh]
- :563 — tagObjects (function)                [STALE]

tool used: penguin filesymbols brazil-v2 apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts --repo FPMS-NT [--json]
confidence: high on the list; the two STALE rows are passed on as the tool reported them
```

Per rule 4 I am passing the staleness on rather than presenting it as current.
I cannot explain it: `explore` on `data` (`node_4baf05a9`) returns
`"freshness": {"stale": false, "reason": null}` at the top level and
`"branches": [{"branch": "branch_10012ad4…", "status": "stale"}]` twelve lines
later, in the same response.

### Q11 · external calls from `intercept` (accumulative-event-config/interceptors/grpc-base-response.interceptor.ts)

```
answer:
- @nestjs/common → ExecutionContext (line 20)
- @nestjs/common → CallHandler      (line 20)
- rxjs → Observable                 (line 20)
- rxjs → map                        (line 24)
- rxjs → catchError                 (line 31)
- rxjs → of                         (line 35)
in-repo calls: none (calls == []); callers: none (callers == [])

is the list COMPLETE? NO — "completeness.status": "partial", externalCallCount 6.
tool used: penguin explore intercept --repo FPMS-NT --json (ambiguous, 14 matches)
           penguin explore node_a39de83e-e269-470b-a4e8-aa451ec598ba --json
confidence: high on the six; NO on completeness
```

Two reasons I am confident it is *not* complete, one from the tool and one
structural. The tool's: `status: "partial"` plus the standing lower-bound note.
The structural one, from the index's own data: `confidence.totalEdges` is 19 for
this node, yet `calls` and `callers` are both empty arrays. Nineteen edges exist
that `explore` does not surface in either list. Whatever they are (`references`,
`throws`, `reads_field`), the calls list is demonstrably not the whole story.

An interceptor's `intercept` is invoked by the framework and dispatches through
`CallHandler`, both of which fall in the declared blind spot ("interface
dispatch"), so zero callers here is expected, not a bug — but a reader who did
not check `completeness` would read "callers: none" as "dead".

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

tool used: penguin explore addPlayerMudDisbursement --repo FPMS-NT --json (resolved directly, no ambiguity)
confidence: high — confidence.level "high", inferredEdges 0, totalEdges 100
```

Route reached: `gRPC MudInternalService.AddPlayerMud`. Note this is the mirror
image of Q7 (`addPlayerFreeSpin`): eight callers, seven of them the same
dispatch sites. Two parallel reward pipelines.

### Q13 · callees of `createLeaderBoardRewardProposal` (leaderboard.processor.ts)

```
answer — in repo:
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

answer — leaving the repo (@snsoft/proposal-sdk):
- proposalSDK.getProposalData  (line 693)
- proposalSDK.createProposal   (line 756)

tool used: penguin explore createLeaderBoardRewardProposal --repo FPMS-NT --json
confidence: high for the listed edges; completeness "partial"
```

One caller: `apps/promotion/src/pulsar/leaderboard-reward/leaderboard-reward.consumer.ts:60 — handleMessage`.
So this is a Pulsar-consumer path, not an HTTP one (`routes: []`).

### Q14 · `POST /promotion/GetPlayerFreeSpinInfo`

```
answer:
handler:
- apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20 — getPlayerFreeSpinInfoRestful
what it calls next (depth 2):
- apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117 — execute
- apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11 — transformRestfulReqToNt
external: @nestjs/common Body (line 21), Headers (line 22)
tests: [] — the index knows of no test for this endpoint

tool used: penguin explore "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
confidence: high
```

`implementation.source` came back verbatim and confirms the two calls and their
order. This is the single best result in the whole evaluation — see B2.

---

## 3. Part B write-ups

### B1 · Onboarding to `FPMS-NT`

**The obvious move first, and it failed.** There is a command literally named for
this task:

```sh
penguin onboarding FPMS-NT
```

It returns a 24-line template with exactly one fact about FPMS-NT in it — the
repo path. Verbatim, in full:

```markdown
# Penguin Onboarding
## 1. 系统边界
- FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt
## 2. 主要 actor 和术语
- 术语来自已索引的 service、endpoint、entity 和 notes。
## 3. 关键请求/事件流程
- 使用 `penguin flow <endpoint>` 查看已验证的线性流程。
## 4. 数据和状态
- 使用 `penguin architecture` 查看当前索引概况。
...
## 8. 推荐阅读顺序
- Search → Context → Graph → Evidence
```

Every section tells me to run another command instead of answering. It also
switches the CLI into Chinese with no flag. This is the flagship use case and
the flagship command is a stub.

So I built the orientation by hand. Here is what I would actually hand a new
joiner, and every line of it came out of the index.

**Shape of the repo.** 3,333 files admitted, 7 excluded, 0 failed
(`penguin coverage --repo FPMS-NT`). It is a NestJS monorepo of 23 apps plus
shared `libs/`. Distribution from `penguin files FPMS-NT brazil-v2 --json`:

| app | files | app | files |
|---|---|---|---|
| `apps/promotion` | **1686** | `apps/provider` | 46 |
| `apps/payment` | 293 | `apps/offline-casino` | 41 |
| `apps/user-engagement` | 127 | `apps/cms` | 29 |
| `apps/livechat` | 102 | `apps/promotion-scheduler` | 23 |
| `apps/admin` | 66 | `apps/recommend` | 22 |
| `apps/riskControl` | 55 | `apps/card-system` | 15 |
| `apps/push` | 48 | 11 more, ≤13 files each | |

**The first thing I would tell a new joiner: this is not 23 services, it is one
service (`apps/promotion`, 51% of the repo) plus 22 satellites.** That single
number reframes the whole repo and the index gave it up in one command.

**How it talks.** From `penguin architecture --repo FPMS-NT`:

```
nodes: field 102009 · symbol 14435 · file 3306 · log_site 3027 · topic 438 ·
       entity 80 · service 18 · websocket_event 11 · endpoint 6
edges: writes_field 110431 · reads_field 99587 · defines 13710 · imports 11272 ·
       calls 10650 · references 7976 · emits_log 2903 · passes_field 1796 ·
       tests 1620 · publishes 1167 · throws 1046 · uses 258 · invokes 127 ·
       subscribes 68 · handles 7
```

Read that as: **6 HTTP endpoints, 127 gRPC invocations, 1,167 publishes across
438 topics.** This is a gRPC-and-Pulsar estate with a handful of REST doors.
That is a genuinely useful orientation fact and it is not obvious from the file
tree. Confirmed independently: of 135 files with `controller` in the name, only
5 are HTTP-shaped; the rest are `*.internal.controller.ts` gRPC handlers
(`@GrpcMethod('FreeSpinInternalService', 'AddPlayerFreeSpin')`, seen in a
`penguin search` snippet).

**Busiest entry points.** `penguin repograph FPMS-NT brazil-v2 --json` ranks by
degree, and the round-2 fix is confirmed working — degree is reported per node
and no `.spec.ts` file is at the top. But the top of the list is infrastructure,
not domain:

```
IsRequired (libs/tools/src/validators/is-required.ts:20)   degree 339
getSecret  (libs/tools/src/vault/vault-fetcher.ts:126)     degree 300
VaultFetcher (…/vault-fetcher.ts:8)                        degree 287
async      (libs/common/common.ts:754)                     degree 178
PromotionRedisService (…/promotion-redis.service.ts:46)    degree  90
```

`IsRequired` is a validation decorator and `getSecret` is config plumbing — true
hubs, useless for orientation. (`async` is *not* a parser bug, as I first
assumed: `penguin explore` on it shows a real object property literally named
`async: async <T>(spanName, operation) => {…}`, an OpenTelemetry span wrapper in
`libs/common/common.ts`. 25 callers. Worth knowing, badly named, correctly
indexed.) The first genuinely domain-bearing hubs are
`PromotionRedisService` (90), `PlayerClientGrpc` (63),
`redeemPhysicalGift` (64) and `playerDailyShareMissionBoosts` (51).

**Where I would start reading**, derived only from the index:

1. `libs/common/common.ts` and `libs/common/enum.ts` — they anchor community #5
   (3,085 nodes) and every trace I ran passed through them.
2. `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts` — 1,839
   lines, degree 90, appears in the callee list of every reward path I traced
   (`incrby` at :215 shows up in both `addPlayerFreeSpin` and
   `addPlayerMudDisbursement`).
3. `libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts` — the
   door to the other 25 repos.
4. `apps/promotion/src/reward-grant/adapters/` — the Q7/Q12 answers show
   `free-spin-grant.adapter.ts` and `mud-grant.adapter.ts` as parallel adapters
   over the same dispatch surface. That is the repo's core abstraction and the
   call graph handed it to me without my asking.

**Commands: 7** (`onboarding`, `coverage`, `files`, `architecture`,
`repograph`, `communities`, `explore`). One of them was useless.

**Confidence: medium.** High on structure and call topology; low on anything
temporal or human.

**What the index did not tell me that I wanted on day one:**

- **What changed recently and who owns it.** `penguin timeline 8 --repo FPMS-NT`
  → `(no commits indexed)`. `penguin recent --repo FPMS-NT` → `(no results)`.
  Both commands work on the tool's own repo (`penguin timeline 6` returns six
  penguin-src commits), so this is not a broken feature, it is missing data for
  FPMS-NT. Churn is the single best "where do I start reading" signal and it is
  absent.
- **What the endpoints are.** I know there are exactly 6. I could not enumerate
  them. `penguin search "POST /promotion/GetPlayerFreeSpinInfo"` → `hits 0`,
  even though that exact string is a node title in the graph. There is no
  `penguin endpoints` verb.
- **Module boundaries.** `penguin communities 12 --repo FPMS-NT` ignored
  `--repo` entirely and returned clusters from `FPMS-NT-Auth-Player`,
  `casino-plus-app` and `FPMS`. Of the 12, communities #1 and #2 have
  near-identical member lists (`enum.ts, common.ts, player-repository.ts,
  types.ts`), so label propagation split one god-cluster in two. Not usable.
- **Any prose at all** — no README, no note, no design doc surfaced.

### B2 · Trace a request: `POST /promotion/GetPlayerFreeSpinInfo`

One command:

```sh
penguin explore "POST /promotion/GetPlayerFreeSpinInfo" --repo FPMS-NT --json
```

What happens on that request, per the index:

1. **`apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20`
   — `getPlayerFreeSpinInfoRestful`.** Source returned inline:
   ```ts
   async getPlayerFreeSpinInfoRestful(
     @Body() data: Omit<GetPlayerFreeSpinInfoReq, 'token'>,
     @Headers() headers: Record<string, string>,
   ): Promise<GetPlayerFreeSpinInfoRes> {
     const payload = GetPlayerFreeSpinInfoTransformer.transformRestfulReqToNt(data, headers);
     return await this.getPlayerFreeSpinInfoProcessor.execute(payload);
   }
   ```
   A thin REST façade: normalise the body+headers into the internal DTO, delegate.
2. **`…/get-player-free-spin-info.transformer.ts:11` — `transformRestfulReqToNt`**,
   which calls `libs/common/transformer.util.ts:7 — transformUnknownToNt`.
3. **`…/processors/get-player-free-spin-info.processor.ts:117` — `execute`.** It
   reads Redis (`libs/tools/src/redis2/redis2.service.ts:986 —
   getPlayerFreeSpinClaimed`, which bottoms out at
   `libs/common/base-redis.service.ts:300 — smembers`), builds
   `buildVerifyFreeSpinPlayerData` (:177), and picks a strategy via
   `…/strategies/verify-free-spin-strategy.factory.ts:12 — createStrategy`
   against the `IVerifyFreeSpinStrategy` interface.
4. **It leaves the app.** `libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206
   — getFreeSpinPlayerInfo`, wrapped by `catchGrpcError` (:160) and
   `player-client-grpc.transformer.ts:8`, emitting
   `invokes → gRPC PlayerService.GetFreeSpinPlayerInfo`.
5. **And it comes back down in a different app.** The index resolves that gRPC
   call to its handler:
   `apps/player/src/player/controllers/player-internal.controller.ts:49 —
   getFreeSpinPlayerInfoRes`, returning
   `apps/player/src/player/dto/get-free-spin-player-info.dto.ts:81`.

**This is the result that justifies the tool.** Step 5 is the thing grep cannot
do: a string search for `getFreeSpinPlayerInfo` gives you 50 undifferentiated
hits; the index gives you the wire hop and lands you on the handler in another
app. One call, ~2 seconds.

**Where the chain broke, and how I noticed.**

- **Attribution above depth 3.** The `flow` renderer's tree is fabricated. Its
  JSON (`steps[]`) carries only `{depth, via, …}` — no parent id — so the CLI
  indents by depth and every depth-N+1 node visually hangs off the *last*
  depth-N sibling. On this endpoint that puts `smembers` under
  `GetPlayerFreeSpinInfoResData`; on Q9 it renders `VipCohortRunResult` —
  a TypeScript **interface** — as calling `isDisabledBySwitch`, `finishRun`,
  `load`, `drainPages` and nine more. An interface calls nothing. I noticed
  because Q9's flow tree was semantically impossible, then confirmed by dumping
  the JSON keys.
- **Three identical handler rows.** Depth 5 lists
  `getFreeSpinPlayerInfoRes` at `player-internal.controller.ts:49`, `:70` and
  `:95` — three `handles` edges into what the index presents as the same-named
  method at three different lines, with no way to tell which one serves this
  call.
- **Two junk rows:** `handles player | None None` and `handles proto | None None`.
  Proto package/service path fragments leaking in as graph nodes.
- **`penguin context` is not a substitute.** The brief describes it as "the same
  as `explore` as a readable markdown pack". On this endpoint it returns
  *four lines* — `# Context Pack`, `- **type**: endpoint`, `scope:`. All 27
  callPath entries, the source, the routes: gone. On a *symbol* node the same
  command is excellent (195 lines: signature, full source, HTTP routes, called-by,
  calls, external packages, uses-types, imported-by). It just does not implement
  the endpoint case.
- **`tests: []`.** No test covers this endpoint.

### B3 · Change impact: signature of `addPlayerFreeSpin`

If I change `addPlayerFreeSpin(payload: AddFreeSpinDto)` in
`apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts:34`,
the direct call sites are (from Q7):

```
apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:19  — addPlayerFreeSpin
apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:182 — dispatchFreeSpin
apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:30        — dispatch
apps/promotion/src/winsday-billion/services/reward-grant.service.ts:65        — grantFreeSpin
apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — dispatchReward
apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88 — redeemPhysicalGift
apps/promotion/src/special-event/services/special-event-mission.service.ts:1731 — claimTaskReward
apps/promotion/src/winsday-billion/services/post-win-share.service.ts:457     — grantFreeSpin
```

Transitive blast radius, 19 symbols (`penguin impact node_c628b4a7… --json`),
adds these 11 beyond the direct callers:

```
apps/promotion/src/winsday-billion/services/reward-grant.service.ts:50        — grant
apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.ts:34 — claimColorLandTaskReward
apps/promotion/src/modules/color-land/processors/dice.processor.ts:51         — playDice
apps/promotion/src/physical-gift/controllers/physical-gift.controller.ts:31   — redeemPhysicalGift
apps/promotion/src/special-event/services/special-event-mission.service.ts:2309 — claimReward
apps/promotion/src/winsday-billion/services/post-win-share.service.ts:432     — grant
apps/promotion/src/winsday-billion/services/boost-claim.service.ts:281        — grantAndCache
apps/promotion/src/modules/color-land/controllers/color-land.controller.ts:155 — claimColorLandTaskReward
apps/promotion/src/modules/color-land/controllers/color-land.controller.ts:103 — rollColorLandDice
apps/promotion/src/special-event/processors/special-event-mission.processor.ts:25 — claimTaskReward
apps/promotion/src/winsday-billion/services/post-win-share.service.ts:212     — claim
```

Externally reachable surface and the tests that cover it
(`penguin affected …/add-free-spin-processor.ts --repo FPMS-NT --json`):

```
routes: gRPC FreeSpinInternalService.AddPlayerFreeSpin
        gRPC v1.FrontendPhysicalGiftService.RedeemPhysicalGift
        gRPC promotion.v1.FrontendColorLandService.RollColorLandDice
        gRPC promotion.v1.FrontendColorLandService.ClaimColorLandTaskReward
tests:  apps/promotion/src/physical-gift/processors/redeem-physical-gift-routing.spec.ts
        apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.spec.ts
        apps/promotion/test/unit/color-land/processors/dice.processor.spec.ts
        apps/promotion/src/modules/color-land/processors/claim-color-land-task-reward.processor.spec.ts
        apps/promotion/test/unit/color-land/controllers/color-land.controller.spec.ts
```

**How much would I trust this list before actually making the change? For the
eight direct callers: enough to start, not enough to stop.** Three reasons, all
of them things the index told me:

1. `completeness.status` for this node is `"partial"` and the standing note says
   *"constructor calls, interface dispatch, static-method calls and calls inside
   callback bodies are not modelled."* `free-spin-grant.adapter.ts:30 — dispatch`
   is, by its name and position, an implementation of a grant-adapter interface.
   **A call site that goes through that interface is exactly the case the index
   admits it cannot see.** For a signature change — where a missed site is a
   compile error at best and a runtime failure at worst — that is disqualifying
   on its own. I would still run `tsc`.
2. `confidence.level` came back `"low"` with `inferredEdges: 1` out of
   `totalEdges: 118`. The index is telling me one of these relations is a guess
   and not telling me which one.
3. Four of the five tests cover `physical-gift` and `color-land`, i.e. the
   *transitive* consumers. **No test in the list exercises `addPlayerFreeSpin`
   itself**, and the endpoint that reaches it
   (`gRPC FreeSpinInternalService.AddPlayerFreeSpin`) has no direct spec. So the
   list of things that would catch my mistake is thinner than the list of things
   that would break.

**Two defects surfaced while doing this**, both in `affected`, and one is the
worst thing I found in the whole evaluation:

**(a) `affected` silently answered against the wrong repository.** Run without
`--repo`, from a shell whose cwd is `/Users/shieng/Desktop/Pengvi`:

```
$ penguin affected apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts
changed 0 · impacted 0 · tests 0 · routes 0

scope: penguin-src@main d84c9b6 (aligned)
```

`impacted 0` on a symbol with a 19-node blast radius and four live gRPC routes.
It resolved the repo from the **working directory**, not from the path it was
handed; that path does not exist in `penguin-src` at all; and it reported
`alignment: "aligned"` rather than "file not found in this revision". A user
asking "what breaks if I change this file" gets a confident **"nothing"**. The
scope line is printed *below* the answer, and in `--json` `alignment: "aligned"`
sits next to four empty arrays. `--repo FPMS-NT` fixes it completely
(`changed 12 · impacted 30 · tests 5 · routes 4`), which makes this a pure
default-behaviour bug, not a data gap. Note `affected` is **not** on the round-2
list of commands that learned `--repo`; it evidently accepts it now, but the
no-`--repo` path was never made safe.

**(b) `affected`'s `impacted[]` has no locations.** All 30 entries look like
this — bare titles, no `filePath`, no `startLine`:

```
?:None — constructor      (× 10)
?:None — addPlayerFreeSpin
?:None — dispatchFreeSpin
?:None — grant            (× 2)
?:None — claimTaskReward  (× 2)
...
```

Ten of the thirty are called `constructor` with no owning class. The list is
unnavigable. `penguin impact` on the same symbol returns full `filePath` +
`startLine` for every node — so the data exists and `affected` drops it. I had
to run `impact` separately to get the table above.

**Effort: 4 commands and one wrong answer** — `affected` (wrong repo, silent),
`affected --repo`, `impact --json`, `explore --json`.

### B4 · Find something wrong: a forked `http-health-check` that has drifted

`libs/tools/src/http-health-check/` is the shared health-check module. `apps/livechat`
carries its own copy. The copy has drifted, and both register the same route.

Evidence, three commands, no source reads:

```sh
penguin filesymbols brazil-v2 libs/tools/src/http-health-check/http-health-check.controller.ts --repo FPMS-NT
penguin filesymbols brazil-v2 apps/livechat/src/http-health-check/http-health-check.controller.ts --repo FPMS-NT
```
```
libs/tools/…/http-health-check.controller.ts:6   class  HttpHealthCheckController
libs/tools/…/http-health-check.controller.ts:7   method constructor
libs/tools/…/http-health-check.controller.ts:12  method check
apps/livechat/…/http-health-check.controller.ts:6   class  HttpHealthCheckController
apps/livechat/…/http-health-check.controller.ts:7   method constructor
apps/livechat/…/http-health-check.controller.ts:12  method check
```

Identical names at identical lines — a straight copy. Now the services:

```
libs/tools/…/http-health-check.service.ts:11  class  HttpHealthCheckService
libs/tools/…/http-health-check.service.ts:15  method constructor
libs/tools/…/http-health-check.service.ts:35  method check          ← 35..65
apps/livechat/…/http-health-check.service.ts:11  class  HttpHealthCheckService
apps/livechat/…/http-health-check.service.ts:12  method constructor  ← 12, not 15
apps/livechat/…/http-health-check.service.ts:20  method check        ← 20..60
apps/livechat/…/http-health-check.service.ts:22  function mongoChecks  (stale)
```

**The controllers are still identical but the services have diverged.** The
shared one starts `check` at line 35; the livechat fork starts it at 20 and
carries a `mongoChecks` helper the shared one does not have. Roughly 15 lines of
drift in the file that decides whether a service reports itself healthy.

Which one is real (`penguin deadcode --repo FPMS-NT --path <dir>/ --json`, reading
`fileImportedBy`):

```
libs/tools/…/http-health-check.controller.ts:6  HttpHealthCheckController  fileImportedBy=8
libs/tools/…/http-health-check.service.ts:15    constructor                fileImportedBy=9
apps/livechat/…/http-health-check.controller.ts:6  HttpHealthCheckController  fileImportedBy=1
apps/livechat/…/http-health-check.service.ts:12    constructor                fileImportedBy=2
```

**8-9 files use the shared module; 1-2 use the livechat fork.** And both are
live: `penguin explore "GET /healthcheck" --repo FPMS-NT --json` returns *two*
`handles` edges from the same endpoint node, one to each controller:12.

So: `apps/livechat` runs a stale private fork of the platform health check,
8-9 other files run the shared one, and the two disagree about what "healthy"
means. Concrete, actionable, and I never opened a file.

**A second one, cheaper to fix**, found the same way:
`apps/promotion/libs/interceptor/GrpcResponseInterceptor.ts` and
`libs/common/interceptor/GrpcResponseInterceptor.ts` are *identical* —
`interface StandardResponse` at :11, `class GrpcResponseInterceptor` at :18,
`method intercept` at :21, in both. `fileImportedBy` 2 and 1 respectively. Two
live copies of the same gRPC response envelope, in a repo that also has a third
base-response implementation (`CMSGenBaseResponse` exists at both
`libs/common/base-response.ts:452` and
`apps/promotion/src/budget/budget-base-response.ts:14` — that is what made Q1
ambiguous).

Ironically, none of these showed up in `penguin deadcode`'s 77-row candidate
list for `apps/admin/`, and `deadcode` has no cross-repo duplicate detection at
all. **Duplicate-implementation detection is the highest-value thing this graph
could do that it currently does not do** — the data is already there.

---

## 4. What worked well

**Round 1-3 regression check** (one line each, as the brief asks):

| Fixed in | Status |
|---|---|
| `completeness.status` never says "complete" | ✅ Every resolved target returned `lower_bound` or `partial` with the caveat note verbatim; `unknown` on unresolved ones. |
| Unresolved target → `confidence: low` | ✅ For unresolved. ❌ But `low` is now *also* returned for well-resolved targets — see §5.3. |
| `callers` reports a failed lookup, not `(none)` | ✅ `cannot answer callers for "CMSGenBaseResponse": ambiguous`. |
| `--repo` narrows `explore/context/flow/callers/calls/impact/filesymbols/deadcode/architecture` | ✅ All nine. ❌ Not `communities`, and `affected` needs it but does not default safely — see §5.1. |
| `architecture --repo` scoped; `repograph` ranks by degree | ✅ Both. `repograph --json` reports `degree` per node, no `.spec.ts` at the top. ⚠️ `architecture --json` regressed differently — see §5.6. |
| `truncated` flag on capped results | ✅ Present on `deadcode` (`"truncated": false` on a 77-row result) and `explore` (`"truncated": []`). |
| `fileImportedBy` on dead-code candidates | ✅ Present on all 77 rows. ❌ Does not discriminate — see §5.5. |

**The call graph is accurate where it claims to be.** Not "it looks right" —
Q1's eight callers matched `evidence.incomingByType: {"calls": 8, "defines": 1}`
exactly. Q7 and Q12 independently produced two eight-caller lists that share
seven dispatch sites, which is what a real pair of parallel reward pipelines
looks like. Nothing in Part A was wrong.

**Cross-service tracing is the killer feature.** `POST /promotion/GetPlayerFreeSpinInfo`
crossed from `apps/promotion` through
`libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206`, emitted
`invokes → gRPC PlayerService.GetFreeSpinPlayerInfo`, and landed on
`apps/player/src/player/controllers/player-internal.controller.ts:49`. One
command. Grep gives you 50 identical string hits and no direction.

**`completeness` is exemplary and I want to say so loudly.** Most code-graph
tools return a list and let you assume it is complete. This one returns
`{"status": "lower_bound"|"partial"|"unknown", "externalCallCount": N, "note": "…"}`
naming the four constructs it cannot see. That single field is why my B3
answer could be honest about its own limits instead of confidently wrong. It is
the best-designed thing in the tool and nothing else is close.

**`externalCalls` with `specifier`, `callee`, `receiver` and `line`.** Q8
returned `proposalSDK.getProposalData` at lines 1332, 1338 and 1407 — three
separate call sites of the same external method, each with its own line, plus
the receiver variable name. That is more than "this file imports proposal-sdk".

**Ambiguity is handled correctly.** `explore` refuses rather than guessing, says
how many matches, and hands back `ambiguousCandidates[]` with node ids,
`identityKey`, path and line. The `identityKey`
(`repo_…::apps/promotion/src/budget/budget-base-response.ts::CMSGenBaseResponse`)
is a genuinely well-designed stable identifier.

**`context` on a symbol node** is the best single command in the tool: 195 lines
of signature, full source, HTTP routes reaching it, called-by, calls, external
packages, uses-types, and imported-by-files. If `context` did this for every
node type it would be the front door.

**Speed.** Every query in this evaluation returned in under ~3 seconds against a
993,974-node / 4,410,660-edge database. `penguin doctor`: `ledger seq 12347 /
materialized 12347 — ok`.

---

## 5. What did not work

Ordered by how much damage each one does.

### 5.1 `affected` silently answers against the wrong repo — and says "aligned"

Already given in B3, repeated here because it is the one finding I would fix
before anything else:

```
$ penguin affected apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts
changed 0 · impacted 0 · tests 0 · routes 0

scope: penguin-src@main d84c9b6 (aligned)
```

Correct answer, with `--repo FPMS-NT`: `changed 12 · impacted 30 · tests 5 ·
routes 4`. The tool resolved the repo from cwd, the path does not exist in the
repo it chose, and it returned `alignment: "aligned"` and four empty arrays. **A
change-impact tool that returns a confident empty answer is worse than no tool**,
because "impacted 0" is exactly the answer that stops you checking further. The
scope line prints *after* the verdict, and in JSON there is no signal at all —
just `"alignment": "aligned"` beside `"changed": [], "impacted": [], "tests": [],
"routes": []`.

Fix: if a path argument does not resolve to a file in the chosen revision,
refuse. Do not answer.

### 5.2 `search` never returns graph nodes, and `explore` tells you it does

`explore`'s ambiguity error says, verbatim:

```
the name matches more than one symbol inside FPMS-NT — pass a node id from `penguin search`
```

`penguin search` cannot produce a node id. Four queries, every hit:

| query | hits | kinds | lanes | any nodeId |
|---|---|---|---|---|
| `intercept` | 50 | `{source_occurrence: 50}` | `{source: 50}` | **false** |
| `LiveChatConvoProcessor` | 25 | `{source_occurrence: 25}` | `{source: 25}` | **false** |
| `VipCohortRunner` | 21 | `{source_occurrence: 21}` | `{source: 21}` | **false** |
| `CMSGenBaseResponse` | 16 | `{source_occurrence: 16}` | `{source: 16}` | **false** |

Hit keys are `['evidence','hitId','kind','lane','locator','rankReasons','score','snippet','title','untrustedContent']`
— no `nodeId`, no `nodeType`, no symbol lane. `--legacy-search` is also
source-only. `search "GetPlayerFreeSpinInfo"` returns 50 rows whose `title` is
the *file path*, nine of them the same file, so the text output reads as nine
duplicate lines.

The path that actually works is undocumented: `explore <name> --json` →
`ambiguousCandidates[].nodeId`. I only found it by dumping JSON on a failure.
**Every single Part-A question with an ambiguous name cost me an extra round
trip because the documented route is wrong.**

Worse: **you cannot discover endpoints at all.** `search "POST /promotion/GetPlayerFreeSpinInfo"`
→ `hits 0`, on a string that is verbatim a node title in the graph.
`search "POST /"` returns six source occurrences from DTO and module files and
zero endpoint nodes. So `flow`/`explore` on an endpoint only work if you already
know the route string — which means you already grepped.

### 5.3 `confidence.level` is inverted

Four resolved targets, with the numbers the tool reported alongside each verdict:

| target | totalEdges | inferredEdges | minimum | **level** |
|---|---|---|---|---|
| `data` (livechat-convo-processor.ts:527) | **0** | 0 | 0 | **high** |
| `addPlayerMudDisbursement` | 100 | 0 | 1 | high |
| `intercept` (grpc-base-response) | 19 | 0 | 1 | mixed |
| `createLeaderBoardRewardProposal` | 138 | 0 | 1 | mixed |
| `addPlayerFreeSpin` | 118 | **1** | 0.45 | **low** |
| `applyOpenPromoCode` | 318 | **1** | 0.45 | **low** |

Read the top and bottom rows together. A symbol with **zero edges** — which the
same response also flags `"status": "stale"` — is graded **high**. A symbol with
118 well-resolved edges of which one is inferred is graded **low**. The grade is
`min()` over edge scores, so a single weak edge in 318 condemns the whole answer,
while having no edges at all condemns nothing.

This defeats the round-2 fix. `low` was made to mean "did not resolve"; it now
also means "resolved beautifully, one of three hundred edges is a guess", and the
user cannot tell the two apart. And `mixed` vs `high` is not derivable from any
number in the payload — `addPlayerMudDisbursement` and `createLeaderBoardRewardProposal`
have identical `minimum: 1, inferredEdges: 0` and get different grades.

Fix: report `high | mixed | low` from the *distribution* (e.g. share of inferred
edges), return `unknown` for zero-edge nodes, and name which edges are inferred.
"1 INFERRED edge(s) — verify" without saying *which* is not actionable.

### 5.4 `flow` renders a tree that is not the tree

`flow`'s JSON `steps[]` keys are
`['depth','endLine','filePath','nodeId','nodeType','source','startLine','title','via']`.
There is no parent pointer. The renderer indents by depth, so every depth-N+1
node appears to hang off the last depth-N sibling. On `POST /internal/vip-cohort/retention-risk`
that produces:

```
  ↳ handles → `triggerRetentionRisk`
    ↳ calls → `run`
    ↳ references → `VipCohortRunResult`
      ↳ calls → `isDisabledBySwitch`
      ↳ calls → `finishRun`
      ↳ calls → `load`
      ↳ calls → `drainPages`
      ...
```

`VipCohortRunResult` is an **interface** at
`apps/promotion/src/modules/vip-cohort/interfaces/vip-cohort.interface.ts:133`.
It calls nothing. Those thirteen calls belong to `run`. The output is not
"abbreviated" — it asserts a relationship that does not exist. An agent reading
`flow` output and reasoning from it will reason wrongly.

Either persist the parent edge, or stop drawing a tree and print a depth-banded
list (`depth 3: isDisabledBySwitch, finishRun, load, …`) which would be honest
and just as useful.

### 5.5 `deadcode` produced 77 candidates and, as far as I can tell, zero findings

Full list in Q6. Every one of the 69 rows with `fileImportedBy > 0` is a NestJS
`constructor`, `@Module` class, controller class, DTO constructor, or lifecycle
hook (`onModuleInit`, `onModuleDestroy`, `onApplicationShutdown`) — i.e. exactly
the DI/decorator wiring the tool's own warning says to discount. The 8 rows with
`fileImportedBy == 0` are one app entry point (`main.ts:31 — bootstrap`), one
jest setup file, and six helpers defined and used inside their own `.spec.ts`.

`fileImportedBy` therefore separates **leaf files from imported files**, not dead
code from live code. And the reason the spec helpers appear at all is the
index's own declared blind spot: a helper called from inside an `it(…)` callback
is a "call inside a callback body", which is not modelled.

So the signal-to-noise is 0/77 on this path. Two things would fix most of it,
cheaply, from data already in the graph: drop symbols whose file matches
`*.spec.ts`/`test/**` (or bucket them separately), and drop symbols whose
enclosing file has an inbound `handles`/`defines`-from-`@Module` shape. What I
would actually want instead is **duplicate detection** (§B4) — the graph already
holds everything needed and it finds real problems.

### 5.6 Text and JSON contradict each other in three places

- `penguin architecture --repo FPMS-NT` (text) prints `entrypoints: 6`.
  `penguin architecture --repo FPMS-NT --json` returns `"entryPoints": null`.
  The brief says "`--json` shows fields the text output abbreviates". Here JSON
  shows *less*, and the two disagree about whether the data exists.
- `penguin status` → `FPMS-NT brazil-v2(live,stale=725)`.
  `trust` on the same branch → `"stale": false, "staleReason": null, "worktreeState": "clean", indexedCommit == headCommit`.
  `penguin coverage --repo FPMS-NT --json` → `"stale": 0`.
- `penguin explore node_4baf05a9… --json` returns, in one response:
  `"freshness": {"stale": false, "reason": null}` and
  `"implementation": {"branches": [{"branch": "branch_10012ad4…", "status": "stale"}]}`.

I could not find out what those 725 stale symbols are, why they are stale on a
clean branch at HEAD, or which ones. `filesymbols` surfaces per-symbol `status`,
so the data exists — but there is no `penguin stale --repo X` to list them, and
rule 4 asks me to pass staleness on, which I can only do file by file by
accident.

### 5.7 `penguin onboarding` is a stub, `penguin context` is empty for endpoints

Both covered in B1/B2. `onboarding FPMS-NT` returns a template whose only fact is
the repo path, and switches language to Chinese unprompted. `context` on an
endpoint returns four lines where `explore` on the same target returns 55
callPath entries plus source. Both are commands a user would reach for first.

### 5.8 `--repo` is documented as global but `communities` ignores it

```
$ penguin communities 12 --repo FPMS-NT
7130 communities across 119895 connected nodes; top 12:
  #1 (7211) FPMS-NT-Auth-Player — libs/common/enum.ts, …
  #3 (4948) casino-plus-app — src/utils/index.ts, …
  #8 (804)  FPMS — parseInt, Client/public/js/controllers/campaignController.js, …
```

Help says `Global: --json (machine-readable), --repo/--branch/--commit/--snapshot
(scope selectors)`. Nine commands honour it; this one does not. Separately, the
clustering itself is not usable: #1 and #2 have near-identical member lists
(`enum.ts, common.ts, player-repository.ts, types.ts`), and `parseInt` and
`async` appear as *members* of communities alongside file paths.

### 5.9 Smaller things

- **`penguin callers` text output has no file:line.** It prints
  `symbol<TAB>success`. Eight rows, eight identical-looking lines, no way to
  navigate. `--json` has it. For Q1, where all eight callers live in one file,
  and for Q7, where two callers are both named `grantFreeSpin`, the text output
  is unusable.
- **`penguin path` output has no file:line either.** `path node_09ea1ebe…
  node_c628b4a7…` prints `addPlayerFreeSpin → addPlayerFreeSpin`. Those are two
  different symbols in two different files. The rendering makes them look like a
  self-loop.
- **`penguin node <id>` returns almost nothing.** `symbol async / versions: 1 /
  aliases: 0`. No file, no line, no signature. `explore` on the same id returns
  the full source.
- **`ambiguousCandidates` is padded with unusable `field` rows.**
  `addPlayerFreeSpin` → 10 candidates, **8** of them `nodeType: "field"` with
  `filePath: null, startLine: null`. `intercept` → 14 candidates, 3 unusable.
  `accumulatePlayerDeposit` → 6 candidates, 3 unusable. Either give field nodes a
  location or exclude them from a disambiguation list.
- **`focus.startLine` is null on resolved targets.** `explore` returns
  `focus: {filePath: "…add-free-spin-processor.ts", startLine: null}` while
  `callPath` entries for the same node carry `startLine`. Answering "where is
  this symbol" from `explore` needs a second lookup.
- **`penguin timeline --repo FPMS-NT` → `(no commits indexed)`; `penguin recent
  --repo FPMS-NT` → `(no results)`.** Both work for `penguin-src`. And where
  timeline does work, the author column is `?` for every row, though help
  advertises "date/author/merge/tags".
- **`knowledge_service_graph` is a repo graph, not a service graph.** Node ids
  are `repo_*`, titles are repo names, and it ignores a `repo` argument. It
  returned all 26 repos including `claude_code` and `grpc-web-debugger`, with
  `FPMS-NT-Auth-Player` appearing **three times** (once per indexed branch) with
  `invokes` edges between the copies — a service that appears to call itself
  three ways. Meanwhile `architecture` reports 18 `service` nodes *inside*
  FPMS-NT, and those are not reachable through `service_graph` at all.
- **`knowledge.graph.query` is undiscoverable.** `penguin capabilities` lists it
  as `requiredOn: ["cli","mcp","wiki"]`, but `penguin help` has no verb for it.
  Via MCP it rejects two plausible `project` shapes with the bare string
  `{"error":"GRAPH_QUERY_PROJECT_INVALID"}` and no schema, no example, no hint.
  `capabilities --json` gives only `inputSchemaId: "knowledge.graph.query.input.v2"`
  — an id, not a schema. This is the escape hatch for "the graph knows it but no
  verb exposes it" (e.g. "list every endpoint"), and it is unusable.
- **Junk nodes in call paths.** `handles player | None None`,
  `handles proto | None None` (proto path fragments), and `throws Error | None None`.
- **`FALLBACK_LIVE_BRANCH` warning fires on every node-id query.** *"no revision
  was resolved for this query; answered against the live branch … instead of an
  explicit revision."* It fired on every `callers`/`impact` call I made even
  though the node id uniquely determines the revision. A warning that always
  fires is a warning nobody reads.

### 5.10 On the round-3 rejected claim (`deadcode` and symbol-level `imports`)

The brief says an earlier reviewer's claim that `deadcode` ignores symbol-level
`imports` edges was rejected, because all 86,745 active import edges are
file-to-file. **I think the rejection was right on the facts and wrong on the
lesson.** The facts check out — `architecture` on FPMS-NT reports `imports 11272`
alongside `defines 13710`, consistent with file-granular imports. But the
reviewer was pointing at a real hole with the wrong mechanism: `deadcode` cannot
see DI wiring, and file-level `fileImportedBy` is too coarse to stand in for it
(§5.5). Closing the ticket on "no such edge exists" leaves the actual defect —
0/77 precision — open. I would reopen it as "deadcode has no NestJS-provider
awareness", which is a different and fixable statement.

---

## 6. Pros and cons

Judged as a daily tool, against grep + reading files.

| | Penguin | grep + reading files |
|---|---|---|
| **Find all callers of a known symbol** | One call, complete, with `file:line`, plus a declared completeness floor. **Wins clearly.** | Misses aliases, drowns in string matches, no idea when you are done. |
| **Follow a request across a service boundary** | Resolves `invokes → gRPC PlayerService.GetFreeSpinPlayerInfo` to the handler in another app. **Nothing else does this.** | Effectively impossible without reading proto files and guessing. |
| **Know what your answer is missing** | `completeness.status` + `externalCalls` + `truncated`. **Best-in-class; nothing else even tries.** | You never know. |
| **Find a symbol you can only half-name** | **Loses badly.** `search` is a grep with worse output than grep, returns no node ids, and the documented disambiguation path does not exist. | ripgrep with `-n` is faster and gives you line numbers. |
| **Discover what exists (endpoints, modules, services)** | **Loses.** No endpoint enumeration, `communities` unusable, `onboarding` a stub, `service_graph` is a repo graph. | `rg '@Controller|@Post|@Get'` answers it in one command. |
| **Orient in an unfamiliar repo** | Mixed. File-count distribution and node/edge census are genuinely good; hubs are infra noise; no churn, no prose. | Slower but you get README, comments and git log. |
| **Blast radius of a change** | Good *if* you pass `--repo` and use `impact` not `affected`. **Dangerous otherwise** (§5.1). | Reliable but slow, and you will miss transitive sites. |
| **Dead code** | 0/77 useful on the path I tried. | `rg` plus judgement is no worse. |
| **Duplicate implementations** | Not implemented — but the graph found two real ones in three commands once I did it by hand. **Biggest unclaimed win.** | Very hard. |
| **Trustworthiness of the output** | High on call edges. Undermined by inverted `confidence`, a fabricated `flow` tree, and text/JSON disagreeing. | You saw the code. |
| **Speed** | ~2-3 s per query on a 4.4M-edge DB. | Comparable for one grep, much worse for ten. |
| **Freshness** | Explicit, and honest when it disagrees with itself — but three subsystems give three answers for FPMS-NT. | Always current. |
| **Token cost for an agent** | Much lower — one structured answer instead of five file reads. **Real advantage.** | High. |

**Net.** I would use it every day for *"what calls this / what does this call /
where does this request go"* — those three questions it answers better than
anything else I have. I would not use it as my entry point, because the entry
point (`search`) does not lead into the graph. In practice that means: grep to
find the name, Penguin to understand it. That is still a good trade, but it is
not the pitch.

---

## 7. Suggestions

Ordered by how much difference they would make.

**1. Make `affected` refuse when the path does not exist in the revision it picked.**
*Problem:* §5.1 — a confident `impacted 0 · aligned` for a symbol with a 19-node
blast radius and four live gRPC routes. The worst class of bug a code tool can
have. *Cost:* small. One existence check against the file table before answering,
plus a typed error. Also make cwd-based repo inference a last resort behind
path-based inference — the argument already names the repo, if you match it
against indexed file paths.

**2. Give `search` a symbol lane that returns node ids.**
*Problem:* §5.2 — the graph is unreachable except by exact name; `explore`'s own
error message points at a route that does not exist; endpoints cannot be found at
all. *Cost:* medium. The data is there (`explore` resolves names to nodes
already). Emit `kind: "symbol"` / `kind: "endpoint"` hits carrying `nodeId`,
`nodeType`, `filePath`, `startLine`, ranked above source occurrences. Until then,
at minimum fix the error text to say `penguin explore <name> --json` →
`ambiguousCandidates`.

**3. Fix `confidence.level`.**
*Problem:* §5.3 — a zero-edge stale node grades `high`, a 118-edge node with one
inferred edge grades `low`. *Cost:* small. Return `unknown` when `totalEdges == 0`;
grade on the *proportion* of inferred edges, not `min()`; and list which edges
are inferred so "verify" is actionable.

**4. Persist the parent edge in `flow`/`callPath`, or stop drawing a tree.**
*Problem:* §5.4 — the rendered tree asserts that a TypeScript interface calls
thirteen functions. *Cost:* small-to-medium. Add `parentNodeId` to each step
(BFS already knows it) and render from that. If that is expensive, print
depth-banded lists instead — honest and equally useful.

**5. Add duplicate-implementation detection.**
*Problem:* B4 found a drifted health-check fork and an identical duplicated gRPC
interceptor in three commands, by hand. The tool has no verb for it. *Cost:*
medium. `penguin duplicates --repo X`: group symbols by (name, kind, shape) across
files, rank by `fileImportedBy` skew, flag pairs whose line spans have diverged.
The graph already stores everything needed. **This is the highest-value thing
Penguin could do that nothing else does**, and it is a much better use of the
dead-code machinery than the current dead-code output.

**6. Make `deadcode` framework-aware, or split its output.**
*Problem:* §5.5 — 0/77 useful. *Cost:* small. Bucket the result into
`likely-dead` / `framework-wired` / `test-local` / `entry-point` using signals
already present (file path matches `*.spec.ts`/`test/**`; symbol is `constructor`
or an `onModule*` hook; enclosing class is decorated). Print the first bucket by
default.

**7. Add `penguin endpoints [--repo X]` and `penguin stale --repo X`.**
*Problem:* the graph holds 6 endpoint nodes, 18 service nodes and 725 stale
symbols for FPMS-NT, and none of the three can be listed. *Cost:* small — three
list queries. `stale` in particular is needed to comply with the evaluation's own
rule 4.

**8. Reconcile the freshness reporting.**
*Problem:* §5.6 — `status` says 725 stale, `trust` says not stale, `coverage`
says 0, and one `explore` response says both. *Cost:* small. Pick one definition,
report it consistently, and give `staleReason` a value whenever `staleSymbols > 0`.

**9. Put `file:line` in every text output.**
*Problem:* §5.9 — `callers`, `path` and `affected`'s `impacted[]` all render bare
symbol names, and names repeat constantly in this codebase (`grantFreeSpin` twice
in one caller list, `constructor` ten times in one impact list). *Cost:* trivial
for `callers`/`path` (the JSON already has it); for `affected.impacted[]` the
field is being dropped between query and serialisation.

**10. Make `context` handle endpoint nodes, and delete or implement `onboarding`.**
*Problem:* §5.7. `context` on an endpoint returns four lines; on a symbol it is
the best command in the tool. `onboarding` is a template with one fact in it.
*Cost:* small for `context` (reuse the `explore` endpoint path). For `onboarding`
— either generate it from the data that B1 shows is available (app file
distribution, node/edge census, top domain hubs, entry points) or remove the verb,
because a stub command is worse than no command.

**11. Document `knowledge.graph.query`, or drop it from `capabilities`.**
*Problem:* §5.9 — advertised as CLI-required, has no CLI verb, and returns
`GRAPH_QUERY_PROJECT_INVALID` with no schema. *Cost:* trivial. Return the expected
shape in the error, and have `capabilities --json` inline the schema rather than
an id.

**Capabilities I wanted and could not find at all:**

- **"Which of the 6 endpoints have no tests?"** — `explore` reports `tests: []`
  per target, but there is no way to ask it across a repo. Two of the three
  endpoints I traced have no tests, and I only know that because I happened to
  trace them.
- **"What changed in this repo lately?"** — no commit data for FPMS-NT.
- **"Show me the gRPC service surface"** — 18 `service` nodes and 127 `invokes`
  edges exist inside FPMS-NT; no verb reaches them.
- **"Which symbols read/write this field?"** — `writes_field` (110,431) and
  `reads_field` (99,587) are the two largest edge types in the graph, 80% of all
  edges, and **no CLI verb exposes them.** For "what actually mutates
  `player.balance`" — a question grep genuinely cannot answer — the data is
  already indexed and completely unreachable. That is the biggest gap between
  what this database knows and what it will tell you.

---

## 8. How it felt to use

The first ten minutes were the best. `explore` on a gRPC-backed endpoint gave me
the handler source, the processor, the Redis read, the strategy factory, the wire
hop and the handler in *another app*, and I thought: this is the thing. I have
wanted this tool for years. Nothing I know of does step five.

Then I tried to find a second thing to look at, and could not. That is the shape
of the whole experience: **once you know a name, Penguin is excellent; getting to
a name, it is worse than ripgrep.** `search` returns fifty rows whose title is a
file path, nine of them the same file, no node ids, no symbol lane. And when
`explore` refuses on an ambiguous name it tells you to get a node id from
`search` — which cannot give you one. I spent the first twenty minutes assuming I
was holding it wrong, then dumped `explore --json` on a failure and found
`ambiguousCandidates` sitting there, undocumented, containing exactly what I
needed. **Every ambiguous question in Part A cost an extra round trip because the
error message points somewhere that does not work.** That is the single cheapest
fix on the list and the one I felt most.

What surprised me, in a good way, was `completeness`. I have used a lot of code
graphs and every one of them hands you a list and lets you believe it. This one
says `"status": "lower_bound"` and names the four constructs it cannot see. When
I got to B3 — "would you trust this before changing a signature?" — I could give a
real answer instead of a shrug, and the answer was *no, because the index itself
told me `free-spin-grant.adapter.ts:30` is exactly the interface-dispatch case it
misses.* A tool that makes me correctly distrust it is doing something most tools
do not.

What surprised me in the other direction was `affected`. I ran it the obvious
way, got `changed 0 · impacted 0 · tests 0 · routes 0`, and for about thirty
seconds believed the symbol had no callers — I had `impact` output on screen
saying nineteen. The scope line was three lines further down. If I had been in a
hurry, or an agent with a narrow context window, I would have shipped that. It
says `aligned`. **Nothing about that output looks like a failure**, and that is
what makes it the worst thing in the tool.

`penguin onboarding FPMS-NT` was the one that made me laugh, and then not. The
brief's B1 is "onboard yourself onto this repo"; there is a command named
`onboarding`; it returns eight headings that tell you to run other commands.
Half of the actual answer — that `apps/promotion` is 1,686 of 3,333 files, that
there are 6 HTTP endpoints against 1,167 publishes and 127 gRPC invokes — was
sitting in `files` and `architecture` the whole time, one join away.

The `flow` tree bothered me more the longer I looked at it. It is not that the
data is wrong; it is that the *rendering* invents a relationship. Seeing an
interface presented as calling thirteen functions is the kind of thing that
would quietly corrupt an agent's reasoning three steps later, and it would never
show up as an error.

Two smaller things stuck. `field` nodes with null paths padding the
disambiguation list — eight of the ten candidates for `addPlayerFreeSpin` were
unpickable, which turns a menu into a puzzle. And `FALLBACK_LIVE_BRANCH` firing on
every single node-id query, including ones where the node id fully determines the
revision; by the tenth query I had stopped reading warnings, which is exactly the
state you do not want a user in when `affected` is about to lie to them.

**Would I reach for it again? Yes — for three questions.** What calls this. What
does this call. Where does this request actually go. It answers those better than
anything I have, fast, with an honest floor on its own completeness, and at a
fraction of the tokens of reading files. I would keep ripgrep open next to it for
everything else, and I would put `--repo` in a shell alias so I never run
`affected` bare again.

The gap between what this database knows and what it will tell you is large.
210,000 field read/write edges — 80% of the graph — and no verb touches them.
Eighteen gRPC services indexed and unreachable. Six endpoints you cannot list.
Two genuine duplicated implementations that fell out of three commands once I
went looking by hand. **The parsing and the graph are in better shape than the
query surface.** Most of section 7 is plumbing, not research.

---

## 9. Addendum — what I would want as a user

*Beyond the sections the brief asked for. Section 7 is a bug list — what to fix.
This is the product argument — what the tool should be. Written as someone who
would use it daily, not as an evaluator.*

### 9.1 The entry point is wrong, and it caps the whole product

My actual working loop was **ripgrep to get the name, then Penguin to understand
it.** That is not laziness — it is that `search` does not lead into the graph
(§5.2).

Once that loop is established, the positioning quietly downgrades: Penguin is not
"how you understand unfamiliar code", it is "the magnifier you reach for once you
already know the name". The magnifier is excellent. But its ceiling is now
whether people bother to open ripgrep first.

**What I want:** `penguin <repo>` with no verb at all, printing one page — how
many apps and their file distribution, the HTTP endpoints *enumerated*, the gRPC
services *enumerated*, the five files that changed most recently, and the three
most suspicious things found. Something to click on with **zero prior
knowledge**. Today that page requires seven commands and me joining the results
by hand (B1).

### 9.2 There are too many verbs and I never knew which to use

`explore / context / locate / flow / callers / calls / impact / affected / graph
/ repograph / path / node / domain / explain` — at least half are slices of the
same data, and the choice is not predictable:

- `context` is the best command in the tool on a symbol (195 lines) and returns
  four lines on an endpoint.
- `affected` and `impact` answer the same question; one carries `file:line`, one
  does not.
- `node <id>` returns three useless lines; `explore` on the same id returns the
  full source.
- `locate` is documented in `--help` as "alias of explore".

**What I want:** three verbs. `explore` (anything, any granularity), `flow` (what
happens at runtime), `affected` (what breaks if I change it). Everything else
becomes a field or a flag on those. A wide verb surface is not capability — it is
a memory tax I pay on every invocation.

### 9.3 The single biggest waste: 80% of the graph has no exit

`writes_field` (110,431) + `reads_field` (99,587) = **80% of all edges, reachable
by no command.**

And this is precisely the thing grep cannot do and you have already finished
building. *"What actually writes `player.balance`?"* is a question I ask weekly
and currently answer with grep plus eyeballing. The answer is sitting in the
database.

**What I want:** `penguin field player.balance` → who writes it, who reads it,
at which line. That one command is worth more than half the existing verbs
combined.

### 9.4 `deadcode` should be renamed `duplicates`

77 candidates, 0 true positives (§5.5). In a NestJS repo it is *structurally*
unable to work — DI and decorator wiring **is** the "no caller" shape.

But the same machinery, driven by hand in three commands, found a real defect:
`apps/livechat` running a private fork of the shared health-check, controllers
still byte-identical, services already drifted, 8-9 importers on the shared one
against 1-2 on the fork (B4). **That is a finding you can open a PR for and a
manager can understand.**

**What I want:** demote the current behaviour to
`deadcode --include-framework-wired` (default: only non-spec leaf symbols with
zero inbound edges), and spend the freed effort on `penguin duplicates`.

### 9.5 The default output is aimed at the wrong consumer

`callers` prints `symbol<TAB>success` — eight visually identical rows, no file,
no line. `path` prints `addPlayerFreeSpin → addPlayerFreeSpin` for two different
symbols in two different files. `affected`'s `impacted[]` is thirty bare names,
ten of them `constructor`.

So I ran the entire evaluation with `--json` piped through a python reshaper. The
text layer is not *abbreviating* — it is **dropping the identifying fields**.

**What I want:** JSON as the default, `--pretty` for the human renderer, and
`file:line` on every row of the human renderer too. Right now both the agent and
the human are using the second-class interface.

### 9.6 A principle: when unsure, say nothing — do not return an empty array

The `affected` bug (§5.1) is the worst thing I found, and not because it is
wrong. It is because **it does not look wrong**. `impacted 0 · aligned` reads
like an answer.

The same disease shows up four times:

| symptom | what it really is |
|---|---|
| `affected` → `impacted 0`, `alignment: "aligned"` | never looked at that repo |
| `confidence: "high"` on a 0-edge stale symbol | nothing to be confident about |
| `flow` drawing an interface as calling 13 functions | indentation faked from `depth` |
| "pass a node id from `penguin search`" | `search` has never returned one |

All four are the same failure: **stated confidence decoupled from actual
reliability.** Fixing them individually is treating symptoms. What I would rather
see is a house rule, enforced at the query layer:

> Any "not found / no impact / no callers" result must distinguish *there is
> genuinely nothing* from *I did not look*. When it cannot, return a typed error,
> not an empty array.

`completeness` already does exactly this for the calls list. It should be the
pattern, not the exception.

### 9.7 `completeness` is the moat — market it like one

The genuinely positive one, and I mean it: **no other code-graph tool I have used
volunteers what it cannot see.**

`"status": "lower_bound"` plus a named list of the four unmodelled constructs is
why my B3 answer could be *"I do not fully trust these eight callers, because
`free-spin-grant.adapter.ts:30` falls squarely in the interface-dispatch case you
told me you miss"* instead of a shrug or false confidence.

**What I want:** push it into every command (today only the `explore` family has
it), and make `confidence` *derive from* it rather than computing a second,
contradictory verdict (§5.3). This is the one thing here that competitors do not
have. It is worth more than ten more verbs.

### 9.8 If only three things get done

1. **Make `affected` error when the path does not exist in the revision it
   chose.** The only bug in this report that can cause a wrong decision.
2. **Make `search` return node ids.** Today the graph is enterable only by exact
   symbol name, and endpoints are not enterable at all.
3. **Ship `penguin duplicates` and `penguin field`.** Turn data you already have
   into the reason someone has to use this instead of ripgrep.

The first two are triage. The third is the product.

### 9.9 The good news

**The parsing and the graph are in visibly better shape than the query surface.**
Of the eleven items in section 7, ten are interface, rendering, or default-value
work; exactly one needs the indexer touched. Nothing in Part A came back wrong.

The hard half is done.

---

*Evaluation complete. ~55 CLI invocations. No source files were read; every
claim in sections 1-8 is traceable to a quoted command output. Section 9 is
opinion, grounded in those same outputs.*
