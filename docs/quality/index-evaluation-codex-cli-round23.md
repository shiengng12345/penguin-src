# Penguin Knowledge Round 23 — Independent Codex CLI Evaluation

## Evaluation statement

- Evaluator/model: independent Codex CLI evaluator, OpenAI GPT-5 family.
- Evaluation date: 2026-09-01 Asia/Kuala_Lumpur.
- Fresh-process statement: this evaluation used the fresh Penguin MCP session emitted in this process. I read only `index-evaluation-brief-round23.md`; I did not read source, Git, SQLite, CLI output, plans, snapshots, bundles, old reports, or another evaluator's report.
- Product evidence boundary: every product fact below came from Penguin MCP. No Penguin state, source, index, configuration, semantic queue, notes, or application state was mutated.
- Overall score: **75/100**.
- Final verdict: **CONDITIONAL GO** for bounded exact/lexical/graph investigation; **not complete for Round 23 program closure**.

## 1. Bootstrap and dynamic targets

### Runtime evidence

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| MCP initialize/session | Session `d40378de-d88e-4701-8884-29bfb114992d`; connected `2026-08-31T17:11:47.719Z`; build `1.16.0-7fd7fc227ab7c1c6`; schema 18; contract 2; hash `e38ea18f3da0cd3a3f68941a8c8adc2e13bc76d8fa898461160fa847d56365fb` | Yes | `initializeHealthy=true` | Yes; real scoped query succeeded | No | PASS |
| Launcher/runtime | Running and available build both `1.16.0-7fd7fc227ab7c1c6`; `launcherHealthy=true`; `runtimeOutdated=false` | Yes | Yes | Graph/lexical queries usable | No (`clientRestartRequired=false`) | PASS |
| Native semantic runtime | sqlite-vec, ONNX runtime, model manifest/model/tokenizer all reported `ready` | Yes | Native dependencies loaded | Useful only where an active compatible generation exists | No | PARTIAL |
| Repo A semantic space | Scope `repo:repo_e55541f5-455e-4c3d-b2b6-7296ec7b5ecc` returned no semantic status rows | N/A | No active generation | Graph/lexical useful; semantic mode returned `MODE_UNAVAILABLE/no_active_space` | No | PARTIAL |
| Repo B semantic space | Active generation `generation_5c026dc4ef2ab3a3c43641d4ee1c1cea37e9c81c37ac440f`; snapshot `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55`; nomic-embed-text-v1.5; model hash `00646f...32c`; 768 dimensions; chunker `semantic-chunker-v6-precision`; 45,007/45,007 ready | N/A | Yes | Pure semantic queries usable | No | PASS |

Observed fact: health, capability discovery, and a real search all agreed on schema 18, contract 2, capability hash, build, and session identity. Inference: the MCP process is current and does not need a client restart.

### Selected targets

| Target | Fresh MCP identity | Discovery |
| --- | --- | --- |
| Repo A | `FPMS-NT-User-Engagement`; `repo_e55541f5-455e-4c3d-b2b6-7296ec7b5ecc`; branch `branch_d8f61a1d-63e1-48f5-b2b3-7010cb571ee2`; snapshot `snapshot_8de6d493-ba55-4d3f-948a-67c459133ae9`; commit `5b006b...af` | Coverage reported the largest admitted count, 12,460, and architecture reported useful graph coverage: 4,752 symbols, 2,984 calls, 134 endpoints. |
| Repo B | `FPMS-NT`; `repo_a48ec7fb-5987-47df-9198-06969359cb50`; branch `branch_1d21f868-3252-4b74-8289-8f7c4735247f`; snapshot `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55`; commit `3f0f19...908` | Index status, architecture, and active semantic status. |
| Concept A | VIP customers likely to disengage / retention risk | Selected in Repo B because wording differs from `vip-cohort` and `retention-risk`, and Repo B had the only complete active semantic generation. |
| Symbol A | `RgMarketingGateClientGrpc`; `node_84ce25a8-c7b9-4ee2-afa6-0eba263e7dd9`; identity `repo_e55541f5-455e-4c3d-b2b6-7296ec7b5ecc::src/modules/rg-marketing-gate/services/rg-marketing-gate-client.service.ts::RgMarketingGateClientGrpc` | Exact search in Repo A. |
| File A | `src/modules/rg-marketing-gate/services/rg-marketing-gate-client.service.ts` | Symbol A locator. |
| Endpoint A | `gRPC userEngagement.BackendAppPushService.CreateAppPushMission`; `node_c4863db9-10bc-41b9-8000-473d85a1fc96`; identity `grpc::userEngagement.BackendAppPushService.createapppushmission` | Repo A endpoint inventory; `handlerStatus=handled`. |
| Service A | `service:repo_e55541f5-455e-4c3d-b2b6-7296ec7b5ecc` | Service graph. |
| Service B | `service:repo_ac05b4a1-d936-46e7-9c0b-89b413d4ccad` (Risk Control) | Service graph emitted a proven `invokes` edge from Service A. |

## 2. Q1–Q20

### Q1 — Fresh-process identity chain

PASS. Session, build, available build, schema, contract, and capability hash were mutually consistent across tool registration metadata, health, capabilities, and search diagnostics. `generation.runningBuildId` equalled `generation.availableBuildId`, `outdated=false`, and `clientRestartRequired=false`; no restart is required.

### Q2 — Discoverability and annotation audit

The correct MCP-native capabilities are `knowledge.search`, `knowledge.context`, `knowledge.flow`, `knowledge.affected`, `knowledge.coverage`, `knowledge.semantic_status`, `knowledge.semantic_control`, `knowledge.endpoints`, `knowledge.service_graph`, and `knowledge.onboarding.generate`. The corresponding callable exports were discoverable. The manifest marked every investigative operation above as `mutating=false` and `confirmation=not_required`; only `knowledge.semantic_control` was `mutating=true` and `confirmation=required`.

All 101 compact registration rows reported `implemented`; no duplicate canonical capability ID was observed. PARTIAL discoverability: several exported names differ from canonical IDs (`get_architecture` versus `knowledge.architecture`, `find_dead_code` versus `knowledge.dead_code`, `get_node` versus `knowledge.get_node`). More importantly, the manifest says context supports cursors, but the exported context schema has no cursor parameter and a truncated context returned no cursor.

### Q3 — Architecture count reconciliation

Aggregate architecture returned 20 repository items, matching its 20-repository headline. It reported 1,846 `service` nodes and 1,531 `endpoint` nodes. The aggregated service graph returned 20 boundary nodes and 87 relationship edges, with `candidateCount=returnedCount=87`, `truncated=false`, and no cursor. These are different units: service-symbol nodes versus repository/service boundaries. The 30 architecture entry-point strings are a bounded display, not the 1,531 endpoint total. Aggregate service evidence was explicitly `lower_bound`, freshness `unknown`, with `service_graph_is_aggregated` and unavailable revision provenance.

### Q4 — Exact and lexical target recovery

Exact search for `RgMarketingGateClientGrpc` in Repo A produced 13 candidates, returned 8, and was truncated; the class hit carried node `node_84ce...7dd9`, verified graph provenance, exact rank reasons, and the stable File A locator. Lexical search for `responsible gaming promotional message suppression` returned 8 of 5,136 candidates in 24.69 seconds; its top results were repeated source occurrences in the specification file rather than the class node. The difference is explained by lexical token coverage and occurrence-level ranking, not by missing code. Exact identity is the safer factual anchor.

### Q5 — Paraphrased semantic consistency

Scope and limit were fixed to Repo B / `brazil-v2`, limit 8.

| Semantic run | Root hits | Evidence count | Query status | Semantic applied/generation | Top stable identities | Warnings | Timing |
| --- | ---: | ---: | --- | --- | --- | --- | ---: |
| “identify VIP customers likely to stop playing” | 8 | 8 | MATCH | Yes / `generation_5c026d...440f`; 45,007/45,007 | `vector_8016a5d1449ddc44`, `vector_ef1fbfdd6877a6c1`, `vector_11cccf0c7f75e210` | Coverage incomplete | 3,953 ms MCP |
| “estimate churn danger for valuable players” | 8 | 8 | MATCH | Yes / same generation | `vector_18b3a3bca622c4f0`, `vector_fd457ba79d73b2b3`, `vector_43e17db1681ea563` | Coverage incomplete; best similarity 0.1795 below 0.20 | 881 ms MCP |
| “find high value users at risk of disengagement” | 8 | 8 | MATCH | Yes / same generation | `vector_0c83355a7000a036`, `vector_6e396f39d8b77d3a`, `vector_a2fb6bfff72798bf` | Coverage incomplete; best similarity below 0.20 | 791 ms MCP |
| Hybrid “detect VIP player retention risk” | 8 | 8 | MATCH | **No**; reason `async_semantic_lane_required`; source/symbol only | `hit_ba9257006e35f46fa15d0144`, `hit_b114e39856c3dc0cf0c519f7`, `hit_1683f602581a15c5893f17ad` | Coverage incomplete; semantic lane unavailable | 3,153 ms MCP |

Counts and status were internally consistent. PARTIAL consistency: the three semantic paraphrases shared no top-five identity, and two runs were explicitly low-similarity. The returned `vector_*` identities are generation-scoped retrieval identities, not proven graph node identities.

### Q6 — Hybrid ranking honesty

PARTIAL. The hybrid request did not actually use vector similarity even though the scope had a complete active generation: `semantic.applied=false`, `reason=async_semantic_lane_required`, lanes `source,symbol`. Therefore no hybrid vector widening can be credited. Pure semantic results demonstrate wider recall, but their own rank reasons correctly say they are recall candidates and that exact/source lanes retain truth precedence. Similarity cannot prove execution, ownership, DI/runtime wiring, or production behavior.

### Q7 — Semantic readiness and failure truth

Repo B is semantically ready: active generation, compatible current model metadata, 45,007 expected and ready, zero running/pending/retryable/terminal failures, and 100% progress. Repo A is not semantically ready: scoped status returned no rows and semantic queries returned typed `MODE_UNAVAILABLE` with `reason=no_active_space`, zero hits, `NO_MATCH_INCOMPLETE`, and `semantic.applied=false`. Exact and lexical searches in Repo A still worked. No semantic-answer credit is assigned to Repo A.

### Q8 — Stable node round-trip

PASS identity, PARTIAL usefulness. Search, `get_node`, context, and affected all preserved `node_84ce...7dd9`, Repo A, branch `branch_d8f6...1ee2`, File A, class kind, snapshot, and canonical identity. No identity drift was observed. However, node-based affected analysis returned no impacted nodes or tests, while file-based affected found both; this is an analysis-parity defect, not identity drift.

### Q9 — Endpoint inventory pagination

PASS. Initial page returned 5 of exact total 134, remaining 129; continuation returned the next 5, remaining 124. There was no node/identity overlap, cursor repetition, omission detectable at the boundary, or scope drift. Both pages retained Repo A, branch, snapshot, and endpoint identities. `returnedCount` equalled page length and was not confused with total count.

### Q10 — Endpoint-to-boundary flow

Endpoint A produced 60 steps: 41 execution and 19 reference steps, not truncated. Direct, proven extracted hops included endpoint → controller `createAppPushMission` → service `createAppPushMission` → repository `insertMission` → base repository `create`. Additional direct outbound/storage candidates included OSS `copy/download/exists`; repository execution-record writes were also present. The MCP result did not label a datastore technology boundary, so “persistence occurs” is supported by repository/create edges, while the concrete database technology remains UNPROVEN. Overall flow was correctly marked `partial/not_proven` because coverage is incomplete.

### Q11 — Affected file/node parity

FAIL parity. File A analysis returned six changed symbols, two impacted symbols (`makeService` and provider `check`), three proven impact edges, and the specification file; 8/8 candidates were returned. Node analysis for Symbol A returned only the class itself, zero impacted nodes, zero tests, and `coverageGaps=[unresolved_reference_counts_not_persisted]`; 1/1 was returned. The legitimate scope difference is class-only versus all symbols in the file, but total loss of the provider call and test makes stable node affected analysis materially weaker.

### Q12 — Context usefulness and counters

Compact context for Symbol A returned one definition/focus, zero callers, zero callees, one `referencedBy`, one `usesTypes`, three importers, one external call, zero routes, and zero tests. Evidence reported 6 candidates/6 returned, reconciling the six relation items. No truncation cursor was present. PARTIAL: the context’s zero tests contradicts file-based affected evidence that identifies `rg-marketing-gate-client.service.spec.ts`; also `firstHopRelations=[]` despite the separately populated relation families. Zero must not be interpreted as proof of no tests.

### Q13 — Coverage debt actionability

| Coverage dimension | Count/status | Concrete evidence | Limitation | Safe conclusion |
| --- | --- | --- | --- | --- |
| Discovered/admitted | 12,466 / 12,460 | Repo A exact snapshot | “Admitted” includes a repository with `.pnpm-store` paths in coverage accounting | Most files admitted; not proof all are useful source |
| Excluded | 6 | Three examples were `.pnpm-store/v3/files/...` binaries with NUL bytes | Page returned 3/6 | Known excluded debt remains |
| Failed | 0 | `kind=failed` returned exact zero | Aggregate coverage still partial | No recorded failed file in this snapshot |
| Stale | 0 | Fresh aligned commit and `kind=stale` exact zero | Does not resolve exclusions/unresolved references | No recorded stale item in Repo A |
| Unresolved | **70 versus 32,556** | Coverage summary said 70; reconciliation said aggregate 32,556; search/context used 32,556 | `kind=unresolved` returned zero items and reconciliation mismatch delta -32,556 | Count is contradictory; negative proof is unsafe |
| Next action | MCP-native | Search suggested `knowledge_coverage({"repo":"<repo>","kind":"failed"})` | No actionable unresolved examples were returned | Failed/excluded debt inspectable; unresolved debt is not actionable |

### Q14 — Freshness and revision truth

Repo A was aligned and clean: indexed commit equalled head commit `5b006b...af`, dirty file count 0, freshness `fresh`, snapshot stable, and search warnings contained coverage warnings but no stale warning. This is distinct from aggregate status, which reported 18 fresh and 2 stale repositories. Repo A is fresh but coverage-incomplete; “fresh” does not mean “complete.”

### Q15 — Semantic lifecycle integrity

Two aggregate status reads 5,797 ms apart were identical. One active Repo B generation stayed complete at 45,007/45,007 with no work, lease, worker, heartbeat, rate, or ETA. Three older Repo B generations were `superseded` with `SEMANTIC_CHUNK_SET_REPLACED`; legacy v16 was also superseded and explicitly ineligible. No replaced generation was falsely active or stalled.

### Q16 — Graph-first responsiveness

| Operation | MCP/observed timing | Result |
| --- | ---: | --- |
| Bounded exact search | 2,148 ms MCP / 2,307 ms observed | MATCH, truncated with cursor |
| Context | 146 ms MCP / 220 ms observed | Partial, not truncated for Symbol A |
| Flow | 746 ms observed in bounded sequence; later 1,139 ms MCP | 60 steps, partial, not truncated |
| Affected | 313 ms file; 378 ms node | Returned, but parity defect |
| Scoped service graph | 109 ms MCP | 72 relationships, lower bound |
| Scoped semantic status | 111 ms MCP / 197 ms observed | Empty for Repo A, truthful |

Graph/lexical remained available while Repo A semantic was unavailable. PARTIAL responsiveness: two earlier lexical paraphrases hit the 30-second hard timeout, and a Repo A hybrid request also timed out.

### Q17 — Three-family continuation handoff

| Cursor family | Initial scope/identity | Cursor emitted | Continuation result | Overlap/drift | Verdict |
| --- | --- | --- | --- | --- | --- |
| Search | Repo A snapshot `snapshot_8de6...3ae9`; exact `RgMarketingGateClientGrpc`; first hits `hit_42b6...`, `hit_81e6...` | `eyJzY2hlbWFWZXJzaW9uIjoiMSIsInF1ZXJ5SGFzaCI6IjBkODAzNjRiNzEwNTQ0NjE0NzA3M2Y4YzdlYzY1M2U5Y2NhZmM5ZDIxODE5OWYyYWE1YTIwYzhjNjM1OGJmZWUiLCJub3JtYWxpemVkUmVxdWVzdEhhc2giOiJkZDI4NDc1NDhlMjliYzM2MjQwNDc4ODM1OGU5ZmY3NmU0NTZkZDZkNTJmYTFiNzFhZmRmZjg3MTc1YmNjMjFlIiwic2NvcGVIYXNoIjoiYTQ0MzI0YmNiOTk4MDU3M2M2MmMwMTM2N2NiZjI4NDA5ZTkwNWRhMTM1ZTAzNWM4MWZhOTNhOGRmZDMyMjVjZiIsIm1vZGUiOiJleGFjdCIsImxhbmVzIjpbInNvdXJjZSIsInN5bWJvbCJdLCJsYXN0UmFuayI6MS4xLCJsYXN0SGl0SWQiOiJoaXRfODFlNmVmMTZhNzU3Y2E1NmQxMmZjZGU3IiwiY2FwYWJpbGl0eUhhc2giOiJlMzhlYTE4ZjNkYTBjZDNhM2Y2ODk0MWE4YzhhZGMyZTEzYmM3NmQ4ZmE4OTg0NjExNjBmYTg0N2Q1NjM2NWZiIiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0zMVQxNzozMzo1My40NjVaIn0.ptLkbtgbom8da4iYUOTpZI4eUqW3VFdr528FCmPMl_A` | Later returned `hit_27f8...` and `hit_c363...` | None | PASS |
| Endpoint inventory | Repo A/branch/snapshot; first identities AssignTicketEvent, GetGameImageUrl, GetTicketEvent | `eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJlbmRwb2ludHMiLCJzY29wZSI6InJlcG9fZTU1NTQxZjUtNDU1ZS00YzNkLWIyYjYtNzI5NmVjN2I1ZWNjfGJyYW5jaF9kOGY2MWExZC02M2UxLTQ4ZjUtYjJiMy03MDEwY2I1NzFlZTJ8KnxpZGVudGl0eUtleSxub2RlSWQiLCJvcmRlcmluZ0tleSI6ImlkZW50aXR5S2V5LG5vZGVJZCIsImxhc3RLZXkiOiJncnBjOjpDTVMuQmFja2VuZFNlcnZpY2UuZ2V0dGlja2V0ZXZlbnRcdTAwMDBub2RlXzM2ODIyMThkLTZhY2EtNDQxYy04MmIyLWQxN2FmODA3OTBkMyIsInJldmlzaW9uIjoic25hcHNob3RfOGRlNmQ0OTMtYmE1NS00ZDNmLTk0OGEtNjdjNDU5MTMzYWU5IiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0zMVQxNzozMzo1My42NTRaIiwibGltaXQiOjN9.1XVPQEvKfe3O44c7_ilDQPtVi47dCVa8dPSeldmpsqI` | Later returned SetPopupWhiteList and two CMSInternal endpoints | None | PASS |
| Context/affected traversal | High-degree `BackendAppPushService.createAppPushMission`, `node_2b5144...`; 32/32 counters; `truncated=[calls]` | **None** | Cannot continue: exported context schema has no cursor input and response cursor was null | Continuation unavailable | FAIL |

Search and endpoint cursors were family-isolated in successful use. The third required family could not create resumable state.

### Q18 — Typed negative matrix

| Negative case | Expected boundary | Actual error code | MCP-native remediation | Verdict |
| --- | --- | --- | --- | --- |
| Unknown repository `round23-missing-repo-1788196704325` | Repository resolution | `REPOSITORY_NOT_FOUND` | Call `index_status({"mode":"detailed"})` and choose an indexed repo | PASS |
| Unavailable branch `round23-missing-branch-1788196704325` | Branch inside known Repo A | `BRANCH_NOT_FOUND` | Call `index_status` and choose an indexed branch | PASS |
| Unknown node `node_round23_missing_1788196704325` | Stable-node resolution | `INVALID_TARGET` | None emitted | PARTIAL |
| Search cursor supplied to endpoint family | Cursor family | `CURSOR_INVALID`, message “malformed cursor” | None emitted | FAIL: not family-specific |
| One-character-tampered endpoint cursor | Signature/integrity | `CURSOR_INVALID`, message “malformed cursor” | None emitted | FAIL: collapsed with wrong family |

The repository error did not collapse into a branch error. Cursor failures did collapse into the same code/message and did not provide remediation.

### Q19 — Compactness and duplication

Endpoint normal and compact pages contained the same five canonical endpoint items, identities, handlers, scope, totals, and cursor semantics. Compact omitted redundant mirrors and reported raw 8,600 bytes, sent 6,552 bytes, ratio 0.762. Dead-code normal and compact returned the same five node identities and the same 3,241-candidate meaning; compact was faster, but neither response exposed raw/sent-byte statistics. Therefore semantic meaning was preserved, but byte-stat honesty is only proven for endpoints, not dead code.

### Q20 — New-user onboarding

PASS with a minor caveat. Onboarding used current MCP capability IDs, canonical nested search `scope/options/page`, stable node handoff, and a real `page.cursor` continuation example. It explicitly said MCP users do not need shell/CLI, and placed CLI commands in an owner-only optional section. The semantic-status example used the repo name as `scopeKey`; a live call proved that name resolves to the canonical Repo A scope, so it is executable. The ordering and caveats were current.

## 3. Bonus engineering scenarios B1–B8

### B1 — Cross-service ownership decision

Proven: Service A invokes Service B. The edge is parser-extracted, confidence 1, with provenance File A, and Symbol A’s MCP source shows the Risk Control client and lifecycle-state call. UNPROVEN: Service A does not thereby own Service B, and no organizational ownership evidence was returned. Because the graph is a lower bound, other dependencies may exist.

### B2 — Safe-change proposal

Minimal safe plan for File A:

1. Treat `checkMarketingSuppression` and its error/closed-gate behavior as the focused behavior.
2. Preserve the proven provider `check` call and `onModuleInit` setup path.
3. Update/execute the discovered specification `rg-marketing-gate-client.service.spec.ts` for suppressed statuses and downstream failure behavior.
4. Re-check the Service A → Risk Control `invokes` boundary and any campaign-delivery caller before rollout.
5. Treat file-based impact (two impacted symbols) as the current proven lower bound; do not trust the node-based empty impact set.
6. Inspect unresolved-reference debt before making a negative blast-radius claim.

### B3 — Conflicting retrieval signals

Exact `retention-risk` recovery found the scheduler trigger controller and VIP cohort runner/constants. Semantic paraphrases emphasized different candidates: VIP cohort specs in one run, player-credibility/risk-gate files in another, and reward-grant files in the third. Exact path/source evidence should anchor factual claims about the retention-risk implementation. Semantic recall remains useful for discovering adjacent risk, reward, and cohort concepts, especially when explicitly low-similarity.

### B4 — Endpoint completeness audit

Implemented Endpoint A had `handlerStatus=handled`, a proven handler, 60 flow steps, and repository/OSS boundaries. Declaration-only `gRPC CMS.BackendService.AssignTicketEvent` had no handlers, `handlerStatus=incomplete`, and a one-step declaration-only flow marked `partial/not_proven`. The emitted reason explicitly said the handler was not proven absent because endpoint/generated wiring coverage may be incomplete. No complete implementation chain is claimed for it.

### B5 — Repository isolation

Exact Symbol A search in Repo A returned only Repo A IDs and snapshot. The same search in Repo B returned zero hits, Repo B’s own IDs/snapshot, `NO_MATCH`, and coverage warning; no Repo A endpoint, service, node, or identity leaked. A zero in Repo B is only absence in indexed coverage.

### B6 — Lower-bound negative conclusion

Claim chosen: “Symbol A has no tests.” This is disproven as a safe conclusion: context returned zero tests, but file-based affected returned a concrete specification. Therefore the context zero proves only that its test relation family did not return a link; it does not prove absence. More generally, 32,556 unresolved-reference evidence and partial coverage prevent repository-wide absence claims.

### B7 — Agent-A/Agent-B transfer simulation

Agent-A handoff contained only MCP-emitted Repo A repo/branch/snapshot, Symbol A node/identity/File A, Endpoint A node/identity, the exact search and endpoint cursors in Q17, and caveats (`coverage=partial`, semantic unavailable in Repo A, affected parity defect). Agent B resumed search and endpoint continuation without rediscovery and without scope drift. It also resolved Symbol A directly with `get_node`. Continuity score: **4/5**. Answer-quality score: **3/5**, reduced because context traversal could not be resumed and node-based impact was incomplete.

### B8 — Product readiness verdict

| Surface | Verdict | Strongest safe use | Strongest unsafe claim |
| --- | --- | --- | --- |
| Exact/graph investigation | GO with lower-bound caveat | Locate stable symbols/endpoints and trace proven extracted calls to repositories/outbound helpers | “This is the complete runtime execution path” |
| Semantic discovery | CONDITIONAL GO | Candidate discovery in Repo B’s complete generation | Semantic readiness across all repos or semantic rank as factual proof |
| MCP runtime reliability | CONDITIONAL GO | Fresh identity-consistent bounded graph calls | All paraphrased/hybrid searches are fast or vector-applied |
| Coverage completeness | NO-GO for negative proof | Inspect known exclusions/failures and fresh revision identity | Absence/completeness while unresolved counts contradict |
| Owner-only Tauri UX | N/A | None; no owner evidence in this process | Any Tauri readiness statement |

Strongest safe use case: bounded, revision-scoped exact/lexical lookup followed by stable-node context/flow and file-based affected analysis, with coverage caveats. Strongest unsafe claim: repository-wide absence, complete blast radius, or runtime ownership based only on partial static/semantic evidence.

## 4. Owner-only Tauri evidence lane

| Owner Tauri check | Owner evidence | Result | Included in MCP score? |
| --- | --- | --- | --- |
| Graph opens by default | None in fresh process | N/A | No |
| Focus tab absent | None | N/A | No |
| Background semantic state visible | None | N/A | No |
| UI state/counters match backend | None | N/A | No |
| Valid Pause/Resume/Retry/Cancel visibility | None | N/A | No |
| Pause/Resume cycle with natural work | None | N/A | No |
| Closing window does not claim cancellation | None | N/A | No |
| Storage/Graph responsive during polling | None | N/A | No |

## 5. Hard gates

| Hard gate | Outcome | Evidence |
| --- | --- | --- |
| Penguin MCP available in fresh session | PASS | Health, capabilities, and real queries succeeded |
| Running/available identity current and consistent | PASS | Same build; no restart/outdated state |
| Schema/contract/capability hash consistent | PASS | 18 / 2 / identical hash across surfaces |
| Semantic readiness claimed only for compatible complete active generation | PASS | Repo B 45,007/45,007; Repo A explicitly unavailable |
| Repeated semantic counts/status/warnings non-contradictory | PASS | Three pure semantic runs and two lifecycle reads internally consistent |
| Stable node/endpoint identity round-trip | PASS | Node and endpoint IDs survived required hops |
| Pagination does not repeat/skip/cross scope | PASS for search/endpoints | No overlap or scope drift in continued pages |
| Unknown repo/branch/node/cursor failures stay distinct and truthful | **FAIL** | Wrong-family and tampered cursors collapsed to identical `CURSOR_INVALID/malformed cursor` with no remediation |
| Graph/lexical available independent of semantic lifecycle | PASS | Repo A graph/lexical worked with no active semantic space |
| Negative conclusions respect exclusions/stale/unresolved/truncation | PASS for evaluator | All absence claims bounded; product unresolved evidence is contradictory |
| MCP remediation does not require unavailable CLI | PASS | Remediation and onboarding used MCP; CLI explicitly owner-optional |
| No forbidden fallback | PASS | MCP-only product evidence; only brief read and requested report write |

Additional required-scenario failure: context reported truncated calls but emitted no continuation cursor, so the required three-family handoff could not be completed.

## 6. Limitations and unproven claims

- Static graph evidence cannot prove runtime DI, configuration, ownership, live RPC execution, or production behavior.
- Repo A coverage is partial; excluded files and unresolved references remain.
- The unresolved-reference count is contradictory and its detail inventory is empty, so completeness and negative proof are UNPROVEN.
- No owner Tauri evidence was supplied; all Tauri checks are N/A and add no points.
- No source/Git/DB/CLI fallback was used, so any question not answerable through MCP remains PARTIAL, BLOCKED, or UNPROVEN.
- Pure semantic hits are recall candidates. Low-similarity results and paraphrase instability prevent semantic factual claims.

## 7. Top remaining defects by user impact

1. **Coverage reconciliation is contradictory and non-actionable:** Repo A reports 70 unresolved references in coverage, 32,556 in search/context and reconciliation, and zero `kind=unresolved` items.
2. **Required traversal continuation is broken:** context can report `truncated=[calls]` while returning `cursor=null`; exported schema has no cursor input despite capability metadata saying cursors are supported.
3. **Affected parity is materially inconsistent:** File A finds provider/test impact while the stable Symbol A node finds none.
4. **Cursor error typing collapses boundaries:** wrong-family and tampered cursors both return identical `CURSOR_INVALID/malformed cursor`, without MCP-native remediation.
5. **Hybrid semantic execution is unreliable:** vector application was skipped as `async_semantic_lane_required` even on a complete active generation; another hybrid query timed out.
6. **Retrieval responsiveness is uneven:** multiple lexical/hybrid queries reached the 30-second hard timeout.
7. **Compact byte statistics are incomplete:** endpoint stats are useful, but dead-code compact/normal responses expose no raw/sent-byte accounting.
8. **Context test counters can mislead:** zero tests contradicted a specification found by file-based affected analysis.

## 8. Scoring

| Category | Maximum | Score | Rationale |
| --- | ---: | ---: | --- |
| Runtime identity, fresh-session load and MCP reliability | 10 | 10 | Fresh identity chain, builds, contract, schema and hash consistent |
| Capability discovery, schemas, annotations and onboarding | 10 | 8 | Good manifest/onboarding; traversal cursor contract mismatch and alias naming friction |
| Exact/lexical/graph retrieval and execution tracing | 20 | 17 | Strong exact identity and endpoint flow; affected/context parity defects |
| Semantic readiness, consistency, ranking honesty and lifecycle | 20 | 14 | Complete active lifecycle and truthful pure semantic diagnostics; weak paraphrase overlap and hybrid not applied |
| Stable identities, pagination and multi-family continuation | 15 | 10 | Stable round-trips and two good cursor families; third family blocked and cursor errors collapse |
| Scope isolation, freshness, coverage and negative-proof honesty | 15 | 9 | Isolation/freshness strong; unresolved coverage contradiction is severe |
| Compactness, responsiveness and engineering usability | 10 | 7 | Endpoint compactness and graph latency good; timeouts and missing dead-code byte stats |
| **Total** | **100** | **75** | One explicit hard-gate failure; score cannot approach 95 |

## 9. Final verdict

**CONDITIONAL GO — 75/100.** Penguin Knowledge is useful today for bounded, scoped exact/lexical/graph engineering investigation, especially stable symbol lookup, endpoint inventory, and proven extracted flow edges. It is not ready for Round 23 program closure: the score is below 95, the cursor negative hard gate fails, the required third continuation family is blocked, and coverage reconciliation is too contradictory for dependable negative proof.
