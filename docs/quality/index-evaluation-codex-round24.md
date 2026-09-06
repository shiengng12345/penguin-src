# Penguin Knowledge Round 24 — Independent Codex Evaluation

## Executive result

**Evaluator/model:** Codex (GPT-5 family)  
**Evaluation boundary:** fresh Penguin MCP session; the evaluator read only `index-evaluation-brief-round24.md` as local input, did not inspect any Claude report, and used no shell, Git, source-file read, SQLite, Penguin CLI, web, old report, plan, snapshot file, or non-Penguin code index after loading the brief. The only non-Penguin operation after evidence collection is creation of this report.  
**Score:** **74/100**  
**Verdict:** **NO-GO**

The runtime is loaded and internally consistent; exact search, stable node lookup, flow, file-atomic affected analysis, endpoint pagination, scope isolation, and the one compatible semantic generation are useful. Round 24 nevertheless fails a hard gate: `knowledge.context` continuation repeats relation items across pages and its page counts do not honor the requested `limit`. The loaded MCP contract also advertises cursor support for operations whose MCP input schemas expose no cursor, so the required affected/service continuation audit is partly blocked.

## Fresh-process and target discovery

Direct MCP evidence of the new connection is `sessionId=857baa68-0dec-4bbe-937b-ae0d37a13524`, `clientConnectedAt=2026-08-31T17:59:22.173Z`, with health `serverTimeUtc=2026-08-31T17:59:53.000Z`. MCP does not expose an OS PID, so an external PID-level attestation is **UNPROVEN**; the distinct Penguin session identity and connection time are the strongest MCP-native proof available.

All targets below were selected from this session's MCP output:

| Target | Fresh MCP discovery path | Selected identity |
| --- | --- | --- |
| Primary Repo | `status_panel` listed 20 repos; largest admitted coverage was 12,460 | `FPMS-NT-User-Engagement`, `repo_e55541f5-455e-4c3d-b2b6-7296ec7b5ecc`, branch `brazil-v2`, snapshot `snapshot_8de6d493-ba55-4d3f-948a-67c459133ae9` |
| Secondary Repo | different admitted repo; architecture and semantic status both usable | `FPMS-NT`, `repo_a48ec7fb-5987-47df-9198-06969359cb50`, branch `brazil-v2`, snapshot `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55` |
| Natural Concept | Secondary architecture hub `redeemPhysicalGift`; phrased without identifier | fulfillment/redemption of a player's tangible or real-world reward |
| Primary Symbol | exact search for current architecture hub `retryAppPushMission`, then selected the service implementation | `node_8562e2c2-6939-4029-9791-cee068e1113b`; identity `repo_e55541f5-455e-4c3d-b2b6-7296ec7b5ecc::src/modules/app-push/backend-app-push/backend-app-push.service.ts::BackendAppPushService.retryAppPushMission` |
| Primary File | exact hit and `get_node` version locator | `src/modules/app-push/backend-app-push/backend-app-push.service.ts` |
| Sibling Symbol | `knowledge.file_symbols`, same file | `TokenQuery`, `node_ab8fbeb0-3e4f-433d-84f1-61023e0de851` (one of 37 symbols in file) |
| Primary Endpoint | endpoint inventory found handled app-push route | `node_16cb05bb-daf0-4217-8cc0-c53fff5fc9af`; `grpc::userEngagement.BackendAppPushService.retryapppushmission` |
| Service Pair | current service graph | `service:repo_e555...` and `service:repo_a48...`; proven `invokes` edges in both directions |

## Required runtime table

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| MCP health | session `857baa68...`; running/available `1.16.0-6c00b391a5bfe482`; schema 18; contract 2; hash `e38ea18f...365fb` | true | `launcherHealthy=true`, `initializeHealthy=true` | bounded queries work | false (`clientRestartRequired=false`, `runtimeOutdated=false`) | PASS |
| Capability manifest | same build/schema/contract/hash; selected registrations `implemented` | yes | yes | schemas discoverable | false | PASS_WITH_CONTRACT_GAPS |
| Graph/lexical index | Primary exact commit `5b006b951c232ee279b5062314c026ba8154aaaf`; clean; snapshot `snapshot_8de...` | yes | yes | exact/flow/affected useful | false | PASS |
| Semantic | one active FPMS-NT generation `generation_5c026...`; 45,007/45,007 ready | model files configured | generation loaded only for FPMS-NT | semantic applied there; Primary has no status row | false | PARTIAL_SCOPE |

## Q1–Q20

### Q1 — New-session runtime proof

**Direct observations:** health returned app `1.16.0`, build `1.16.0-6c00b391a5bfe482`, session/time above, `configured=true`, `status=ok`, `queryRuntime.workers=2`, hard timeout 30,000 ms, and cursor TTL 900 seconds. `generation.runningBuildId` and `availableBuildId` match; both outdated/restart flags are false. Health, capability manifest, tool-registration metadata, and bounded exact search all agreed on contract `2`, schema `18`, and capability hash `e38ea18f3da0cd3a3f68941a8c8adc2e13bc76d8fa898461160fa847d56365fb`. The bounded exact query returned real hits in 0.7–3.9 s depending on run.

**Inference:** runtime identity is consistent and restart is not required. OS PID proof is unavailable through MCP, so only the fresh MCP session is proven.

**Verdict:** PASS.

### Q2 — First-time tool selection

| Need | Canonical capability / loaded MCP wire | Relevant schema/annotation |
| --- | --- | --- |
| Architecture | `knowledge.architecture` / `knowledge_architecture` (`get_architecture` alias) | read-only; no confirmation |
| Repository status/inventory | `knowledge.index_status`, `knowledge.status_panel`, `knowledge.repository_graph` | read-only |
| Services | `knowledge.service_graph` | read-only; aggregated lower bound |
| Exact/lexical/hybrid search | `knowledge.search` | `mode`; nested `scope.revisions`, `options.semantic`, `page.limit/cursor` |
| Node lookup | `knowledge.get_node` (`get_node` alias) | stable `id` or `identity_key` |
| Context | `knowledge.context` | target/depth/limit/cursor |
| Flow | `knowledge.flow` | target plus revision scope |
| Affected | `knowledge.affected` | mutually exclusive node/file forms |
| Endpoints | `knowledge.endpoints` | protocol/limit/cursor/compact |
| Coverage | `knowledge.coverage` | kind/limit/cursor |
| Semantic status/control | `knowledge.semantic_status`, `knowledge.semantic_control` | status read-only; control mutating and confirmation required |
| Dead code | `knowledge.dead_code` (`find_dead_code` alias) | read-only; cursor/compact |
| Onboarding | `knowledge.onboarding.generate` | read-only |

**Direct observations:** aliases are explicit rather than duplicate registrations. Mutating/confirmation annotations are present. No explicit idempotency field was returned. More seriously, the manifest says `supportsCursor=true` for `affected`, `flow`, `architecture`, `service_graph`, `get_node`, and onboarding, while their MCP schemas expose no cursor (or no pagination fields). This makes capability inventory misleading for a first-time consumer.

**Verdict:** PARTIAL.

### Q3 — Count and page semantics

**Direct observations:** global architecture returned exactly 20 repository entries but no `returnedCount`, truncation flag, or cursor. It reported corpus totals (for example 76,261 symbols, 17,344 files, 1,531 endpoints). Primary architecture reported 4,752 symbols, 1,439 files, 134 endpoints. A bounded Primary endpoint inventory with `limit=3` returned three items, `candidateCount=134`, `returnedCount=3`, `remainingCount=131`, `totalIsExact=true`, `truncated=true`, and a next cursor.

**Reconciliation:** architecture totals describe the selected whole scope; endpoint `candidateCount=134` is the complete exact set, while `returnedCount=3` and item-array length 3 describe the page. Service graph returned all 72 aggregated candidates with `returnedCount=72`, `truncated=false`; despite the manifest cursor claim, its schema has no limit/cursor.

**Verdict:** PASS for endpoint page semantics; PARTIAL for bounded service/repository inventory discoverability.

### Q4 — Identifier-to-node recovery

**Exact recovery:** exact `retryAppPushMission` search found both controller and service identities. The service symbol was `node_8562...`, path `...backend-app-push.service.ts`, line 2330; `get_node` returned the identical node ID/identity, kind `method`, branch/snapshot, and content hash. Exact query timings ranged 0.7–4.0 s; it warned `COVERAGE_INCOMPLETE` and used verified source/graph provenance.

**Lexical recovery:** `mode=lexical` for “retry failed app push mission” hit the 30 s hard timeout. A second descriptive `auto`/semantic-off query, “retry a failed push-notification mission,” completed in 8.582 s but returned five irrelevant one-byte occurrences in `.github/workflows/codex-code-review.yml`, with 13,070 candidates; it did not recover the Primary Symbol.

**Verdict:** PARTIAL. Stable exact identity is strong; natural lexical recovery is not reliable.

### Q5 — Semantic paraphrase robustness

Semantic scope was identical for all calls: Secondary repo `FPMS-NT`, branch `brazil-v2`, limit 5. This is the only repo with a current complete active semantic generation.

| Semantic query | Root/evidence counts | Status | Requested/applied/generation | Top stable identities | Warnings | Timing |
| --- | --- | --- | --- | --- | --- | ---: |
| “fulfill a player's tangible reward claim” | 5 / 5 | MATCH; 50 candidates | true/true/`generation_5c026...`; 45,007/45,007 | vector locators: `post-win-share.service.ts`, leaderboard spec/service, reward specs | coverage incomplete | 4,297.566 ms |
| “exchange a won real-world prize for delivery” | 5 / 5 | MATCH; 50 candidates | true/true/same generation | `winsday-push.service.ts`; `redeem-hotel-voucher.handler.ts`; qualification/free-spin files | coverage incomplete; `LOW_SIMILARITY` best 0.1615 | 904.465 ms |
| “process redemption of a physical gift” | 5 / 5 | MATCH; 21 candidates | true/true/same generation | `redeem-physical-gift.processor.ts`; lucky-deal processor; physical-gift service/specs | coverage incomplete | 4,285.889 ms |

**Inference:** wording materially changes ranking; the third paraphrase best recovers the discovered concept. Vector similarity remains discovery evidence only, not proof of ownership or execution.

**Verdict:** PASS_WITH_WEAK_RECALL_VARIANCE.

### Q6 — Hybrid evidence separation

**Direct observations:** `mode=auto` with nested `options.semantic="blend"`, `compact=false`, `explain=true`, and generated/vendor exclusions was accepted. Diagnostics reported source, symbol, and vector lanes; semantic requested/applied true on the complete generation. Yet the top eight fused hits were lexical source occurrences in `promotion-redis.service.ts`, including unrelated symbols, while the most useful vector candidate from the pure semantic query (`redeem-physical-gift.processor.ts`) was crowded out.

Exact/source evidence in the hybrid result carried verified paths, line/byte locators, content hashes, and term-coverage reasons. Vector evidence carried persisted similarity and explicit “recall candidate; exact/source lanes retain truth precedence.”

**Verdict:** PARTIAL. Evidence separation is honest and nested options work; fused ranking is poor for this concept.

### Q7 — Semantic generation integrity

Two aggregate status reads 5.2 seconds apart were identical. Active FPMS-NT generation: `generation_5c026...`, snapshot `snapshot_5225...`, state active, model `nomic-ai/nomic-embed-text-v1.5`, model hash `00646ffa...32c`, 768 dimensions, chunker `semantic-chunker-v6-precision`, expected/ready 45,007/45,007, pending/running/retryable/terminal failed all zero, 100%, not paused, no active lease, no restart required. Rate/ETA/heartbeat/worker build were null because no work was running.

Historical rows were one legacy superseded generation and three FPMS-NT superseded generations. Each had pending/running/failure counters zero and reason `SEMANTIC_CHUNK_SET_REPLACED` (legacy had its own non-activation reason). Their historical expected counts were not counted as current pending work.

Tokenizer identity/digest and model revision were absent, so those fields are **UNPROVEN**.

**Verdict:** PASS for current generation integrity; PARTIAL metadata completeness.

### Q8 — Three-page context continuation

Initial request: Primary Symbol, depth 1, limit 2. Scope, target node/identity, branch, snapshot, and commit stayed stable and a new signed cursor was emitted at offsets 2, 4, and 6.

**Hard-gate failure:** page 1 reported `candidateCount=8`, `returnedCount=8` despite limit 2. Page 2 reported 4 and page 3 reported 4. The two importer nodes appeared on all three pages. Page 2 repeated the same `warn` node twice; page 3 repeated `coercePbIntEnum` twice. Thus continuation overlaps, page counts are not page counts, and deterministic no-overlap semantics fail. Definitions/focus, caller, route, type uses, and importers were repeated outside the advertised relation window; tests stayed empty. `truncated=["calls"]` persisted.

**Verdict:** FAIL_HARD_GATE.

### Q9 — Stable identity round-trip

Search → `get_node` → context → affected preserved `node_8562...`, repository `repo_e555...`, branch `brazil-v2`, snapshot `snapshot_8de...`, path `...backend-app-push.service.ts`, kind method/symbol, and title `retryAppPushMission`. No operation refused the freshly emitted node ID.

**Verdict:** PASS.

### Q10 — File/node affected parity

The MCP affected schema has no depth/limit/cursor despite the manifest advertising cursor support, so “same depth/limit” is **BLOCKED_BY_SCHEMA**. Under the same repo/branch defaults, file and node calls returned identical file-atomic sets: 37 changed sibling symbols, 19 impacted symbols, 45 proven call impact edges, 17 routes, 0 tests, `candidateCount=56`, `returnedCount=56`, `truncated=false`, completeness lower bound. The node request recorded the Primary node as requested target.

File atomicity correctly included `TokenQuery` and every other symbol defined in the Primary File because changing a file can affect any definition in that compilation unit.

**Verdict:** PASS for atomic parity; PARTIAL/BLOCKED for requested pagination controls.

### Q11 — Test evidence consistency

Primary Symbol context returned zero tests. File and node affected results also returned zero tests. A depth-2 local graph contained 150 nodes and 1,016 edges but no `tests` edge (edge mix: calls 244, references 10, imports 1, reads 400, writes 308, defines 30, logs 11, publishes 12). Primary repo architecture does contain 36 test edges globally, but none was connected to this file/node in the returned evidence.

**Safe conclusion:** no MCP test edge was proven for this Primary File; this is not proof that tests do not exist, and no inference was made from filenames.

**Verdict:** PASS_HONEST_NEGATIVE.

### Q12 — Endpoint pagination and identity

Three pages at limit 3 returned nine unique endpoint node IDs/identity keys, with no overlap, omission in the observed prefix, cursor repetition, or scope drift. Counts were exact: candidate 134; remaining 131 → 128 → 125. All three sampled pages were declaration/consumer endpoints with `handlerStatus=incomplete`; later bounded inventory found 31 handled endpoints among the first 100. The selected Primary Endpoint persisted as handled with one proven `handles` edge to controller `node_bbbe...`.

**Verdict:** PASS.

### Q13 — Endpoint-to-boundary flow

| Hop | Evidence classification |
| --- | --- |
| gRPC endpoint `node_16cb...` | direct declaration/root |
| controller `node_bbbe...` | direct, proven `handles`, confidence 1 |
| service `node_8562...` | direct, proven `calls`, confidence 1 |
| repository methods `findActiveById`, `startRetryWorkflow`, `updateStatusById`, `abortFailedWorkflow` | direct graph calls, confidence 1; persistence boundary inferred from repository role/name, not a returned database edge |
| OSS `download` | direct graph call; outbound storage boundary inferred from indexed type/role |
| `createMissionSchedule` and `startSend` | visible in MCP-returned Primary Symbol source, but not surfaced as resolved symbol steps in the 50-step flow; unresolved as graph hops |

Flow returned 50/50 steps, `truncated=false`, but completeness `partial`, proof status `not_proven`, and coverage partial. A complete execution-to-database/outbound claim is therefore unsafe.

**Verdict:** PARTIAL but useful.

### Q14 — Coverage reconciliation and actionable debt

Two pages at limit 3 returned all six concrete exclusions, all `.pnpm-store/v3/files/...` paths rejected because a NUL byte was detected. Aggregate: discovered 12,466; admitted 12,460; excluded 6; failed 0; stale 0; unresolved references 70. Pagination was exact and non-overlapping.

The six exclusions look deliberate binary/content exclusions, not parser failures. However unresolved-reference reconciliation was explicitly `status=unavailable`, `itemCount=0`, `aggregateUnresolved=70`, `delta=null`; there were no concrete unresolved items. Gaps were `coverage_debt_requires_remediation` and `unresolved_reference_coverage_unavailable`.

Search suggested `knowledge_coverage` followed by owner-only refresh with `knowledge_index`. The capability manifest claims `knowledge.index` is implemented on MCP and confirmation-required, but no `knowledge_index` tool was loaded in this process. The coverage result itself offered no callable remediation. A first-time consumer can inspect debt but cannot complete the remediation from the loaded MCP surface.

**Verdict:** PARTIAL.

### Q15 — Revision and freshness truth

Primary inventory/status/coverage/search agree: indexed/head commit `5b006b...`, branch `brazil-v2`, clean worktree, no stale files, exact commit/worktree trust, last indexed `2026-08-30T20:27:20.681Z`. Elsewhere, status correctly distinguished `behind`, `branch_not_indexed`, and `worktree_dirty` repos.

**Strongest safe negative conclusion:** within the admitted, fresh Primary snapshot, no returned evidence proves a fact absent. Six excluded binary-like files, 70 unresolved references, lower-bound graph modeling, and truncation on some queries prevent corpus-wide absence claims even though the revision itself is trusted.

**Verdict:** PASS.

### Q16 — Cursor error taxonomy

| Cursor family | Scope/identity | Initial cursor | Continuation(s) | Overlap/drift | Negative test | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| Search | exact Primary query/snapshot | signed search cursor, limit 2 | next page produced hit IDs `52c4...`, `8934...` | none observed | tamper → `CURSOR_INVALID` with restart-search remediation | PASS |
| Context | Primary node/branch | signed context cursor offset 2 | offsets 4 and 6 | repeated importers and repeated relation nodes | wrong-family not needed to establish observed failure | FAIL |
| Affected | same Primary file/node | no cursor emitted; schema has no cursor | impossible | N/A | manifest/schema conflict | BLOCKED |
| Endpoints | Primary repo/snapshot | signed endpoint cursor, limit 2/3 | valid pages continued cleanly | none observed | search cursor → `CURSOR_OPERATION_MISMATCH` | PASS |
| Service graph | Primary with neighbors | no cursor or limit schema | impossible | N/A | manifest/schema conflict | BLOCKED |

Wrong-family and tampered cursors were distinct: `CURSOR_OPERATION_MISMATCH` versus `CURSOR_INVALID`. Tampered search included MCP-native remediation; wrong-family endpoint message was truthful but had no remediation field.

**Verdict:** PARTIAL; taxonomy passes, family coverage does not.

### Q17 — Compact response truthfulness

Endpoint normal and compact returned the same five IDs/titles, candidate 134, returned 5, and same continuation identity. Compact stats: raw 8,594 bytes, sent 6,549, ratio 0.762 (arithmetically plausible). Normal endpoint output had no stats, contrary to the requested comparison contract.

Dead-code normal/compact returned the same five IDs (`walk`, `add`, `main`, `BiPopularityModule`, `BiPopularityService`), candidate 3,241, returned 5. Compact: raw 4,428, sent 2,949, ratio 0.666. “Normal” unexpectedly also carried stats raw 4,428, sent 4,515, ratio 1.02; arithmetic is plausible but it expanded rather than compressed.

Compact never turned non-zero counts into zero and preserved canonical items.

**Verdict:** PARTIAL.

### Q18 — Bounded responsiveness under mixed calls

| Call family | Duration | Complete/truncated | Cursor/warning | Responsiveness verdict |
| --- | ---: | --- | --- | --- |
| exact search | 1,211.636 ms | truncated by limit | cursor; coverage warning | PASS |
| semantic status 1–4 | 446.378 / 117.971 / 109.220 / 111.161 ms | complete | none | PASS |
| context | 286.203 ms | calls truncated | cursor | fast but semantically FAIL |
| flow | 1,977.397 ms | 50/50, not truncated, partial proof | no cursor | PASS |
| affected | 104.382 ms | 56/56 lower bound | no cursor | PASS |
| service graph | 127.045 ms | 72/72 lower bound | aggregated gap | PASS |
| earlier lexical mode | 30,000 ms hard timeout | `QUERY_TIMEOUT` | no useful result | FAIL_BOUND |

Graph/lexical exact operations remained responsive while semantic status was interleaved; no graph call waited for embeddings. One lexical-description call hit the exact hard timeout and therefore failed the bounded budget.

**Verdict:** PARTIAL.

### Q19 — Scope and negative-boundary matrix

| Negative case | Expected boundary | Actual code | MCP-native remediation | Verdict |
| --- | --- | --- | --- | --- |
| Same exact query, Primary | only Primary hits | MATCH; all `repo_e555...` | coverage next action | PASS, no leakage |
| Same exact query, Secondary | only Secondary hits | MATCH; all `repo_a48...` | coverage next action | PASS, no leakage |
| Unknown repo | repository boundary | `REPOSITORY_NOT_FOUND` | call detailed index status and choose indexed repo | PASS |
| Missing branch in known repo | branch boundary | `BRANCH_NOT_FOUND` | call index status and use indexed branch | PASS |
| Unknown node | node boundary | `INVALID_TARGET` | none | PARTIAL |
| Search cursor used as endpoint cursor | family/operation boundary | `CURSOR_OPERATION_MISMATCH` | none | PASS_CODE / PARTIAL_UX |
| Tampered search cursor | integrity boundary | `CURSOR_INVALID` | restart pagination with same query/scope/mode/options/limit | PASS |

**Verdict:** PASS_WITH_REMEDIATION_GAPS.

### Q20 — Fresh-user onboarding and handoff

Onboarding used current nested search scope/options/page shapes and explicitly told MCP consumers they do not need shell/CLI. It referenced current wire names. Defects: its example `knowledge_semantic_status({"scopeKey":"FPMS-NT-User-Engagement"})` is not the emitted canonical scope key (`repo:repo_e555...`) and returned no statuses when tried canonically by repo name; it also recommends alias names rather than consistently using canonical capability IDs. Owner-only CLI examples are clearly segregated and not prerequisites.

**Agent A handoff (MCP-emitted only):** repo `repo_e555...`; snapshot `snapshot_8de...`; endpoint IDs `node_f7c...`, `node_0bb...`; emitted signed endpoint cursor; caveats coverage partial (12,460/12,466, six excluded, 70 unresolved), `endpoint_coverage_incomplete`. Agent B first tried cursor alone and truthfully received `CURSOR_SCOPE_MISMATCH`. Using only the handoff's emitted repo ID, snapshot ID, cursor, and limit (no rediscovery), Agent B resumed successfully and received `node_368...`, `node_09a...` plus a new cursor in 42.172 ms.

**Verdict:** PARTIAL_PASS.

## Coverage table

| Coverage dimension | Aggregate | Concrete evidence | Reconciliation/limit | Safe conclusion |
| --- | ---: | --- | --- | --- |
| Discovered | 12,466 | aggregate only | exact revision | corpus discovery count |
| Admitted/indexed | 12,460 | architecture has 1,439 code-index file nodes; coverage aggregate counts broader admitted files | not a one-to-one file-node count | useful admitted graph/source scope |
| Excluded | 6 | six `.pnpm-store` binary/NUL paths across two pages | exact total | deliberate content exclusion likely |
| Failed | 0 | no failed items | exact total | no recorded parser failures in Primary snapshot |
| Stale | 0 | freshness clean/exact commit | exact total | no recorded stale Primary file |
| Unresolved references | 70 | no items | reconciliation unavailable, itemCount 0, delta null | lower-bound graph; cannot claim absence/completeness |

## Bonus B1–B8

### B1 — Cross-service relationship

Service graph has proven, parser-extracted, confidence-1 `invokes` edges in both directions between FPMS-NT and FPMS-NT-User-Engagement. Provenance is `libs/tools/src/client-grpc/user-engagement-client-grpc/user-engagement-campaign-client-grpc.ts` for FPMS-NT → User Engagement and `src/libs/tools/src/client-grpc/admin-client-grpc.ts` for the reverse. This proves indexed invocation references, not runtime traffic, ownership, or operational dependency.

### B2 — Minimal safe-change plan

1. Treat all 37 symbols in `backend-app-push.service.ts` as atomically changed; do not scope only to `retryAppPushMission`.
2. Validate the proven controller/endpoint and the 19 impacted symbols/17 routes, especially retry, cancel/resume/pause, scheduled execution, and workflow paths.
3. Exercise repository boundaries `findActiveById`, `startRetryWorkflow`, `updateStatusById`, `abortFailedWorkflow`, and outbound OSS/Temporal/push-campaign behavior.
4. Add or locate explicit tests: MCP returned no test edge for this file, so test coverage is unproven.
5. Recheck six exclusions and 70 unresolved references before asserting the blast radius is complete.

Proven radius is the file-atomic changed/impacted/route set. Dynamic dispatch, unresolved references, external behavior, and missing test edges are lower-bound risk.

### B3 — Retrieval disagreement

Exact `redeemPhysicalGift` prioritizes verified controller `node_f44...` and processor `node_10a...`. The first paraphrase's semantic top hit was `post-win-share.service.ts`, and the second prioritized `winsday-push.service.ts`; only the third ranked the physical-gift processor first. Exact/path/graph evidence governs factual identity and execution claims; semantic ranking remains useful for discovering neighboring reward concepts.

### B4 — Implemented versus declaration-only endpoint

Implemented Primary endpoint has handled status, a proven handler, controller → service → repository/outbound graph steps, and partial execution evidence. Declaration/consumer-only `gRPC CMS.BackendService.AssignTicketEvent` has incomplete handler status and flow returned only the root (one step), partial/not-proven. Missing handler is explicitly not proof of absence because generated wiring/coverage can be incomplete.

### B5 — Historical generation hygiene

PASS. Replaced generations are superseded, not active or stalled; old expected counts do not become pending current work. All historical pending/running/failure counters are zero.

### B6 — Pause/resume discoverability without mutation

Control capability is discoverable, mutating, and confirmation-required. Pause/resume require scope key and forbid generation ID; retry/cancel require generation ID. No control was invoked. Current active generation is complete with no lease/work/failures, so Pause, Resume, Retry, and Cancel are not currently justified. Inference: Pause is for running/pending work, Resume for paused work, Retry for retryable failure, Cancel for an active/staging generation; exact state-transition rules were not emitted and remain **UNPROVEN**.

### B7 — MCP-only remediation quality

Unknown repo, missing branch, and tampered cursor each returned actionable MCP-native remediation. Wrong-family cursor and unknown node returned correct codes but no remediation. Coverage exposes debt but not a callable loaded fix; manifest/loaded-tool disagreement around `knowledge_index` weakens first-time usability. **Score: 3/5 useful remediations.**

### B8 — Readiness verdict

| Surface | Verdict |
| --- | --- |
| Exact/graph investigation | CONDITIONAL GO — strong exact identities, flow, affected; lower-bound caveats required |
| Semantic discovery | CONDITIONAL GO for FPMS-NT only — complete compatible generation, honest weak-similarity warnings |
| Runtime reliability | GO for bounded common calls; lexical hard-timeout case remains |
| Coverage completeness | NO-GO for completeness/negative proof; unresolved reconciliation unavailable |
| Continuation/identity stability | NO-GO because context continuation violates hard gate; endpoint/search identity are good |
| Owner-only Tauri UX | N/A_OWNER_EVIDENCE_NOT_SUPPLIED |

Strongest safe use: scoped exact/graph investigation and candidate discovery with explicit lower-bound caveats. Strongest unsafe claim: that a context page sequence is exhaustive/non-overlapping, or that missing graph/test/endpoint evidence proves absence.

## Owner-only Tauri evidence

| Owner Tauri item | Current owner evidence | Result | Included in MCP score? |
| --- | --- | --- | --- |
| Wiki opens on Graph; Focus absent | none supplied | N/A_OWNER_EVIDENCE_NOT_SUPPLIED | No |
| Semantic state/counters visible | none supplied | N/A_OWNER_EVIDENCE_NOT_SUPPLIED | No |
| Controls shown only when valid | none supplied | N/A_OWNER_EVIDENCE_NOT_SUPPLIED | No |
| Reopen does not cancel durable work | none supplied | N/A_OWNER_EVIDENCE_NOT_SUPPLIED | No |
| Storage/Graph responsive while polling | none supplied | N/A_OWNER_EVIDENCE_NOT_SUPPLIED | No |
| Installed app/runtime build matches MCP | none supplied | N/A_OWNER_EVIDENCE_NOT_SUPPLIED | No |

## Hard-gate audit

| Hard gate | Result | Evidence |
| --- | --- | --- |
| MCP loaded in fresh process | PASS | fresh session/connection; health OK |
| Runtime identity consistent; no restart | PASS | running=available, schema/contract/hash agree |
| Semantic application requires complete compatible active generation | PASS | applied only on FPMS-NT 45,007/45,007 active generation |
| Repeated semantic counts/status consistent | PASS | identical reads >5 s apart |
| Fresh node/endpoint round-trip | PASS | Primary node and endpoint identities persisted |
| Context/endpoint/search/affected continuation | **FAIL** | context overlaps/repeats and ignores page limit; affected cursor blocked |
| Wrong-family vs tampered cursor distinct | PASS | operation mismatch vs invalid |
| File-atomic affected contract | PASS | file/node sets identical; 37 siblings included |
| Graph/lexical independent of semantic | PASS_WITH_TIMEOUT_DEFECT | mixed graph calls fast; one lexical description hit 30 s hard timeout |
| Coverage honesty | PARTIAL | partial/lower-bound labels honest; unresolved reconciliation unavailable |
| Negative conclusions honor gaps | PASS in this report | exclusions/unresolved/truncation/revision caveats retained |
| MCP-native remediation | PARTIAL/FAIL_UX | several good remedies; coverage/index loaded-tool gap and missing node/family remedies |
| Forbidden fallback used | PASS | none used |

Because context continuation violates a listed hard gate, a 95–100 score is impossible regardless of other strengths.

## Score

| Category | Score | Rationale |
| --- | ---: | --- |
| Fresh runtime/MCP identity and reliability | 9/10 | consistent session/build/contract; no PID-level MCP attestation |
| Discoverability, schemas, annotations, onboarding | 6/10 | good manifest and nested schemas; cursor claims contradict MCP schemas; onboarding semantic scope example is wrong |
| Exact/lexical/graph/context/flow usefulness | 14/20 | exact, node, affected, and flow useful; lexical recovery failed and context continuation is broken |
| Semantic readiness, recall honesty, lifecycle | 17/20 | one complete compatible generation and honest warnings; scope limited, ranking variable, tokenizer/revision absent |
| Stable identity, affected parity, pagination/cursors | 11/20 | stable identity, atomic parity, endpoint/search pagination pass; context hard fail; affected/service pagination blocked |
| Scope, freshness, coverage, negative-proof honesty | 13/15 | strong scope/freshness and typed negatives; unresolved reconciliation/remediation gaps |
| Compactness and responsiveness | 4/5 | compact preserves truth and mixed calls are fast; normal stats inconsistent and one lexical timeout |
| **Total** | **74/100** | **NO-GO** |

## Top remaining defects by user impact

1. **Context continuation is not a true page:** repeated importers/relations, duplicate items, and returned counts exceed the requested limit. This is the release-blocking hard-gate defect.
2. **Capability/schema cursor contradiction:** manifest advertises cursor support for affected/service/flow/architecture/onboarding/get-node surfaces that cannot accept cursors through the loaded MCP schemas.
3. **Natural lexical retrieval is unreliable:** one query timed out at 30 seconds; a bounded fallback ranked unrelated workflow bytes over the target symbol.
4. **Coverage cannot reconcile 70 unresolved references to concrete items or a delta**, and loaded MCP remediation is incomplete.
5. **Onboarding emits a noncanonical semantic `scopeKey` example** and mixes canonical IDs with aliases.
6. **Compact metrics are asymmetric:** normal endpoint has no byte stats; normal dead-code response reports expansion ratio 1.02.
7. **Flow omits some source-visible external awaits as resolved graph hops**, so downstream-boundary claims remain partial.

## Final verdict

**NO-GO.** Exact/graph and FPMS-NT semantic discovery can be used conditionally today, but Round 24 program closure remains open until context pagination is non-overlapping and limit-truthful, advertised cursor contracts match loaded MCP schemas, and coverage/remediation/onboarding defects are corrected and re-evaluated in another fresh process.
