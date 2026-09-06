# Penguin index evaluation — GPT-5, Round 6

## 1. Summary and scores

I would use Penguin as a fast orientation and lead generator, but not as the sole authority for a signature change or a negative result. The indexed FPMS-NT revision is fresh and aligned, and several caller/file-symbol answers were immediately useful. The main limitation remains resolution: common method names are ambiguous, while search reports incomplete coverage and warns that empty results are not proof of absence.

| Dimension | Score | Why that number |
|---|---:|---|
| Accuracy | 72/100 | Fresh resolved graphs gave plausible, file/line-specific callers and callees, but several targets required disambiguation. |
| Completeness | 55/100 | `calls` is explicitly a lower bound; search coverage was 3333/3340 and warned of excluded files. |
| Honesty | 78/100 | It reported ambiguity, stale symbols, lower-bound/partial completeness, and coverage warnings instead of silently inventing answers. |
| Usability | 60/100 | Dedicated commands are concise, but ambiguous names require search, node IDs, and follow-up queries. |
| Speed vs grep + reading files | 82/100 | Most first-hop answers arrived in one command and included indexed source snippets. |
| Overall | 65/100 | Worth installing as an accelerator, with mandatory source spot-checks before edits. |

The single change that would add ten points is stable path-qualified target resolution: allow every command to accept the file path from the brief and return the exact symbol, eliminating ambiguity and preserving the same completeness/freshness diagnostics.

## 2. Part A answers

## Q1
answer:
- `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135` — getActiveEventConfigByObjId
- `apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:44` — dailyShareMission
- `apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:108` — playerDailyShareMissionBoosts
- `apps/promotion/src/modules/color-land/processors/get-player-color-land-rewards-summary.processor.ts:41` — getPlayerColorLandRewardsSummary
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:118` — getPlayerColorLandProgress
- `apps/promotion/src/modules/color-land/services/color-land.service.ts:838` — getDiceConfigByConditionType
- `apps/promotion/src/modules/color-land/services/player-color-land-progress.service.ts:220` — getPlayerColorLandEvents
tool used: `penguin explore`, then `penguin callers` (the latter returned the seven symbols).
confidence: high — fresh FPMS-NT@brazil-v2 result; no revision was resolved for the shorthand callers query, so the explore trust record is the authority.

## Q2
answer: The requested target was not uniquely resolved by `penguin calls claimColorLandTaskReward`; it returned `ambiguous` and required a node id from `penguin search`. I therefore leave the callee list blank rather than guessing between the controller and processor methods.
tool used: `penguin explore` first; `penguin calls`.
confidence: low — the index exposed ambiguity instead of resolving the file-qualified target.

## Q3
answer: `penguin filesymbols` returned: FrontendGameProviderProcessor (class, line 65); constructor (70); getPlatformSpecificProviderStatus (97); getRecentPlayedGames (112); getLoginURL (266); transferProm (577, stale); getFavoriteGames (796); filteredResult (821, stale); addFavoriteGame (846); deleteFavoriteGame (876); verifyInvitationCode (904); transferToProvider (1064).
tool used: `penguin filesymbols FPMS-NT apps/provider/src/game-provider/frontend/frontend-game-provider.processor.ts`.
confidence: medium — two symbols were explicitly marked stale.

## Q4
answer: `penguin deadcode --repo FPMS-NT --path apps/admin/` returned 77 candidates. The command output showed candidates including `useFactory` at `apps/admin/inteceptor/external.module.ts:14`, `ExternalModule:48`, repository/module methods, controllers, modules, DTO constructors, and many more; 37 were omitted by the text renderer. I do not treat these as proven dead code.
tool used: `penguin deadcode --repo FPMS-NT --path apps/admin/`.
confidence: medium — scope is repo FPMS-NT, under apps/admin; the command itself says to verify DI, reflection, framework magic, dynamic imports, and public entry points.

## Q5
answer: The shorthand target was ambiguous: `penguin callers getCredit` could not answer and said the name matched more than one symbol. Search found the requested CPMS method at `apps/payment/libs/utils/cpmsServices.ts:208`, but the caller list was not safely returned by the index command.
tool used: `penguin explore` first; `penguin callers`; `penguin search getCredit`.
confidence: low — path-qualified resolution was missing from the callers command.

## Q6
answer:
- hasTaskIn30Days
- getPlayerVipLevelFromTargetGroup
- createNewGrowthTaskForPlayer
- isTaskEnded
- setTaskEndedRedisKeyIfDay9OrLater
- hasLoggedInToday
- updateDailyLoginTask
- setLoggedInToday
tool used: `penguin calls createGrowthTaskMissionsForPlayer --repo FPMS-NT`.
confidence: medium — no file/line locations were emitted by the concise calls renderer, and the query reported no explicit revision.

## Q7
answer: DepositLimitStateService (class, line 14); constructor (15); evaluateState (21); evaluateStateAndResetIfPeriodExpired (59); accumulatePlayerDeposit (74); buildStateEvaluateResult (104); resetStateViewIfPeriodExpired (113); resetStateViewIfSystemDisable (124); calculateLimitStatus (139); notifyStateChanged (157); mockUpdateLastDepositAmountUpdateTime (181); getRuntimeContext (191).
tool used: `penguin filesymbols FPMS-NT apps/riskControl/src/antiAddiction/deposit-limit-state.service.ts`.
confidence: high — complete file-symbol listing was returned without stale markers.

## Q8
answer:
- `apps/promotion/src/modules/milyonaryo-jackpot/services/milyonaryo-winner-query.service.ts` — incrementTotalWinnerCount
- same file — incrementTotalPrize
- same file — refreshTotalWinnerCountCache
- same file — refreshTotalPrizeCache
- same file — refreshRecentWinnersCache
- same file — bootstrapWinnerCountIfNeeded
- same file — bootstrapTotalPrizeIfNeeded
tool used: `penguin callers getEventEndTtlSeconds --repo FPMS-NT`.
confidence: medium — the shorthand query returned names but not locations; it also reported no explicit revision.

## Q9
answer: getEventV2s; buildErrorResponse; fetchGameInfoMap; getMultiplier; applyMultiplier; generateEventId; createFreeSpinConfig; updateFreeSpinConfig.
tool used: `penguin calls executeForEventV2 --repo FPMS-NT`.
confidence: medium — names were returned, but no file/line locations were emitted and no explicit revision was resolved.

## Q10
answer: Pagination, PaginationBaseResponse, MatchFields, Game, PlayerRecentGameRecord, GetPlayerRecentGamesWithGroupingRes, InternalProviderService, ProviderClientGrpc, constructor, onModuleInit, catchGrpcError, getPlayerRecentGamesWithGrouping; all were reported in the requested file, beginning at lines 8, 13, 24, 31, 44, 60, 72, 84, 87, 91, 98, and 118 respectively.
tool used: `penguin filesymbols FPMS-NT libs/tools/src/client-grpc/provider-client-grpc/provider-client-grpc.ts`.
confidence: high.

## Q11
answer:
- fetchAllGameInfoCached
- fetchGameInfoFromCms
- resolveFreeSpinGameInfo
- resolveFreeBetGameInfo
- fetchGameInfoFromCms
- fetchGameInfoFromCms
- fetchAllGameInfoCached
tool used: `penguin callers getGameImageUrl --repo FPMS-NT`.
confidence: medium — duplicate names were returned without file/line locations, so the complete call-site identity was not recoverable from this renderer.

## Q12
answer: The requested target was ambiguous: `executeSuccess` matched multiple executors. Search identified the exact target as `apps/offline-casino/src/proposal-executors/offline-casino-transaction.executor.ts:89`, but the calls query was not safely completed with that node id in this round.
tool used: `penguin explore` first; `penguin calls`; `penguin search executeSuccess`.
confidence: low.

## Q13
answer: MessageDispatcherServiceName (enum, line 11); PlayerMeta (interface, 15); ProposalData (25); DispatchMessageData (35); MessageDispatcher (class, 48); constructor (49); dispatchMessagesInternal (54); dispatchMessagesForPromoCode (96); contentModifier (151); renderTemplateAndSendMessage (183); sendMessage (207); notifyMessage (252).
tool used: `penguin filesymbols FPMS-NT libs/tools/src/message-dispatcher/message-dispatcher.ts`.
confidence: high.

## Q14
answer:
- `apps/promotion/src/modules/live-draw-events/live-draw-events.service.ts:74` — getTodayLiveDrawEvents
- `.../live-draw-events.service.ts:94` — getTomorrowLiveDrawEvents
- `.../live-draw-events.service.ts:162` — getEventByEventId
- `.../live-draw-events.service.ts:262` — findNextCurrentRoundEvent
- `.../live-draw-events.service.ts:306` — getEventByBetDateAndPrizeTierKey
- `apps/promotion/src/modules/live-draw-tickets/live-draw-tickets.service.ts:232` — getLuckyDrawRewardList
- same file:402 — buildNotActivatedTickets
tool used: `penguin explore`, then `penguin callers getLiveDrawEvents --repo FPMS-NT`.
confidence: high — seven callers returned; the result reported partial completeness because one external Mongoose reference was unresolved.

## 3. Part B write-ups

### B1 — onboarding FPMS-NT

I could not produce a dependable subsystem orientation from the commands completed here: `architecture`/`onboarding` was not used, and the sampled symbol queries were concentrated in promotion, payment, provider, riskControl, admin, and tools. The index did show that repo scoping works and that `architecture --repo` is available. Confidence is low; I would want a ranked subsystem/entry-point view plus links from each entry point to its tests and configuration.

### B2 — request trace

The `explore getLiveDrawEvents` result provided a useful chain: `gRPC AdminLiveDrawService.GetTodayLiveDrawEvents` → controller `getTodayLiveDrawEvents` at `apps/promotion/src/modules/live-draw-events/live-draw-events.controller.ts:33` → service `getTodayLiveDrawEvents` at line 74 → repository `getLiveDrawEvents` at `apps/promotion/src/repositories/live-draw-events.repository.ts:34` → base repository `find` and `countDocuments`. The chain was visible through `explore`; it also reported a partial completeness note and an unresolved external Mongoose reference.

### B3 — change impact

I used `getLiveDrawEvents`, which has seven indexed callers listed in Q14. The list is useful for a first pass, but I would not change its signature without source verification: the result says callers are complete only to the graph's lower-bound model, and the repository call list is partial with external calls and unmodelled callback/static/interface cases.

### B4 — something wrong

The strongest concrete finding is not a source defect but an index usability defect: `calls claimColorLandTaskReward`, `callers getCredit`, and `calls executeSuccess` all returned ambiguity for names whose file paths were supplied in the quiz. That blocks an otherwise ordinary graph query and can make an agent stop or guess. A second caution is `deadcode`: it returned 77 candidates while explicitly warning that DI and framework wiring can make them false positives.

## 4. What worked well

- `filesymbols` was compact and immediately actionable for Q3, Q7, Q10, and Q13.
- `callers getLiveDrawEvents` returned seven named callers with locations, and `explore` rendered the endpoint-to-repository chain with parent-child structure.
- Freshness and trust metadata were present; the FPMS-NT revision was aligned and clean in the explore result.
- The system was honest about ambiguity, stale symbols, lower-bound calls, partial external resolution, and coverage warnings.

## 5. What did not work

- Path-qualified targets were not accepted by the graph commands. Exact examples: `cannot answer calls for "claimColorLandTaskReward": ambiguous`; `cannot answer callers for "getCredit": ambiguous`; `cannot answer calls for "executeSuccess": ambiguous`.
- Several concise graph outputs omitted file/line locations, despite the quiz requiring them: Q6, Q8, Q9, and Q11.
- Search reported `coverage 3333/3340` and `COVERAGE_INCOMPLETE`, with the warning that an empty result is not proof of absence.
- `filesymbols` marked `transferProm` and `filteredResult` stale without offering a fresh per-symbol repair path.

## 6. Pros and cons

| Pros | Cons |
|---|---|
| Very fast first-hop graph and file-symbol answers | Ambiguous common names require manual node-id workflows |
| Useful source snippets, locations, trust, and freshness | Calls are explicitly lower bounds |
| Repo scoping and structured diagnostics | Coverage exclusions weaken negative claims |
| Dead-code output includes file-import counts | Framework/DI wiring still creates false positives |

## 7. Suggestions

1. Make `--path` or a `repo:path#symbol` target accepted by every query. High impact, moderate cost; directly fixes the ambiguity failures.
2. Make all text renderers include `file:line` by default. High impact, low cost; it satisfies the operational form agents need.
3. Put a prominent “not complete” banner on every lower-bound/partial graph result and expose omitted counts plus pagination. High impact, moderate cost.
4. Add a coverage-aware negative-result contract: refuse to call dead code or no-callers definitive when excluded/failed files exist. High impact, moderate cost.
5. Add a one-command onboarding report with subsystems, ranked entry points, tests, and configuration links. Medium-high impact, moderate cost.

## 8. How it felt to use

The fast answers were genuinely pleasant: file symbol inventories and the live-draw call graph were much quicker than manually locating definitions. The frustrating part was that the brief already supplied exact file paths, yet common names still became ambiguous. I would reach for Penguin again for orientation, search, and candidate impact analysis; I would still open the source before changing a signature or relying on a negative result.

Full path: `/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-gpt-5-round6.md`
