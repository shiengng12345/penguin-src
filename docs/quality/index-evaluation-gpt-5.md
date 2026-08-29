# Penguin index evaluation

## 1. Summary

I would use Penguin as a fast orientation and triage aid, especially for unique symbols and known HTTP routes. I would not rely on it alone for a signature change or a complete call-graph audit: target resolution, stale data, truncation, inferred edges, and framework/dynamic wiring make completeness uncertain. The strongest results were route-to-handler and file-symbol queries; the weakest were common-name callers/callees and negative claims. This evaluation itself was run against `FPMS-NT/brazil-v2`, while the initial status reported `stale=725` and a checked-out HEAD different from the indexed commit, so freshness must be checked per query.

## 2. Part A answers

## Q1
answer:
- Cannot determine. `explore("CMSGenBaseResponse", --repo FPMS-NT, --json)` returned `diagnostics: ["ambiguous target: 2 matches", "CMSGenBaseResponse matches 2 symbols — specify one."]`, with candidates in `apps/promotion/src/budget/budget-base-response.ts:14` and `libs/common/base-response.ts:452`, and `callers: []`.
tool used: knowledge_explore("CMSGenBaseResponse")
confidence: low — the requested file was one of two candidates, but the CLI did not provide a file-qualified target syntax that resolved it.

## Q2
answer:
- Cannot determine. The query resolved to an endpoint/service representation rather than the requested method and returned `calls: []`; it also reported `ambiguous target: 6 matches`.
tool used: knowledge_explore("accumulatePlayerDeposit")
confidence: low — the index exposed candidates including `DepositLimitService.accumulatePlayerDeposit` at `apps/riskControl/src/antiAddiction/deposit-limit.service.ts:163`, but did not return its callees.

## Q3
answer:
- `apps/livechat/src/http-health-check/http-health-check.controller.ts:12` — `check`.
- Next: `apps/livechat/src/http-health-check/http-health-check.service.ts:20` — `check`.
tool used: knowledge_explore("GET /healthcheck")
confidence: high — the result included the handler source, route, and call edge; it also showed duplicate handling in `libs/tools/src/http-health-check/http-health-check.controller.ts` and marked the overall result mixed because external calls were unresolved.

## Q4
answer:
- `apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts:10` — `LiveChatBotProcessor`
- `:20` — `constructor`
- `:34` — `_initializeChatBotClient`
- `:41` — `create`
- `:60` — `destroy`
- `:73` — `_getChatbotClient`
- `:83` — `_releaseChatbotClient`
- `:87` — `_initBot`
- `:97` — `updateBotAccessToken`
- `:103` — `_getBotMatrixClient`
- `:110` — `delay`
- `:156` — `updateNewAccessToken`
tool used: knowledge_file_symbols("FPMS-NT/brazil-v2", "apps/livechat/src/processor/liveChatBot/livechat-bot-processor.ts")
confidence: high — complete file-symbol output; no stale marker was shown.

## Q5
answer:
- `class-transformer` — `Type` at `apps/promotion/src/modules/dynamic-threshold-configs/dto/dynamic-threshold-vip-config.dto.ts:23`.
- The result reports six external calls, but the visible external list was truncated before all six could be transcribed.
- The list is not complete: Penguin explicitly returned `completeness: {status: "partial", externalCallCount: 6}` and the diagnostic `6 call(s) go to external packages and cannot be resolved to repo symbols — see externalCalls; the calls list is incomplete`.
tool used: knowledge_explore("DynamicThresholdVipConfigDto")
confidence: medium for the reported package/count; low for a complete per-call list because the CLI output was truncated.

## Q6
answer:
- Penguin reported `77 candidate(s) — no inbound calls/references/handles/tests` under `apps/admin/` in `FPMS-NT`.
- Visible candidates included `useFactory` at `apps/admin/inteceptor/external.module.ts:14`, `ExternalModule` at `:48`, repository methods at `apps/admin/libs/repositories/fpms/admin/platform-announcement/platform-announcement-repository.ts:13,25,29,36`, and controllers/modules such as `AddressController` at `apps/admin/src/address/address.controller.ts:6` and `AdminModule` at `apps/admin/src/admin/admin.module.ts:80`.
- This is a candidate list, not proof of dead code. Scope is repo `FPMS-NT`, path `apps/admin/`; 37 more candidates were omitted by the text output.
tool used: knowledge_dead_code("FPMS-NT", path="apps/admin/")
confidence: medium — exact scope/count are clear, but the complete list and framework false-positive checks are not available from this output.

## Q7
answer:
- Cannot determine. `explore("addPlayerFreeSpin")` reported `ambiguous target: 10 matches`; it returned `callers: []` for the unresolved target, although the graph showed nine incoming `invokes` edges for a resolved endpoint-related node.
tool used: knowledge_explore("addPlayerFreeSpin")
confidence: low — the requested implementation could not be selected uniquely.

## Q8
answer:
- `libs/tools/src/repositories/player/fpms/logs2/open-promo-code-template/open-promo-code-template.repository.ts:16` — `findActiveOpenTemplate` was visible as one callee; the result reported nine additional repo calls that were omitted by truncation.
- External calls leave through `@snsoft/proposal-sdk`: `getProposalTypeList` at `:1317`, and `getProposalData` at `:1332`, `:1338`, and `:1407` in `apps/promotion/src/promo-code/promo-code.processor.ts`.
- The list is not complete: `completeness.status` was `partial`, `externalCallCount` was `4`, and diagnostics included `1 INFERRED edge(s)` plus unresolved external calls.
tool used: knowledge_explore("applyOpenPromoCode")
confidence: medium for the external calls; low for all repo callees because the CLI abbreviated the result.

## Q9
answer:
- `apps/promotion-event-scheduler/src/vip-cohort/vip-cohort-trigger.controller.ts:45` — `triggerRetentionRisk`.
- Next: `apps/promotion/src/modules/vip-cohort/services/vip-cohort-runner.service.ts:101` — `run`.
tool used: knowledge_explore("POST /internal/vip-cohort/retention-risk")
confidence: high for the first hop; medium for the full route result because Penguin reported one unresolved external call and `completeness: partial`.

## Q10
answer:
- `apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts:18` — `LiveChatConvoProcessor`
- `:20` — `constructor`
- `:35` — `updateConversationReview`
- `:62` — `updateConversationTag`
- `:97` — `getConversationTag`
- `:113` — `_endConversation`
- `:213` — `storeConversationData`
- `:300` — `_createConversation`
- `:466` — `getConversationList`
- `:527` — `data` (stale)
- `:553` — `updateConversationTagList`
- `:563` — `tagObjects` (stale)
tool used: knowledge_file_symbols("FPMS-NT/brazil-v2", "apps/livechat/src/processor/liveChatConversation/livechat-convo-processor.ts")
confidence: high for the returned list; two entries were explicitly marked stale.

## Q11
answer:
- Cannot determine. `explore("intercept")` returned `ambiguous target: 14 matches` and no resolved implementation/calls for the requested file.
- Therefore no package attribution or complete-call claim is justified.
tool used: knowledge_explore("intercept")
confidence: low — the common method name was not disambiguated to `apps/promotion/src/accumulative-event-config/interceptors/grpc-base-response.interceptor.ts`.

## Q12
answer:
- `apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66-113` — `dispatchMud` was visible as one caller in the resolved result.
- Penguin reported additional callers, but the abbreviated result did not expose the complete list.
tool used: knowledge_explore("addPlayerMudDisbursement")
confidence: medium — the target implementation resolved and the result was fresh, but the CLI output was truncated.

## Q13
answer:
- `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1404-1412` — `incrementMessageDedup` was visible as one callee; nine additional repo calls were abbreviated.
- External: `@snsoft/proposal-sdk.getProposalData` at `apps/promotion/src/leaderboard/leaderboard.processor.ts:693`; `@snsoft/proposal-sdk.createProposal` at `:756`.
tool used: knowledge_explore("createLeaderBoardRewardProposal")
confidence: medium for the external calls; low for the complete repo-callee list because the result was abbreviated.

## Q14
answer:
- `apps/promotion/src/free-spin/controllers/free-spin-http.controller.ts:20-29` — `getPlayerFreeSpinInfoRestful`.
- Next calls: `apps/promotion/src/free-spin/processors/get-player-free-spin-info.transformer.ts:11-23` — `transformRestfulReqToNt`; and `apps/promotion/src/free-spin/processors/get-player-free-spin-info.processor.ts:117-175` — `execute`.
tool used: knowledge_explore("POST /promotion/GetPlayerFreeSpinInfo")
confidence: high for the handler and immediate calls; the result was fresh and aligned, though it marked external decorator calls unresolved.

## 3. Part B write-ups

### B1 · Onboarding

Commands: `penguin architecture`; `penguin onboarding FPMS-NT --json`; `penguin status`.

The generated onboarding pack only established the repository boundary (`FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt`), suggested `Search → Context → Graph → Evidence`, and pointed to `penguin flow` and `penguin affected`. It did not identify major subsystems, busiest entry points, or a useful reading order. From the route queries I could identify promotion, promotion-event-scheduler, livechat, and risk-control as active areas, but that is a sample-driven inference, not a complete onboarding answer. Confidence is low. I wanted a ranked service/module map and entry-point list; the generated onboarding output did not contain them.

### B2 · Trace a request

Commands: `penguin explore 'POST /promotion/GetPlayerFreeSpinInfo' --repo FPMS-NT --json`; `penguin flow 'POST /promotion/GetPlayerFreeSpinInfo'`.

The route resolves to `getPlayerFreeSpinInfoRestful` (`free-spin-http.controller.ts:20-29`), then `transformRestfulReqToNt` (`get-player-free-spin-info.transformer.ts:11-23`) and `execute` (`get-player-free-spin-info.processor.ts:117-175`). The deeper graph reaches `getFreeSpinPlayerInfo` (`libs/tools/src/client-grpc/player-client-grpc/player-client-grpc.ts:206-222`), Redis `getPlayerFreeSpinClaimed` (`libs/tools/src/redis2/redis2.service.ts:986-991`), strategy creation, and the gRPC `PlayerService.GetFreeSpinPlayerInfo` endpoint. The chain did not fully reach a database boundary. I noticed the boundary because the result showed a gRPC endpoint and service/client nodes rather than a DB repository, and reported `completeness: partial` for unresolved decorator calls.

### B3 · Change impact

Commands: `penguin explore 'addPlayerMudDisbursement' --repo FPMS-NT --json`; `penguin callers 'addPlayerMudDisbursement' --repo FPMS-NT`.

The resolved target was `addPlayerMudDisbursement` in `apps/promotion/src/mud/processors/add-mud/add-mud-processor.ts`, but the complete caller list was not safely recoverable from the abbreviated output. One visible caller was `dispatchMud` at `apps/promotion/src/modules/growth-task/services/reward-dispatcher.service.ts:66-113`; the result indicated additional callers. I would not use this output as a signature-change checklist. The missing complete list and the tool's routine output abbreviation are enough to make the answer unsafe.

### B4 · Find something wrong

Commands: `penguin deadcode --repo FPMS-NT --path apps/admin/`; `penguin explore 'GET /healthcheck' --repo FPMS-NT --json`.

The concrete index finding is the dead-code candidate result: 77 symbols under `apps/admin/` had no inbound calls, references, handles, or tests. That is a useful lead, but not proof because Penguin itself says to verify DI, reflection, framework magic, dynamic import, and public entry points. A second concrete quality problem is the healthcheck route: Penguin reported two handlers for `GET /healthcheck`, one in the livechat app and one in `libs/tools`, with mixed confidence and unresolved external calls. The index surfaces both, but cannot by itself decide whether that duplicate is intentional or a routing defect.

## 4. What worked well

- Route resolution was useful and evidence-rich. `GET /healthcheck` returned a handler source, exact file/line, next service call, freshness, and route metadata.
- `filesymbols` answered both livechat file inventories in one call and included line numbers and stale markers.
- Unique method exploration exposed useful cross-service edges. The free-spin route reached a player gRPC endpoint and Redis operations; the retention-risk route reached the runner service.
- The tool is unusually honest about uncertainty. Examples include `ambiguous target: 14 matches`, `completeness: partial`, `1 INFERRED edge(s)`, and `unresolved_reference_counts_not_persisted`.

## 5. What did not work

- File-qualified questions were not reliably resolvable through the obvious CLI query. `CMSGenBaseResponse`, `addPlayerFreeSpin`, and `intercept` became ambiguous despite the brief naming the defining file.
- `calls`/`callers` results were frequently abbreviated or empty after an ambiguous resolution. This makes the required “complete list” impossible to produce honestly for Q1, Q2, Q7, Q11, Q12, and parts of Q8/Q13.
- Negative queries are not proof. The dead-code command returned 77 candidates but explicitly requires manual verification and omitted 37 candidates from text output.
- External-call reporting is partial by design. The DTO reported six external calls but the visible output did not preserve all six; several other queries reported unresolved package calls and incomplete call lists.
- The initial `status` output reported `FPMS-NT brazil-v2(live,stale=725)` and Penguin also warned that the indexed commit was behind the checked-out HEAD. Individual explore results later reported a fresh aligned snapshot, so freshness is confusing and must be interpreted per command.
- The generated onboarding document was generic. It did not answer the practical day-one questions the brief asks.

## 6. Pros and cons

| Pros | Cons |
|---|---|
| Fast route, symbol, and file inventory queries | Common names require fragile disambiguation |
| File/line evidence and source snippets | Output truncation prevents complete lists |
| Freshness, trust, inferred-edge, and completeness diagnostics | `partial` results are easy to mistake for complete answers |
| Cross-service and gRPC edges are visible | Framework, DI, reflection, and external package edges remain incomplete |
| Dead-code candidates provide useful triage leads | Negative claims require source verification, outside the index-only contract |
| Faster initial orientation than grep plus broad reading | Onboarding output is too generic for daily use |

## 7. Suggestions

1. Add a first-class `--file`/`--symbol` resolver, or accept the exact `path::symbol` identity from the brief. This would fix the highest-impact ambiguity failures at low-to-medium cost.
2. Add machine-readable pagination and a `--limit 0`/full-output mode for callers, callees, dead-code, and external calls. Completeness should be explicit and mechanically retrievable.
3. Make every result carry one consistent trust/freshness block, including ambiguous results, and reconcile `status` staleness with per-query snapshot freshness.
4. Improve framework-aware edges for NestJS decorators, DI providers, controllers, modules, and dynamic calls. This would reduce false dead-code candidates and improve endpoint completeness.
5. Make `onboarding <repo>` produce ranked subsystems, entry points, representative flows, tests, and coverage gaps instead of generic instructions.
6. Add a query that verifies “all callers for this exact node” and fails closed when the result is truncated, inferred, or ambiguous.

## 8. How it felt to use

Penguin felt valuable when I already knew the route or had a unique symbol: a few commands produced a compact map that would otherwise require opening several files. It felt frustrating for the questions that mattered most for safe change work. I expected the defining file in the question to be enough to identify a symbol, and I expected a caller/callee command to either return the complete list or clearly fail; instead, ambiguity and truncation repeatedly forced an insufficiency verdict. I would reach for Penguin again for route discovery, file inventories, and first-pass orientation, but I would still switch to source reading before changing a shared method signature or declaring code dead.
