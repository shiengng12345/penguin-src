# Penguin Wiki / Knowledge Evaluation Report — Round 14

Evaluator: Codex / GPT-5  
Evaluation date: 2026-08-30  
Session timestamp: date recorded; exact wall-clock time was not exposed by the allowed Penguin surfaces.  
Agent type: Codex.  
Repository under test: `FPMS-NT`, branch `brazil-v2`.  
Evaluation mode: read-only; no source, database, Git, browser, release, packaging, signing, or indexing mutation was used.

## 1. Environment and fresh-session setup.

The allowed CLI fallback was used at:

```text
runtime: /Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
bundle: /Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs
wasm: /Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm
```

The first wrapper attempt failed before Penguin started because `rtk proxy` does not parse a shell-style leading environment assignment. The retry using `env PENGUIN_WASM_DIR=... runtime bundle ...` succeeded. Workaround count: 1.

CLI setup results:

- `help --json`: exit 0; exposed `endpoints`, `endpoint-identity`, `filesymbols`, `deadcode`, `search`, `node`, `callers`, `calls`, `callees`, `impact`, `context`, `explore`, `flow`, `affected`, `coverage`, and `onboarding`, among others. Cursor contract says ordering is `filePath,startLine,nodeId`, scope is checked, exhaustion is `nextCursor:null`, and invalid cursors use exit code 2.
- `capabilities --json`: exit 0; `schemaVersion=14`, `contractVersion=2`, `capabilityHash=40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`.
- `status --compact --json`: exit 0; FPMS-NT is `fresh`, `dirtyFileCount=0`, `indexedCommit=headCommit=3f0f1984b9e4337668529a13bad5264501729908`, `indexErrorCount=0`.
- `doctor --json`: exit 0; `ledgerSeq=12348`, `materializedSeq=12348`, `status=ok`, `nodes=1004663`, `edges=4430749`, `pendingSuggestions=1`.
- `coverage --repo FPMS-NT --json`: exit 0; `discovered=3340`, `admitted=3333`, `excluded=7`, `failed=0`, `stale=0`.
- `onboarding FPMS-NT`: exit 0; identified `/Users/shieng/Desktop/Projects/fpmsnt`, 3333 indexed files, 13710 fresh symbols, six key entry points, and the recommended order `Search → Context → Graph → Evidence`.

MCP was available through the configured Penguin server. `mcp_health` returned `status=ok`, `nodeVersion=v22.23.1`, `penguinRoot=/Users/shieng/.penguin`, `runningBuildId=availableBuildId=12765c69a2ed6a33`, `outdated=false`, `workers=2`, and `hardTimeoutMs=15000`. One MCP `knowledge_doctor` call timed out with `QUERY_TIMEOUT`; the CLI doctor call succeeded. This is recorded as both a runtime behavior and a parity difference, not silently ignored.

Fresh FPMS-NT evidence from MCP:

```json
{"branch":"brazil-v2","headCommit":"3f0f1984b9e4337668529a13bad5264501729908","indexedCommit":"3f0f1984b9e4337668529a13bad5264501729908","worktreeState":"clean","stale":false,"changedFiles":0,"coverageGaps":[]}
```

The MCP capability manifest exposed registration and schemas for the required read-only operations. The available host did not expose a controllable `tools/list` or an explicit MCP session-reset operation, so a separately initialized MCP session was `not proven`.

## 2. Capability/readiness split and scores /100.

These are evaluation scores, not release gates. They score the observed contract and evidence behavior separately from local environment readiness.

| Dimension | Score | Evidence-based reason |
|---|---:|---|
| Agent discoverability | 82 | Help, capabilities, and onboarding are useful; MCP endpoint scope behavior is misleading. |
| Context usefulness | 85 | `context` and `explore` provide locators, source packs, callers/callees, routes, provenance, and next boundaries. |
| Accuracy | 78 | Positive symbol and endpoint identity resolution is strong, but MCP scope can contaminate an ambiguous node and an invalid `commit_sha` was silently ignored. |
| Completeness | 62 | FPMS-NT has 7 excluded files; some relations report 103925 unresolved references; calls and flows are explicitly lower bounds. |
| Honesty | 88 | `not_proven`, `lower_bound`, `partial`, `COVERAGE_INCOMPLETE`, inferred, external, and `no_static_edge` warnings are generally surfaced. |
| MCP/CLI parity | 55 | Search/filesymbols/context/flow broadly align; endpoint scope, invalid-cursor error shape, and some field wrappers do not. |
| Continuity | 74 | Fresh CLI processes preserve node IDs and cursors; MCP fresh-session replay could not be independently initialized. |
| Usability | 76 | Copyable commands and repair suggestions exist, but some errors are not actionable and command syntax is inconsistent across surfaces. |
| Speed | 70 | Most CLI calls were sub-second; MCP search/explore was usable, while MCP doctor hit the 15-second hard timeout. |
| Product overall | 75 | Strong bounded navigation and evidence packaging; unsafe as a sole source for negative or complete-impact claims. |
| Environment readiness | 80 | MCP health, runtime generation, FPMS-NT freshness, coverage, and CLI bundle are usable; doctor timeout and lack of explicit session reset remain. |

Capability score and environment readiness are deliberately separate: the local FPMS-NT index is ready for focused queries even though several client-contract defects remain.

## 3. Q1–Q17 answers with exact commands/tools, raw evidence, confidence, scope, freshness, coverage, completeness, counts, cursor/truncation, and workaround count.

Shared evidence envelope for the FPMS-NT queries below: scope `repo=FPMS-NT`, branch `brazil-v2`, commit `3f0f1984b9e4337668529a13bad5264501729908`, snapshot `legacy:branch_10012ad4-067a-4749-aafb-7a9c4f5c133d`, worktree `clean`, freshness `fresh/aligned`, coverage `3340 discovered / 3333 admitted / 7 excluded / 0 failed`. Where a query reports another scope, that is called out explicitly.

### Q1 — contract boot and capability truthfulness

Commands/tools: CLI `help --json`, `capabilities --json`, `status --compact --json`, `doctor --json`, `coverage --repo FPMS-NT --json`, `onboarding FPMS-NT`; MCP `knowledge_capabilities`, `mcp_health`, `status_panel`.

Observed capability classes:

- Read-only: `search`, `get_hit`, `coverage`, `capabilities`, `index_status`, `status_panel`, `context`, `explore`, `flow`, `files`, `file_symbols`, `callers`, `callees`, and `endpoints` where registered.
- Graph: `callers`/`callees`, `impact`, `path`, `architecture`, `service_graph`, `local_graph`, and `graph.query`.
- Pagination: `endpoints`, `filesymbols`, `deadcode`, and search all expose cursor fields in the CLI contract; observed CLI pages carry `candidateCount`, `returnedCount`, `totalIsExact`, `truncated`, and `nextCursor`.
- Negative-result surfaces: empty search, unresolved context targets, `no_static_edge`, and dead-code candidates. They carry useful warnings in some surfaces but not all.

Raw excerpts: CLI help reports `callees` and cursor `invalidExitCode=2`; MCP health reports matching running/available build IDs; CLI doctor is `status=ok`; MCP doctor returned `QUERY_TIMEOUT` with `retryable=false`.

Verdict: discoverability is good, but “registered”, “implemented”, and “healthy at runtime” are distinct. MCP doctor is registered but timed out; endpoint MCP registration did not honor the passed scope. Confidence: high for the observed client contract, medium for universal runtime health. Completeness: partial. Cursor: available. Workarounds: 1 wrapper syntax workaround; 1 CLI fallback for MCP doctor timeout.

### Q2 — source-pack usefulness without source reading

Commands/tools: CLI `filesymbols FPMS-NT apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --json`; CLI `search getActiveEventConfigByObjId --repo FPMS-NT --json`; MCP `knowledge_search`, `knowledge_context`, `knowledge_explore`.

Fresh emitted focus ID: `node_af26e1f8-17f5-473b-b76c-e33a150abfac`. `filesymbols` returned 10 symbols, including `getActiveEventConfigByObjId` at lines 135–156. MCP search returned one scoped symbol hit with a verified locator and the same node ID. MCP explore with `include_sources=true` returned the focus source pack with `truncated=false` and `sourcesOmitted=[]`, plus callers, one direct callee, importers, provenance, confidence, revision, and warnings.

The pack is sufficient to prepare a source-review checklist: inspect the three callers, the cache callee, the 20 importer files, the public route/endpoint relationship if later surfaced, and the missing tests. It is not sufficient to claim semantic correctness. Confidence: high for locator and source-pack delivery. Completeness: `lower_bound` for calls; QD reports `partial` when unresolved references are included. Cursor: filesymbols pageable, first page 3/10. Workarounds: 0.

### Q3 — dynamic identifier handoff matrix

Fresh IDs emitted in this evaluation:

| Origin | Fresh ID | Follow-up result |
|---|---|---|
| `filesymbols` | `node_af26e1f8-17f5-473b-b76c-e33a150abfac` | `context`, `flow`, `callers`, `callees`, and CLI `affected` resolved under FPMS-NT; revision preserved. |
| `search` | `node_60f4c2d2-f94c-4069-bef9-646d88b32838` (`playDice`) | Same four follow-ups resolved; context reported 1 caller and 19 calls; completeness partial with 6 external calls. |
| ambiguous `explore constructor` candidate | `node_77ae6441-5809-4e55-a1df-4d981a40c7b1` | Follow-ups accepted the ID, but diagnostics resolved the node to `FPMS-NT-Auth-Player/email-ue`, not FPMS-NT. This is a scope-contamination defect. |
| endpoint page two | `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | `context` and `flow` accepted the ID; flow found the `proto` handler/service. `callers`/`callees` returned `no_static_edge` with `totalIsExact=true`, which is not absence proof. |

Exact tools: MCP `knowledge_context`, `knowledge_flow`, `knowledge_callers`, `knowledge_callees`; CLI `endpoints FPMS-NT --protocol grpc --limit 3 --json` and cursor continuations. Freshness was fresh for FPMS-NT IDs. Candidate counts were exact only for the bounded returned relation, not for graph completeness. Workarounds: 1 — reject an ambiguous candidate unless its returned repository identity matches the requested scope.

### Q4 — scoped search and collision containment

Commands/tools: MCP `knowledge_search` with global and `repoName=FPMS-NT, branch=brazil-v2` scopes for `constructor`, `execute`, and `update`; MCP `knowledge_explore target=constructor`; CLI search for scoped symbol evidence.

The scoped searches returned `NO_MATCH_INCOMPLETE` for the three bare terms even though the wider indexed corpus contained spelling suggestions. The response correctly included `COVERAGE_INCOMPLETE`, `NO_MATCH`, `scopeApplied=true`, and suggestions. The ambiguous `constructor` explore returned 20 candidates, but the first candidate belonged to Auth-Player despite the FPMS-NT request. A follow-up using that emitted ID preserved the wrong node identity while the outer revision metadata still showed FPMS-NT. This means candidate repository identity is not safely contained across ambiguous handoff.

Verdict: warnings are present, but collision containment fails for ambiguous node IDs. Confidence: high. Completeness: unknown for no-match results; coverage incomplete. Cursor: not used. Workarounds: 1 — use path-qualified or repository-qualified symbol identity and verify returned repo before every follow-up.

### Q5 — endpoint inventory as a paged work queue

Command: `endpoints FPMS-NT --protocol grpc --limit 3 --json`, followed by fresh CLI processes using each returned `nextCursor`.

Observed pages:

| Page | Items selected | returned/candidate | exact | cursor |
|---:|---|---:|---|---|
| 1 | `AccountActivityService.GetAccountActivityRecord`; `AccumulativeBetRewardFrontendService.GetAccumulativeBetRewardProgression`; `AccumulativeEventConfigAdminService.CreateAccumulativeEventConfig` | 3/1535 | false | non-null |
| 2 | `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs`; `...UpdateAccumulativeEventConfig`; `AdminGrowthTaskService.CreateTaskConfig` | 3/1532 | false | non-null |
| 3 | `AdminGrowthTaskService.DeleteTaskConfig`; `...GetGrowthTaskHitCount`; `...GetGrowthTaskUserTags` | 3/1529 | false | non-null |

The first page and page two had no duplicate IDs in the observed sample. Ordering follows title/node ID. Page-two selection ID: `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`. CLI inventory marked the selected endpoint `handlerStatus=handled`; its handler title was `proto` and the handler repository ID was the indexed Rust repository. MCP flow independently returned endpoint → `proto` service via `handles`.

Because `totalIsExact=false` and 1535 candidates exist, three pages are a work-queue sample, not exhaustion. Confidence: high for pagination mechanics and page-two selection; medium for full inventory. Completeness: lower bound for flow. Workarounds: 0.

### Q6 — five-form endpoint identity equivalence

Tools: CLI `endpoint-identity` with `--title`, `--identity`, and `--node`; CLI `flow` and `context` with the slash route and invalid canonical identity.

For the selected endpoint, the following three forms resolved equal:

```json
{"forms":[{"status":"resolved"},{"status":"resolved"},{"status":"resolved"}],"equal":true,"rootNodeId":"node_ec762949-fbcc-4387-aa8e-f1ba65f6d626","completeness":"complete"}
```

The slash form `/AccumulativeEventConfigAdminService/GetAccumulativeEventConfigs` resolved in `flow` to the same endpoint and `proto` service, with `proofStatus=proven` for the bounded two-step result. The same slash form failed in `context` with `TARGET_NOT_RESOLVED`. The invalid `grpc::NoSuchService.noSuchMethod` failed with structured `TARGET_NOT_RESOLVED`, but did not include a retry suggestion. Confidence: high for the three-form equivalence, medium for slash interoperability because surfaces disagree. Completeness: complete only for endpoint identity; flow remains bounded. Workarounds: 1 — use `flow` for slash routes, or canonical identity/node ID for `context`.

### Q7 — request path with an explicit evidence frontier

Tools: endpoint inventory, MCP/CLI `context`, `flow`, `callers`, `callees`, and `explore`.

Handoff chain:

```text
endpoint node_ec762949-fbcc-4387-aa8e-f1ba65f6d626
  --handles--> service node_0fb2fbd0-1160-4b5c-b60a-28a62dc57463 (title: proto)
  --next--> no indexed repository/data candidate in the bounded flow
  --next--> no related test returned
```

The first evidence frontier is the handler/service boundary. The endpoint inventory says it is handled, and flow records the `handles` edge, but no application handler source locator or database/data boundary is emitted. `context` for the endpoint has no direct caller/callee list; `callers` and `callees` return `no_static_edge` with `totalIsExact=true` only for that edge query. It is not valid to claim database reachability or non-reachability. Confidence: high for the observed frontier, low for any beyond-frontier claim. Completeness: partial/lower bound. Workarounds: 1 — source review is required at the frontier.

### Q8 — simulated change-preparation packet

Target: `node_af26e1f8-17f5-473b-b76c-e33a150abfac`, `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135-156`.

Penguin-only packet:

- Direct callers: `verifyPlayerColorLand` at `color-land-auth.service.ts:30-182`, `playDice` at `dice.processor.ts:51-485`, and `buildContext` at `color-land-base-rule.service.ts:27-134`.
- Direct callee: `getColorLandEventConfigByIdFromCache` at lines 111–115.
- Importers: 20 file nodes, including production files and tests; method-level `tests=[]`.
- Provenance: parser `EXTRACTED`; inferred edges 0 for the focus method.
- Coverage: 3333 admitted / 7 excluded / 0 failed; target fresh and aligned.
- Context completeness: `lower_bound`; query diagnostics expose `unresolvedReferenceCount=103925` and `coverageGaps=[unresolved_references_present]`.
- CLI `affected node:<id>` returned 9 impacted candidates, 6 tests, and 2 gRPC routes; MCP path-based `affected` returned a broader candidate list. Neither proved a complete impact closure.
- Source review checklist: verify all three caller semantics; verify cache and time/status conditions; inspect all external/DI calls; inspect the listed test files; confirm endpoint/route reachability; rerun with explicit revision after any change; check excluded files and unresolved references.

Edit decision: `NO-GO`. Penguin alone provides a strong preparation packet, not enough proof for a safe edit or complete blast radius. Confidence: high for the packet, high for the NO-GO decision. Workarounds: 0.

### Q9 — four adversarial negatives

Tools: `context`, `callers`, `flow`, `explore_graph`, `deadcode`, endpoint inventory, and coverage metadata.

| Claim | Observed result | Correct conclusion |
|---|---|---|
| “This function has no callers.” | Focus context returned 3 callers. | False for the selected focus; a null relation elsewhere is not absence proof. |
| “This endpoint has no handler.” | Endpoint inventory returned `handlerStatus=handled`; flow returned `handles → proto`. | Handler existence is proven for this bounded inventory result; implementation/data reachability is not. |
| “This symbol is unused.” | Dead-code output is explicitly a candidate list and warns about DI, reflection, dynamic import, and public entry points. | `not proven`; dead-code candidates are leads, not deletion evidence. |
| “This request never reaches a data boundary.” | Flow stops at the endpoint/service frontier with no data node. | `not proven`; the bounded flow cannot establish non-reachability. |

Coverage/freshness for the selected symbol was fresh/aligned but included 7 excluded files and 103925 unresolved references in query diagnostics. Completeness was lower bound or partial; no negative claim was promoted from an empty array. Confidence: high for the distinction, medium for endpoint handler existence. Workarounds: 0.

### Q10 — revision drift and stale evidence

Tools: CLI `status --compact --json`; MCP `status_panel`, `index_status`, `context`, and `explore` with implicit and explicit `branch=brazil-v2`.

FPMS-NT live branch and explicit branch both resolved to `brazil-v2`; indexed commit and HEAD matched; snapshot/branch IDs were stable; worktree was clean; `changedFiles=0`; parser `tree-sitter-wasm-v8-wrapper-allowlist`; schema `14`; stale reason `null`. Target context and explore both labeled the evidence fresh and `trust=exact_commit`.

The wider status panel also exposed other registered repositories with stale/dirty states, including `penguin-src`, but this was not substituted for FPMS-NT truth. A stale case was therefore observed in the global inventory but not manufactured in the target repository. Confidence: high. Completeness: freshness metadata complete for FPMS-NT, coverage still incomplete due exclusions/unresolved references. Workarounds: 0.

### Q11 — evidence provenance cross-check

Tools: `knowledge_explore` on the focus and caller IDs, `knowledge_context`, `knowledge_callers`, `knowledge_callees`, `explore_graph`, and `list_suggestions`.

Observed categories:

- Confirmed parser edge: focus provenance included `calls / parser / EXTRACTED / confidence=1`; the caller explore result reported 8 extracted calls.
- Inferred edge: caller explore reported `tests / parser / INFERRED / confidence=0.5 / count=1`, with diagnostic `1 INFERRED edge(s)` and overall confidence `low`.
- External call: caller explore reported `externalCalls=[{specifier:"moment", ...}]`, `externalCallCount=5`, and said the calls list is incomplete.
- Unresolved reference: caller query diagnostics reported `unresolvedReferenceCount=103925` and `coverageGaps=[unresolved_references_present]`.
- Agent suggestion: `list_suggestions` returned `edgeId=edge_led_e7b633c9-b2d9-4d3f-bf5f-4d8f3955f236`, `edgeType=mentions`, `confidence=0.7`, and a pending suggestion event ID.

`explore` preserves origin, method, confidence, external calls, omitted-source reasons, and diagnostics. Targeted `context` preserves high-level completeness but not the same per-edge provenance detail. `callers`/`callees` graph responses expose node counts and `no_static_edge` diagnostics but omit the richer provenance fields. CLI wraps revision under `evidence`, while MCP usually exposes it at top level. Confidence: high. Completeness: partial. Workarounds: 1 — retain the richer explore result in handoffs instead of flattening to callers/callees only.

### Q12 — cursor recovery after context compaction

Fresh child CLI processes exercised each continuation.

- `filesymbols`: page 1 returned 3/10 with a cursor; page 2 returned 3/7 with a cursor; page 3 returned 4/4 with `totalIsExact=true`, `truncated=false`, and `nextCursor=null`. No duplicates were observed.
- `endpoints`: page 1 → page 2 → page 3 returned 3 items each, counts 1535 → 1532 → 1529, and retained non-null cursors. The sample did not exhaust 1535 candidates.
- `deadcode`: scoped `FPMS-NT/apps/promotion/src` page 1 returned 3/2348 and page 2 returned 3/2345, both with cursors and no duplicate sample IDs.
- Malformed cursor: CLI returned exit 2 with `CURSOR_INVALID`.
- Wrong-surface cursor: CLI returned exit 2 with `CURSOR_SCOPE_MISMATCH` or `CURSOR_INVALID`.
- MCP malformed search cursor: `isError=true`, code `INTERNAL`, message `CURSOR_INVALID`, `retryable=false`; this is less actionable and less typed than the CLI contract.

Ordering and scope checks worked on the CLI. Exhaustion was proven for filesymbols only; endpoint/deadcode exhaustion was not attempted because the result sets were large. Confidence: high for continuation mechanics, medium for universal exhaustion. Workarounds: 1 — use CLI for typed cursor recovery when MCP returns `INTERNAL`.

### Q13 — onboarding as a first-day decision aid

Tool: CLI `onboarding FPMS-NT`, cross-checked with CLI status/coverage/capabilities/help.

The generated memo gives a copyable boundary (`FPMS-NT: /Users/shieng/Desktop/Projects/fpmsnt`), indexed-file and fresh-symbol counts, key entry points, `penguin flow <endpoint>`, `penguin architecture --repo <repo>`, `penguin status`, and the warning that failed coverage cannot support negative conclusions. It does not fully spell out the endpoint page-two cursor workflow, the explicit branch/commit gate, or a complete MCP fallback command. Result: useful first-day aid, but incomplete for this brief’s stricter investigation protocol. Confidence: high. Completeness: partial. Workarounds: 1 — append the setup/cursor/revision rules from this report.

### Q14 — MCP/CLI contract and behavior comparison

Tools: matching CLI and MCP `search`, `filesymbols`, `context`, `flow`, `endpoints`, and invalid cursor exercises.

Observed parity:

- Search for `getActiveEventConfigByObjId` returned the same FPMS-NT target node ID and line 135. CLI emphasized source occurrences; MCP auto mode returned one symbol lane hit with verified evidence.
- Filesymbols returned the same 10-symbol file inventory and focus node.
- Context and flow resolved the same focus and revision, but CLI places evidence under `evidence` while MCP uses top-level fields and returns different completeness wrappers.
- Endpoints diverged: CLI honored `FPMS-NT --protocol grpc --limit 3` and returned `candidateCount=1535` with a cursor. MCP `knowledge_endpoints` returned the global first three endpoints, `candidateCount=3`, `nextCursor=null`, and ignored the requested repo/protocol shape passed to the tool.
- Invalid cursor diverged: CLI typed `CURSOR_INVALID` with exit 2; MCP returned `isError=true`, `code=INTERNAL`, `message=CURSOR_INVALID`.

MCP is available, so parity is scored as a product comparison rather than `N/A`. Confidence: high. Completeness: partial. Workarounds: 2 — use CLI endpoints/cursor, and normalize MCP errors at the client boundary.

### Q15 — agent-to-agent handoff

Handoff packet contained only Penguin output: repo `FPMS-NT`, branch `brazil-v2`, commit `3f0f1984b9e4337668529a13bad5264501729908`, symbol `node_af26e1f8-17f5-473b-b76c-e33a150abfac`, endpoint `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`, flow endpoint → `proto`, impact file/candidates, and a negative-result rule.

Separate fresh CLI child processes replayed the emitted endpoint page-two cursor and filesymbol cursor; the IDs and cursors continued without reconstructing hidden state. MCP follow-ups also accepted current-session IDs. A replay of the invalid node ID returned an empty context-shaped response without a structured invalid-node error, so that negative handoff is not safely actionable.

Verdict: positive handoff continuity for valid IDs/cursors; failure for invalid-ID remediation. Confidence: high for CLI replay, medium for MCP session continuity because explicit session reset was unavailable. Workarounds: 1 — include repository, branch, revision, and a validation command in every handoff.

### Q16 — recovery-oriented error exercise

| Input | Surface/result | Actionability |
|---|---|---|
| Missing/empty search query | MCP error `knowledge_search requires a non-empty query`. | Clear; retryable by supplying a query. |
| Unknown repository | MCP `revision_repo_not_found`. | Clear code; retry with a registered repo. |
| Ambiguous symbol | `constructor` returned 20 candidates and a node-ID suggestion list. | Good recovery, but candidate scope was unsafe. |
| Invalid node ID | Context returned an empty result-shaped response without an explicit invalid-node code. | Not actionable; product failure. |
| Wrong branch | Flow returned `SCOPE_NOT_FOUND` and candidate branch `brazil-v2`. | Good recovery. |
| Wrong `commit_sha` | Context silently resolved the current fresh node instead of rejecting `deadbeef`. | Unsafe; revision contract failure. |
| Malformed cursor | CLI exit 2 `CURSOR_INVALID`; MCP `INTERNAL/CURSOR_INVALID`. | CLI good, MCP needs typed normalization. |
| Cross-surface cursor | CLI `CURSOR_SCOPE_MISMATCH` or `CURSOR_INVALID`, exit 2. | Good enough for CLI. |
| Invalid endpoint identity | Context `TARGET_NOT_RESOLVED` for `grpc::NoSuchService.noSuchMethod`; no retry suggestion. | Structured but incomplete remediation. |
| Empty negative result | Search returned `NO_MATCH_INCOMPLETE`, `COVERAGE_INCOMPLETE`, and `NO_MATCH`; graph returned `no_static_edge`. | Honest if warnings are read; not an absence proof. |

Freshness/coverage: FPMS-NT was fresh/aligned, but negative search still had 7 excluded files; graph caller diagnostics exposed unresolved-reference gaps. Confidence: high. Workarounds: 2 — prefer CLI errors and reject silent revision fallback.

### Q17 — repaired runtime and long-lived client handoff

Tools: CLI help/capabilities; MCP `mcp_health`, `knowledge_capabilities`, `knowledge_callees`, `knowledge_affected`.

`help --json` and `capabilities --json` both exposed `callees`; current-session `callees` and CLI `affected node:<id>` accepted emitted symbol IDs. MCP path-based `affected` also returned a result. MCP health showed running and available build IDs equal and `outdated=false`. Stable runtime metadata was exposed as `/Users/shieng/.penguin` plus `/Users/shieng/.penguin/config.json`; no app-bundle path was required by the MCP health response.

The allowed host did not provide an explicit MCP initialize/hello replay or a controllable second `tools/list` session. Therefore “the new runtime is installed” is supported by equal build IDs, but “an already-running long-lived MCP process has reloaded it” is `not proven`. No restart notice was emitted. Confidence: high for current health, low for long-lived-session reload. Workarounds: 1 — restart the client manually and record a second capability hash/tool list in a future run.

## 4. B1–B6 workflows with the full handoff evidence.

### B1 — cold-start gRPC investigation

Onboarding identified FPMS-NT. CLI endpoint inventory selected page-two endpoint `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626`. Fresh flow replay produced `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs → proto`; the first evidence frontier was the handler/service boundary. Revision stayed `brazil-v2 / 3f0f1984...`, fresh/aligned, with endpoint candidate totals non-exact. No data reachability was claimed.

### B2 — safe change planning

Symbol handoff used `node_af26e1f8-17f5-473b-b76c-e33a150abfac`. Context gave three callers and one direct callee; explore gave source blocks and importer/test candidates; affected returned path-level impacted candidates. Because calls are lower bounds, unresolved references are 103925, coverage has 7 excluded files, and test/route closure is incomplete, the decision was `NO-GO`. Two fresh follow-ups (`node_79307c9d-df34-4ddb-86c3-074075bebb03` and `node_0a9ea225-9c88-4f94-9db4-c207bc9cf4a2`) were valid Penguin-emitted IDs.

### B3 — negative-result audit

The selected function has three observed callers, so “no callers” is disproven. The selected endpoint has an inventory handler and flow `handles` edge, so “no handler” is disproven at inventory level. Dead-code candidates remain candidates, and the flow stopping at `proto` does not prove that no data boundary exists. The last two claims are `not proven`, with coverage and completeness warnings retained.

### B4 — two-agent continuity replay

Agent A’s packet included repo, branch, commit, symbol ID, endpoint ID, flow output, cursor, and next commands. Agent B was simulated with separate fresh CLI child processes. Endpoint and filesymbol cursors continued successfully; context and flow accepted the IDs. The invalid-node replay returned an empty result without a typed error, so valid handoff continuity passed while invalid recovery failed.

### B5 — MCP/CLI degraded-mode report

Product capability score: 75/100. Environment readiness score: 80/100. MCP was available and healthy for most calls, but MCP endpoint scoping and cursor error normalization failed parity. FPMS-NT itself was fresh and clean; MCP doctor timeout is an environment/runtime behavior and does not negate the product’s other capabilities.

### B6 — runtime continuity and repaired command replay

Capability hash, current symbol ID, current endpoint ID, filesymbol cursor, endpoint cursor, and invalid-cursor behavior were recorded. Fresh CLI processes replayed `callees`-equivalent ID handoffs and cursor continuations; `affected` path output was available. MCP health confirmed one current generation but could not prove a second long-lived session reload. The negative query remained `not proven` where graph completeness was lower bound.

## 5. Reliable operations without source reading.

- Discovering repository boundary, indexed counts, branch, commit, clean/fresh status, parser/schema versions, and coverage exclusions.
- Finding a path-qualified symbol and copying a fresh node ID into context, flow, callers, and callees.
- Building a bounded source pack with line ranges, callers/callees, importers, routes when indexed, tests when indexed, provenance, omitted-source reasons, and next commands.
- Enumerating gRPC endpoints through CLI pagination and treating page two as a work queue.
- Resolving endpoint title/canonical/node identity equivalence through CLI `endpoint-identity`.
- Distinguishing confirmed parser edges, inferred edges, external calls, unresolved references, dead-code candidates, and agent suggestions.
- Producing an honest `NO-GO` change packet when completeness or revision evidence is insufficient.
- Replaying valid CLI IDs and cursors across fresh processes.

## 6. Operations that still require source reading or human intervention.

- Confirming business semantics, dynamic dispatch, DI/reflection wiring, callback bodies, external package behavior, and database/data-boundary reachability.
- Proving absence of callers, handlers, usage, or downstream data access.
- Treating dead-code candidates as deletion candidates.
- Resolving excluded files and the 103925 unresolved-reference gap reported by the selected caller query.
- Confirming whether an endpoint’s `proto` handler maps to a concrete application implementation.
- Performing a true second MCP session/tool-list replay for long-lived clients.
- Deciding whether a stale or dirty repository may be used for a production-impacting change.

## 7. Misleading, ambiguous, failed, unavailable, or non-actionable outputs.

- MCP `knowledge_endpoints` ignored the requested repo/protocol scope and returned global results without a matching cursor.
- An ambiguous `constructor` candidate emitted from a scoped request belonged to Auth-Player; follow-ups accepted it while outer metadata still showed FPMS-NT.
- A wrong `commit_sha` was silently ignored by MCP context and returned current fresh evidence.
- CLI `context` rejected a slash endpoint route while CLI `flow` accepted the same route.
- MCP invalid cursors were wrapped as `INTERNAL` instead of a typed cursor error.
- Invalid node IDs returned an empty context-shaped response without a clear `TARGET_NOT_FOUND`/`TARGET_NOT_RESOLVED` code.
- `no_static_edge`, empty arrays, dead-code candidates, `totalIsExact=false`, and `NO_MATCH_INCOMPLETE` remain unsafe for absence claims.
- MCP doctor timed out while CLI doctor succeeded.
- The initial `rtk proxy` environment-assignment wrapper failed before invoking Penguin.

## 8. Product failures versus evaluation-environment failures.

Product failures:

- MCP endpoint scope/protocol arguments were not applied.
- Ambiguous candidate follow-up did not enforce repository identity.
- Invalid revision selection was silently accepted.
- Slash-route acceptance differed between context and flow.
- Invalid node and cursor error shapes were not consistently typed/actionable.
- Targeted graph surfaces dropped some provenance and scope diagnostics compared with explore.

Evaluation-environment or client-surface limitations:

- `rtk proxy` did not parse the shell-style environment assignment; the corrected `env` invocation worked.
- MCP doctor exceeded the configured 15-second hard timeout; CLI doctor completed successfully.
- The available MCP host did not expose a controllable fresh-session reset or direct `tools/list`, so second-session reload was `not proven`.
- Endpoint/deadcode cursor exhaustion was not completed because the indexed candidate sets were large; this is an evaluation coverage gap, not evidence of a product failure.

## 9. Ordered improvements with impact, cost, and a directly testable acceptance criterion.

1. **Enforce scope on every MCP endpoint and ambiguous-node request.** Impact: critical; cost: medium. Acceptance: `knowledge_endpoints(repo=FPMS-NT, protocol=grpc, limit=3)` returns only the same first page and cursor as CLI; a candidate from another repo is rejected with `SCOPE_MISMATCH`.
2. **Reject or explicitly label revision mismatches.** Impact: critical; cost: low. Acceptance: passing `commit_sha=deadbeef` returns typed `REVISION_MISMATCH` and never returns fresh current-commit evidence.
3. **Unify error envelopes and retry suggestions.** Impact: high; cost: medium. Acceptance: invalid node, invalid endpoint, malformed cursor, wrong-scope cursor, and unknown repo each return stable code, retryability, remediation, and copyable next command on CLI and MCP.
4. **Make slash endpoint identity a shared resolver.** Impact: high; cost: medium. Acceptance: the same slash route resolves or rejects identically in `context`, `flow`, `endpoint-identity`, CLI, and MCP.
5. **Preserve provenance and completeness fields across targeted graph calls.** Impact: high; cost: medium. Acceptance: callers/callees/affected expose origin, method, confidence, locator, unresolved reason, coverage gaps, and proof status without requiring explore.
6. **Expose a first-class fresh-session/reload health check.** Impact: medium; cost: low. Acceptance: a second MCP session records `tools/list`, capability hash, runtime generation, and a restart/reload result that distinguishes installed from reloaded.
7. **Improve onboarding with the explicit revision and pagination gate.** Impact: medium; cost: low. Acceptance: `onboarding FPMS-NT` contains copyable `status`, coverage, page-two endpoint, cursor continuation, source-review frontier, and negative-claim rules.
8. **Add a bounded endpoint/deadcode exhaustion test mode.** Impact: medium; cost: medium. Acceptance: a deterministic test fixture proves `nextCursor:null`, duplicate-free ordering, malformed cursor, and wrong-scope cursor on all three surfaces without scanning the full production corpus.

## 10. Final recommendation for Claude/Codex-only internal use; do not make a release recommendation.

Penguin is recommended for Claude/Codex internal use as a bounded knowledge and navigation layer when the agent first verifies repository scope, branch/commit alignment, freshness, coverage, and completeness. It is particularly effective for path-qualified symbol discovery, source-pack preparation, endpoint inventory, graph navigation, provenance-aware handoff, and conservative `NO-GO` change planning.

It must not be treated as the sole authority for negative claims, complete impact closure, dynamic/DI wiring, endpoint implementation reachability, or database reachability. For those cases, the agent should stop at the first evidence frontier and request source review or human confirmation. The MCP endpoint-scope, revision-validation, and error-envelope defects should be fixed before treating MCP and CLI as interchangeable clients.
