# Penguin index evaluation — GPT-5, Round 5

## 1. Summary and scores

I would use Penguin for orientation and as a fast lead, provided the result is
spot-checked before a change or a negative conclusion. The parser-backed graph
is useful and often honest about partial coverage, but the CLI still loses
important location detail and frequently requires a node-id workaround for
common names. The FPMS-NT branch reported by `explore` was fresh and aligned;
the simpler commands warned that no revision was resolved and answered against
the live branch. I would not treat a short callers/callees/dead-code result as
complete without checking its diagnostics.

| Dimension | Score | Why that number |
|---|---:|---|
| Accuracy | 78/100 | Resolved symbols and graph edges were plausible and carried parser provenance; stale symbols were explicitly marked. |
| Completeness | 55/100 | `explore` says calls are a lower bound, and callers/callees omit locations or stop at ambiguity; dead-code output is capped at 77 with 37 hidden. |
| Honesty | 82/100 | It reports `ambiguous`, `COVERAGE_INCOMPLETE`, `lower_bound`, stale symbols, and missing endpoint resolution instead of silently inventing data. |
| Usability | 58/100 | Search → node-id → explore is workable, but ordinary symbol queries often need that multi-step workflow. |
| Speed vs grep + reading files | 76/100 | Architecture, onboarding, file-symbol and graph summaries are much faster than manual traversal; exact call-site evidence still requires extra queries. |
| Overall | 68/100 | I would install it as an exploration tool, not as an authority for refactors or dead-code deletion. |

The single change worth ten points is to make every graph command return a
complete, location-bearing result (or an explicit truncated/partial result),
with deterministic node-id disambiguation and the selected revision shown in
the normal text output.

## 2. Part A answers

The index was queried with `--repo FPMS-NT`; the branch used by the explicit
explore query was `brazil-v2`, commit `3f0f198`, aligned and fresh.

## Q1
answer:
- apps/promotion/src/modules/realtime-task/services/realtime-task-budget.service.ts:60-114 — checkAndDeductBudget
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:189-257 — enroll
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:264-274 — findCycleTask
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:285-332 — getPlayerTaskView
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:343-363 — getPlayerTaskBanner
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:386-457 — resolveLevelUpMultiplier
- apps/promotion/src/modules/realtime-task/services/realtime-task.service.ts:467-480 — markTaskBannerSeen
tool used: `penguin callers claimPeriod --repo FPMS-NT`; `penguin explore claimPeriod --repo FPMS-NT --json`
confidence: medium — explore reports `completeness.status=lower_bound`; the text callers command omitted file/line fields.

## Q2
answer:
- isPlayerTypeForbidEditProfileFields
- isAdult
- normalizeName
- uploadPhotoId
- encrypt
- withTransaction
- update
- bindEmailToPlayer
- checkAndUpdateIsCompleteInfo
tool used: `penguin calls updatePlayerProfile --repo FPMS-NT`
confidence: low — the index listed callees but the normal output did not provide their defining files/lines, and explore warns the calls list is a lower bound.

## Q3
answer:
- RewardGrantType — apps/promotion/src/reward-grant/reward-grant.types.ts:25
- GrantStatus — :28
- GrantResult — :34
- AdapterDispatchResult — :41
- GrantBase — :53
- MudGrantPayload — :81
- FreeSpinGrantPayload — :99
- PromoCodeGrantPayload — :107
- PlayerLevelUpGrantPayload — :120
- PlayerLevelMaintainGrantPayload — :148
- GrantRewardRequest — :161
- RewardAdapter — :178
tool used: `penguin filesymbols FPMS-NT apps/promotion/src/reward-grant/reward-grant.types.ts`
confidence: high — one file-scoped result with all 12 definitions.

## Q4
answer:
- 77 candidates were returned under `apps/admin/`; the text result displayed 40 and said “37 more not shown”.
tool used: `penguin deadcode --repo FPMS-NT --path apps/admin/`
confidence: low — incomplete display prevents a complete answer. The command itself says candidates need verification for DI, reflection, framework magic, dynamic import, and public entry points; it also reports `COVERAGE_INCOMPLETE`.

## Q5
answer:
- requirePbIntEnum
- pauseAppPushMission
- _executeOneMission
- _executeTopicMission
- _executeMulticastMission
- retryAppPushMission
- buildScheduleSummary
tool used: `penguin callers coercePbIntEnum --repo FPMS-NT`
confidence: medium — all names were returned, but no file/line locations were emitted and the command answered against live branch without an explicit revision.

## Q6
answer:
- validateNameAndDisplayName
- validatePopupCopy
- validateTimeWindow
- validateFrequencies
- validateTaskDaysAndSubTasks
- validateAudienceXor
- validateRewards
- validateFreeSpinPlatformId
- validateCreateStatus
tool used: `penguin calls validateForCreate --repo FPMS-NT`
confidence: medium — the callees were returned, but locations were absent and the graph is documented as a lower bound.

## Q7
answer:
- pbToLedgerSource — :39
- toDate — :58
- flattenCvErrors — :64
- SkinFragmentAdminController — :84
- constructor — :87
- createActivity — :93
- updateActivity — :158
- getActivity — :254
- listActivities — :266
- listFragmentLedger — :295
- listRedemptions — :355
- runAutoEndJob — :395
tool used: `penguin filesymbols FPMS-NT apps/promotion/src/skin-fragment/controllers/skin-fragment-admin.controller.ts`
confidence: high.

## Q8
answer: not resolved.
tool used: `penguin callers deleteMany --repo FPMS-NT`
confidence: low — exact output was `cannot answer callers for "deleteMany": ambiguous`; search showed many unrelated `deleteMany` definitions/usages, including the requested base repository method, but the index did not resolve the requested definition from the supplied name alone.

## Q9
answer:
- zrange
- agentHmget
- addChatTransferLog
- _isMemberInRoom
- get
- inviteUser
- _agentAutoJoinRoom
- set
tool used: `penguin calls _findAvailableAgentAndJoinRoom --repo FPMS-NT`
confidence: medium — names were returned, but locations were absent and calls are lower-bound.

## Q10
answer:
- SpecialEventAdminController — :26
- constructor — :29
- queryRedPacketRecords — :45
- queryRewardRecords — :56
- queryLuckyDealRecords — :70
- queryRewardTicketRecords — :85
- queryPalayokRewardRecords — :120
- queryMilyonaryoJackpotReport — :140
- queryWinsdayBillionReport — :157
- queryWinsdayBoostRelationReport — :185
- sameInitiator — :204 (stale)
- queryPlayerMissionProgress — :244
tool used: `penguin filesymbols FPMS-NT apps/promotion/src/special-event/controllers/special-event-admin.controller.ts`
confidence: high for the file result; medium overall because `sameInitiator` is explicitly stale.

## Q11
answer: not resolved as a complete caller list.
tool used: `penguin callers findOneByPlatformId --repo FPMS-NT`; `penguin search findOneByPlatformId --repo FPMS-NT`
confidence: low — callers returned `ambiguous`; search exposed at least two definitions and multiple usages, including the requested `libs/tools/src/repositories/player/fpms/admin/platform/platform.repository.ts:46`, but did not provide a resolved caller graph for that node.

## Q12
answer: not resolved as a complete callee list.
tool used: `penguin calls callBackToUser --repo FPMS-NT`; `penguin search callBackToUser --repo FPMS-NT`
confidence: low — calls returned `ambiguous`; search found the controller call and processor definition but the supplied name did not resolve the requested processor method.

## Q13
answer:
- ClaimBoostResult — :24
- BoostClaimService — :38
- constructor — :41
- claim — :50
- fail — :52
- replay — :240
- option — :253 (stale)
- grantAndCache — :281
- optionDetail — :342
- optionDetailFromConfig — :352
- option — :360 (stale)
- toResult — :366
tool used: `penguin filesymbols FPMS-NT apps/promotion/src/winsday-billion/services/boost-claim.service.ts`
confidence: medium — complete-looking file result, but two symbols are explicitly stale.

## Q14
answer:
- apps/promotion/src/modules/color-land/processors/color-land-player-auxiliary.processor.ts:44-106 — dailyShareMission
- apps/promotion/src/modules/color-land/processors/get-player-color-land-rewards-summary.processor.ts:41-173 — getPlayerColorLandRewardsSummary
- apps/promotion/src/modules/color-land/services/color-land.service.ts:118-402 — getPlayerColorLandProgress
- apps/promotion/src/modules/color-land/services/color-land.service.ts:404-443 — getPlayerFirstRemainingDiceToday
- apps/promotion/src/modules/color-land/services/color-land.service.ts:838-899 — getDiceConfigByConditionType
- apps/promotion/src/modules/color-land/services/player-color-land-progress.service.ts:84-117 — getPlayerCellCurrentLevel
- apps/promotion/src/pulsar/colorland/bet-dice-count/bet-dice-count.consumer.ts:81-516 — handleMessage
tool used: `penguin callers findPlayerProgress --repo FPMS-NT`; `penguin explore findPlayerProgress --repo FPMS-NT --json`
confidence: medium — the result reports seven incoming calls but the text callers output omitted locations; the explore result says incoming calls are complete only within the modeled/lower-bound graph.

## 3. Part B write-ups

### B1 — onboarding FPMS-NT

Commands: `penguin onboarding FPMS-NT`; `penguin architecture --repo FPMS-NT`.

Architecture gave a useful scale and language picture: one branch, 3,306 files,
14,435 symbols, 18 services, six endpoints, 10,650 calls, 1,620 test edges,
and seven handles edges. It identified hubs such as `PromotionRedisService`,
`PlayerClientGrpc`, `VaultFetcher`, and `redeemPhysicalGift`. The generated
onboarding pack supplied the repo boundary, `status`, `pnpm run typecheck`, and
the Search → Context → Graph → Evidence reading order.

Confidence is medium-low. It did not explain the major subsystems in domain
terms, rank the busiest HTTP/gRPC entry points beyond “six endpoints”, or give
file locations for the hubs. The onboarding generator is structurally useful
but too generic for a first day on this repo.

### B2 — trace a request

Commands: `penguin flow dailyShareMission --repo FPMS-NT`; `penguin flow
symbol:node_6ea96e3e-960b-481a-ad13-22805ae21683 --repo FPMS-NT` was the suggested
next step from the command output; `penguin explore findPlayerProgress --repo FPMS-NT --json`.

The first flow query found two endpoint symbols and stopped with an ambiguity
message. The explore result nevertheless exposed a concrete chain for the
selected endpoint: `promotion.v1.FrontendColorLandService.DailyShareMission` →
`dailyShareMission` → `findPlayerProgress` →
`PlayerMissionProgress` references. The chain stopped before a concrete data
access method, and the result reported `calls=[]` for `findPlayerProgress` while
showing the repository call in its source pack; this is a boundary of the graph
representation, not a safe claim that no database access occurs.

### B3 — change impact

I selected `claimPeriod`, which has seven reported callers. Commands:
`penguin explore claimPeriod --repo FPMS-NT --json`; `penguin callers claimPeriod
--repo FPMS-NT`.

The impact candidates are the seven symbols listed in Q1. I would trust this as
a review lead only. Explore explicitly says `completeness.status=lower_bound`,
with constructor calls, interface dispatch, static calls, and callback-body
calls not modeled. The normal callers command also dropped file/line data and
warned that it answered against the live branch without an explicit revision.

### B4 — find something wrong

The clearest concrete problem was not necessarily a code bug but an index
quality defect affecting safety: `penguin callers deleteMany --repo FPMS-NT`
returned `cannot answer ... ambiguous`, even though the requested definition was
specified by its file in the quiz and search found it at
`libs/common/base-repository/base-repository.ts:290`. A second concrete finding
was the stale marker on `sameInitiator` in the special-event controller file
symbol result. I would not call either a source-code defect without reading
source, which the brief forbids; the honest index finding is that negative or
signature-impact conclusions are unsafe when resolution is ambiguous or stale.

## 4. What worked well

- `filesymbols` was the strongest command: it returned compact, complete-looking
  file inventories with line numbers for the reward-grant, skin-fragment, and
  special-event files.
- `explore` combined source, callers, callees, flow, trust, provenance, and
  completeness. For `claimPeriod` it reported `confidence.level=high`, parser
  edges, `freshness.stale=false`, and the selected commit.
- The index was explicit about limitations: `lower_bound`, `partial`,
  `COVERAGE_INCOMPLETE`, `ambiguous`, and `sameInitiator (stale)` were all
  actionable warnings.
- `architecture --repo FPMS-NT` correctly scoped to one repo rather than
  dumping the entire multi-repo database.

## 5. What did not work

- Ordinary `callers` and `calls` output omitted file and line locations, despite
  the evaluation contract requiring `file:line`.
- Same-name resolution remains a daily-use failure. `deleteMany`,
  `findOneByPlatformId`, and `callBackToUser` all needed a node-id workflow;
  two of the three still could not be resolved from the requested definition.
- `penguin flow` needed exact endpoint spelling and returned two candidates for
  `dailyShareMission`; the first fully qualified string supplied in the brief
  was rejected as “No symbol found”.
- `deadcode` displayed only 40 of 77 candidates and required JSON for the rest,
  while also warning that coverage was incomplete. This makes a complete
  negative audit awkward.
- The simpler commands warned that no revision was resolved and used the live
  branch, while `explore` supplied a precise aligned revision. Revision selection
  should be consistent across commands.
- Calls are explicitly a lower bound. That is honest, but it means the default
  result is not adequate for signature changes unless the user understands and
  acts on the warning.

## 6. Pros and cons

| Pros | Cons |
|---|---|
| Fast repo-scale orientation and compact graph summaries | Ambiguous common names block otherwise valid questions |
| File-symbol inventories include useful line numbers | Calls/callers text output loses file/line evidence |
| Trust, freshness, provenance, and completeness diagnostics are visible | Lower-bound edges are easy to mistake for complete lists |
| Scoped architecture avoids cross-repo noise | Onboarding is generic and does not explain subsystems |
| Faster than manual grep for graph-shaped questions | Still needs source spot-checking before changes or deletion |

## 7. Suggestions

1. Make all callers/calls/impact/deadcode output location-bearing by default and
   expose a visible `truncated`/`partial` status. This is high impact and a
   modest formatter/API change.
2. Accept a file-qualified target or definition path directly, and print the
   resolved node id in every result. This removes the repeated search workaround
   and is moderate resolver work.
3. Apply the same explicit revision and freshness header to every CLI command.
   This is relatively low-cost and prevents live/snapshot confusion.
4. Improve `onboarding` to rank entry points by handles/calls and list the
   defining files for hubs; moderate aggregation work, high onboarding value.
5. Add a flow mode that follows endpoint → handler → service → repository and
   clearly labels the first unmodeled edge; this would make the current boundary
   useful instead of merely confusing.
6. Provide a complete machine-readable dead-code report without display caps,
   retaining the existing DI/reflection caveat.

## 8. How it felt to use

Penguin feels promising when the question is “what is in this file?” or “what
does this named symbol connect to?” The first answer is often immediate and
well packaged. It feels much less dependable when the question contains a
common method name or asks for a complete change-impact list: I had to search,
disambiguate, inspect JSON, and interpret warnings before knowing whether I had
an answer or a lookup failure. I would reach for it again for onboarding and
graph discovery, but I would keep grep/source reading in the loop for a refactor,
dead-code deletion, or any claim that something is absent.

/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-gpt-5-round5.md
