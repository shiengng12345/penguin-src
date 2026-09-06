# Penguin Wiki / Knowledge Evaluation — Round 18 — Codex Agent A

Evaluation date: 2026-08-31, Asia/Kuala_Lumpur  
Evaluator: Codex Agent A; exact deployed model/version, evaluator PID, and MCP session identifier were not exposed by the client.

## 1. Compliance statement and fresh-session evidence

The evaluation brief was read completely. All repository findings and Round 18 evidence came only from the installed stable Penguin CLI and the live Penguin MCP tools. There were no project-source reads, grep/rg/filesystem searches, database inspections, Git calls, browser calls, old-report reads, remembered IDs, builds, index/rebuild/repair/config changes, knowledge writes, or other Penguin/project mutations. The only repository write is this report.

Transparency correction: after Agent A had completed Penguin evidence collection and created the report, Agent A read the external verification-before-completion SKILL.md solely to self-check the report. It was not project source, an old report, or evaluation evidence and did not affect any Penguin finding. It is nevertheless outside the strict literal Penguin-only allowed-read list in the brief. This run is therefore marked literal process non-compliant, and the brief’s no-95+ ceiling applies. The product and environment scores below are already below 95, so the ceiling does not change either numeric result. During this resumption, only the brief and this report were read, no Penguin call was rerun, and only this report was updated.

Every ID and cursor below was emitted in this Agent A process. No target from an older report was used. The current capability hash ends in hexadecimal 0, so:

- endpointSelectionIndex = 0 mod 5 = 0
- symbolSelectionIndex = 0 mod 3 = 0

Fresh-session evidence:

| Observation | Current evidence | Conclusion |
| --- | --- | --- |
| Agent A client/session | Fresh Codex exec process/conversation; session 01a054fe-d593-72b3-aa60-d7c8473c8cfb; exact model, PID, and process start timestamp not exposed | New conversation/process invocation proven by coordinator; missing values not invented |
| Agent B client/session | Separate fresh ephemeral Codex exec process/conversation; session 01a05515-bdb5-76d1-a562-e1811209e410; received only the bounded packet and no report/brief/source/memory; exact model, PID, and process start timestamp not exposed | Independent packet-only process invocation proven by coordinator |
| CLI discovery | PATH resolved Penguin to /Users/shieng/.local/bin/penguin; Penguin help supplied command spelling | Installed CLI observed |
| MCP initialization | mcp_health returned status ok and initializeHealthy true | This process has a working initialized MCP connection |
| MCP generation | runningBuildId and availableBuildId both 1.16.0-caf621d03b0402b6; outdated false | Current process uses the exposed current generation |
| MCP registry | 82 live mcp__penguin__ tools, no duplicate live tool names; capability manifest contains 99 implemented capability records | Live tools/list proxy observed |
| Two-session proof | Distinct coordinator session IDs above; Agent B repeated health, tools/capabilities, exact IDs/revision, cursor, edge, and structured error from only Agent A’s packet | FRESH SESSION: PROVEN |
| Residual identity limits | Exact models, process start timestamps, client PIDs, server PID/process identity, and raw initialize envelopes were not exposed | Evaluation date/timezone is recorded; unavailable fields remain not exposed and do not negate the distinct process/conversation proof |

Agent B explicitly made no whole-round completion claim. Its evidence is integrated only as the independent replay/continuity result.

## 2. Client/runtime/MCP/CLI preflight table

| Surface | Exact current call | Bounded observation | Status / elapsed |
| --- | --- | --- | --- |
| CLI discovery | rtk command -v penguin | /Users/shieng/.local/bin/penguin | exit 0 |
| CLI help | rtk proxy penguin help | Read-only discovery/search/graph/pagination/API commands were listed separately from init/index/rebuild/materialize/watch/remove/pin/master and write/suggestion operations | exit 0 |
| CLI capabilities | rtk proxy penguin capabilities --json | build 1.16.0-caf621d03b0402b6; schema 15; contract 2; hash 40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0 | exit 0; Q18 wrapper samples recorded below |
| MCP capabilities | mcp__penguin__knowledge_capabilities {"compact":true} | schema 15; contract 2; same hash; full manifest reported 99 implemented capability records | success |
| MCP health | mcp__penguin__mcp_health {} | status ok; initializeHealthy true; clientRestartRequired false; workers 2; hardTimeoutMs 30000; configured null; launcherHealthy null | success; final batch wall 4.5 s |
| MCP server generation | same health call | runningBuildId = availableBuildId = 1.16.0-caf621d03b0402b6; outdated false | success |
| MCP registry | live client tools/list proxy | 82 unique mcp__penguin__ tool names | success |
| Agent B independent baseline | separate session 01a05515-bdb5-76d1-a562-e1811209e410: mcp_health, tools/list proxy, capabilities | health ok; initializeHealthy true; clientRestartRequired false; runtimeOutdated false; 82 tools; 99 implemented manifest capabilities; same build/schema/contract/hash | success; per-call timing not supplied |
| Status | rtk proxy penguin status --json | 20 indexed repositories; 18 fresh and 2 stale; FPMS-NT is fresh | exit 0; 0.335 s |
| FPMS-NT coverage | rtk proxy penguin coverage FPMS-NT --json | discovered 3340; admitted 3333; excluded 7; failed 0; stale 0; unresolvedReferences 103958; completeness unknown; proofStatus not_proven | exit 0; 0.058 s |
| CLI doctor | rtk proxy penguin doctor --json | status ok; ledgerSeq/materializedSeq 12348/12348; nodes 748840; edges 1724945; pendingSuggestions 1 | exit 0; first 5.477 s |
| MCP doctor | mcp__penguin__knowledge_doctor {} | QUERY_TIMEOUT after the 30000 ms hard timeout; retryable false; no empty-success substitution | structured error |
| Onboarding | rtk proxy penguin onboarding FPMS-NT --json and mcp__penguin__knowledge_onboarding_generate | Safe order explicitly included Status, Coverage, Scoped Search, Explore, Affected, Source Review; lower_bound, partial, stale, and not_proven stop claims | CLI exit 0; 11.841 s |

Stable FPMS-NT scope used for all repository claims:

- repo: FPMS-NT
- repoId: repo_a48ec7fb-5987-47df-9198-06969359cb50
- branch: brazil-v2
- branchId: branch_1d21f868-3252-4b74-8289-8f7c4735247f
- commit: 3f0f1984b9e4337668529a13bad5264501729908
- snapshot/revision: snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3
- worktreeFingerprint: 073264f852ac84af18fb68cb22b56c5bdb3801e578c69510f638e13a0b0544c5
- freshness: fresh, exact_commit/exact_worktree, dirtyFileCount 0
- coverage: partial, 3340/3333/7/0/0 files and 103958 unresolved references

Required capability table:

| Capability | Advertised | Real call | CLI/MCP parity | Runtime status | Verdict |
| --- | --- | --- | --- | --- | --- |
| Discovery/status | yes | status and index_status succeeded | matching repository/revision state | available | PASS |
| Lexical search | yes | scoped CLI and MCP searches succeeded | stable IDs/scope; defaults/envelopes are not identical | available | PARTIAL |
| Context/flow graph | yes | selected node and endpoint calls succeeded in both sessions | endpoint/handler/first edge agree; Agent B adds a depth-5 async node beyond Agent A’s partial frontier | available with deeper-flow variance | PARTIAL |
| Endpoint pagination | yes | page 1, page 2, malformed/wrong-scope/final-page calls executed | Agent A cursor continued in Agent B without expiry or repair | available | PASS |
| File-symbol/dead-code pagination | yes | all Agent A pages plus Agent B fresh-process pages executed | Agent B proved fresh-process continuation using Agent-B-generated cursors, not Agent A’s two cursors | available with bounded handoff proof | PARTIAL |
| Affected analysis | yes | Agent A and Agent B CLI/MCP calls succeeded | Agent B CLI returned 29 lower-bound candidates while exact MCP file target returned only its file node and 0 impacted | available with material surface divergence | PARTIAL |
| Semantic/blend | manifest search schema advertises semantic and off/fallback/blend | semantic/blend returned semantic lane skipped: async_semantic_lane_required | both preserve unavailable warning rather than invent hits | unavailable | honesty PASS; power UNAVAILABLE |
| API documents | yes | list/show succeeded | CLI positional preview ID and MCP preview_id work; camelCase previewId produced INTERNAL/ENOENT | available but schema/alias defect | PARTIAL |
| Link listing | manifest advertises link.list | no current live knowledge_link_list MCP tool and no read-only CLI list command was exposed | not callable | unavailable | FAIL |
| Structured errors | yes | SCOPE_MISMATCH, TARGET_AMBIGUOUS, CURSOR_INVALID and others returned | core shapes agree; semantic unavailable is only a warning/success envelope | mixed | PARTIAL |

## 3. Product score /100 and environment score /100, including hard caps

### Product capability: 71/100 — CONDITIONAL

| Dimension | Score |
| --- | ---: |
| Discoverability/onboarding | 7/8 |
| Scoped search quality | 6/10 |
| Context and source-pack usefulness | 8/10 |
| Graph/flow/affected quality | 9/14 |
| Endpoint investigation | 9/10 |
| Cross-repo/service identity | 3/8 |
| Pagination and handoff | 9/10 |
| Accuracy and revision integrity | 7/8 |
| Completeness and honesty | 8/10 |
| Semantic/vector usefulness | 3/7 |
| Wiki/API provenance | 1/3 |
| Recovery and speed | 1/2 |
| Total | 71/100 |

Product hard cap: 79 because the emitted service-map stable ID repo_5513e90d-a231-455e-9feb-d15d69e93b38 did not round-trip through node, graph, or path. The literal process-compliance ceiling is also below 95. The raw score is already below both ceilings, so the final remains 71. The successful Agent A endpoint-cursor handoff earns one pagination point, offset by one point removed from graph/flow/affected for the Agent B same-target affected divergence and deeper-flow variance. No net capability inflation is applied.

### Environment readiness: 72/100 — DEGRADED

| Dimension | Score |
| --- | ---: |
| Installed stable launcher/runtime | 17/20 |
| MCP initialize/tools/health | 16/20 |
| CLI/MCP build/schema parity | 15/20 |
| Fresh two-session generation proof | 17/20 |
| Installed-runtime self-containment | 4/10 |
| Error/timeout observability | 3/5 |
| Release/signing evidence | 0/5 |
| Total | 72/100 |

The previous Environment-69 fresh-session cap no longer applies: coordinator-provided distinct session IDs prove two new conversations/process invocations, and Agent B replayed the same build/hash/schema/revision/IDs/error from only the bounded packet. This dimension receives 17/20 rather than full points because exact model, process start timestamp, client PID, server PID/process identity, and raw initialize envelopes were not exposed. The literal process-compliance no-95+ ceiling still applies, but the raw 72 is already below it. No current surface exposed release/signing evidence.

## 4. Q1–Q20 with full evidence contracts

### Q1 — zero-memory discovery test

- scenario: derive and execute the safest cold-start sequence from current help/capabilities.
- surface: CLI and MCP.
- exact command/tool and exact inputs: rtk proxy penguin status --json; rtk proxy penguin coverage FPMS-NT --json; rtk proxy penguin search "Where does FPMS-NT decide whether a withdrawal or payout operation may proceed, and which returned evidence is only a candidate?" --repo FPMS-NT --branch brazil-v2 --json; rtk proxy penguin context "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT --branch brazil-v2 --json; rtk proxy penguin flow "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT --branch brazil-v2 --json. MCP fallback equivalents: index_status, knowledge_coverage, knowledge_search, knowledge_context, knowledge_flow.
- bounded raw evidence: status selected FPMS-NT; coverage was partial; literal business search returned NO_MATCH_INCOMPLETE; a scoped refinement emitted a current node; context/flow continued by node ID. Help marks mutating commands, and no mutating command was called. Safe sequence is repository selection → freshness/coverage → positive scoped discovery → dynamic ID continuation → stop at lower_bound/unresolved/external boundary → source/log/DB review. If MCP is unavailable, use the same stable CLI read calls.
- elapsed time: status 0.335 s; coverage 0.058 s; literal search 2.240 s; selected context samples 4.837–8.009 s; selected flow samples 6.379–10.751 s.
- exit/status/error code: CLI exit 0 except no-match remains a successful incomplete query envelope; MCP calls succeeded.
- repo/branch/snapshot/revision: stable FPMS-NT scope above.
- freshness: fresh, exact commit/worktree, dirty 0.
- coverage: partial; excluded 7; unresolvedReferences 103958; completeness unknown/lower_bound; proofStatus not_proven.
- candidateCount/returnedCount/totalIsExact: literal 0/0/false; refined withdrawal 447/10/false.
- cursor/hasMore/truncated: refined search truncated true; cursor emitted; unexhausted result is a lower bound.
- evidence origin/method/confidence: indexed source/symbol lanes; graph relations only where returned; no causality from a search candidate.
- dynamic IDs and the result that emitted them: withdrawal refinement emitted service symbol node_3ea02dfa-66da-4570-8872-fde857971da1, updatePlatformConfig, apps/admin/src/admin/admin.service.ts.
- workaround count: 2 discovery refinements, first to "withdrawal payout" and then to "withdrawal".
- verdict: PASS.
- confidence: high.

### Q2 — capability honesty, including semantic/vector search

- scenario: compare explicit lexical-only, blend, and semantic search.
- surface: MCP, with CLI capability manifest inspection.
- exact command/tool and exact inputs: mcp__penguin__knowledge_search with repo FPMS-NT, branch brazil-v2, query equal to the Q1 business question, and options.semantic set separately to off, blend, and semantic.
- bounded raw evidence: off searched source and symbol lanes and returned no hits with NO_MATCH_INCOMPLETE. Blend returned no hits, source/symbol lanes, semantic skipped with reason async_semantic_lane_required and warning SEMANTIC_LANE_UNAVAILABLE. Semantic returned no hits, searchedLanes empty, and the same explicit unavailable warning. No active model/space, dimensions, ready vector/chunk counts, provider, or vector-health values were returned. A later semantic "withdrawal" call emitted suggestions but no semantic hits.
- elapsed time: observed MCP semantic calls 0.463 s, 0.124 s, 0.112 s; median 0.124 s; max 0.463 s.
- exit/status/error code: transport success; warning SEMANTIC_LANE_UNAVAILABLE rather than typed error.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial; lexical output not exhaustive.
- candidateCount/returnedCount/totalIsExact: business prompt 0/0/false for all three modes.
- cursor/hasMore/truncated: none/false/false for empty result.
- evidence origin/method/confidence: lexical lanes explicitly source/symbol; semantic lane explicitly skipped; no semantic provenance exists.
- dynamic IDs and the result that emitted them: none from semantic hits.
- workaround count: 0; the permitted read was attempted exactly as advertised.
- verdict: PASS for capability honesty; semantic/vector power is UNAVAILABLE.
- confidence: high.

### Q3 — installed runtime self-containment

- scenario: determine whether the installed runtime is independent of the workspace without inspecting bundles.
- surface: CLI and MCP.
- exact command/tool and exact inputs: rtk command -v penguin; rtk proxy penguin capabilities --json; rtk proxy penguin search updatePlatformConfig --repo FPMS-NT --branch brazil-v2 --json; mcp_health {}; knowledge_capabilities {"compact":true}; knowledge_search for the same scope/query.
- bounded raw evidence: installed CLI path is under /Users/shieng/.local/bin; current build/generation and real CLI/MCP searches work. Health reports no native-dependency failure. No output identified /Users/shieng/Desktop/Pengvi as an execution import/module dependency; repository file locators are evidence data, not runtime dependency proof. Semantic native/provider readiness is not separately exposed beyond async_semantic_lane_required.
- elapsed time: CLI exact searches 0.763 s and 0.658 s; final MCP health/search batch 4.5 s total.
- exit/status/error code: success.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial.
- candidateCount/returnedCount/totalIsExact: explicit exact CLI sample 21/21/false; a later default MCP sample reported 34/10 with truncation, showing defaults are not a self-containment signal.
- cursor/hasMore/truncated: CLI exact sample not exhausted as proof because totalIsExact false; later MCP default truncated true.
- evidence origin/method/confidence: exposed runtime/health only.
- dynamic IDs and the result that emitted them: same selected symbol remained queryable.
- workaround count: 0.
- verdict: PARTIAL; runtime works, but installed-runtime self-containment is not directly observable and therefore not proven.
- confidence: high.

### Q4 — canonical CLI/MCP contract parity

- scenario: compare discovery, search, graph, pagination, Wiki/API, and structured-error classes.
- surface: CLI and MCP.
- exact command/tool and exact inputs: status/index_status; search/knowledge_search with updatePlatformConfig; context/knowledge_context for node_3ea02dfa-66da-4570-8872-fde857971da1; endpoints/knowledge_endpoints with limit 5 and the emitted cursor; api-doc list/show and api_doc_list/show with preview ID; wrong-repository context for the selected node.
- bounded raw evidence: build/hash/schema/contract and stable scope/revision agree. Context/flow and endpoint page 2 agree on node IDs. CLI cursor continued through MCP. SCOPE_MISMATCH is structured on both surfaces. Differences: default search candidate envelopes differed; API show works with MCP preview_id but an attempted previewId alias produced INTERNAL/ENOENT; the MCP input schema was generic and did not document that key; link.list is advertised but no live read tool is registered. No duplicate live tool names were found.
- elapsed time: CLI search 0.658–0.763 s; endpoint page 2 0.581 s; API show 0.071 s; wrong-scope CLI 0.121 s; final MCP batch 4.5 s.
- exit/status/error code: successes as stated; camelCase API input INTERNAL; wrong scope SCOPE_MISMATCH retryable false.
- repo/branch/snapshot/revision: stable FPMS-NT scope; API previews carried no resolved revision.
- freshness: code calls fresh; API objects stale.
- coverage: code partial; API preview proofStatus not_proven.
- candidateCount/returnedCount/totalIsExact: endpoints 610/5/true; exact CLI search 21/21/false; API list 2/2.
- cursor/hasMore/truncated: endpoint continuation portable; truncated true on page 1.
- evidence origin/method/confidence: endpoint handler edge EXTRACTED confidence 1; Wiki provenance incomplete.
- dynamic IDs and the result that emitted them: selected symbol, endpoint, handler, preview ID, and cursors appear in later tables.
- workaround count: 1, changing MCP api_doc_show input from previewId to preview_id after the first call failed.
- verdict: PARTIAL.
- confidence: high.

### Q5 — concept query versus exact query

- scenario: locate a withdrawal/payout proceed decision without a known symbol.
- surface: CLI and MCP.
- exact command/tool and exact inputs: scoped search of the literal question; then "withdrawal payout"; then "withdrawal"; then exact "updatePlatformConfig"; then path-qualified "apps/admin/src/admin/admin.service.ts:updatePlatformConfig"; semantic comparison from Q2.
- bounded raw evidence: literal and "withdrawal payout" returned no matches. "withdrawal" returned 447 candidates; the first actionable FPMS-NT result under symbolSelectionIndex 0 was updatePlatformConfig in apps/admin/src/admin/admin.service.ts. Exact updatePlatformConfig returned deterministic current nodes, with controller occurrences ahead of the selected service node. Path-qualified form returned NO_MATCH_INCOMPLETE. Semantic added no hits. The selected symbol concerns returned withdrawal-distribution configuration and is only a candidate, not proof that it decides whether an operation proceeds.
- elapsed time: literal 2.240 s; exact 0.763 s and 0.658 s; path-qualified 0.736 s and 0.727 s.
- exit/status/error code: exit 0 envelopes; no-match is incomplete, not absence.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial/lower_bound; unresolved 103958.
- candidateCount/returnedCount/totalIsExact: literal 0/0/false; withdrawal 447/10/false; exact CLI 21/21/false; path-qualified 0/0/false.
- cursor/hasMore/truncated: withdrawal truncated true; exact total not exact.
- evidence origin/method/confidence: source/symbol lexical candidate; no business-rule or runtime confidence was returned.
- dynamic IDs and the result that emitted them: node_3ea02dfa-66da-4570-8872-fde857971da1; updatePlatformConfig; apps/admin/src/admin/admin.service.ts.
- workaround count: 2 discovery refinements; the exact/path follow-up is required evaluation work, not a target substitution.
- verdict: PARTIAL.
- confidence: high.

### Q6 — metamorphic search stability

- scenario: exact, path-qualified, and Penguin-terminology paraphrase, each twice in fresh CLI processes and once in MCP.
- surface: CLI and MCP.
- exact command/tool and exact inputs: "updatePlatformConfig"; "apps/admin/src/admin/admin.service.ts:updatePlatformConfig"; "withdrawal distribution platform config", each scoped to FPMS-NT/brazil-v2.
- bounded raw evidence: exact runs were deterministic in ordering, IDs, scope, and revision. Path-qualified runs were consistently empty with NO_MATCH_INCOMPLETE. Natural paraphrase runs were also consistently empty. No query crossed repository scope or manufactured proof. An unqualified context lookup of updatePlatformConfig separately resolved an endpoint rather than exposing ambiguity, while search showed multiple symbols.
- elapsed time: exact 0.763/0.658 s; path 0.736/0.727 s; paraphrase 0.651/0.661 s; MCP exact diagnostic approximately 0.488 s.
- exit/status/error code: exit 0; empty cases are no-match incomplete.
- repo/branch/snapshot/revision: stable FPMS-NT scope throughout.
- freshness: fresh.
- coverage: partial.
- candidateCount/returnedCount/totalIsExact: exact 21/21/false; path and paraphrase 0/0/false.
- cursor/hasMore/truncated: no cursor for empty forms; exact totalIsExact false.
- evidence origin/method/confidence: lexical source/symbol lanes.
- dynamic IDs and the result that emitted them: exact search retained node_3ea02dfa-66da-4570-8872-fde857971da1 among stable results.
- workaround count: 0 target substitutions.
- verdict: FAIL because the documented path-qualified equivalent did not resolve, despite deterministic exact search.
- confidence: high.

### Q7 — dynamic endpoint selection and identity

- scenario: page-two endpoint selection by capability-hash index 0 and identity convergence.
- surface: CLI and MCP.
- exact command/tool and exact inputs: rtk proxy penguin endpoints FPMS-NT --limit 5 --json; same with emitted --cursor; endpoint-identity with rendered title, canonical identity, and node ID; context and flow for rendered title, canonical identity, and node form; corrupted identity "gRPC AdminGrowthTaskController.QueryUserTaskReport_CORRUPTED".
- bounded raw evidence: page 1 returned 610 total exact, five items, 605 remaining. A fresh CLI process continued page 2; index 0 emitted gRPC AdminGrowthTaskController.QueryUserTaskReport. MCP accepted the CLI cursor and returned the same page. endpoint-identity reported title/canonical/node forms equal. Context and flow converged on the same endpoint and snapshot. Corrupted identity returned TARGET_NOT_FOUND with remediation to copy an identity from endpoints output.
- elapsed time: page 1 3.108 s; page 2 0.581 s; endpoint identity 0.071 s; title/identity/node context 3.742/1.043/0.965 s; title flow 5.633 s; corrupted form 2.657 s.
- exit/status/error code: valid calls exit 0; corrupt identity exit 1, TARGET_NOT_FOUND, retryable false.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial; endpoint aggregate completeness partial/not_proven due repository debt.
- candidateCount/returnedCount/totalIsExact: 610/5/true on each small page.
- cursor/hasMore/truncated: page 1 and page 2 truncated true; cursor portable across CLI and MCP.
- evidence origin/method/confidence: endpoint-to-handler handles edge is proven, method EXTRACTED, confidence 1, provenance controller file, revision scope.
- dynamic IDs and the result that emitted them: endpoint node_34182942-61ef-40a1-82b8-720902e799ba; canonical grpc::AdminGrowthTaskController.queryusertaskreport; handler node_865365a4-384c-4150-a9c0-374dc6d92386.
- workaround count: 0; no easier endpoint substituted.
- verdict: PASS.
- confidence: high.

### Q8 — endpoint handler truth versus inventory decoration

- scenario: carry the Q7 endpoint and handler through context, flow, callers, and callees.
- surface: CLI and MCP.
- exact command/tool and exact inputs: context/flow/callers/callees for node:node_34182942-61ef-40a1-82b8-720902e799ba and node:node_865365a4-384c-4150-a9c0-374dc6d92386, scoped to FPMS-NT/brazil-v2; graph handler depth 2.
- bounded raw evidence: endpoint context, endpoint flow, and graph all contain endpoint → handler with edge type handles. Handler callees contains three direct calls, including query node_f1e90f30-8154-45dd-82ff-118d7d04c785. Specialized callers for the endpoint/handler can be empty while context/graph still shows incoming defines/handles; those empty specialized results have lower_bound completeness and do not negate the handles relation.
- elapsed time: context range 0.965–3.742 s for identity forms; graph depth 2 0.144 s; measured endpoint context runs appear in Q18.
- exit/status/error code: success.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial; unresolvedReferences 103958; specialized callers/callees lower_bound.
- candidateCount/returnedCount/totalIsExact: endpoint context/flow returned the selected endpoint plus relations; MCP flow 29/29 with overall exactness not proven.
- cursor/hasMore/truncated: no continuation needed for first-hop identity; deeper completeness remains partial.
- evidence origin/method/confidence: handles, proven, EXTRACTED, confidence 1, provenance apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts, revision scope.
- dynamic IDs and the result that emitted them: endpoint and handler IDs above; service query node_f1e90f30-8154-45dd-82ff-118d7d04c785.
- workaround count: 0.
- verdict: PASS.
- confidence: high.

### Q9 — bounded request-flow reconstruction

- scenario: endpoint → handler → service/use case → data candidate → tests.
- surface: CLI and MCP.
- exact command/tool and exact inputs: flow and graph depth 2 for the Q7 endpoint/handler, plus context/callees for returned nodes.
- bounded raw evidence:

| Hop | Current locator | Classification | Boundary |
| --- | --- | --- | --- |
| endpoint node_34182942-61ef-40a1-82b8-720902e799ba → handler node_865365a4-384c-4150-a9c0-374dc6d92386 | admin-growth-task.controller.ts:230 | proven | handles, EXTRACTED, confidence 1 |
| handler → query node_f1e90f30-8154-45dd-82ff-118d7d04c785 | v2-task-report.service.ts:112 | proven static graph call | origin/method/confidence not populated for this deeper edge |
| query → aggregateReportRows node_ca45eae1-92c2-4546-8c1f-257de6d200f8 | task-report.repository.ts:206 | proven static graph call | repository/data candidate only |
| aggregateReportRows → aggregate node_66424dbe-90c0-4497-8fe6-f61d01478689 | base-repository.ts:258 | proven static graph call | actual datastore/external execution not proven |
| related test | node_ff666136-a1a6-44ae-9221-20d863c6f391, v2-task-report.service.spec.ts | proven indexed tests relation | runtime coverage not proven |

- elapsed time: flow measured 6.379–10.751 s; graph 0.144 s.
- exit/status/error code: success.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial; unresolved 103958; flow proofStatus not_proven.
- candidateCount/returnedCount/totalIsExact: MCP flow 29/29; total/exhaustiveness not proven.
- cursor/hasMore/truncated: no cursor; completeness partial is the frontier.
- evidence origin/method/confidence: first hop fully proven/extracted/1; later direct graph calls have current node/locator relations but no populated edge origin/confidence.
- dynamic IDs and the result that emitted them: all hop IDs in the table were emitted by current flow/graph.
- workaround count: 0.
- verdict: PASS because the reconstruction stops before claiming a live DB/external boundary.
- confidence: high for returned static hops; low for any live data-path inference.

### Q10 — duplicate service labels and cross-repository identity

- scenario: inspect repeated display labels and test stable service identity.
- surface: CLI and MCP; GUI N/A because browser use was prohibited.
- exact command/tool and exact inputs: rtk proxy penguin services --json; mcp__penguin__knowledge_service_graph {}; penguin node repo_5513e90d-a231-455e-9feb-d15d69e93b38 --json; penguin graph repo_5513e90d-a231-455e-9feb-d15d69e93b38 1 --json; penguin path repo_a48ec7fb-5987-47df-9198-06969359cb50 repo_5513e90d-a231-455e-9feb-d15d69e93b38 --json.
- bounded raw evidence: the current 20-node/87-edge service graph has no repeated display title. FPMS-NT-Auth-Player appears once with stable service ID repo_5513e90d-a231-455e-9feb-d15d69e93b38. node and graph could not resolve that emitted ID; path returned TARGET_NOT_FOUND. Therefore the brief’s current duplicate-label collision case is evidenced N/A, but service-map stable-ID continuation is unusable.
- elapsed time: service graph CLI 0.267 s; node 2.272 s; path 0.740 s.
- exit/status/error code: service graph exit 0; follow-ups exit 1 with node not found/TARGET_NOT_FOUND.
- repo/branch/snapshot/revision: graph spans 20 registered services; stable follow-up could not bind a revision for the service ID.
- freshness: service-map generation current; per-service revision unavailable.
- coverage: service graph returned 20 nodes/87 edges; title collision count 0 in current output.
- candidateCount/returnedCount/totalIsExact: 20/20 for service nodes; exactness field not exposed.
- cursor/hasMore/truncated: none reported.
- evidence origin/method/confidence: service graph relation only; GUI evidence N/A.
- dynamic IDs and the result that emitted them: services emitted repo_5513e90d-a231-455e-9feb-d15d69e93b38 for FPMS-NT-Auth-Player.
- workaround count: 0; no title/path reconstruction was used.
- verdict: FAIL for stable-identity usability; duplicate-label existence itself is N/A.
- confidence: high.

### Q11 — file-target versus node-target affected parity

- scenario: compare file-target affected with node-target impact/affected for the Q5 symbol.
- surface: CLI and MCP.
- exact command/tool and exact inputs: rtk proxy penguin affected apps/admin/src/admin/admin.service.ts --repo FPMS-NT --branch brazil-v2 --json; rtk proxy penguin impact node_3ea02dfa-66da-4570-8872-fde857971da1 --repo FPMS-NT --branch brazil-v2 --json; knowledge_affected with the same file target and node target.
- bounded raw evidence: file-target affected returned 29 changed/impacted candidates but empty tests/routes. CLI node impact returned one controller node. MCP node-target affected additionally surfaced apps/admin/test/unit/admin/admin.service.spec.ts and route gRPC admin.AdminService.UpdatePlatformConfig. The output semantics differ; neither crossed repository scope. Empty file-level tests/routes are not proof of safety.
- elapsed time: CLI affected 1.160 s; CLI impact 0.590 s; Q18 affected samples 0.931–1.443 s.
- exit/status/error code: success.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial/lower_bound; unresolved-reference-count gap.
- candidateCount/returnedCount/totalIsExact: file 29/29/not proven exact; node CLI 1/1/not proven exact.
- cursor/hasMore/truncated: no cursor; no truncation observed, but proofStatus remains not_proven.
- evidence origin/method/confidence: static affected/impact graph; tests/routes are indexed relations, not runtime coverage.
- dynamic IDs and the result that emitted them: selected node; caller/controller node_83868dc3-ec91-450c-a984-7eca32a7d2f1; test node_8d48310f-5bc5-4abb-a5e3-687289ade5b3.
- workaround count: 0.
- verdict: PARTIAL because target semantics and surfaced tests/routes differ materially, though the envelopes disclose lower-bound proof.
- confidence: high.

### Q12 — coverage debt as actionable evidence

- scenario: retrieve aggregate and concrete FPMS-NT coverage debt without source/DB access.
- surface: CLI and MCP.
- exact command/tool and exact inputs: penguin coverage FPMS-NT --json; penguin status --json; penguin doctor --json; knowledge_coverage for FPMS-NT; knowledge_search with includeExcludedMetadata true on the current scoped query.
- bounded raw evidence: discovered 3340, admitted 3333, excluded 7, failed 0, stale 0, unresolvedReferences 103958. Coverage returned items [], gaps [], completeness unknown, proofStatus not_proven, totalIsExact false. includeExcludedMetadata returned exclusions [] despite the aggregate seven exclusions. No documented read-only surface emitted a concrete excluded/stale/unresolved item with reason/path/type/pagination.
- elapsed time: coverage 0.058 s; doctor first 5.477 s; status 0.335 s.
- exit/status/error code: CLI success; MCP doctor independently timed out with QUERY_TIMEOUT.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh; no stale FPMS-NT files reported.
- coverage: visible aggregate but not actionable.
- candidateCount/returnedCount/totalIsExact: coverage null/0/false.
- cursor/hasMore/truncated: no debt-item cursor exposed.
- evidence origin/method/confidence: indexed aggregate counters only.
- dynamic IDs and the result that emitted them: stable repo/branch/snapshot IDs from coverage.
- workaround count: 1 permitted attempt using includeExcludedMetadata; it did not expose a concrete item.
- verdict: PARTIAL; positive scoped search/graph remain useful, while absence, exhaustive affected, dead-code certainty, and complete request-flow claims are blocked.
- confidence: high.

### Q13 — adversarial negative tri-state

- scenario: evaluate four negative statements without converting lower bounds into absence.
- surface: CLI and MCP.
- exact command/tool and exact inputs: callers/context/flow/affected for the Q5 symbol and Q7 endpoint; service_graph; coverage.
- bounded raw evidence:

| Claim | Evidence lane | Completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |
| No production caller exists for updatePlatformConfig | context/callers | lower_bound, partial coverage | contradicted: controller node_83868dc3-ec91-450c-a984-7eca32a7d2f1 is returned | Source/runtime only needed to establish actual invocation |
| No test covers updatePlatformConfig | context/affected | lower_bound | contradicted: admin.service.spec.ts is returned | Runtime test execution/coverage for behavioral coverage |
| No production caller exists for the Q7 endpoint | specialized callers plus handles | callers is lower_bound | not proven; callers is empty but endpoint has a proven handler relation | Framework/DI/runtime route registration and source |
| No test covers the Q7 endpoint path | flow related tests | partial | contradicted at indexed relation level by v2-task-report.service.spec.ts; runtime coverage still not proven | Test execution/coverage |
| Endpoint never reaches external/data boundary | flow | partial/not_proven | not proven; repository aggregate is a data candidate, live datastore/external execution is unsupported | Source plus runtime trace/log and datastore client evidence |
| Service-label duplicate has no effect on routing | service graph | no duplicate exists currently; stable ID fails continuation | not proven | A real repeated-label case plus round-trippable stable IDs and GUI evidence |

- elapsed time: bounded by context/flow/service/coverage measurements already recorded; no additional mutation or repair.
- exit/status/error code: successful query envelopes.
- repo/branch/snapshot/revision: stable FPMS-NT scope for code claims; service graph spans repositories.
- freshness: FPMS-NT fresh.
- coverage: partial; unresolved 103958; dynamic dispatch/DI/reflection caveats remain.
- candidateCount/returnedCount/totalIsExact: as Q8–Q12; no negative uses an exact exhaustive total.
- cursor/hasMore/truncated: no negative depends on an unexhausted cursor as proof.
- evidence origin/method/confidence: current lexical/graph/coverage lanes only.
- dynamic IDs and the result that emitted them: Q5/Q7 IDs and returned callers/tests above.
- workaround count: 0.
- verdict: PASS for disciplined tri-state handling.
- confidence: high.

### Q14 — cursor portability without hidden process state

- scenario: endpoint, file-symbol, and dead-code pagination across fresh CLI processes and current MCP, including malformed, final-page, and wrong-scope cases.
- surface: CLI and MCP.
- exact command/tool and exact inputs: endpoints FPMS-NT --limit 5; filesymbols FPMS-NT brazil-v2 apps/admin/src/admin/admin.service.ts --limit 2; deadcode --repo FPMS-NT --path apps/admin/src/admin --limit 2; repeat each with its raw --cursor; repeat endpoint through knowledge_endpoints; use malformed cursor; use each cursor against a different repository.
- bounded raw evidence: endpoint page 2 selected the Q7 endpoint and CLI cursor worked through MCP. A 500-item endpoint continuation plus final 105-item page exhausted all 610 without duplicate IDs. File-symbol pagination exhausted 18 unique IDs over nine pages; page 2 began with onModuleInit node_ff76... then signIn node_49c.... Dead-code exhausted nine unique candidate IDs over five pages; page 2 began with AdminModule node_d387... and constructor node_6ff.... Final pages returned nextCursor null; replaying the final inbound cursor returned the same final page, remaining 0, without hidden consumed-state. Malformed cursors returned CURSOR_INVALID. Endpoint and dead-code wrong-repository cursors returned CURSOR_SCOPE_MISMATCH. File-symbol wrong-repository validation returned FILE_NOT_FOUND for the scoped path before checking cursor scope.
- elapsed time: endpoint page 1 3.108 s and page 2 0.581 s; fresh current samples endpoint 3.457 s, file-symbol 0.085 s, dead-code 1.883 s.
- exit/status/error code: valid pages exit 0; malformed exit 2 CURSOR_INVALID; endpoint/dead-code wrong scope exit 2 CURSOR_SCOPE_MISMATCH; file-symbol wrong repo exit 2 FILE_NOT_FOUND.
- repo/branch/snapshot/revision: stable FPMS-NT scope and revision for endpoint/file-symbol; dead-code scope FPMS-NT/apps/admin/src/admin with revision field null in its cursor.
- freshness: fresh.
- coverage: endpoint/file-symbol partial repository coverage; dead-code explicitly candidate-only with dynamic_dispatch_and_di_not_proven.
- candidateCount/returnedCount/totalIsExact: endpoint 610/5/true; file-symbol 18/2/true; dead-code 9/2/true.
- cursor/hasMore/truncated: current raw page-1 cursors follow.

  Endpoint cursor:

    eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJlbmRwb2ludHMiLCJzY29wZSI6InJlcG9fYTQ4ZWM3ZmItNTk4Ny00N2RmLTkxOTgtMDY5NjkzNTljYjUwfGJyYW5jaF8xZDIxZjg2OC0zMjUyLTRiNzQtODI4OS04ZjdjNDczNTI0N2Z8KnxpZGVudGl0eUtleSxub2RlSWQiLCJvcmRlcmluZ0tleSI6ImlkZW50aXR5S2V5LG5vZGVJZCIsImxhc3RLZXkiOiJncnBjOjpBZG1pbkdyb3d0aFRhc2tDb250cm9sbGVyLnByZXZpZXdzZWdtZW50aGl0Y291bnRcdTAwMDBub2RlXzgyYzgzOGY0LTBjMTUtNGJjYS04MzBhLTIzYjg0YTJjOTNhNyIsInJldmlzaW9uIjoic25hcHNob3RfMjg5ZTZhMjktZTFkMy00ODNkLWI3MmQtZWVkN2Y4MjA3NWMzIiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0zMFQyMzo1Nzo0OS42MjZaIn0.svas_kZSv1fAd1qp5oO6hEh5G87Pww84CoGnjgHCidg

  File-symbol cursor:

    eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJmaWxlc3ltYm9scyIsInNjb3BlIjoiYnJhbmNoXzFkMjFmODY4LTMyNTItNGI3NC04Mjg5LThmN2M0NzM1MjQ3ZnxhcHBzL2FkbWluL3NyYy9hZG1pbi9hZG1pbi5zZXJ2aWNlLnRzIiwib3JkZXJpbmdLZXkiOiJzdGFydExpbmUsbm9kZUlkIiwibGFzdEtleSI6IjMxXHUwMDAwbm9kZV82ZmY5MTk1Zi01MjEyLTRiMjYtYjRlNy0wZGY4YjA1YmM5Y2IiLCJyZXZpc2lvbiI6ImJyYW5jaF8xZDIxZjg2OC0zMjUyLTRiNzQtODI4OS04ZjdjNDczNTI0N2YiLCJleHBpcmVzQXQiOiIyMDI2LTA4LTMwVDIzOjU3OjQzLjgyM1oifQ.V2-Taxt8xK7HleyzK7KVUeP5ciRNLBJv6FoKtfOQ3tQ

  Dead-code cursor:

    eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJkZWFkY29kZSIsInNjb3BlIjoiRlBNUy1OVHxhcHBzL2FkbWluL3NyYy9hZG1pbnwqIiwib3JkZXJpbmdLZXkiOiJmaWxlUGF0aCxzdGFydExpbmUsbm9kZUlkIiwibGFzdEtleSI6ImFwcHMvYWRtaW4vc3JjL2FkbWluL2FkbWluLmNvbnRyb2xsZXIudHNcdTAwMDAxMlx1MDAwMG5vZGVfZTYxNTBhMGUtZWNkMy00ZmNiLWJmNjAtZGNjNGQ3NTQ2NzlhIiwicmV2aXNpb24iOm51bGwsImV4cGlyZXNBdCI6IjIwMjYtMDgtMzBUMjM6NTc6NDUuOTI2WiJ9.2NHuPwkX6lH-QmwmQYDAbIg0HxtDk1mAeuIFzHxOhLA

- evidence origin/method/confidence: cursor contract schema 1/contract 2; stable ordering keys identityKey+nodeId, startLine+nodeId, and filePath+startLine+nodeId respectively.
- dynamic IDs and the result that emitted them: page-1 item IDs and all three raw cursors were emitted during this run.
- workaround count: 0; no offset/title reconstruction.
- verdict: PARTIAL because Agent A’s endpoint cursor now has independent Agent B cross-session proof, but file-symbol wrong-scope validation is masked by FILE_NOT_FOUND and the specific Agent A file-symbol/dead-code raw cursors were not replayed by Agent B.
- confidence: high.

### Q15 — typed-error discrimination

- scenario: trigger ten non-mutating invalid/unavailable conditions.
- surface: CLI and MCP.
- exact command/tool and exact inputs: context with missing target; search with empty query; status/search unknown repository; context constructor in FPMS-NT; context node:node_invalid; context selected node under FPMS-NT-Payment/newzealand-v2; malformed and wrong-scope cursors from Q14; endpoint-identity with corrupted form; semantic search while async lane is unavailable.
- bounded raw evidence:

| Condition | Human/JSON result | Exit/status | Retryable/category | Copyable remediation |
| --- | --- | --- | --- | --- |
| Missing target | INVALID_TARGET, target is required | CLI exit 1 | false/input | pass a concrete target |
| Empty query | INVALID_QUERY, query must be non-empty | exit 2 | false/input | provide a non-empty scoped query |
| Unknown repository | REPOSITORY_NOT_FOUND | exit 2 | false/scope | run penguin status --json and choose an indexed repo |
| Ambiguous target constructor | TARGET_AMBIGUOUS with candidates | exit 1 | false/ambiguity | specify repo/branch and an exact node ID |
| Invalid node ID | INVALID_TARGET | exit 1 | false/input | run scoped search and copy an emitted node ID |
| Wrong-repository node | SCOPE_MISMATCH with requested/actual repo/revision | CLI exit 1; MCP isError true | false/scope | specify FPMS-NT and brazil-v2, the owning scope |
| Malformed cursor | CURSOR_INVALID | exit 2 | false/cursor | copy nextCursor unchanged from a current page |
| Wrong-scope cursor | CURSOR_SCOPE_MISMATCH, except file-symbol path validates first | exit 2 | false/cursor-scope | continue using the emitting repo/branch/path |
| Invalid endpoint identity | TARGET_NOT_FOUND | exit 1 | false/identity | run penguin endpoints FPMS-NT --limit 5 --json and copy title/identity/node |
| Unsupported semantic lane | successful empty envelope plus SEMANTIC_LANE_UNAVAILABLE, async_semantic_lane_required | transport success | warning/unavailable, not typed error | use semantic off and continue graph/lexical |

- elapsed time: missing target 0.057 s; empty query 0.055 s; unknown repo 0.053 s; ambiguous 0.258 s; invalid node 2.261 s; wrong scope 0.121 s; corrupt endpoint 2.657 s.
- exit/status/error code: in table.
- repo/branch/snapshot/revision: wrong-scope error preserved both requested snapshot_4803f142-c085-4e8f-82d3-5a6602eb36fc and actual FPMS-NT snapshot.
- freshness: actual FPMS-NT target fresh.
- coverage: partial; typed input/scope errors are independent of coverage, while semantic empty result remains incomplete.
- candidateCount/returnedCount/totalIsExact: ambiguous target returned candidates; semantic 0/0/false.
- cursor/hasMore/truncated: cursor cases in Q14.
- evidence origin/method/confidence: structured Penguin error envelopes; no inference.
- dynamic IDs and the result that emitted them: current selected node and current cursors only.
- workaround count: 0 repairs during the scenarios.
- verdict: PARTIAL because most distinctions are typed and actionable, but unavailable semantic is only a warning/success envelope and file-symbol wrong-scope is masked by path validation.
- confidence: high.

### Q16 — Wiki/API knowledge freshness boundary

- scenario: inventory and read one current API/Wiki object plus notes/memory/tags/links/evidence/saved-query surfaces.
- surface: CLI and MCP.
- exact command/tool and exact inputs: penguin api-doc list --json; penguin api-doc show "preview:v1:0f638a792d12e21e9851f49a4bed76c3:a117288688ad59388f308b82aa30755b" --json; api_doc_list {}; api_doc_show {"preview_id":"preview:v1:0f638a792d12e21e9851f49a4bed76c3:a117288688ad59388f308b82aa30755b"}; knowledge_note_list, knowledge_memory_recall, knowledge_tag_list, knowledge_saved_query_list, knowledge_source_list, knowledge_note_backlinks when a stable note node exists, list_sls_targets, list_evidence_notes.
- bounded raw evidence: API list returned two stale previews. The selected FrontendRegisterService preview is stale, proofStatus not_proven, has empty source revisionIds/sourceCommits and empty IR revisions/endpoints, gap preview_revision_stale/revision_unresolved, while currentRevisionIds lists the FPMS-NT snapshot. The rendered claim of exhaustiveness is not accepted as current truth. One note redis-clusterallfailederror.md has nodeId null, repo/revision null, sensitivity normal, mcpAccess allowed, and gap index_node_unavailable. Memory, tags, saved queries, and evidence notes were empty; source list was empty; SLS target discovery returned six current target configurations. No stable note node existed for a meaningful backlinks follow-up. Advertised link.list had no live read tool.
- elapsed time: CLI API show 0.071 s; MCP per-call time unavailable from host.
- exit/status/error code: list/show success using preview_id; camelCase previewId produced INTERNAL/ENOENT and required one key correction.
- repo/branch/snapshot/revision: API object has no resolved source revision; current revision list includes FPMS-NT snapshot only as freshness comparison.
- freshness: stale and clearly marked.
- coverage: partial/not_proven; provenance incomplete.
- candidateCount/returnedCount/totalIsExact: API previews 2/2; notes 1/1; memory/tags/saved queries/sources/evidence notes 0; SLS targets 6.
- cursor/hasMore/truncated: no continuation cursor returned for these small lists.
- evidence origin/method/confidence: generated preview metadata; author/type, generated/manual provenance, sensitive/redaction details, source revision, and backlinks are missing or incomplete.
- dynamic IDs and the result that emitted them: selected preview ID above; note has no node ID.
- workaround count: 1, previewId to preview_id.
- verdict: PARTIAL; staleness is honest, but provenance/read-schema/link continuity are insufficient.
- confidence: high.

### Q17 — runtime-generation two-session replay

- scenario: Agent A record plus new Agent B replay.
- surface: MCP.
- exact command/tool and exact inputs: Agent A and Agent B independently used mcp_health {}; tools/list proxy; knowledge_capabilities {"compact":true}; context for node:node_3ea02dfa-66da-4570-8872-fde857971da1 in FPMS-NT/brazil-v2; flow for node:node_34182942-61ef-40a1-82b8-720902e799ba; and wrong-scope context under FPMS-NT-Payment/newzealand-v2 followed by the prescribed owning-scope remediation.
- bounded raw evidence: coordinator identifies Agent A session 01a054fe-d593-72b3-aa60-d7c8473c8cfb and separate packet-only Agent B session 01a05515-bdb5-76d1-a562-e1811209e410. Agent B received no report, brief, source, or memory. Both sessions report health ok, initializeHealthy true, 82 exposed Penguin MCP tools, 99 implemented manifest capabilities, build 1.16.0-caf621d03b0402b6, schema 15, contract 2, and hash 40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0. Agent B resolved the exact Q5 node, Q7 endpoint/handler, and proven handles/EXTRACTED/confidence-1/revision-scope edge at the same FPMS-NT revision. Its live CLI+MCP flow added depth-5 node_b38eac89-6c43-4aec-ba79-d980676d00d1, async, after Agent A’s packet frontier node_66424dbe-90c0-4497-8fe6-f61d01478689. Completeness remains partial and proofStatus not_proven, so the extra node is deeper current evidence, not a proven live datastore/external hop. Raw protocol initialize envelopes, exact models, client/server PIDs, server process identity, and full tool annotations were not exposed.
- elapsed time: Agent A final five-call batch 4.5 s wall; Agent B per-call timings were not supplied and are recorded as not exposed rather than invented.
- exit/status/error code: both baselines and owning-scope replays succeeded; wrong-scope CLI+MCP returned SCOPE_MISMATCH, retryable false, with exact requested/actual revisions and remediation.
- repo/branch/snapshot/revision: exact FPMS-NT repo_a48ec7fb-5987-47df-9198-06969359cb50; branch branch_1d21f868-3252-4b74-8289-8f7c4735247f; commit 3f0f1984b9e4337668529a13bad5264501729908; snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3; fingerprint 073264f852ac84af18fb68cb22b56c5bdb3801e578c69510f638e13a0b0544c5. Wrong requested snapshot: snapshot_4803f142-c085-4e8f-82d3-5a6602eb36fc.
- freshness: fresh.
- coverage: partial; 3340 discovered, 3333 admitted, 7 excluded, 0 failed, 0 stale, 103958 unresolved references.
- candidateCount/returnedCount/totalIsExact: Q17 identity continuity is exact for the emitted nodes/edge; deeper flow remains partial/not_proven. Agent A’s current default MCP exact search was 34/10 and truncated; Agent B did not substitute an ID.
- cursor/hasMore/truncated: Q17 does not rely on cursor exhaustion; Agent B endpoint-cursor continuity is recorded in Q19.
- evidence origin/method/confidence: distinct coordinator process/conversation IDs plus live MCP health/registry/context/flow/error envelopes; endpoint edge handles/proven/EXTRACTED/confidence 1/revision scope.
- dynamic IDs and the result that emitted them: Q5 node_3ea02dfa-66da-4570-8872-fde857971da1, Q7 endpoint node_34182942-61ef-40a1-82b8-720902e799ba, handler node_865365a4-384c-4150-a9c0-374dc6d92386, and Agent B flow node_b38eac89-6c43-4aec-ba79-d980676d00d1.
- workaround count: repairs 0; substituted IDs 0; expired cursors 0; workarounds 0. The one prescribed wrong-scope remediation succeeded and is not counted as a repair.
- verdict: PARTIAL. Two fresh process/conversation invocations and generation/node/error continuity are proven; raw initialize, exact model/PID/server-process identity, complete deeper flow, and exhaustive coverage remain unavailable.
- confidence: high for session separation and replayed evidence; medium for generation identity beyond exposed build/hash because server PID/process identity is not exposed.

### Q18 — timeout and latency honesty

- scenario: three-run cold/warm-like latency samples through fresh CLI processes where possible, plus advertised semantic and MCP timeout behavior.
- surface: CLI and MCP.
- exact command/tool and exact inputs: capabilities; scoped search updatePlatformConfig; endpoint page limit 5; context selected endpoint; flow selected endpoint; affected selected file; doctor; MCP semantic query, all with the stable inputs used above.
- bounded raw evidence:

| Operation | Run seconds | Median | Maximum | Result |
| --- | --- | ---: | ---: | --- |
| capabilities | 0.000002959, 0.000002833, 0.000003041 | 0.000002959 | 0.000003041 | exit 0; wrapper-observed values are implausibly small and not treated as native runtime latency |
| scoped search | 2.682, 0.783, 0.681 | 0.783 | 2.682 | exit 0 |
| endpoint page | 4.418, 4.261, 4.065 | 4.261 | 4.418 | exit 0 |
| context | 7.973, 8.009, 4.837 | 7.973 | 8.009 | exit 0 |
| flow | 7.282, 10.751, 6.379 | 7.282 | 10.751 | exit 0 |
| affected | 1.443, 0.931, 0.939 | 0.939 | 1.443 | exit 0 |
| CLI doctor | 5.801, 5.692, 5.724 | 5.724 | 5.801 | exit 0 |
| MCP semantic | 0.463, 0.124, 0.112 | 0.124 | 0.463 | transport success, semantic unavailable |

  A separate MCP knowledge_doctor call exceeded hardTimeoutMs 30000 and returned QUERY_TIMEOUT, retryable false. It did not project timeout as an empty graph, but its structured result did not expose an explicit timedOut boolean, partial evidence, or a safe narrower retry command.

- elapsed time: table.
- exit/status/error code: table; MCP doctor QUERY_TIMEOUT.
- repo/branch/snapshot/revision: stable FPMS-NT scope where applicable.
- freshness: fresh.
- coverage: partial.
- candidateCount/returnedCount/totalIsExact: same per operation as earlier Q records.
- cursor/hasMore/truncated: endpoint page truncated true; other operations as recorded.
- evidence origin/method/confidence: process wall timing; capabilities measurements are explicitly treated as wrapper artifacts, not authoritative native latency.
- dynamic IDs and the result that emitted them: Q5 symbol/Q7 endpoint used.
- workaround count: 0; no timeout repair attempted.
- verdict: PARTIAL because latency is measurable and timeout is typed, but the timeout contract lacks timedOut, partial evidence, and safe retry guidance.
- confidence: high for recorded wall values; low for interpreting the capabilities microsecond samples.

### Q19 — agent-to-agent investigation packet

- scenario: Agent A creates a Penguin-only packet; Agent B replays it in a completely new session.
- surface: CLI and MCP.
- exact command/tool and exact inputs: Agent A packet below; Agent B used the packet’s exact CLI/MCP health, capabilities, context, flow, affected, endpoint-cursor, callers, wrong-scope, and owning-scope remediation inputs. Agent B also used Penguin help to correct one rejected command spelling from file-symbols to filesymbols; Penguin help is an allowed Penguin surface.
- bounded raw evidence: separate Agent B session 01a05515-bdb5-76d1-a562-e1811209e410 received only the packet. CLI+MCP context resolved Q5 node node_3ea02dfa-66da-4570-8872-fde857971da1 at the exact file/revision. Flow preserved Q7 endpoint node_34182942-61ef-40a1-82b8-720902e799ba, handler node_865365a4-384c-4150-a9c0-374dc6d92386, and handles/proven/EXTRACTED/confidence-1/revision-scope edge; it additionally returned depth-5 async node_b38eac89-6c43-4aec-ba79-d980676d00d1 beyond Agent A’s aggregate frontier. The live datastore/external hop remains not proven. CLI affected included the Q5 symbol with 29/29 lower-bound candidates, while exact MCP file target returned only file node node_a87f5401-df34-4230-ae75-bfc8a9d3b5d1 and 0/0 impacted, without repair. The Agent A endpoint cursor was accepted and not expired; continuation IDs began node_34182942, node_5628002b, node_102a8f36, node_dba69c40, node_7cbb51dd. CLI+MCP callers returned one caller node_83868dc3-ec91-450c-a984-7eca32a7d2f1, but overall completeness is lower_bound with 103958 unresolved references, so negative exclusivity remains not proven. Wrong-scope CLI+MCP reproduced exact SCOPE_MISMATCH; prescribed owning-scope remediation succeeded.
- elapsed time: Agent A packet evidence uses Q5/Q7/Q9/Q14/Q15 timings. Agent B timings were not supplied; no values are invented.
- exit/status/error code: positive replay calls succeeded; wrong-repo CLI+MCP returned SCOPE_MISMATCH, retryable false; remediation succeeded. Agent B explicitly made no whole-round completion claim.
- repo/branch/snapshot/revision: exact FPMS-NT repo/branch/commit/snapshot/fingerprint match Agent A; wrong requested repo/revision repo_670fda10-d25a-4ad5-9dc8-50766fefe986/snapshot_4803f142-c085-4e8f-82d3-5a6602eb36fc; actual repo/revision repo_a48ec7fb-5987-47df-9198-06969359cb50/snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3.
- freshness: fresh.
- coverage: partial, unresolved 103958.
- candidateCount/returnedCount/totalIsExact: endpoint continuation 610/5/true with 600 remaining; CLI affected 29/29 lower-bound/candidate; MCP exact file affected 0/0 impacted plus the file node; callers one exact enumerated result but overall lower_bound.
- cursor/hasMore/truncated: Agent A page-1 endpoint cursor accepted, not expired, continuation truncated true with 600 remaining.
- evidence origin/method/confidence: proven handles edge, EXTRACTED, confidence 1, revision scope; deeper flow and affected/callers remain partial/lower_bound/not_proven.
- dynamic IDs and the result that emitted them: packet Q5/Q7 IDs round-tripped; Agent B emitted async node_b38eac89-6c43-4aec-ba79-d980676d00d1, affected file node_a87f5401-df34-4230-ae75-bfc8a9d3b5d1, caller node_83868dc3-ec91-450c-a984-7eca32a7d2f1, and the five endpoint continuation IDs above.
- workaround count: repairs 0; substituted IDs 0; expired cursors 0; workarounds 0; prescribed remediation 1 and successful. The B6 command-name discovery correction count is 1 and is separately recorded there.
- verdict: PASS; bounded label PASS_WITH_BOUND. The packet was sufficient for exact scope/ID/edge/cursor/error replay, while deeper-flow, affected parity, and negative exclusivity remain bounded rather than promoted to proof.
- confidence: high.

AGENT_B_PACKET_BEGIN

PENGUIN_SCOPE_OUTPUT:

- repo: FPMS-NT
- repoId: repo_a48ec7fb-5987-47df-9198-06969359cb50
- branch: brazil-v2
- branchId: branch_1d21f868-3252-4b74-8289-8f7c4735247f
- commitSha: 3f0f1984b9e4337668529a13bad5264501729908
- snapshotId: snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3
- worktreeFingerprint: 073264f852ac84af18fb68cb22b56c5bdb3801e578c69510f638e13a0b0544c5
- freshness.status: fresh
- freshness.dirtyFileCount: 0
- coverage: status partial; discovered 3340; admitted 3333; excluded 7; failed 0; stale 0; unresolvedReferences 103958

PENGUIN_CAPABILITY_OUTPUT:

- build/generation: 1.16.0-caf621d03b0402b6
- schemaVersion: 15
- contractVersion: 2
- capabilityHash: 40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0

PENGUIN_EMITTED_IDS:

- Q5 symbol: node_3ea02dfa-66da-4570-8872-fde857971da1; title updatePlatformConfig; file apps/admin/src/admin/admin.service.ts
- Q7 endpoint: node_34182942-61ef-40a1-82b8-720902e799ba; title gRPC AdminGrowthTaskController.QueryUserTaskReport; identity grpc::AdminGrowthTaskController.queryusertaskreport
- Q7 handler: node_865365a4-384c-4150-a9c0-374dc6d92386; title queryUserTaskReport; file apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts; lines 230-241

PENGUIN_EMITTED_CURSOR:

    eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJlbmRwb2ludHMiLCJzY29wZSI6InJlcG9fYTQ4ZWM3ZmItNTk4Ny00N2RmLTkxOTgtMDY5NjkzNTljYjUwfGJyYW5jaF8xZDIxZjg2OC0zMjUyLTRiNzQtODI4OS04ZjdjNDczNTI0N2Z8KnxpZGVudGl0eUtleSxub2RlSWQiLCJvcmRlcmluZ0tleSI6ImlkZW50aXR5S2V5LG5vZGVJZCIsImxhc3RLZXkiOiJncnBjOjpBZG1pbkdyb3d0aFRhc2tDb250cm9sbGVyLnByZXZpZXdzZWdtZW50aGl0Y291bnRcdTAwMDBub2RlXzgyYzgzOGY0LTBjMTUtNGJjYS04MzBhLTIzYjg0YTJjOTNhNyIsInJldmlzaW9uIjoic25hcHNob3RfMjg5ZTZhMjktZTFkMy00ODNkLWI3MmQtZWVkN2Y4MjA3NWMzIiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0zMFQyMzo1Nzo0OS42MjZaIn0.svas_kZSv1fAd1qp5oO6hEh5G87Pww84CoGnjgHCidg

- emitted envelope: candidateCount 610; returnedCount 5; remainingCount 605; totalIsExact true; truncated true

PENGUIN_PROVEN_EDGE_OUTPUT:

- from node_34182942-61ef-40a1-82b8-720902e799ba
- to node_865365a4-384c-4150-a9c0-374dc6d92386
- edgeType handles
- evidenceState proven
- method EXTRACTED
- confidence 1
- provenance.filePath apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts
- scope revision

PENGUIN_UNRESOLVED_BOUNDARY_OUTPUT:

- current returned chain ends at node_66424dbe-90c0-4497-8fe6-f61d01478689, title aggregate, after repository node_ca45eae1-92c2-4546-8c1f-257de6d200f8, title aggregateReportRows
- flow completeness partial/lower_bound
- flow proofStatus not_proven
- coverage.unresolvedReferences 103958
- no proven current live datastore/external hop is present in the returned chain

PENGUIN_TYPED_ERROR_OUTPUT:

- code SCOPE_MISMATCH
- message target node_3ea02dfa-66da-4570-8872-fde857971da1 is outside the requested repository scope
- retryable false
- requestedRepoId repo_670fda10-d25a-4ad5-9dc8-50766fefe986
- requestedRevisionId snapshot_4803f142-c085-4e8f-82d3-5a6602eb36fc
- actualRepoId repo_a48ec7fb-5987-47df-9198-06969359cb50
- actualRevisionId snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3
- remediation specify the repository that owns the target

EXACT_NEXT_CLI_COMMANDS:

    rtk proxy penguin context "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin flow "node:node_34182942-61ef-40a1-82b8-720902e799ba" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin affected apps/admin/src/admin/admin.service.ts --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin endpoints FPMS-NT --limit 5 --cursor "eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJlbmRwb2ludHMiLCJzY29wZSI6InJlcG9fYTQ4ZWM3ZmItNTk4Ny00N2RmLTkxOTgtMDY5NjkzNTljYjUwfGJyYW5jaF8xZDIxZjg2OC0zMjUyLTRiNzQtODI4OS04ZjdjNDczNTI0N2Z8KnxpZGVudGl0eUtleSxub2RlSWQiLCJvcmRlcmluZ0tleSI6ImlkZW50aXR5S2V5LG5vZGVJZCIsImxhc3RLZXkiOiJncnBjOjpBZG1pbkdyb3d0aFRhc2tDb250cm9sbGVyLnByZXZpZXdzZWdtZW50aGl0Y291bnRcdTAwMDBub2RlXzgyYzgzOGY0LTBjMTUtNGJjYS04MzBhLTIzYjg0YTJjOTNhNyIsInJldmlzaW9uIjoic25hcHNob3RfMjg5ZTZhMjktZTFkMy00ODNkLWI3MmQtZWVkN2Y4MjA3NWMzIiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0zMFQyMzo1Nzo0OS42MjZaIn0.svas_kZSv1fAd1qp5oO6hEh5G87Pww84CoGnjgHCidg" --json
    rtk proxy penguin callers "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin context "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT-Payment --branch newzealand-v2 --json
    rtk proxy penguin context "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT --branch brazil-v2 --json

EXACT_NEXT_MCP_TOOLS_AND_INPUTS:

- mcp__penguin__mcp_health {}
- mcp__penguin__knowledge_capabilities {"compact":true}
- mcp__penguin__knowledge_context {"target":"node:node_3ea02dfa-66da-4570-8872-fde857971da1","repo":"FPMS-NT","branch":"brazil-v2"}
- mcp__penguin__knowledge_flow {"target":"node:node_34182942-61ef-40a1-82b8-720902e799ba","repo":"FPMS-NT","branch":"brazil-v2"}
- mcp__penguin__knowledge_affected {"target":"apps/admin/src/admin/admin.service.ts","repo":"FPMS-NT","branch":"brazil-v2"}
- mcp__penguin__knowledge_endpoints {"repo":"FPMS-NT","branch":"brazil-v2","limit":5,"cursor":"eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJlbmRwb2ludHMiLCJzY29wZSI6InJlcG9fYTQ4ZWM3ZmItNTk4Ny00N2RmLTkxOTgtMDY5NjkzNTljYjUwfGJyYW5jaF8xZDIxZjg2OC0zMjUyLTRiNzQtODI4OS04ZjdjNDczNTI0N2Z8KnxpZGVudGl0eUtleSxub2RlSWQiLCJvcmRlcmluZ0tleSI6ImlkZW50aXR5S2V5LG5vZGVJZCIsImxhc3RLZXkiOiJncnBjOjpBZG1pbkdyb3d0aFRhc2tDb250cm9sbGVyLnByZXZpZXdzZWdtZW50aGl0Y291bnRcdTAwMDBub2RlXzgyYzgzOGY0LTBjMTUtNGJjYS04MzBhLTIzYjg0YTJjOTNhNyIsInJldmlzaW9uIjoic25hcHNob3RfMjg5ZTZhMjktZTFkMy00ODNkLWI3MmQtZWVkN2Y4MjA3NWMzIiwiZXhwaXJlc0F0IjoiMjAyNi0wOC0zMFQyMzo1Nzo0OS42MjZaIn0.svas_kZSv1fAd1qp5oO6hEh5G87Pww84CoGnjgHCidg"}
- mcp__penguin__knowledge_callers {"target":"node:node_3ea02dfa-66da-4570-8872-fde857971da1","repo":"FPMS-NT","branch":"brazil-v2"}
- mcp__penguin__knowledge_context {"target":"node:node_3ea02dfa-66da-4570-8872-fde857971da1","repo":"FPMS-NT-Payment","branch":"newzealand-v2"}
- remediation replay: mcp__penguin__knowledge_context {"target":"node:node_3ea02dfa-66da-4570-8872-fde857971da1","repo":"FPMS-NT","branch":"brazil-v2"}

AGENT_B_PACKET_END

AGENT_B_REPLAY_RESULT_BEGIN

- independent session: 01a05515-bdb5-76d1-a562-e1811209e410; separate fresh ephemeral Codex exec process/conversation; packet-only input; exact model/PID not exposed
- baseline: health ok; initializeHealthy true; clientRestartRequired false; runtimeOutdated false; 82 Penguin MCP tools; 99 implemented capabilities; build/schema/contract/hash exact
- context: Q5 node/file/revision exact through CLI and MCP
- flow: Q7 endpoint/handler/proven edge exact; additional depth-5 async node_b38eac89-6c43-4aec-ba79-d980676d00d1; completeness partial; proofStatus not_proven; live datastore/external hop absent from proven evidence
- affected: CLI 29/29 lower-bound candidates including Q5 symbol; exact MCP file target returned file node node_a87f5401-df34-4230-ae75-bfc8a9d3b5d1 and 0/0 impacted; no repair
- endpoint cursor: Agent A cursor accepted and unexpired; five returned IDs node_34182942-61ef-40a1-82b8-720902e799ba, node_5628002b, node_102a8f36, node_dba69c40, node_7cbb51dd; 610 candidates, 5 returned, 600 remaining, total exact, truncated
- callers: one caller node_83868dc3-ec91-450c-a984-7eca32a7d2f1; enumerated total exact but overall lower_bound with 103958 unresolved references; exclusivity not proven
- typed error: wrong-scope CLI+MCP exact SCOPE_MISMATCH, retryable false, requested/actual scopes exact; prescribed owning-scope remediation succeeded
- counts: repairs 0; substituted IDs 0; expired cursors 0; workarounds 0; prescribed remediation 1
- replay verdict: PASS_WITH_BOUND

AGENT_B_REPLAY_RESULT_END

### Q20 — installed, configured, loaded, and useful

- scenario: make four independent current-session claims.
- surface: CLI and MCP.
- exact command/tool and exact inputs: command discovery/help/capabilities, mcp_health, live tools/list proxy, current scoped search/context/flow/error calls.
- bounded raw evidence:

| Claim | Current observation | Verdict |
| --- | --- | --- |
| Installed | Both sessions observed the installed CLI/MCP runtime and exact build 1.16.0-caf621d03b0402b6 | PASS |
| Configured | health configured remains null; no current client configuration surface proves a launcher binding | NOT PROVEN |
| Loaded | distinct Agent A and Agent B process/conversation IDs each report initialized MCP, 82 tools, the same build/hash/schema, and successful exact replays | PASS; exact model/PID/server process identity and raw initialize are not exposed |
| Useful | exact context/handler/error/cursor replay is actionable; partial coverage, deeper-flow variance, affected divergence, concept/path/semantic/service-ID/provenance limitations remain | CONDITIONAL |

- elapsed time: health/final call batch 4.5 s; representative operation timings in Q18.
- exit/status/error code: live success plus explicitly recorded structured failures.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial.
- candidateCount/returnedCount/totalIsExact: representative endpoint 610/5/true; coverage null/0/false; exact/concept search as above.
- cursor/hasMore/truncated: Agent A endpoint cursor crossed into Agent B without expiry; file-symbol/dead-code cross-process continuity used Agent-B-generated cursors and remains a bounded limitation.
- evidence origin/method/confidence: current CLI/MCP evidence plus coordinator-provided distinct process/conversation session IDs; exact model/PID not exposed.
- dynamic IDs and the result that emitted them: Agent A IDs round-tripped; Agent B emitted the additional flow, affected-file, caller, and continuation IDs recorded in Q19.
- workaround count: replay repairs 0, substitutions 0, expiries 0, workarounds 0; one prescribed remediation succeeded.
- verdict: PARTIAL overall.
- confidence: high.

## 5. B1–B8 end-to-end evidence

Required dynamic ID/cursor table:

| Dynamic ID/cursor | Emitted by | Follow-up | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |
| node_3ea02dfa-66da-4570-8872-fde857971da1 | Q5 scoped withdrawal search, actionable index 0 | exact search, context, flow, callers/callees, impact/affected, wrong-scope error; Agent B CLI+MCP replay | FPMS-NT/brazil-v2/snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3 | Round-tripped across sessions; business gate not proven | 2 discovery refinements; Agent B repairs 0 |
| node_34182942-61ef-40a1-82b8-720902e799ba | Q7 endpoint page 2, index 0 | endpoint identity, context, flow, graph; Agent B flow/cursor replay | same FPMS-NT scope/revision | Valid forms and proven handler edge converged across sessions; deeper flow varied | 0 |
| node_865365a4-384c-4150-a9c0-374dc6d92386 | Q7 endpoint handler | context, flow, callers/callees, graph | same FPMS-NT scope/revision | Proven handles target; deeper frontier partial | 0 |
| Endpoint nextCursor ending svas_kZSv1fAd1qp5oO6hEh5G87Pww84CoGnjgHCidg | Agent A endpoint page 1 | separate Agent B session continuation | same FPMS-NT scope/revision | Accepted/unexpired; 610/5/true; 600 remaining after continuation; truncated | 0 |
| File-symbol nextCursor ending V2-Taxt8xK7HleyzK7KVUeP5ciRNLBJv6FoKtfOQ3tQ | Agent A file-symbol page 1 | Agent A new CLI page 2/full exhaustion | branch ID plus admin.service.ts | Agent A 18 unique IDs; Agent B continuity used a newly emitted Agent B cursor, not this cursor | 0 |
| Dead-code nextCursor ending 2NHuPwkX6lH-QmwmQYDAbIg0HxtDk1mAeuIFzHxOhLA | Agent A dead-code page 1 | Agent A new CLI page 2/full exhaustion | FPMS-NT/apps/admin/src/admin; cursor revision null | Agent A 9 unique candidates; Agent B continuity used a newly emitted Agent B cursor, not this cursor | 0 |
| repo_5513e90d-a231-455e-9feb-d15d69e93b38 | current service graph, FPMS-NT-Auth-Player | node, graph, path | service graph/current generation | Did not round-trip | 0; no title/path reconstruction |
| preview:v1:0f638a792d12e21e9851f49a4bed76c3:a117288688ad59388f308b82aa30755b | current API preview list | CLI and MCP show | source revision unresolved; current revision comparison only | Readable but stale/not_proven | 1 MCP input-key correction |

### B1 — cold production-symptom triage

- scenario: a withdrawal or payout operation is not progressing; identify likely entry points and a source/log checklist without an unproven root cause.
- surface: CLI and MCP.
- exact command/tool and exact inputs: status; coverage FPMS-NT; scoped literal business search; scoped refinements "withdrawal payout" then "withdrawal"; context and flow for node_3ea02dfa-66da-4570-8872-fde857971da1.
- bounded raw evidence: literal business intent did not match. The first actionable dynamically selected candidate was updatePlatformConfig, which calls notifier send, getPlatformByObjectId, and a processor update and has an indexed unit-test relation. This is a withdrawal-distribution configuration-write candidate, not a proven operation-progression gate. Evidence frontier: no returned current relation proves where allow/deny/proceed is decided, and no runtime/log/DB evidence was permitted. Next checklist: source-review the candidate and its callers; identify the real withdrawal/payout request ID and service boundary from logs; correlate runtime configuration; inspect datastore state only with later authorization; verify tests/runtime traces before causality.
- elapsed time: literal 2.240 s; exact 0.658–0.763 s; selected flow 7.032 s; coverage 0.058 s.
- exit/status/error code: successful envelopes; initial no-match incomplete.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial, unresolved 103958.
- candidateCount/returnedCount/totalIsExact: literal 0/0/false; withdrawal 447/10/false; selected flow 17 candidates with proof not_proven.
- cursor/hasMore/truncated: discovery truncated true.
- evidence origin/method/confidence: lexical source/symbol candidate and static context/flow; no runtime causality.
- dynamic IDs and the result that emitted them: Q5 selected node and returned direct calls/tests.
- workaround count: 2 query refinements.
- verdict: PASS for honest triage; no root cause claimed.
- confidence: high for locators, low for business-gate relevance.

### B2 — dynamic gRPC request investigation

- scenario: trace the Q7 page-two gRPC endpoint to the supported frontier.
- surface: CLI and MCP.
- exact command/tool and exact inputs: endpoint page 1/page 2; endpoint-identity; context/flow/graph/callers/callees for endpoint and handler.
- bounded raw evidence: request-trace memo is endpoint node_34182942-61ef-40a1-82b8-720902e799ba → handles → handler node_865365a4-384c-4150-a9c0-374dc6d92386 → calls → service query node_f1e90f30-8154-45dd-82ff-118d7d04c785 → calls → repository aggregateReportRows node_ca45eae1-92c2-4546-8c1f-257de6d200f8 → calls → base aggregate node_66424dbe-90c0-4497-8fe6-f61d01478689. Related test node_ff666136-a1a6-44ae-9221-20d863c6f391. Only the first hop includes EXTRACTED/confidence 1 metadata. Actual datastore/external execution and runtime behavior require source and trace review.
- elapsed time: page 2 0.581 s; identity 0.071 s; flow 6.379–10.751 s.
- exit/status/error code: success.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial/not_proven.
- candidateCount/returnedCount/totalIsExact: endpoint 610/5/true; MCP flow 29/29 with exhaustive proof unavailable.
- cursor/hasMore/truncated: endpoint page 2 continued by raw cursor; truncation true.
- evidence origin/method/confidence: first hop proven/EXTRACTED/1; later static calls lack populated origin/confidence.
- dynamic IDs and the result that emitted them: all memo IDs were emitted in Q7–Q9.
- workaround count: 0.
- verdict: PASS.
- confidence: high to the stated frontier.

### B3 — safe-change decision

- scenario: use callers/callees/affected/tests/routes evidence to decide whether changing the Q5 symbol is safe.
- surface: CLI and MCP.
- exact command/tool and exact inputs: context, callers, callees, affected file, impact node, affected node for updatePlatformConfig.
- bounded raw evidence: controller caller, notifier/config/processor callees, unit spec, and gRPC admin.AdminService.UpdatePlatformConfig route are returned. File-target affected returned 29 candidates but omitted tests/routes that node-target MCP exposed. All code evidence is fresh, but coverage is partial and unresolved references remain. Decision: CONDITIONAL, not unconditional GO.
- elapsed time: affected 0.931–1.443 s; impact 0.590 s; context as Q18.
- exit/status/error code: success.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial/lower_bound; unresolved 103958.
- candidateCount/returnedCount/totalIsExact: file 29/29/not proven; node impact 1/1/not proven.
- cursor/hasMore/truncated: no cursor; lack of truncation is not completeness proof.
- evidence origin/method/confidence: indexed static relations, not runtime change-safety proof.
- dynamic IDs and the result that emitted them: selected symbol, caller/controller, unit-test node.
- workaround count: 0.
- verdict: PARTIAL; decision is CONDITIONAL pending source review and targeted tests.
- confidence: high.

### B4 — semantic recall honesty

- scenario: compare exact and conceptual business retrieval with semantic off/blend/semantic.
- surface: CLI and MCP.
- exact command/tool and exact inputs: exact updatePlatformConfig; literal withdrawal/payout question; knowledge_search semantic off, blend, semantic.
- bounded raw evidence: exact lexical retrieval works and is reproducible. Concept prompt is empty/incomplete. Blend and semantic explicitly skip the semantic lane with async_semantic_lane_required and SEMANTIC_LANE_UNAVAILABLE. No semantic hit is mislabeled as a graph fact; graph/lexical fallback remains usable.
- elapsed time: exact 0.658–0.763 s; literal 2.240 s; semantic median 0.124 s, max 0.463 s.
- exit/status/error code: success envelopes plus unavailable warning.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial.
- candidateCount/returnedCount/totalIsExact: exact 21/21/false; concept/semantic 0/0/false.
- cursor/hasMore/truncated: exact total is not exact; conceptual empty is not absence.
- evidence origin/method/confidence: source/symbol lexical lanes; semantic lane skipped.
- dynamic IDs and the result that emitted them: selected Q5 node from lexical discovery only.
- workaround count: 0 in the semantic comparison.
- verdict: PASS for honesty; semantic/vector UNAVAILABLE.
- confidence: high.

### B5 — service-map collision investigation

- scenario: investigate one current repeated service label and carry a stable ID.
- surface: CLI and MCP; GUI N/A.
- exact command/tool and exact inputs: services/service_graph plus node/graph/path for repo_5513e90d-a231-455e-9feb-d15d69e93b38.
- bounded raw evidence: no repeated display label exists in the current 20-node graph, so a true collision scenario cannot be manufactured. The singled-out FPMS-NT-Auth-Player label appears once. Its emitted stable service ID does not resolve through node, graph, or path, which is an independent identity-continuation failure. No GUI comparison was permitted.
- elapsed time: service graph 0.267 s; node 2.272 s; path 0.740 s.
- exit/status/error code: graph success; follow-ups node not found/TARGET_NOT_FOUND.
- repo/branch/snapshot/revision: multi-repo service graph; follow-up revision unresolved.
- freshness: current graph generation; per-service revision unavailable.
- coverage: 20 nodes/87 edges, zero repeated titles observed.
- candidateCount/returnedCount/totalIsExact: 20/20/exactness unavailable.
- cursor/hasMore/truncated: none.
- evidence origin/method/confidence: service graph only.
- dynamic IDs and the result that emitted them: service ID above.
- workaround count: 0.
- verdict: N/A for the required repeated-label collision because none exists; stable-ID usability separately FAILS.
- confidence: high.

### B6 — three-surface continuity

- scenario: continue endpoint/file-symbol/dead-code cursors in new processes/sessions, then replay a node ID through CLI and MCP.
- surface: CLI and MCP; Agent B is the required new-session surface.
- exact command/tool and exact inputs: Agent A Q14 raw cursor continuations and packet context inputs; Agent B continued the exact Agent A endpoint cursor, replayed CLI+MCP context for node_3ea02dfa-66da-4570-8872-fde857971da1, and independently requested file-symbol/dead-code page 1 limit 2 then continued each emitted cursor in a fresh CLI process. Agent B used Penguin help after file-symbols was rejected; help identified the valid filesymbols spelling.
- bounded raw evidence: Agent A endpoint cursor crossed into the independent Agent B session, was accepted/not expired, and returned node_34182942, node_5628002b, node_102a8f36, node_dba69c40, node_7cbb51dd with 600 remaining. file_symbols and dead_code advertise supportsCursor true. Agent B file-symbol page 1 returned AdminService/node_cf6d3277 and constructor/node_6ff9195f, candidate 18/remaining 16; a fresh CLI continuation returned onModuleInit/node_ff76f169 and signIn/node_49c3b4f9, remaining 14, with no overlap. Agent B dead-code page 1 returned constructor/node_6ff9195f and onModuleInit/node_ff76f169, candidate 4/remaining 2; fresh continuation returned onModuleDestroy/node_485dcf53 and onApplicationShutdown/node_82aff638, remaining 0, with no overlap. Dead-code stayed candidate-only with dynamic_dispatch_and_di_not_proven. Limitation: the file-symbol/dead-code cursors were generated live by Agent B, not the Agent A cursors preserved in Q14; only the endpoint cursor proves Agent A→Agent B token handoff.
- elapsed time: Agent A endpoint page 2 0.581 s, file-symbol page 1 0.085 s, dead-code page 1 1.883 s; Agent B per-call times were not supplied.
- exit/status/error code: endpoint, valid filesymbols/dead-code pages, and node replays succeeded. Initial file-symbols spelling was rejected; Penguin-help correction to filesymbols succeeded. No cursor expired.
- repo/branch/snapshot/revision: exact stable FPMS-NT scope/revision for endpoint/context/file-symbol; dead-code candidate scope as emitted.
- freshness: fresh.
- coverage: partial; dead-code candidate-only.
- candidateCount/returnedCount/totalIsExact: endpoint continuation 610/5/true, remaining 600; Agent B file-symbol 18/2 with 16 then 14 remaining; Agent B dead-code 4/2 with 2 then 0 remaining. Exactness for the Agent B file/dead totals is as emitted; dead-code unusedness is still not proven.
- cursor/hasMore/truncated: Agent A endpoint cursor portable across sessions; Agent B file-symbol/dead-code cursors portable across fresh CLI processes; no overlaps or expiries. Agent A→Agent B portability for the latter two specific raw tokens was not tested.
- evidence origin/method/confidence: emitted cursor contracts, independent session/process evidence, and Penguin help. The help-based command spelling discovery is an allowed Penguin surface.
- dynamic IDs and the result that emitted them: endpoint continuation IDs and Agent B file-symbol/dead-code node IDs listed above; Q5 node round-tripped CLI+MCP.
- workaround count: repairs 0; substituted IDs 0; expired cursors 0; workarounds 0; command-discovery correction 1. The correction is disclosed but is not a cursor/ID repair.
- verdict: PASS; bounded label PASS_PACKET_SUFFICIENT_LIMITED. The packet was sufficient for endpoint and node continuity; file-symbol/dead-code continuity is proven only with Agent-B-generated cursors.
- confidence: high for tested continuations; medium for the untested Agent A→Agent B file-symbol/dead-code raw-token handoff.

### B7 — degraded-environment recovery

- scenario: use naturally occurring MCP doctor and semantic failures without breaking configuration.
- surface: CLI and MCP.
- exact command/tool and exact inputs: knowledge_doctor {}; penguin doctor --json; semantic/blend Q2 call; lexical search/context/flow fallbacks.
- bounded raw evidence: MCP doctor returned QUERY_TIMEOUT at 30000 ms while CLI doctor returned status ok with ledger/materialized counts and graph totals. Semantic is unavailable, while lexical search and graph remain usable. MCP overall is not unavailable: health, capabilities, endpoints, search, context, flow, API and typed errors worked. Product gaps are timeout retry metadata and semantic readiness; environment gap is degraded evidence for native/session/reload identity. No repair was attempted.
- elapsed time: MCP doctor over 30 s; CLI doctor median 5.724 s; semantic median 0.124 s.
- exit/status/error code: QUERY_TIMEOUT retryable false; CLI doctor exit 0; semantic success warning.
- repo/branch/snapshot/revision: stable FPMS-NT scope where applicable.
- freshness: fresh.
- coverage: partial.
- candidateCount/returnedCount/totalIsExact: CLI doctor graph nodes 748840/edges 1724945; semantic 0/0/false.
- cursor/hasMore/truncated: N/A to doctor; graph/lexical cursors remain usable.
- evidence origin/method/confidence: current runtime/tool envelopes.
- dynamic IDs and the result that emitted them: current Q5/Q7 IDs remained usable during degraded cases.
- workaround count: 0 repairs; documented read-only CLI fallback used.
- verdict: PASS for recovery discipline; environment remains DEGRADED.
- confidence: high.

### B8 — final one-page decision packet

- scenario: synthesize Round 18 without averaging product and environment scores.
- surface: CLI and MCP evidence in this report.
- exact command/tool and exact inputs: all Q1–Q20 and B1–B7 calls; exact retest calls appear in Section 13.
- bounded raw evidence: product 71/100 with Product-79 stable-ID cap; environment 72/100 with two distinct coordinator session/process IDs and no longer subject to the Environment-69 fresh-session cap; literal process non-compliance applies a no-95+ ceiling to the run. Graph/lexical is useful but conditional; semantic unavailable; CLI/MCP parity partial; fresh two-session invocation and packet replay proven, with exact model/PID/server-process identity not exposed.
- elapsed time: representative medians/maxima in Q18.
- exit/status/error code: positive calls, structured errors, unavailable warning, and timeout all preserved.
- repo/branch/snapshot/revision: stable FPMS-NT scope.
- freshness: fresh.
- coverage: partial, unresolved 103958.
- candidateCount/returnedCount/totalIsExact: preserved per scenario.
- cursor/hasMore/truncated: all three cursor classes tested by Agent A; Agent A endpoint cursor accepted by Agent B; Agent B file-symbol/dead-code continuations used newly generated Agent B cursors.
- evidence origin/method/confidence: Penguin findings remain current Penguin output; session/process separation is coordinator evidence. The post-evaluation SKILL.md self-check was not evaluation evidence and is disclosed as a literal boundary violation.
- dynamic IDs and the result that emitted them: dynamic table, outbound packet, and Agent B replay result.
- workaround count: discovery 2; API input key 1; Agent B repairs/substitutions/expiries/workarounds 0; command discovery correction 1; prescribed remediation 1.
- verdict: PARTIAL; PRODUCT TRUST CONDITIONAL and ENVIRONMENT DEGRADED.
- confidence: high.

## 6. Graph/lexical capability verdict

Graph/lexical score: 68/93 available non-semantic product points, approximately 73% — CONDITIONAL.

Strengths: reproducible exact identifiers, current scoped locators, Agent A→Agent B endpoint-cursor continuity without expiry, exact cross-session Q5/Q7 IDs and endpoint→handler edge, stable typed scope error/remediation, useful direct-call/test/route candidates, fresh revision identity, explicit coverage debt, and disciplined lower-bound envelopes.

Limits: literal business-intent and path-qualified searches can return no match; Agent B’s CLI file affected returned 29 lower-bound candidates while exact MCP file affected returned only the file node and zero impacted; Agent B flow added a depth-5 async node beyond Agent A’s packet frontier at the same revision; deeper edges omit origin/confidence; file-symbol/dead-code Agent A→Agent B raw-token handoff was not tested; coverage debt is aggregate-only; service-map IDs do not round-trip. Penguin is safe for discovery and bounded navigation, not for business causality, complete deeper flow, affected parity, or absence without later evidence.

## 7. Semantic/vector capability verdict

SEMANTIC/VECTOR: UNAVAILABLE. Honesty score 3/7.

The contract advertises semantic/blend selection, and the real calls explicitly report async_semantic_lane_required and SEMANTIC_LANE_UNAVAILABLE. That is preferable to silent fallback, so capability honesty passes. No persisted retrieval, model/space, provider, dimension, ready-vector/chunk count, vector health, or semantic provenance was exposed. Suggestions returned during a semantic request are not hits and were not treated as proof.

## 8. Cross-repo/service-label identity verdict

Current repeated display labels: none observed, so duplicate collision is N/A. FPMS-NT-Auth-Player appears once. However, its current emitted service ID repo_5513e90d-a231-455e-9feb-d15d69e93b38 cannot be consumed by node, graph, or path. Identity usability therefore FAILS even without a collision. No repository scope silently crossed during either session’s code-node follow-ups; Agent B reproduced SCOPE_MISMATCH with exact requested/actual revisions and the prescribed owning-scope remediation succeeded.

## 9. Operations safe without source reading

- Discover installed command spelling and callable/read-only versus mutating surfaces from current help/capabilities.
- Select a repository/branch and inspect current freshness, revision, and aggregate coverage.
- Run scoped lexical discovery and treat results as candidates.
- Continue emitted code node IDs through context, direct graph, flow, callers/callees, endpoint identity, and affected.
- Prove the current endpoint→handler relation when Penguin supplies edge state, method, confidence, provenance, scope, and revision.
- Enumerate endpoints, file symbols, dead-code candidates, service-map nodes, and stale API objects.
- Carry current cursors across CLI/MCP processes and inspect typed invalid/scope errors.
- Hand a bounded packet containing current scope/IDs/edge/cursor/error to a separate session and replay exact context, endpoint cursor, and remediation without target substitution.
- Build source/log review checklists and name an evidence frontier.

## 10. Operations requiring source, logs, DB, runtime evidence, or human review

- Decide where the withdrawal/payout allow/deny/proceed rule truly lives or claim a root cause.
- Confirm that a returned static call executes for a specific request or reaches a particular live database/external service.
- Treat either Agent A’s aggregate frontier or Agent B’s additional async depth-5 node as an exhaustive request-flow terminus.
- Treat CLI/MCP file-target affected outputs as equivalent or complete without resolving the observed 29-versus-0 impacted divergence.
- Prove absence of callers, tests, dead code, routes, duplicate-label routing effects, or impacted files under partial coverage.
- Validate runtime test coverage, DI/reflection/dynamic-dispatch paths, authorization, transaction behavior, side effects, and error handling.
- Approve an unconditional code change using the current affected envelope.
- Treat stale API documentation as current code truth or infer missing authorship/redaction/source provenance.
- Prove installed-runtime self-containment, Codex/Claude configuration, release signing, exact model/PID/server-process identity, or raw initialize details from the session IDs alone.

## 11. Product defects versus environment failures versus unproven claims

### Product defects/gaps

| Finding | Evidence |
| --- | --- |
| Concept and path-qualified retrieval weakness | Literal business and path-qualified queries return NO_MATCH_INCOMPLETE while a broad token query yields 447 candidates |
| Semantic contract lacks an available runtime/readiness record | async_semantic_lane_required; no model/provider/dimensions/vector counts |
| Service graph IDs are not consumable by node/graph/path | emitted repo_5513... fails all three follow-ups |
| Coverage debt is visible but not actionable | excluded 7/unresolved 103958 but items/gaps/exclusions are empty |
| File-target affected diverges across CLI/MCP | Agent B CLI returned 29/29 lower-bound candidates; exact MCP file target returned only file node node_a87f5401-df34-4230-ae75-bfc8a9d3b5d1 and 0/0 impacted |
| Deeper flow varies across sessions | same revision and stable endpoint/handler edge, but Agent B adds async node_b38eac89-6c43-4aec-ba79-d980676d00d1 beyond Agent A’s packet frontier |
| Wiki/API input/provenance defect | preview_id works; previewId causes INTERNAL/ENOENT; schema generic; stale object lacks source revision/author/type/redaction |
| Read-only link inventory is advertised but unavailable | manifest link.list has no live read tool |
| Error classification gaps | semantic unavailable is a success warning; file-symbol wrong-scope can be masked by FILE_NOT_FOUND |
| MCP doctor timeout contract incomplete | QUERY_TIMEOUT lacks explicit timedOut, partial evidence, and safe narrower retry |

### Environment failures/gaps

| Finding | Evidence |
| --- | --- |
| Fine-grained process identity unavailable | distinct conversation/process invocation IDs prove freshness, but exact models, process start timestamps, client/server PIDs, server-process identity, and raw initialize envelopes are not exposed |
| Launcher/config state not proven | mcp_health configured null and launcherHealthy null |
| Runtime self-containment and native semantic health not observable | successful calls do not expose execution dependency provenance |
| Release/signing evidence absent | no current Penguin/client surface returned it |
| Literal process boundary violated after evidence collection | Agent A read verification-before-completion SKILL.md after creating the report; it did not affect findings, but the brief’s no-95+ compliance ceiling applies |

### Limitation matrix

| Boundary | What is proven | What remains limited/not proven | Consequence |
| --- | --- | --- | --- |
| Fresh sessions | Distinct Agent A 01a054fe-d593-72b3-aa60-d7c8473c8cfb and Agent B 01a05515-bdb5-76d1-a562-e1811209e410 process/conversation invocations; packet-only B replay | Exact model, process start timestamp, client/server PID, server process identity, raw initialize | Environment receives 17/20, not full |
| Generation/contract | Same build, schema, contract, hash, 82 tools, 99 implemented capabilities, exact scope/revision across sessions | Full tool annotations and server-process identity | Q17 PARTIAL |
| Graph flow | Exact endpoint/handler/proven first edge across sessions | Agent B adds depth-5 async node; completeness partial; datastore/external hop not proven | Deeper chain cannot be treated as exhaustive |
| Affected | Both surfaces return typed current-revision evidence | CLI 29 lower-bound candidates versus MCP 0 impacted plus file node | Safe-change remains CONDITIONAL |
| Cursor handoff | Agent A endpoint cursor accepted by Agent B, no expiry/repair | Agent B used its own file-symbol/dead-code cursors | B6 PASS_PACKET_SUFFICIENT_LIMITED, not full three-token handoff |
| Negative callers | One exact enumerated caller returned in CLI/MCP | Overall lower_bound and 103958 unresolved references | Exclusivity/absence not proven |
| Process compliance | Penguin evidence itself remained black-box; external skill read occurred only after evidence/report creation | Skill read is outside literal allowed surfaces | Run non-compliant; no-95+ ceiling |

### Unproven claims

- The Q5 candidate is the withdrawal/payout progression gate or the incident root cause.
- The Q7 path reaches a live datastore/external service in the observed request.
- Empty specialized callers means no production caller.
- Indexed test relations prove runtime coverage.
- No service-label routing ambiguity exists in all states.
- Agent A’s or Agent B’s deeper flow is exhaustive or proves a live datastore/external hop.
- CLI and MCP affected outputs are semantically equivalent or complete.
- Exact model/PID/server-process identity or raw initialize details are known.

## 12. Ordered improvements with impact, cost, and executable acceptance tests

| Order | Improvement | Impact | Cost | Direct acceptance test |
| ---: | --- | --- | --- | --- |
| 1 | Make semantic runtime state explicit and either serve persisted scoped retrieval or a typed unavailable error | High: removes the largest readiness ambiguity | L | Call knowledge_search with the Q5 prompt and semantic mode; require either scoped semantic hits with model/provider/dimensions/vector and chunk counts/provenance, or isError with SEMANTIC_LANE_UNAVAILABLE and remediation; no suggestions-as-hits |
| 2 | Make service-map stable IDs first-class node/path/graph inputs | High: fixes Product-79 cap and collision investigations | M | rtk proxy penguin node repo_5513e90d-a231-455e-9feb-d15d69e93b38 --json and graph/path equivalents must resolve the same stable service identity without title reconstruction |
| 3 | Align CLI/MCP affected semantics for the same exact file target | High: current 29-versus-0 divergence blocks safe-change trust | M | In two fresh clients, run affected on apps/admin/src/admin/admin.service.ts through CLI and knowledge_affected with exact target=file; require equivalent impacted/tests/routes sets or explicit documented semantic labels explaining every difference |
| 4 | Improve business-intent and path-qualified search | High: reduces two discovery refinements and false no-match | L | Run the exact Q5 question and apps/admin/src/admin/admin.service.ts:updatePlatformConfig twice in fresh CLI plus MCP; require actionable FPMS-NT results, stable IDs, and explicit lanes |
| 5 | Expose paginated coverage-debt items | High: makes completeness decisions auditable | M | rtk proxy penguin coverage FPMS-NT --limit 1 --json must emit at least one of the seven excluded items with path/type/reason and a portable cursor, or an explicit reason that item details are unavailable |
| 6 | Make deeper-flow bounds and ordering reproducible | Medium-high: same-revision sessions currently expose different terminal depth | M | Replay flow for node_34182942-61ef-40a1-82b8-720902e799ba in two fresh sessions; require identical bounded nodes/order or explicit depth/budget/truncation metadata explaining why async node_b38eac89-6c43-4aec-ba79-d980676d00d1 appears |
| 7 | Publish canonical MCP input schemas and alias behavior | Medium: prevents INTERNAL errors and parity workarounds | S | api_doc_show schema must require preview_id; valid documented input succeeds, invalid previewId returns INVALID_ARGUMENT rather than INTERNAL/ENOENT |
| 8 | Make MCP doctor timeout actionable | Medium: improves degraded recovery | M | knowledge_doctor must finish under hardTimeoutMs or return timedOut true, exit/status, any partial evidence, retryable classification, and a copyable narrower/safe retry |
| 9 | Expose full session/process identity in initialize and health | Medium: completes already-proven two-conversation generation evidence | M | Two independent clients must return exact client/server process identity or stable generation instance ID plus raw initialize metadata while preserving the same build/hash/schema/node/error replay |
| 10 | Expose a callable read-only link list and resolvable backlinks | Medium: completes Wiki continuity | M | tools/list must include knowledge_link_list with read-only annotation; listing and a backlink lookup for an emitted note/node must return scope/revision/provenance or a typed unavailable result |

## 13. Exact B8 one-page decision packet

ROUND: 18  
PRODUCT TRUST: CONDITIONAL — 71/100; Product-79 stable-ID cap and literal no-95+ process-compliance ceiling  
ENVIRONMENT: DEGRADED — 72/100; fresh-session cap removed after independent replay  
GRAPH/LEXICAL: 68/93 (73%) — CONDITIONAL  
SEMANTIC/VECTOR: UNAVAILABLE  
CLI/MCP PARITY: 15/20 (75%) — PARTIAL  
FRESH SESSION: PROVEN  
SAFE WITHOUT SOURCE: current help/capability discovery; repo/freshness/coverage checks; scoped candidate search; emitted-ID context/flow/endpoint navigation; proven endpoint-handler relation; Agent A→Agent B endpoint-cursor and exact node/error replay; typed-error inspection; stale API inventory  
REQUIRES SOURCE/LOG/DB/HUMAN: business-rule/root-cause claims; actual request/runtime/DB/external path; deeper-flow exhaustiveness; affected 29-versus-0 reconciliation; absence and dead-code proof; runtime test coverage; unconditional change approval; stale-document truth; duplicate-label routing; self-containment/config/process/release proof  
TOP 5 PRODUCT GAPS: semantic runtime/readiness unavailable; service-map stable IDs do not round-trip; CLI/MCP affected diverges; business/path-qualified search weak; coverage debt lacks concrete items and deeper flow varies  
TOP 3 ENVIRONMENT GAPS: configured/launcher state is null/not proven; exact model/process-start/client-server PID/raw initialize/self-containment evidence is unavailable; release/signing evidence is absent  
EXACT RETEST COMMANDS/TOOLS:  

    rtk proxy penguin search "Where does FPMS-NT decide whether a withdrawal or payout operation may proceed, and which returned evidence is only a candidate?" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin search "apps/admin/src/admin/admin.service.ts:updatePlatformConfig" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin node repo_5513e90d-a231-455e-9feb-d15d69e93b38 --json
    rtk proxy penguin context "node:node_3ea02dfa-66da-4570-8872-fde857971da1" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin flow "node:node_34182942-61ef-40a1-82b8-720902e799ba" --repo FPMS-NT --branch brazil-v2 --json
    rtk proxy penguin affected apps/admin/src/admin/admin.service.ts --repo FPMS-NT --branch brazil-v2 --json
    mcp__penguin__mcp_health {}
    mcp__penguin__knowledge_capabilities {"compact":true}
    mcp__penguin__knowledge_search {"query":"Where does FPMS-NT decide whether a withdrawal or payout operation may proceed, and which returned evidence is only a candidate?","repo":"FPMS-NT","branch":"brazil-v2","options":{"semantic":"semantic"}}
    mcp__penguin__knowledge_context {"target":"node:node_3ea02dfa-66da-4570-8872-fde857971da1","repo":"FPMS-NT","branch":"brazil-v2"}
    mcp__penguin__knowledge_affected {"target":"apps/admin/src/admin/admin.service.ts","repo":"FPMS-NT","branch":"brazil-v2"}
    mcp__penguin__knowledge_context {"target":"node:node_3ea02dfa-66da-4570-8872-fde857971da1","repo":"FPMS-NT-Payment","branch":"newzealand-v2"}
