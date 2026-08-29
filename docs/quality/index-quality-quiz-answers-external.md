# Penguin index-quality quiz — answers (external run)

- **Model:** Claude Opus 5 (1M context) — `claude-opus-5[1m]`
- **Date:** 2026-08-29
- **Repo under test:** `FPMS-NT` @ `brazil-v2`, commit `3f0f1984b9e4337668529a13bad5264501729908`
- **Index trust (reported on every FPMS-NT query):** `stale: false`, `indexedCommit == headCommit`,
  `worktreeState: clean`, `dirtyFiles: []`, `indexedAt: 2026-08-29T01:52:16.496Z`,
  `parserVersion: tree-sitter-wasm-v8-wrapper-allowlist`, `schemaVersion: 14`, `coverageGaps: []`.
- **Tooling:** the `penguin` MCP server failed to connect this session, so every answer comes from the
  freshly built CLI bundle (`packages/knowledge-cli/bundle/penguin.mjs`), which is the same query layer
  over the same database. No grep, no file reads, no outside knowledge was used.

> Note on `penguin status`: it prints `FPMS-NT brazil-v2(live,stale=725)`. Per-query `trust` for this
> branch reports `stale: false` with matching head/indexed commits, so I treat the branch as fresh and
> flag the 725 only as an unexplained discrepancy between the two surfaces.

---

## Q1

answer:
- apps/promotion/src/budget/budget-base-response.ts:26 — `success`
- apps/promotion/src/budget/budget-base-response.ts:34 — `forbidden`
- apps/promotion/src/budget/budget-base-response.ts:42 — `internalError`
- apps/promotion/src/budget/budget-base-response.ts:50 — `notFound`
- apps/promotion/src/budget/budget-base-response.ts:58 — `unauthorized`
- apps/promotion/src/budget/budget-base-response.ts:66 — `statusUnspecified`
- apps/promotion/src/budget/budget-base-response.ts:74 — `illegalArgs`
- apps/promotion/src/budget/budget-base-response.ts:82 — `alreadyExists`

All 8 callers are the sibling helpers in the same file. `CMSGenBaseResponse` itself is at
apps/promotion/src/budget/budget-base-response.ts:14.

tool used: `explore CMSGenBaseResponse` → returned `ambiguous target: 10 matches` (same symbol name exists
in FPMS, FPMS-CCMS, and other repos), then `explore node_e8e51538-1f09-436e-92f1-bac9e5221eb5` (the
FPMS-NT `apps/promotion/src/budget/budget-base-response.ts` candidate).

confidence: high — `completeness: {status: "complete", externalCallCount: 0}`, `diagnostics: []`,
`truncated: []`, `confidence.level: high`, all edges `origin: parser / method: EXTRACTED / confidence: 1`
(`calls` ×8 matches the 8 callers exactly).

---

## Q2

answer — `accumulatePlayerDeposit` (apps/riskControl/src/antiAddiction/deposit-limit.service.ts:163) calls:
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:191 — `getRuntimeContext`
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:59 — `evaluateStateAndResetIfPeriodExpired`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:324 — `shouldSkipAccumulate`
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:74 — `accumulatePlayerDeposit` (state service)
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:21 — `evaluateState`
- apps/riskControl/src/antiAddiction/deposit-limit-config.service.ts:122 — `isNotConfigured`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:241 — `flushStateSnapshot`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:314 — `isLimitReached`
- apps/riskControl/src/antiAddiction/deposit-limit.service.ts:276 — `recordDepositLimitChange`
- apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts:157 — `notifyStateChanged`

No external-package calls (`externalCalls: []`).

tool used: `explore accumulatePlayerDeposit` → `ambiguous target: 20 matches` (the name also lives in
FPMS-NT-Risk-Control and in the legacy `casino-plus` repo), then
`explore node_cf76d4d7-08e2-410a-bc9c-04175f5929fb` (FPMS-NT `apps/riskControl/.../deposit-limit.service.ts`).

confidence: high — `completeness: {status: "complete", externalCallCount: 0}`, `diagnostics: []`,
`truncated: []`, all edges EXTRACTED at confidence 1. One caveat: `provenance` counts 12 `calls` edges
while the deduplicated `calls` list has 10 entries, which I read as two callees invoked from two call
sites each, not as two missing callees.

---

## Q3

answer — `GET /healthcheck` in FPMS-NT resolves to **two** handlers, both bound to the same route:

1. apps/livechat/src/http-health-check/http-health-check.controller.ts:12 — `check`
   → calls apps/livechat/src/http-health-check/http-health-check.service.ts:20 — `check`
2. libs/tools/src/http-health-check/http-health-check.controller.ts:12 — `check`
   → calls libs/tools/src/http-health-check/http-health-check.service.ts:35 — `check`

Both service-level `check` implementations then reach:
- libs/common/base-redis.service.ts:721 — `getConnectionStr`
- libs/common/base-redis.service.ts:717 — `ping`

Each controller also touches two external symbols it cannot resolve into the repo:
`Res` (`@nestjs/common`, line 12) and `Response` (`express`, line 12).

tool used: `flow "GET /healthcheck"` → `ambiguous, 9 matches` across repos (note: `--repo FPMS-NT` did
**not** disambiguate it), then `flow symbol:node_4d3b6c2e-87a3-4502-addd-726b3143c2b9` (the FPMS-NT
endpoint node), plus `explore` on each controller node for the per-handler edges.

confidence: medium — the chain itself is EXTRACTED at confidence 1, but each controller reports
`completeness: {status: "partial", externalCallCount: 2}` and `confidence.level: low` with
`1 INFERRED edge(s)` (an INFERRED `publishes` edge at confidence 0.5). The index does not say which of the
two identically-named controllers is the one actually mounted at runtime — it lists both as `handles`.

---

## Q4

answer — apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:
- :10 — `LiveChatBotProcessor` (class, 10–185)
- :20 — `constructor` (method, 20–33)
- :34 — `_initializeChatBotClient` (method, 34–71)
- :41 — `create` (method, 41–59)
- :60 — `destroy` (method, 60–62)
- :73 — `_getChatbotClient` (method, 73–81)
- :83 — `_releaseChatbotClient` (method, 83–85)
- :87 — `_initBot` (method, 87–95)
- :97 — `updateBotAccessToken` (method, 97–101)
- :103 — `_getBotMatrixClient` (method, 103–154)
- :110 — `delay` (function, 110–111 — nested inside `_getBotMatrixClient`)
- :156 — `updateNewAccessToken` (method, 156–184)

12 symbols total. Every one is reported `status: "fresh"`.

tool used: `filesymbols branch_10012ad4-067a-4749-aafb-7a9c4f5c133d apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts --json`

confidence: high — the JSON carries explicit `startLine`/`endLine`/`status` per symbol and no truncation
marker. (The plain-text renderer of `filesymbols` omits line numbers; `--json` was required.)

---

## Q5

answer — `DynamicThresholdVipConfigDto`
(apps/promotion/src/modules/dynamic-threshold-configs/dto/dynamic-threshold-vip-config.dto.ts) makes
**6** calls that leave the repository:

from `class-validator`:
- line 16 — `IsEnum`
- line 19 — `IsArray`
- line 20 — `ArrayMinSize`
- line 21 — `ArrayMaxSize`
- line 22 — `ValidateNested`

from `class-transformer`:
- line 23 — `Type`

In-repo calls: **none** (`calls: []`).

**Is the list COMPLETE, and how do I know?**
Yes — for what the index models. The index is explicit about it rather than silent: it returns
`completeness: {status: "partial", externalCallCount: 6}` and the diagnostic
*"6 call(s) go to external packages and cannot be resolved to repo symbols — see externalCalls; the calls
list is incomplete"*. So `calls` is flagged partial **by design** (external targets have no repo node to
point at), and the six missing targets are then enumerated in `externalCalls` with package specifier,
callee name, and line number. Combining the two fields gives the whole picture: 0 in-repo + 6 external.
Supporting evidence that nothing was dropped: `truncated: []`, `inferredEdges: 0`, `totalEdges: 5`, and
every provenance row is `origin: parser / method: EXTRACTED / confidence: 1`. The one thing the index does
**not** tell me is what those packages resolve to internally — it names the package, not the resolved
third-party symbol, and there is no version/lockfile evidence attached.

tool used: `explore DynamicThresholdVipConfigDto` (resolved unambiguously to
node_cfdcedfe-6943-4007-9339-5b4bb475482a)

confidence: high

---

## Q6

answer — 77 dead-code candidates under `apps/admin/` (repo FPMS-NT, branch `brazil-v2`), complete list:

- apps/admin/inteceptor/external.module.ts:14 — `useFactory`
- apps/admin/inteceptor/external.module.ts:48 — `ExternalModule`
- apps/admin/inteceptor/payment-external.service.ts:18 — `constructor`
- apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19 — `GameRepositoryModule`
- apps/admin/libs/repositories/fpms/admin/game/game-repository.ts:9 — `constructor`
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.module.ts:19 — `PlatformAnnouncementRepositoryModule`
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:8 — `constructor`
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13 — `findById`
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:25 — `findOne`
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:29 — `find`
- apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:36 — `update`
- apps/admin/libs/repositories/fpms/schemas/game.schema.ts:166 — `GameDocument`
- apps/admin/libs/repositories/fpms/schemas/platform-announcement.schema.ts:44 — `PlatformAnnouncementDocument`
- apps/admin/libs/spi/address/sites/base/base-address.provider.ts:12 — `BaseAddressProvider`
- apps/admin/libs/spi/address/sites/base/base-address.provider.ts:13 — `getAddressDetail`
- apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:14 — `BpAddressProvider`
- apps/admin/libs/spi/address/sites/bp/bp-address.provider.ts:15 — `getAddressDetail`
- apps/admin/src/address/address.controller.ts:6 — `AddressController`
- apps/admin/src/address/address.controller.ts:7 — `constructor`
- apps/admin/src/address/address.module.ts:11 — `AddressModule`
- apps/admin/src/address/address.service.ts:10 — `constructor`
- apps/admin/src/admin/admin.controller.ts:11 — `AdminController`
- apps/admin/src/admin/admin.controller.ts:12 — `constructor`
- apps/admin/src/admin/admin.module.ts:80 — `AdminModule`
- apps/admin/src/admin/admin.service.ts:31 — `constructor`
- apps/admin/src/admin/admin.service.ts:48 — `onModuleInit`
- apps/admin/src/admin/admin.service.ts:263 — `onModuleDestroy`
- apps/admin/src/admin/admin.service.ts:267 — `onApplicationShutdown`
- apps/admin/src/admin/dto/check-has-permission.dto.ts:21 — `constructor`
- apps/admin/src/admin/dto/update-platform-config.dto.ts:148 — `constructor`
- apps/admin/src/config/config.controller.ts:13 — `ConfigController`
- apps/admin/src/config/config.controller.ts:14 — `constructor`
- apps/admin/src/config/config.module.ts:27 — `ConfigModule`
- apps/admin/src/config/config.service.ts:17 — `constructor`
- apps/admin/src/config/dto/get-config.dto.ts:13 — `constructor`
- apps/admin/src/config/dto/get-eid-config-by-eid.dto.ts:12 — `constructor`
- apps/admin/src/config/dto/get-platform-config-by-platform-id.dto.ts:8 — `constructor`
- apps/admin/src/http-health-check/http-health-check.module.ts:27 — `useFactory`
- apps/admin/src/http-health-check/http-health-check.module.ts:51 — `HttpHealthCheckModule`
- apps/admin/src/jackpot/dto/update-live-jackpot-config.dto.ts:20 — `JackpotConfigItemDto`
- apps/admin/src/jackpot/executors/jackpot.executor.ts:41 — `constructor`
- apps/admin/src/jackpot/executors/jackpot.executor.ts:48 — `onModuleInit`
- apps/admin/src/jackpot/executors/jackpot.executor.ts:150 — `executeSuccess`
- apps/admin/src/jackpot/executors/jackpot.executor.ts:157 — `executeReject`
- apps/admin/src/jackpot/jackpot-executor.module.ts:18 — `useFactory`
- apps/admin/src/jackpot/jackpot-executor.module.ts:54 — `JackpotExecutorModule`
- apps/admin/src/jackpot/jackpot.controller.ts:11 — `JackpotController`
- apps/admin/src/jackpot/jackpot.controller.ts:12 — `constructor`
- apps/admin/src/jackpot/jackpot.module.ts:20 — `useFactory`
- apps/admin/src/jackpot/jackpot.module.ts:28 — `JackpotModule`
- apps/admin/src/jackpot/jackpot.service.ts:21 — `CreateAdminProposalResponse`
- apps/admin/src/jackpot/jackpot.service.ts:31 — `constructor`
- apps/admin/src/jackpot/jackpot.service.ts:37 — `checkPendingProposal`
- apps/admin/src/main.ts:31 — `bootstrap`
- apps/admin/src/platform-announcement/dto/delete-player-mail.dto.ts:13 — `constructor`
- apps/admin/src/platform-announcement/dto/read-player-mail.dto.ts:11 — `constructor`
- apps/admin/src/platform-announcement/platform-announcement.controller.ts:10 — `PlatformAnnouncementController`
- apps/admin/src/platform-announcement/platform-announcement.controller.ts:11 — `constructor`
- apps/admin/src/platform-announcement/platform-announcement.module.ts:17 — `PlatformAnnouncementModule`
- apps/admin/src/platform-announcement/platform-announcement.service.ts:12 — `constructor`
- apps/admin/src/platform/dto/get-platform-country.dto.ts:9 — `constructor`
- apps/admin/src/platform/platform-cache.manager.ts:37 — `constructor`
- apps/admin/src/platform/platform.controller.ts:10 — `PlatformController`
- apps/admin/src/platform/platform.controller.ts:11 — `constructor`
- apps/admin/src/platform/platform.module.ts:13 — `PlatformModule`
- apps/admin/src/platform/platform.service.ts:14 — `constructor`
- apps/admin/src/player/admin-player.controller.ts:11 — `constructor`
- apps/admin/src/player/admin-player.module.ts:11 — `AdminPlayerModule`
- apps/admin/src/player/admin-player.service.spec.ts:11 — `PlayerClientGrpcMock`
- apps/admin/src/player/admin-player.service.spec.ts:16 — `createDto`
- apps/admin/src/player/admin-player.service.spec.ts:20 — `createBaseResponse`
- apps/admin/src/player/admin-player.service.ts:14 — `constructor`
- apps/admin/src/player/dto/unbind-player-phone-number.dto.ts:3 — `UnbindPlayerPhoneNumberDto`
- apps/admin/test/e2e/setup-jest-e2e.ts:3 — `initEnv`
- apps/admin/test/unit/admin/admin.service.spec.ts:37 — `createAdminTestingModule`
- apps/admin/test/unit/admin/admin.service.spec.ts:64 — `createUpdatePlatformConfigRequest`
- apps/admin/test/unit/admin/platform-cache.manager.spec.ts:99 — `countryResult`

**Scope my answer covers** (verbatim from the tool's own `scope` / `note`):
`{repo: "FPMS-NT", path: "apps/admin/", branch: "branch_10012ad4-067a-4749-aafb-7a9c4f5c133d"}` — i.e.
one repo, one branch, files whose path starts with `apps/admin/`, **including** `.spec.ts` / `test/` files.
The criterion is *"no inbound calls/references/handles/tests"* edges in the graph. The tool itself warns
these are candidates, not confirmed dead code: *"verify: DI, reflection, framework magic, dynamic import,
and public entry points are false positives."* That caveat is clearly load-bearing here — this is a NestJS
codebase and the list is dominated by `constructor`, `@Module` classes, `useFactory`, and lifecycle hooks
(`onModuleInit`, `onModuleDestroy`, `onApplicationShutdown`), plus `bootstrap` in `main.ts`, all of which
are invoked by the framework or by the process entry point rather than by a call edge. The scope also does
not extend to cross-repo callers: a symbol referenced only from another indexed repo would still appear here.

tool used: `deadcode --repo FPMS-NT --path apps/admin/ --json`

confidence: high on the list being exactly what the index holds (`truncated: false`, count 77 — note the
plain-text renderer caps output at 40 rows, so `--json` was necessary); low on these being genuinely dead,
for the framework reasons the tool itself flags.

---

## Q7

answer — callers of `addPlayerFreeSpin`
(apps/promotion/src/free-spin/processors/add-free-spin/add-free-spin-processor.ts:34):
- apps/promotion/src/free-spin/controllers/free-spin.internal.controller.ts:19 — `addPlayerFreeSpin`
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:182 — `dispatchFreeSpin`
- apps/promotion/src/reward-grant/adapters/free-spin-grant.adapter.ts:30 — `dispatch`
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:65 — `grantFreeSpin`
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — `dispatchReward`
- apps/promotion/src/physical-gift/processors/redeem-physical-gift.processor.ts:88 — `redeemPhysicalGift`
- apps/promotion/src/special-event/services/special-event-mission.service.ts:1731 — `claimTaskReward`
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:457 — `grantFreeSpin`

8 callers. Reachable from `gRPC FreeSpinInternalService.AddPlayerFreeSpin` (via caller).

tool used: `explore addPlayerFreeSpin` → `ambiguous target: 12 matches`, then
`explore node_c628b4a7-1f02-4608-a8f7-75236f29d1a0` (the `AddFreeSpinProcessor.addPlayerFreeSpin` node).

confidence: medium-high. The caller edges themselves are EXTRACTED at confidence 1 and `truncated: []`.
Two reservations: (a) `confidence.level` is reported as `low` for this node overall, driven by
`1 INFERRED edge(s)` at confidence 0.45 — that inferred edge is a `reads_field`, not a `calls` edge, so it
does not affect the caller list; (b) the ambiguity listing showed mock stubs named `addPlayerFreeSpin`
inside `redeem-physical-gift-routing.spec.ts` and `redeem-physical-gift.processor.spec.ts`, which the
index classifies as `field` (mocks) and correctly excludes from `callers` — so test files that only mock
the method are deliberately not counted as callers.

---

## Q8

answer — `applyOpenPromoCode` (apps/promotion/src/promo-code/promo-code.processor.ts:1285) calls:

in-repo (10):
- libs/tools/src/repositories/player/fpms/logs2/open-promo-code-template/open-promo-code-template-repository.ts:16 — `findActiveOpenTemplate`
- libs/tools/src/clickhouse/pcr-clickhouse.service.ts:54 — `query`
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:16 — `findByProposalId`
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:190 — `getPlayerLevelWithPlayerLevelObjId`
- libs/tools/src/client-grpc/payment-client-grpc/payment-client-grpc.ts:195 — `DeductPlayerCredit`
- apps/promotion/src/event-bus/producer.routes.ts:31 — `emitEvent`
- libs/common/common.ts:1399 — `warn`
- libs/tools/src/fpms-internal-server/fpms-internal-server.service.ts:173 — `createProposal`
- libs/common/common.ts:1397 — `log`
- libs/tools/src/repositories/player/fpms/log/player-top-up-record/player-top-up-record-repository.ts:27 — `addUsedEvent`

external (4), all from `@snsoft/proposal-sdk`:
- line 1317 — `proposalSDK.getProposalTypeList`
- line 1332 — `proposalSDK.getProposalData`
- line 1338 — `proposalSDK.getProposalData`
- line 1407 — `proposalSDK.getProposalData`

tool used: `explore applyOpenPromoCode` → `ambiguous target: 6 matches` (the legacy `casino-plus` repo has
a same-named symbol), then `explore node_1ea2bee8-96d9-4550-a9ba-9c4a6e74d10b`.

confidence: medium-high — `truncated: []`, all `calls` edges EXTRACTED at confidence 1. The node reports
`completeness: {status: "partial", externalCallCount: 4}` (expected, since the 4 SDK calls have no repo
node) and `1 INFERRED edge(s)` at confidence 0.45, which is a `reads_field` edge and not part of the
callee list.

---

## Q9

answer — `POST /internal/vip-cohort/retention-risk`:

- **Handler:** apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:45 —
  `triggerRetentionRisk` (45–60), route bound `via: "direct"`.
- **What it calls next:** exactly one in-repo call —
  apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101 — `run` (101–291).
  It also references apps/promotion/src/modules/vip-cohort/interfaces/vip-cohort.interface.ts:133 —
  `VipCohortRunResult` (return type), and one external call: `Query` from `@nestjs/common` (line 46).
- Covered by a test: apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.spec.ts

One level deeper (from `flow`, inside `run`): `isDisabledBySwitch`
(vip-cohort-runner.service.ts:314), `isWithinWindow` (vip-cohort-runner.service.ts:80), `load`
(vip-cohort-config.service.ts:52), `finishRun` (vip-cohort-run.repository.ts:43), `vipCohortRunLockKey`
(vip-cohort.constants.ts:219).

tool used: `flow "POST /internal/vip-cohort/retention-risk"` (resolved unambiguously, `diagnostic: null`,
`warnings: []`), then `explore node_0a6c1175-c90c-49b9-87eb-5265d69102f1` for the handler's exact edges.

confidence: high — `handles` and `calls` edges EXTRACTED at confidence 1, `inferredEdges: 0`,
`truncated: []`. `completeness` is `partial` only because of the one unresolvable `@nestjs/common` decorator.

---

## Q10

answer — apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:
- :18 — `LiveChatConvoProcessor` (class, 18–589) — fresh
- :20 — `constructor` (method, 20–33) — fresh
- :35 — `updateConversationReview` (method, 35–60) — fresh
- :62 — `updateConversationTag` (method, 62–95) — fresh
- :97 — `getConversationTag` (method, 97–111) — fresh
- :113 — `_endConversation` (method, 113–211) — fresh
- :213 — `storeConversationData` (method, 213–298) — fresh
- :300 — `_createConversation` (method, 300–464) — fresh
- :466 — `getConversationList` (method, 466–551) — fresh
- :527 — `data` (function, 527–536) — **`status: "stale"`**
- :553 — `updateConversationTagList` (method, 553–588) — fresh
- :563 — `tagObjects` (function, 563–566) — **`status: "stale"`**

12 symbols total. **Staleness passed on as required:** two of them — the nested callbacks `data`
(527–536) and `tagObjects` (563–566) — carry `status: "stale"` in the index while the branch-level trust
record says `stale: false`. I am reporting their line ranges as the index holds them, but they are not
guaranteed to match the current file.

tool used: `filesymbols branch_10012ad4-067a-4749-aafb-7a9c4f5c133d apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts --json`

confidence: high for the 10 fresh symbols; medium for `data` and `tagObjects` because the index flags
them stale.

---

## Q11

answer — `intercept`
(apps/promotion/src/accumulative-event-config/interceptors/grpc-base-response.interceptor.ts:20) makes
**6** calls that leave the repository:

from `@nestjs/common`:
- line 20 — `ExecutionContext`
- line 20 — `CallHandler`

from `rxjs`:
- line 20 — `Observable`
- line 24 — `map`
- line 31 — `catchError`
- line 35 — `of`

In-repo calls: **none** (`calls: []`).

**Is the list COMPLETE, and how do I know?**
Partly, and here the index is honest about a real gap. Two independent signals:
1. `completeness: {status: "partial", externalCallCount: 6}` plus the diagnostic *"6 call(s) go to
   external packages and cannot be resolved to repo symbols — see externalCalls; the calls list is
   incomplete"* — so the six above are enumerated, with package and line, and nothing is silently dropped
   from that set. `truncated: []`, `inferredEdges: 0`, all provenance EXTRACTED at confidence 1.
2. A second diagnostic: *"`intercept` is indexed but has no outgoing calls/references — it may be a
   terminal/leaf symbol, or its callees aren't indexed."* The index is explicitly telling me it cannot
   distinguish "leaf" from "callees missing", so I cannot certify the total call list as complete from the
   index alone.

Concretely, the indexed source shows the method constructing `new CommonPb.BaseResponse({...})` and
reading `CommonPb.StatusCode.STATUS_SUCCESS`, and calling `context.getHandler()` and `next.handle()` —
none of which appear in either `calls` or `externalCalls`. So: the **external** list is complete as far as
the index models external packages (imported symbols used at a call/reference site), but the overall
"what does this symbol call" picture is not — generated-protobuf namespaces (`CommonPb`) and calls on
framework-supplied parameters (`context`, `next`) are not represented as edges at all.

tool used: `explore intercept` first returned `ambiguous target: 20 matches` whose 20-item candidate list
**did not include** the target node; `search "GrpcBaseResponseInterceptor" --repo FPMS-NT` located the
file, and `explore "GrpcBaseResponseInterceptor.intercept"` then resolved it exactly
(node_a39de83e-e269-470b-a4e8-aa451ec598ba).

confidence: high on the 6 external calls; medium on completeness overall, for the reason the index itself
states in its second diagnostic.

---

## Q12

answer — callers of `addPlayerMudDisbursement`
(apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:51):
- apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66 — `dispatchMud`
- apps/promotion/src/mud/controllers/mud.internal.controller.ts:18 — `addPlayerMud`
- apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts:155 — `addPlayerMudToRewardRecordBatch`
- apps/promotion/src/reward-grant/adapters/mud-grant.adapter.ts:24 — `dispatch`
- apps/promotion/src/winsday-billion/services/reward-grant.service.ts:107 — `grantMud`
- apps/promotion/src/modules/color-land/services/color-land-reward.service.ts:47 — `dispatchReward`
- apps/promotion/src/special-event/services/special-event-mission.service.ts:2323 — `claimTaskRewardByTaskId`
- apps/promotion/src/winsday-billion/services/post-win-share.service.ts:504 — `grantMud`

8 callers. Reachable from `gRPC MudInternalService.AddPlayerMud` (via caller).

tool used: `explore "AddMudProcessor.addPlayerMudDisbursement"` (qualified name resolved unambiguously to
node_15366be1-1abc-43ff-9106-acc3e496a4c2)

confidence: high — `completeness: {status: "complete", externalCallCount: 0}`, `confidence.level: high`,
`inferredEdges: 0`, `truncated: []`, all provenance EXTRACTED at confidence 1. Only diagnostic is
"reachable from 1 HTTP route(s) — public-facing".

---

## Q13

answer — `createLeaderBoardRewardProposal`
(apps/promotion/src/leaderboard/leaderboard.processor.ts:579) calls:

in-repo (10):
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1404 — `incrementMessageDedup`
- apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1415 — `checkAndAddEventSession`
- libs/tools/src/manager/fpms-platform-cache/fpms-platform-cache-manager.ts:36 — `getPlatformByPlatformId`
- libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:242 — `getPlayerInfoInternal`
- libs/tools/src/manager/player-level-cache/player-level-cache-manager.ts:41 — `getPlayerLevelByPlayerLevelObjId`
- libs/tools/src/repositories/common/proposal-type/proposal-type-repository.ts:18 — `getProposalTypeByName`
- libs/common/common.ts:258 — `getStartAndEndDate`
- apps/promotion/src/leaderboard/leaderboard.service.ts:365 — `getTotalRewardCountForDay`
- libs/common/common.ts:1236 — `createGrpcMetadataWithTrace`
- libs/common/common.ts:1399 — `warn`

external (2), from `@snsoft/proposal-sdk`:
- line 693 — `proposalSDK.getProposalData`
- line 756 — `proposalSDK.createProposal`

(Its sole caller is apps/promotion/src/pulsar/leaderboard-reward/leaderboard-reward.consumer.ts:60 —
`handleMessage`; test:
apps/promotion/test/unit/leaderboard/leaderboard.processor.createLeaderBoardRewardProposal.spec.ts.)

tool used: `explore createLeaderBoardRewardProposal` → `ambiguous target: 5 matches` (legacy
`casino-plus` also defines it), then `explore node_7d45af43-458b-4f21-a217-be8a4a481c03`.

confidence: high — `truncated: []`, `inferredEdges: 0`, all edges EXTRACTED at confidence 1;
`completeness: partial` only on account of the 2 enumerated `@snsoft/proposal-sdk` calls.

---

## Q14

answer — `POST /promotion/GetPlayerFreeSpinInfo`:

- **Handler:** apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20 —
  `getPlayerFreeSpinInfoRestful` (20–29), route bound `via: "direct"`.
- **What it calls next** (both in-repo, exactly 2):
  - apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11 —
    `transformRestfulReqToNt` (11–23)
  - apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117 — `execute` (117–175)
- It also references apps/promotion/src/free-spin/dto/get-player-free-spin-info.dto.ts:6 —
  `GetPlayerFreeSpinInfoReq`, and makes 2 external calls: `Body` (`@nestjs/common`, line 21) and
  `Headers` (`@nestjs/common`, line 22).

Separate but adjacent: the gRPC twin `gRPC FrontendService.GetPlayerFreeSpinInfo` is handled by
apps/promotion/src/free-spin/controllers/free-spin.controller.ts:22 — `getPlayerFreeSpinInfo`. That is a
different endpoint node; the HTTP route asked about is the one above.

tool used: `flow "POST /promotion/GetPlayerFreeSpinInfo"` (resolved unambiguously in FPMS-NT), then
`explore node_bbda6780-f58a-4d0a-8688-81a0f702dfa5`.

confidence: high — `handles` and both `calls` edges EXTRACTED at confidence 1, `inferredEdges: 0`,
`truncated: []`; `completeness: partial` only for the two NestJS decorators, which are enumerated.

---

## What I could not answer, and why

I was able to give a complete answer to all 14 questions. Nothing was left blank. But several answers
required work the index should arguably have done for me, and two carry limits the index itself declares.
Listing the exact outputs behind each:

### 1. `explore <bare name>` is ambiguous on 6 of 14 questions, and `--repo` does not fix it

Q1, Q2, Q7, Q8, Q11, Q13 all failed on the first attempt with an ambiguity diagnostic instead of an
answer. The index stores the same symbol name across FPMS, FPMS-CCMS, FPMS-NT, FPMS-NT-Risk-Control,
`casino-plus`, etc., and `explore` will not narrow by repo:

- Q1: `"CMSGenBaseResponse" matches 10 symbols — specify one.` — and **`explore CMSGenBaseResponse --repo
  FPMS-NT` returned the identical 10-way ambiguity**, so the documented scope selector did not filter.
- Q2: `ambiguous target: 20 matches` — worse, it silently *answered from the wrong repo*: the response
  carried `trust.repoName: "penguin-src"` and a `callPath` rooted at
  `DepositLimitService.AccumulatePlayerDeposit` with `callers: []`, `calls: []`. A caller who did not read
  the `trust` block would have taken "no callees" as the answer.
- Q3: `flow "GET /healthcheck" --repo FPMS-NT` → `{"reason":"ambiguous","message":"\"GET /healthcheck\"
  matches 9 symbols — specify one."}` — again `--repo` had no effect; I had to match repo UUIDs
  (`repo_c58d58a2-…`) out of `identityKey` strings by hand to pick the FPMS-NT node.
- Q7 (12 matches), Q8 (6), Q13 (5), Q11 (20) — same pattern.

The workaround in every case was to read the `ambiguousCandidates` array, map `repo_<uuid>` to the right
repository by cross-referencing a query I already knew was FPMS-NT, and re-run `explore <nodeId>`. That is
a two-to-three-round-trip tax on the majority of questions, and it is only possible because
`ambiguousCandidates` exposes raw UUIDs.

### 2. Q11: the ambiguity candidate list is capped and **excluded the actual target**

`explore intercept` reported `ambiguous target: 20 matches` and returned 20 candidates — none of which was
`GrpcBaseResponseInterceptor.intercept`. The list was filled with `UserContextInterceptor.intercept`,
`GrpcLogger.intercept`, `RestfulLogger.intercept` etc. from FPMS, FPMS-CCMS and other repos, with FPMS-NT
represented only by `apps/livechat/src/grpc-logger.ts::GrpcLogger.intercept`. So the disambiguation UI
does not merely under-rank the right answer, it truncates it out of the list entirely, with no marker that
the list is capped. I recovered only by falling back to `search "GrpcBaseResponseInterceptor" --repo
FPMS-NT` and then `explore "GrpcBaseResponseInterceptor.intercept"`.

### 3. Q11: the index states it cannot certify the callee list

Verbatim diagnostic: `"intercept" is indexed but has no outgoing calls/references — it may be a
terminal/leaf symbol, or its callees aren't indexed.` The indexed `source` for that same node shows
`context.getHandler()`, `next.handle()`, `new CommonPb.BaseResponse(...)` and `CommonPb.StatusCode.
STATUS_SUCCESS` — none of which appear in `calls` (empty) or `externalCalls` (which lists only the 6
imported `@nestjs/common` / `rxjs` symbols). So generated-protobuf namespace access and calls on
framework-injected parameters are simply not modelled as edges. This is the honest gap behind my
"complete for external packages, not complete overall" answer on Q11.

### 4. Q3: the index cannot say which of two identical handlers is live

`GET /healthcheck` returns **two** `handles` edges — `apps/livechat/src/http-health-check/
http-health-check.controller.ts:12` and `libs/tools/src/http-health-check/http-health-check.controller.ts:12`
— with byte-identical signatures and bodies. Nothing in `routes`, `trust`, or `provenance` distinguishes
the mounted one from the library template. My answer therefore lists both rather than picking one.

### 5. Freshness signals disagree between surfaces

`penguin status` prints `FPMS-NT brazil-v2(live,stale=725)`, while every per-query `trust` block for that
same branch reports `stale: false`, `staleReason: null`, `changedFiles: 0`, `reusePercent: 100`,
`worktreeState: "clean"`, `dirtyFiles: []`, with `indexedCommit == headCommit ==
3f0f1984b9e4337668529a13bad5264501729908`. I went with the per-query `trust` value, but a consumer reading
only `status` would reasonably distrust all 14 answers. Separately, two symbols in Q10 carry
`status: "stale"` at the symbol level (`data` 527–536, `tagObjects` 563–566) inside a branch the same
index calls fresh — flagged in that answer.

### 6. Text renderers silently truncate; `--json` was mandatory

- `deadcode --repo FPMS-NT --path apps/admin/` prints the header `77 candidate(s)` but then emits only
  40 rows, with no "…37 more" marker. `--json` returned all 77 with `truncated: false`. A reader trusting
  the text output would have delivered a 40-item list under a "77" headline.
- `filesymbols` (Q4, Q10) prints names and kinds but **no line numbers**, which the quiz requires; only
  `--json` carries `startLine`/`endLine`. The text renderer does append `(stale)`, which is how I first
  spotted the two stale symbols in Q10.

### 7. Minor: `provenance` edge counts exceed the deduplicated `calls` lists

Q2 reports `calls` provenance count 12 against 10 listed callees; Q7 14 against 6; Q8 12 against 10;
Q12 14 against 6; Q13 12 against 10. I read this as call-site multiplicity collapsing into unique callee
nodes (Q12 has zero external calls, so the delta cannot be explained by unresolved packages), but the
index does not expose per-call-site detail to confirm that, so I cannot rule out that some call sites
resolve to targets that are not surfaced in `calls`.

### 8. Bare `search` silently answers from the wrong repo

`search "GrpcBaseResponseInterceptor"` (no `--repo`) returned `NO_MATCH_INCOMPLETE · 0 hits · coverage
913/996` scoped to `penguin-src@main` — the CLI's working directory — plus `next: penguin index <repo-path>
— refresh stale or failed coverage before relying on a negative result`. Adding `--repo FPMS-NT` turned the
same query into `MATCH · 6 hits · coverage 3333/3340`. The negative result was well-labelled, but the
default scope is the cwd repo rather than the repo under discussion, which is an easy way to record a
false "not in the index".
