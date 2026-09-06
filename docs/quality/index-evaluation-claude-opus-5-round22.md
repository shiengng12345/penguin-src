# Penguin Knowledge — Round 22 Independent Evaluation (Claude Code / claude-opus-5)

> Status: **COMPLETE** — Q1–Q20 and B1–B8 executed or individually justified N/A.
> Result: Product Capability 69/100, MCP-only UX 63/100, Environment Readiness 68/100 — acceptance
> (95–100 on the first two) **NOT MET**. Written incrementally as evidence was produced.
> Created: 2026-08-31 (local machine date), Asia/Kuala_Lumpur assumed from host locale (unverified via MCP).
> Evaluator: fresh Claude Code process, MCP-only consumer.

---

## 1. Compliance and fresh-process proof

| Item | Value | Source |
| --- | --- | --- |
| Client | Claude Code (Claude Agent SDK harness) | host-declared |
| Model | claude-opus-5 | host-declared |
| Session type | Non-interactive single session, started for Round 22 only | host-declared |
| Inputs provided | `docs/quality/index-evaluation-brief-round22.md` only | evaluator |
| Prior reports read | none | evaluator |
| CLI / shell / SQLite / Git / source reads | none | evaluator |

**Fresh-process caveat (declared up front):** this evaluator cannot itself prove, through MCP,
that the host client process was newly started for Round 22 — no MCP surface exposes the client
PID or client start time. The evaluator can only attest that its own conversation context began
empty except for the brief. Per Section 0 this is recorded and its consequence is applied in
Section 3.

### 1.1 Compliance ledger

| Rule | Status |
| --- | --- |
| Only the Round 22 brief was read as input | COMPLIED |
| No terminal / shell / `penguin` CLI | COMPLIED |
| No filesystem source, SQLite, Git reads | COMPLIED |
| No old reports / plans / closure files / Codex report | COMPLIED |
| No indexing, rebuild, watch, register, migrate, repair, note/memory write, export, delete | COMPLIED — every call used was a read surface |
| Only evaluator write = this report | COMPLIED |
| All targets/cursors emitted in this process | COMPLIED |

**Known measurement limitation (declared, not a workaround):** the harness exposes no
wall-clock timer to this evaluator, and no Penguin MCP response carries a server-side
`elapsedMs`. Latency is therefore reported qualitatively (single-response, no timeout
warning, no partial flag) rather than in milliseconds. This is recorded as an
**environment observability gap**, and every "latency" line below says so explicitly
instead of inventing numbers.

---

## 2. MCP / runtime / repository / semantic preflight

### 2.1 Runtime identity (`mcp_health`)

| Field | Value |
| --- | --- |
| appVersion | 1.16.0 |
| runningBuildId | `1.16.0-696f5732bd1f8911` |
| availableBuildId | `1.16.0-696f5732bd1f8911` |
| outdated / restartRequired | `false` / `false` |
| clientRestartRequired | `false` |
| runtimeOutdated | `false` |
| schemaVersion | 18 |
| contractVersion | "2" |
| capabilityHash | `e38ea18f3da0cd3a3f68941a8c8adc2e13bc76d8fa898461160fa847d56365fb` |
| nodeVersion / platform / arch | v22.23.1 / darwin / arm64 |
| status / initializeHealthy | `ok` / `true` |
| queryRuntime | workers 2, hardTimeoutMs 30000 |
| nativeDependencies | 8/8 `ready` (bundled-node, better-sqlite3, sqlite-vec, onnxruntime-node, sharp, embedding-model-manifest, embedding-model, embedding-tokenizer) |
| signing.status | `unknown` |
| configured / launcherHealthy | `null` / `null` |

`serverGeneration` duplicates `generation` exactly. Running == available ⇒ this process is
on the current installed runtime; the `restartRequired=false` claim is consistent with
`runningBuildId == availableBuildId`, so restart guidance is truthful for this session.

Minor honesty gaps: `signing.status="unknown"` and `configured`/`launcherHealthy` are
`null` rather than a typed "not-applicable" — three tri-state fields that an MCP-only
consumer cannot resolve further.

### 2.2 Contract surface (`knowledge_capabilities` compact)

- buildId / schemaVersion / contractVersion / capabilityHash **match `mcp_health` exactly**.
- `capabilityCount: 101`; all 101 registrations report `status: "implemented"`; zero
  `unimplemented`/`degraded` entries; no duplicate capabilityId observed.
- Tool schemas exposed to this client carry human-readable descriptions with routing hints
  (`[targeted — …]`, `[specialised — …]`, `[occasional — writes, docs, or maintenance]`).
- **Annotation gap:** the tool schemas surfaced to this client expose no machine-readable
  `readOnlyHint` / `destructiveHint` annotations. Read-vs-write intent is only inferable
  from prose. Recorded per Section 4 ("missing read/write annotations").
- **Schema-fidelity gap:** several capabilities are exposed with
  `"additionalProperties": true` and an empty `properties` object — `knowledge_doctor`,
  `get_node`, `knowledge_files`, `knowledge_explain`, `knowledge_local_graph`,
  `knowledge_onboarding_generate`. A fresh consumer cannot discover their inputs from the
  contract and must guess. Counted as a discoverability defect (not a workaround, since
  the guessed inputs were repo/target names already emitted by other calls).

### 2.3 Repository discovery (`index_status` compact + `status_panel`)

- 20 repositories registered. Summary: fresh 18, dirty 0, stale 2, unknown 0, errors 0.
- **FPMS-NT** — `repo_a48ec7fb-5987-47df-9198-06969359cb50`, root
  `/Users/shieng/Desktop/Projects/fpmsnt`, branch `brazil-v2`,
  branchId `branch_1d21f868-3252-4b74-8289-8f7c4735247f`,
  commit `3f0f1984b9e4337668529a13bad5264501729908`,
  snapshot `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55`,
  worktreeFingerprint `073264f852ac84af18fb68cb22b56c5bdb3801e578c69510f638e13a0b0544c5`,
  trust `exact_commit`, freshness `fresh`, dirtyFileCount 0, indexErrorCount 0,
  parserVersion `tree-sitter-wasm-v9-canonical-endpoints`,
  lastIndexedAt `2026-08-31T14:42:46.741Z`.
- Stale repos: `FPMS-NT-Proposal` (dirty 1, staleReason `worktree_dirty`),
  `grpc-web-debugger` (dirty 2, staleReason `worktree_dirty`). Both truthfully labelled.
- DB: connected, schemaVersion 18, 5,102,949,488 bytes, WAL 189,552 bytes.

**Cross-surface inconsistency (product defect, medium):** for `FPMS-NT-CCMS`,
`index_status` reports `freshness: "fresh"` with `indexedCommit == headCommit ==
66d736478711f6867346a80fb5ddea53eb08806f` and `dirtyFileCount: 0`, while `status_panel`
reports `revisionAlignment: "behind"` with `staleReason: null` and the same
`indexedBranch: "brazil-v2"`. Two read-only trust surfaces disagree about the same repo
and neither carries a reason for "behind". An MCP-only consumer cannot resolve which is
authoritative without source/Git. Recorded as `CROSS_SURFACE_FRESHNESS_DISAGREEMENT`.
FPMS-NT itself is `fresh` + `aligned` on both surfaces, so this does not contaminate the
Round 22 scope.

### 2.4 FPMS-NT coverage (`knowledge_coverage`)

| Field | Value |
| --- | ---: |
| status | `partial` |
| discovered | 3340 |
| admitted | 3333 |
| excluded | 7 |
| failed | 0 |
| stale | 0 |
| unresolvedReferences | 84024 |
| reconciliation | `reconciled`, itemCount 84024, aggregateUnresolved 84024, **delta 0** |
| completeness | `lower_bound` |
| proofStatus | `candidate` |
| candidateCount | 84031 (= 84024 unresolved + 7 excluded) |
| returnedCount | 50 |
| remainingCount | 83981 |
| totalIsExact | `true` |
| truncated | `true` |
| gaps | `["coverage_debt_requires_remediation"]` |

Counts are internally consistent: `returnedCount + remainingCount == candidateCount`, and
the reconciliation delta is 0. Excluded items carry concrete `reasonCode`
(`secret_policy`, `binary`) and `classification`; unresolved items carry concrete
`filePath`/`startLine`/`rawTarget`/`reasonCode`
(`no_enclosing_symbol`, `external_package`, `unresolved_member_or_type`,
`platform_member`) plus `sourceNodeId` where an enclosing symbol exists.

### 2.5 Semantic status

Aggregate `knowledge_semantic_status()` returns **5** generation rows:

| Scope | Generation | State | Model hash | Chunker | expected | ready | running | pending | retryFail | termFail | Reason |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `legacy` | `generation_legacy_v16` | superseded | `legacy-v16-semantic-space` | legacy | 45007 | 0 | 0 | 0 | 0 | 0 | legacy rows not activation-eligible |
| `repo:repo_a48ec7fb…` | `generation_5c026dc4…c440f` | **active** | `00646ffa…6432c` | `semantic-chunker-v6-precision` | 45007 | **45007** | 0 | 0 | 0 | 0 | `null` |
| `repo:repo_a48ec7fb…` | `generation_ff0a09f7…843d6` | superseded | `5d2ceeba…fe4d31` | v4-packed | 38392 | 0 | 0 | 0 | 0 | 0 | `SEMANTIC_CHUNK_SET_REPLACED` |
| `repo:repo_a48ec7fb…` | `generation_2c7948d8…cfc35` | superseded | `9acfbda2…2dc4` | v3-structured | 68893 | 0 | 0 | 0 | 0 | 0 | `SEMANTIC_CHUNK_SET_REPLACED` |
| `repo:repo_a48ec7fb…` | `generation_f3644985…27e5` | superseded | `ba040970…31b97` | v2-contextual | 380141 | 0 | 0 | 0 | 0 | 0 | `SEMANTIC_CHUNK_SET_REPLACED` |

- Backend/provider: `nomic-ai/nomic-embed-text-v1.5`, bundled ONNX quantized model +
  tokenizer + `sqlite-vec` all `ready` in `mcp_health.nativeDependencies`.
- Exactly **one** `active` generation for the FPMS-NT space; every historical generation is
  `superseded` with a concrete reason — **none falsely reported as `stalled` or `failed`**.
- `activeGenerationId` on every FPMS-NT row points at the same
  `generation_5c026dc4…c440f`, i.e. the active pointer is internally consistent.
- Progress 100%, `paused=false`, `pauseRequested=false`, `restartRequired=false`.
- **Not exposed:** `lastHeartbeatAt=null`, `workerBuildId=null`, `ratePerSecond=null`,
  `etaSeconds=null`, and there is no dimensions field and no lease field anywhere in the
  payload. Section 4 explicitly asks for dimensions, worker identity, lease/heartbeat and
  rate/ETA — **four of those are absent from the contract**, not merely null-because-idle
  (there is no key for `dimensions` or `lease` at all). Recorded as
  `SEMANTIC_OBSERVABILITY_INCOMPLETE`.
- Only FPMS-NT has any semantic generation; the other 19 indexed repos have none, and no
  surface says so — asking for another repo's semantic status returns an empty list
  indistinguishable from "no such scope" (see below).

**Product defect (scope-key silent empty):**
`knowledge_semantic_status({scopeKey:"FPMS-NT"})` — the repo *name* that every other tool
accepts as `repo` — returned `{"statuses":[]}` with **no typed error and no diagnostic**.
The same call with `scopeKey:"repo:repo_a48ec7fb-5987-47df-9198-06969359cb50"` returned the
4 FPMS-NT rows. An unrecognised scope key is therefore indistinguishable from "this scope
has no semantic work", which directly violates truth rule 6 (empty ≠ absence) and the
Q18 requirement that `no_match` must not erase invalid input. The correct scope-key form is
not documented in the tool schema (`"Optional repo scope key"`), and was only recoverable
by reading `scopeKey` out of the aggregate call. **Counted as 1 workaround.**

### 2.6 Independence of Graph/Lexical from semantic

`knowledge_search` exposes `options.semantic: "off" | "fallback" | "blend"` and modes
`exact | phrase | substring | path | regex | lexical | structural` alongside `semantic`.
Graph tools (`knowledge_explore`, `callers`, `callees`, `flow`, `affected`, `path`,
`service_graph`, `local_graph`, `explore_graph`, `endpoints`, `dead_code`) take no semantic
parameter at all. Graph/Lexical is therefore **independently available by construction**;
Q15 verifies it behaviourally.

### 2.7 Onboarding (`knowledge_onboarding_generate`)

Returned a single `markdown` string, stamped with
`revision-hash=29d9be89a96165c7421b51bbacd3b3656a4a6581593e1c8788ed89a4ef1a2aea` and the
matching `capability-hash=e38ea18f…65fb`. Content: system boundary, 3333 indexed files /
13710 fresh symbols, six key entry points, hub list, and §8 "MCP-only 新会话第一轮检查"
giving five copy-pasteable bounded calls plus the rule that negative/partial/lower_bound/
stale results must first be checked against `coverage`, `freshness` and `proofStatus`. §9
explicitly labels CLI as *owner-local and not an MCP prerequisite*; §11 states the static
knowledge boundary (dynamic dispatch, reflection, external services, runtime config need
source/runtime).

Gaps in onboarding: it never mentions `knowledge_semantic_status`, never mentions cursors
or `nextCursor` continuation, and never mentions stable node IDs — three things Q1
explicitly requires a first-time consumer to learn. It also prints the wrong argument shape
for `knowledge_search` (`{"contract_version":…,"semantic":"off","limit":20}`), none of which
are keys in the real `knowledge_search` schema (they belong under `options`/`page`).

### 2.8 Dynamic target derivation (Section 3)

capabilityHash first eight hex = `e 3 8 e a 1 8 f`

| Formula | Computation | Value |
| --- | --- | ---: |
| `endpointPage  = 2 + (hex[0] mod 3)` | 2 + (0xe=14 mod 3 = 2) | **4** |
| `endpointIndex = hex[1] mod 5` | 0x3=3 mod 5 | **3** |
| `serviceIndex  = hex[2] mod 4` | 0x8=8 mod 4 | **0** |
| `conceptIndex  = hex[3] mod 3` | 0xe=14 mod 3 | **2** |

**Dynamic endpoint** — enumerated `knowledge_endpoints(repo=FPMS-NT, limit=5)` and followed
only emitted `nextCursor`s through pages 1→2→3→4. Page 4, zero-based index 3:

- `nodeId`: `node_7f61d503-720b-4923-b57b-e1b2c0297795`
- `identityKey`: `grpc::CMS.BackendService.getresourceidlist`
- title: `gRPC CMS.BackendService.GetResourceIdList`, protocol `grpc`
- source: `apps/payment/libs/utils/cmsService.ts:49-66`
- membership role: `consumer`, locatorNodeId `node_3e0709eb-28c2-42a1-8ec8-de4205b4ac99`
- `handlerStatus: "incomplete"`,
  `missingHandlerReason: "handler_not_proven_absent: endpoint coverage or generated wiring may be incomplete"`

No `DYNAMIC_SELECTION_FALLBACK` needed (page 4 exists; index 3 exists).

**Dynamic service** — `knowledge_service_graph(repo=FPMS-NT)`, first four stable-ID nodes
are `service:repo_a48ec7fb…` (FPMS-NT), `service:repo_670fda10…` (FPMS-NT-Payment),
`service:repo_8297b419…` (FPMS-NT-CCMS), `service:repo_5513e90d…` (FPMS-NT-Auth-Player).
`serviceIndex=0` ⇒ **`service:repo_a48ec7fb-5987-47df-9198-06969359cb50` (FPMS-NT)**.

**Endpoint pagination integrity across the four pages:** ordering key
`identityKey,nodeId`, strictly ascending and stable across all four pages
(`…previewsegmenthitcount` → `…queryusertaskreport` → … → `…getsectionnamelist`);
`candidateCount` constant at 608 with `totalIsExact: true`; `remainingCount`
603 → 598 → 593 → 588, i.e. exactly −5 per page; **zero duplicate nodeIds across 20
returned items**; every page carried the same `revision`/`snapshotId`. Cursors are opaque
signed tokens (JWS-like, with embedded `expiresAt`, `limit`, `revision`, `orderingKey`,
`lastKey`) — **no offset reconstruction was required or possible**.

_(Report continues; Q and B sections below are appended as each batch completes.)_

---

## 3. Three scores and hard caps

### 3.1 Hard caps applied

| Failure | Triggered? | Evidence | Cap |
| --- | --- | --- | ---: |
| MCP unavailable after one clean restart | **No** | `mcp_health status:"ok"`, `initializeHealthy:true`, 101/101 capabilities implemented | — |
| **Fresh process not proven** | **YES** | No Penguin MCP surface exposes a client/session ID, client start time or client process identity. Section 0 requires recording "process or session ID when exposed, start time/timezone"; none is exposed, and every other evidence channel that could prove a new process (terminal, `ps`, filesystem) is forbidden by Section 1. The evaluator can only attest its own context began with the brief alone — which is not MCP evidence. `FRESH_SESSION_NOT_PROVEN`. | **Environment ≤ 69** |
| Silent repository/revision scope crossing | **No** | Wrong-repo node → typed `SCOPE_MISMATCH` with requested vs actual IDs; wrong-scope cursor → `CURSOR_SCOPE_MISMATCH`; both architecture calls returned exactly one repo | — |
| Emitted symbol/endpoint/service ID cannot round-trip | **No** | All three round-tripped; endpoint converged from three identity forms | — |
| **Hits/count/queryStatus/warnings contradict each other** | **YES** | `knowledge_search mode:"exact"` page 1 returned root `truncated:true` + cursor while `diagnostics.truncated:false` in the same response; continuing the cursor returned a 4th hit, proving `diagnostics.truncated` was wrong. Corroborating contradictions: `knowledge_context` `returnedCount:0` with a non-empty `importers`; `explore` `confidence.inferredEdges:0` with an `evidenceState:"inferred"` hop; `knowledge_callers` root `coverageGaps:["unresolved_reference_counts_not_persisted"]` vs `diagnostics.coverageGaps:["unresolved_references_present"]` in a response that *does* carry the count. | **Product ≤ 79; MCP UX ≤ 79** |
| **Empty/partial result presented as absence** | **YES** | `knowledge_search({mode:"semantic"})` against `casino-plus` (indexed, 2222 admitted files, no vector generation) returns the untyped string **`"0 hits · lanes"`** — reproduced twice — with no code, no scope, no `queryStatus`, no warning and no remediation. The identical query in `mode:"auto"` proves **832** deterministic candidates exist in that repo. A zero-result is therefore asserted for a scope that is neither empty nor unsearchable. Secondary instance: `knowledge_semantic_status({scopeKey:"FPMS-NT"})` returns a bare `{"statuses":[]}` for an unrecognised scope key, indistinguishable from "no semantic work exists". | **Product ≤ 69** |
| Semantic claimed applied while inactive/unavailable | **No** | Where unavailable, `applied:false` + `SEMANTIC_LANE_UNAVAILABLE`; where available, `applied:true, ready:45007, expected:45007` with the correct generation | — |
| Staging/superseded vectors queried or active pointer inconsistent | **No** | Exactly one `active` generation; all four others `superseded` with reasons; every hit's `embeddingSpaceId` matched the active generation's `modelHash` | — |
| Graph blocked by semantic work | **No** | Q15; graph tools take no semantic parameter and succeeded on a repo with no vectors at all | — |
| Architecture/note/service scope leak | **No** | Q6, Q7, B6 | — |
| Cursor requires reconstructed offset or silently changes scope | **No** | All cursors opaque and server-authored; scope change rejected with a typed error | — |
| Old session silently uses old runtime | **No** | `runningBuildId == availableBuildId`, `outdated:false`, `clientRestartRequired:false` | — |
| MCP-only wake needs CLI/Tauri workaround | **No** (wake itself is `N/A_NO_QUEUED_WORK`) | No queued work exists to wake; readiness verified via `mcp_health` without any CLI/Tauri action | — |
| CLI/source/DB/Git/old-report fallback or evaluator mutation | **No** | None occurred; the only write is this report | — |

### 3.2 Raw dimension scoring (before caps)

**Product Capability**

| Dimension | Max | Score | Basis |
| --- | ---: | ---: | --- |
| Fresh discovery and scope safety | 8 | 7 | Exemplary `SCOPE_MISMATCH`/`CURSOR_SCOPE_MISMATCH`; −1 for the `semantic_status` silent-empty scope key |
| Exact/path/lexical/concept retrieval | 12 | 10 | Four lanes with verified locators, auditable rank tuples; −2 for the truncation contradiction |
| Semantic response consistency and recall | 12 | 8 | Three byte-identical runs; −4 for no continuation cursor, untyped unavailable path, no similarity floor (a nonsense query returns `MATCH` at sim 0.149) |
| Context/source evidence usefulness | 7 | 6 | Verbatim source, callPath, provenance, `sourcesOmitted`; −1 for root counters that don't describe the payload |
| Graph/flow/affected quality | 13 | 10 | Best-in-class evidence states and typed dead ends; −3 for path/node parity mismatch and `inferredEdges:0` |
| Endpoint identity and pagination | 9 | 8 | Three identity forms converge; stable ordering; −1 for `nodeCounts.endpoint:6` vs 608 |
| Three cursor families | 8 | 6 | Three families proven; −2 for no provable expired/stale class and the non-revision-pinned dead-code cursor |
| Coverage actionability and honesty | 9 | 9 | Every debt category concrete or typed-exact-empty; reconciliation delta 0 |
| Architecture/service/note scope isolation | 8 | 7 | No leaks; −1 because service-graph aggregation, while declared, mixes per-edge revisions |
| Lifecycle/background/runtime truth | 10 | 7 | One active generation, correct `superseded`; −3 for absent worker identity, lease, heartbeat, dimensions |
| Private-owner/provenance boundary | 4 | 4 | Correct boundary, clean separation of fact vs candidate vs generated note |
| **Raw total** | **100** | **82** | |

**MCP-only User Experience**

| Dimension | Max | Score | Basis |
| --- | ---: | ---: | --- |
| New-session discoverability | 17 | 11 | Onboarding is CLI-free and useful; −6 for omitting cursors/stable IDs/semantic status, printing a `knowledge_search` example with non-existent keys, and six capabilities published with empty input schemas |
| Callable annotated surface | 13 | 8 | 101/101 implemented and 26 tools reachable; −5 for zero `readOnlyHint`/`destructiveHint` annotations and `get_node` being uncallable without guessing its parameter name |
| Bounded output and speed | 12 | 8 | `limit`/`page` honoured everywhere, `compact` supported, `hardTimeoutMs` published; −4 for heavy duplication (`handlers`≡`firstHopRelations`, root≡`evidence`, `candidates`≡`items`) and a 1974 ms exact query |
| Stable IDs and three cursors | 16 | 13 | Opaque signed cursors, zero duplicates, truthful remaining counts; −3 for the semantic lane having none |
| Engineering evidence/actionability | 18 | 15 | Locators, contentHashes, provenance, evidence states, honest completeness notes; −3 for CLI-shaped remediation throughout |
| Semantic status/result clarity | 14 | 8 | Rich generation model; −6 for the untyped `"0 hits · lanes"`, the silent-empty scope key, `ready:0/expected:0` when semantic is off, and `requested:false` when it was requested |
| Fresh-process handoff without manual setup | 10 | 0 | Not proven — no permitted way to start a second MCP process |
| **Raw total** | **100** | **63** | |

**Environment Readiness**

| Dimension | Max | Score | Basis |
| --- | ---: | ---: | --- |
| MCP initialize/tools/health | 20 | 19 | `ok`, 8/8 native deps ready with sha256, query runtime published; −1 for `configured`/`launcherHealthy`/`signing` all unknown |
| Running/available identity parity | 20 | 15 | Perfect build/generation parity; −5 for `schemaVersion 17` in graph trust blocks vs 18 elsewhere |
| FPMS-NT freshness/coverage | 15 | 14 | `exact_commit`, clean worktree, 0 index errors, reconciled coverage; −1 for `index_status` vs `status_panel` disagreeing on FPMS-NT-CCMS |
| Active semantic generation integrity | 15 | 13 | One active, four correctly superseded, no leakage; −2 for no dimensions/lease |
| Fresh Agent-A/Agent-B replay | 15 | 0 | Not performed in a new process |
| Worker/wake/restart observability | 10 | 4 | Restart signalling is truthful; −6 for `workerBuildId`/`lastHeartbeatAt` null and no wake evidence obtainable |
| Timeout/error observability | 5 | 3 | `timingsMs` on search, `hardTimeoutMs: 30000` published; −2 because no other tool emits timings and one error path is untyped |
| **Raw total** | **100** | **68** | |

### 3.3 Final scores after caps

| Score | Raw | Cap | **Final** |
| --- | ---: | ---: | ---: |
| Product Capability | 82 | 69 (empty-as-absence) and 79 (count contradiction) → binding cap **69** | **69 / 100** |
| MCP-only User Experience | 63 | 79 (count contradiction) — not binding, raw is lower | **63 / 100** |
| Environment Readiness | 68 | 69 (fresh process not proven) — not binding, raw is lower | **68 / 100** |

**Acceptance (95–100 on Product Capability *and* MCP-only UX): NOT MET.** The 95–100 target is not
earned in this run and is not awarded. Two independent hard caps fire on Product Capability, and
MCP-only UX falls short on its own raw merits before any cap — principally because the
fresh-process handoff cannot be performed at all from an MCP-only client, and because several
tools cannot be invoked without guessing undocumented parameter names.

---

## 4. Q1–Q20 evidence records

> Convention: every record below uses the Section 2 evidence template. Fields constant across
> the whole run are stated once here and referenced as **[STD]**:
> running/available build `1.16.0-696f5732bd1f8911` / `1.16.0-696f5732bd1f8911`, generation
> `generation_5c026dc4ef2ab3a3c43641d4ee1c1cea37e9c81c37ac440f`;
> capability `e38ea18f…65fb`, schema 18 (but see the schema-17 defect), contract "2";
> repo FPMS-NT `repo_a48ec7fb…cb50`, branch `brazil-v2`, commit `3f0f1984…9908`,
> snapshot `snapshot_5225df3e…ee55`, trust `exact_commit`/`exact_worktree`, freshness `fresh`;
> coverage discovered 3340 / admitted 3333 / excluded 7 / failed 0 / stale 0 /
> unresolvedReferences 84024.

### Q1 — Zero-memory safe onboarding

- **MCP tool / input:** `knowledge_onboarding_generate({"repo":"FPMS-NT"})`, then executed the
  sequence it prescribes: `index_status({"mode":"compact"})` → `knowledge_coverage({"repo":"FPMS-NT"})`
  → scoped `knowledge_search` → `knowledge_explore` → `knowledge_affected`.
- **Result:** single `markdown` string stamped with revision-hash + capability-hash; §8 lists five
  bounded MCP calls; §11 states the static-knowledge boundary; §9 explicitly marks CLI as
  owner-local and **not** an MCP prerequisite; §12 gives the reading order
  Status → Coverage → Scoped Search → Explore → Affected → Source Review.
- **Established without CLI knowledge:** repository/revision scope ✔, freshness ✔, coverage ✔,
  search ✔, evidence limits ✔, source/log/runtime escalation boundary ✔.
- **Not established:** stable-ID continuation ✘ (no mention of `nodeId`, `nextCursor`, or
  pagination anywhere), semantic status ✘ (`knowledge_semantic_status` is never named), and the
  printed `knowledge_search` example uses keys that do not exist in the real schema
  (`contract_version`, `semantic`, `limit` at top level instead of `options`/`page`) — a
  first-time consumer copying §8 verbatim gets a schema rejection.
- **Elapsed:** single response, no timeout/partial warning (no server timing field on this tool).
- **[STD]** identity/revision/coverage as above. **retrieval lane:** generated doc.
  **origin/method/confidence:** generated onboarding, `revision-hash=29d9be89…2aea`, medium.
- **workarounds:** 0 for this scenario.
- **verdict: PARTIAL** — the safe sequence is real and CLI-free, but two of the seven required
  elements (stable-ID continuation, evidence-lifecycle/semantic status) are missing and the
  printed search invocation is wrong. **confidence: high**

### Q2 — Loaded runtime identity

| Surface | buildId | schema | contract | capabilityHash | generation |
| --- | --- | ---: | --- | --- | --- |
| `mcp_health` | `1.16.0-696f5732bd1f8911` | 18 | 2 | `e38ea18f…65fb` | running==available, `outdated:false`, `restartRequired:false` |
| `mcp_health.serverGeneration` | same | — | — | — | identical object |
| `knowledge_capabilities` | same | 18 | 2 | `e38ea18f…65fb` | — |
| `knowledge_semantic_status` | — | — | — | — | active `generation_5c026dc4…c440f`, `restartRequired:false` |
| real query `knowledge_search` diagnostics | — | — | 2 | `e38ea18f…65fb` | `activeGenerationIds:["generation_5c026dc4…c440f"]` |
| `knowledge_context` / `explore` / `flow` `trust` block | — | **17** | — | — | — |

- **Verdict on load:** this process **did** load the current installed runtime —
  `runningBuildId == availableBuildId`, `outdated=false`, `clientRestartRequired=false`, and a real
  query echoes the same capability hash and the same active generation. Restart guidance is
  truthful: there is no newer build to require a restart for.
- **Defect (mixed identity):** every graph-tool `trust` block reports `schemaVersion: 17`, while
  `mcp_health`, `knowledge_capabilities` and `status_panel.db` all report `schemaVersion: 18`. Two
  different schema numbers are emitted by one runtime in one session. An MCP-only consumer using
  `trust.schemaVersion` for compatibility gating would gate on the wrong value.
  → `MIXED_SCHEMA_IDENTITY`.
- **verdict: PARTIAL** (loaded=YES and restart guidance truthful, but identity is not uniform).
  **confidence: high**

### Q3 — Repeated semantic result consistency

Input, identical three times:
`knowledge_search({query:"<Section-3 concept question>", mode:"semantic",
scope:{revisions:[{repoName:"FPMS-NT",branch:"brazil-v2"}]}, page:{limit:3},
options:{compact:true, semantic:"blend"}})`

| Run | requestId | timingsMs.total | hits.length | root returnedCount | evidence.returnedCount | candidateCount | queryStatus | semantic applied / reason | ready/expected | activeGenerationIds | Top-3 identities |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| 1 | `search_01c5aa063e679789` | 558.538 | 3 | 3 | 3 | 50 | MATCH | true / null | 45007/45007 | `generation_5c026dc4…c440f` | A, B, C |
| 2 | `search_f50b916f95fb47ff` | 557.205 | 3 | 3 | 3 | 50 | MATCH | true / null | 45007/45007 | `generation_5c026dc4…c440f` | A, B, C |
| 3 | `search_f7af45c4944c253b` | 325.534 | 3 | 3 | 3 | 50 | MATCH | true / null | 45007/45007 | `generation_5c026dc4…c440f` | A, B, C |

A = `apps/cms/src/article/article.service.ts` (hitId `vector_ed077e8074d66c26`, chunk
`chunk_7c191b33…5ed7`, sim 0.24663513898849487, fingerprint `690a128184921345`)
B = `apps/promotion/src/free-spin/processors/create-community-free-spin-config/create-community-free-spin-config.service.spec.ts`
(hitId `vector_175d27a76b9d6be4`, sim 0.2521238923072815, fingerprint `b93180a3dd38542c`)
C = `libs/tools/src/repositories/cms/article/article-repository.module.ts`
(hitId `vector_048b647a1c3e54e8`, sim 0.24514240026474, fingerprint `5633f462ed86667d`)

- All three responses are **byte-identical** apart from `requestId` and `timingsMs.total`
  (`stats.sentBytes = 7808` in all three). Scores, ranks, hitIds, chunkIds, contentHashes,
  retrievalFingerprints and `embeddingSpaceId`
  (`space_00646ffacf327f4fcd62b60556ff95ae652530f3848f34477aea2a8bda26432c`, which matches the
  **active** generation's `modelHash`) are identical.
- Metadata describes the hits exactly: `hits.length == returnedCount == evidence.returnedCount == 3`.
  `queryStatus:"MATCH"`; the only warning is `COVERAGE_INCOMPLETE`, which is truthful and does not
  contradict a MATCH.
- Ranking is disclosed and non-arbitrary: hit B has the **highest** raw vector similarity (0.2521)
  yet ranks 2nd, and `rankReasons` states why — `code-token affinity 0.059 used for bounded candidate
  reranking` vs 0.176 for A, under `rrf(60) hybrid fusion`. Every hit carries
  `"vector is a recall candidate; exact/source lanes retain truth precedence"` and
  `evidence[].status: "inference"`.
- **Defect (unexhaustible semantic page):** all three runs report `truncated: true` with
  `cursor: null` and no `page.nextCursor`, while `candidateCount: 50` and
  `page.totalIsExact: false`. The semantic lane therefore advertises unreturned candidates but
  offers **no continuation**, so semantic output can never be exhausted — directly limiting truth
  rule 6 (unexhausted output cannot prove absence). Lexical and exact modes *do* emit a cursor,
  so this is specific to the vector lane.
- **verdict: PASS** on response consistency (three identical runs, counts/status/warnings agree);
  the truncation-without-cursor issue is scored separately under cursor families.
  **SEMANTIC RESPONSE CONSISTENCY: PROVEN. confidence: high**

### Q4 — Exact, lexical, semantic and path precedence

Dynamic concept target (conceptIndex = 2, third result of the Section 3 concept query):
`libs/tools/src/repositories/cms/article/article-repository.module.ts` →
symbol `ArticleRepositoryModule`, `node_da824730-86ab-4f8e-b1a0-06a986b50d21`.
(Selection note: all three returned hits were in-scope FPMS-NT source occurrences, so
index 2 resolved without `DYNAMIC_SELECTION_FALLBACK`. The selected item is the *lowest*-similarity
of the three — no easier result was substituted.)

| Lane | Input | searchedLanes | Top hit | Rank reason | Evidence status | candidate/returned | timingsMs |
| --- | --- | --- | --- | --- | --- | --- | ---: |
| exact | `mode:"exact"`, `"ArticleRepositoryModule"` | `["source","symbol"]` | symbol hit `hit_837f1545…`, `nodeId node_da824730…d21`, line 37 | `exact symbol name; exact boost=0.1`, `rank_tuple=1/1/1.0000/3/0.950000` | **verified** (`source:"graph"`) | 4 / 3 | 1974.468 |
| path | `mode:"path"`, full repo-relative path | `["path"]` | `hit_c562ac6a…`, same file | `exact full path; exact boost=0.2`, `coverage_status=admitted`, `reason_code=text_searchable` | **verified** (`source:"source"`) | 1 / 1 | 26.540 |
| lexical | `mode:"lexical"`, `"CMS article configuration"` | `["source","symbol"]` | `libs/tools/src/redisCms/redisCms.service.ts:14` (`RedisCmsService`) | `business intent term coverage=3/3` | **verified** | 1971 / 3 | 676.164 |
| semantic | Section-3 paraphrase, `mode:"semantic"` | `["vector"]` | `apps/cms/src/article/article.service.ts` byte 14546-14605 | `persisted vector similarity 0.2466` + rrf(60) | **inference** | 50 / 3 | 325–559 |

- **Precedence is enforced in the payload, not just in prose:** deterministic lanes return
  `evidence[].status:"verified"` with a `nodeId`/line locator and a `contentHash`; the vector lane
  returns `evidence[].status:"inference"` with `untrustedContent:true` and an explicit
  `"exact/source lanes retain truth precedence"` rank reason. Semantic hits carry byte offsets and
  a `chunkId`, never a graph edge.
- **What semantic recall adds:** it surfaced `apps/cms/src/article/article.service.ts` and
  `libs/tools/src/repositories/cms/article/article-repository.module.ts` from a natural-language
  question containing none of those tokens — neither file is returned by the lexical phrase
  (`"CMS article configuration"` returns only `redisCms.service.ts` occurrences). It also surfaced
  one clearly off-target file (a free-spin `.spec.ts`), i.e. recall at the cost of precision. None
  of this is converted into graph proof anywhere in this report: every semantic hit is recorded as
  a **candidate lead**, and each claim about actual relations below is backed by
  `graphEvidence.evidenceState`.
- **Defect (count contradiction in the exact lane):** page 1 of the exact query returned
  root `candidateCount:4, returnedCount:3, truncated:true, cursor:<token>` but
  `diagnostics.truncated:false` in the **same response**, and `page.totalIsExact:false`. Continuing
  the emitted cursor returned exactly one more hit (`apps/cms/src/article/article.module.ts:15`),
  proving `truncated:true` was correct and `diagnostics.truncated:false` was **false**. A consumer
  reading `diagnostics.truncated` would stop early and treat an unexhausted result as complete.
  → `TRUNCATED_FLAG_CONTRADICTION`.
- **Defect (semantic counters lie when semantic is off):** with `options.semantic:"off"`, every
  response reports `semantic:{requested:false, applied:false, reason:"not_requested", ready:0,
  expected:0, activeGenerationIds:[]}`. `ready:0/expected:0` is not the system's state (it is
  45007/45007); only `reason` saves it from being read as "no vectors exist".
- **verdict: PARTIAL** — lane precedence, provenance and locators are excellent; the truncation
  contradiction is a real metadata defect. **confidence: high**

### Q5 — Stable symbol round-trip

Symbol ID emitted in Q4: `node_da824730-86ab-4f8e-b1a0-06a986b50d21`.

| Step | Tool + input | Target/repo/revision stable? | Result |
| --- | --- | --- | --- |
| context | `knowledge_context({target:node_da824730…, repo:"FPMS-NT", branch:"brazil-v2", limit:5, allow_fallback:false})` | ✔ identityKey `repo_a48ec7fb…::libs/tools/src/repositories/cms/article/article-repository.module.ts::ArticleRepositoryModule`, snapshot `…ee55` | focus + `importers:[apps/cms/src/article/article.module.ts]`; callers/calls empty with `completeness.status:"lower_bound"` and an explicit note that constructor/interface/static/callback calls are not modelled |
| callers | `knowledge_callers({node:…, repo, branch, limit:5, allow_fallback:false})` | ✔ same identityKey, `resolutionStatus:"resolved"` | `nodes:[]`, `resultStatus:"no_static_edge"`, `evidence.incomingByType:{defines:1}`, `unresolvedReferenceCount:84024`, `completeness:"lower_bound"` |
| callees | `knowledge_callees({…})` | ✔ | `nodes:[]`, `mode:"calls_of"`, same honest diagnostics |
| explore | `knowledge_explore({target:…, repo, branch, limit:5, max_source_lines:30, allow_fallback:false})` | ✔ | verbatim `sources[]` (`export class ArticleRepositoryModule {}`), `callPath` depth 0→1→2, `provenance[]`, `confidence{level:"high"}` |
| source/evidence pack | `get_node({id:node_da824730…})` | ✔ | `versions[]` with `contentHash 4a81fdca…9230`, `signature`, `kind:"class"`, `status:"fresh"`, `aliases:[]`, `source.code` |
| corrupted form | `knowledge_context({target:"node_da824730-…-CORRUPT"})` | — | typed `INVALID_TARGET`, `retryable:false`, echoes the bad target, has `remediation` |
| wrong-repository form | `knowledge_context({target:node_da824730…, repo:"casino-plus"})` | — | typed **`SCOPE_MISMATCH`** with `requestedRepoId`/`requestedRevisionId` vs `actualRepoId`/`actualRevisionId`, `membershipRepoIds`, `remediation:"specify the repository that owns the target"` |

- **No namesake substitution.** The wrong-repository call refused rather than resolving a
  same-named class in `casino-plus`. This is the single strongest scope-safety result in the run.
- **`callPath` from explore (graph-proved, with evidence states):**
  depth 0 `ArticleRepositoryModule` → depth 1 `ArticleRepository`
  (`node_5019bd2a-fd8f-4d1c-bfae-e4492f0ea9a8`, `libs/tools/src/repositories/cms/article/article-repository.ts:15-97`,
  via `provides`, `evidenceState:"inferred"`, `origin:"framework_adapter"`,
  `method:"DI_MODULE_PROVIDER"`, provenance line 34) → depth 2 `Article`
  (`node_1387ff4a-52d9-46b3-9b97-f2a3f1d30e65`,
  `apps/cms/libs/repositories/schemas/article.schema.ts:25-65`, via `references`,
  `evidenceState:"proven"`, `method:"EXTRACTED"`).
- **Defect (`get_node` is effectively undiscoverable):** `get_node` is published with
  `properties:{}` and `additionalProperties:true`. `{"node":…}`, `{"target":…}` and `{"nodeId":…}`
  all fail with `INVALID_TARGET / "node was not found" / details.target:null`; only `{"id":…}`
  works. The error's `details.target` key actively points at the wrong parameter name.
  **3 guessed identifiers = 3 workarounds**, and no MCP-only path existed to discover the right
  one. Same empty-schema pattern applies to `knowledge_doctor`, `knowledge_files`,
  `knowledge_explain`, `knowledge_local_graph`, `knowledge_onboarding_generate`.
- **Defect (confidence block contradicts callPath):** `explore` reports
  `confidence:{level:"high", minimum:1, inferredEdges:0, totalEdges:2}` while the depth-1 hop it
  just returned is `evidenceState:"inferred"`. `inferredEdges:0` is wrong for this payload.
- **Defect (root counts do not describe the payload):** `knowledge_context` returned
  `candidateCount:0, returnedCount:0, proofStatus:"not_proven"` at the root while `importers`
  contained one real entry. The root counters describe some other (empty) collection than the
  relations actually returned.
- **Minor:** `knowledge_callers` returns `coverageGaps:["unresolved_reference_counts_not_persisted"]`
  at the root but `coverageGaps:["unresolved_references_present"]` in `diagnostics`, and the very
  same response *does* persist a count (`unresolvedReferenceCount: 84024`) — the root gap code
  contradicts the payload.
- **verdict: PARTIAL** — the ID round-trips through five surfaces with stable target/repo/revision
  and both invalid forms are typed and actionable (hard cap "emitted ID cannot round-trip" is
  **not** triggered); but `get_node` required 3 guesses and three separate metadata blocks
  contradict their own payloads. **confidence: high**

### Q6 — Scoped architecture isolation

`get_architecture({repo:"FPMS-NT", branch:"brazil-v2", allow_fallback:false})` then
`get_architecture({repo:"casino-plus", allow_fallback:false})`, using separately emitted repo IDs.

| | FPMS-NT | casino-plus |
| --- | --- | --- |
| repoId | `repo_a48ec7fb…cb50` | `repo_c5cb9c2b-9245-4892-be53-57890e82dc86` |
| branch / commit | `brazil-v2` / `3f0f1984…9908` | `main` / `606364ba…b5f18` |
| snapshot | `snapshot_5225df3e…ee55` | `snapshot_095ae5c0-3abc-4e5e-a452-63aabc8ad943` |
| `repos[]` | `[{name:"FPMS-NT",branches:1}]` | `[{name:"casino-plus",branches:1}]` |
| symbols / files | 13710 / 3306 | 6431 / 2105 |
| languages | ts 13710 | ts 4377, tsx 2038, js 16 |
| entryPoints | 6 REST routes | `[]` |
| alignment | `explicit` | `aligned` |

- **No leak in either direction.** `repos[]` contains exactly one repo per call; every hub,
  language and count belongs to the requested repo; the two responses carry different
  `worktreeFingerprint`s and different `locator.rootPath`s.
- **Defect (`ENDPOINT_COUNT_DISAGREEMENT`):** FPMS-NT architecture reports
  `nodeCounts.endpoint: 6` and `edgeCounts.handles: 7`, while `knowledge_endpoints` on the *same*
  repo/revision reports `candidateCount: 608` with `totalIsExact: true` and returned many
  `handlerStatus:"handled"` endpoints across four pages. Two surfaces disagree about how many
  endpoint nodes and `handles` edges exist in one revision by two orders of magnitude. A consumer
  sizing an API surface from `get_architecture` would be badly wrong.
- **verdict: PASS on isolation, FAIL on count consistency → PARTIAL. confidence: high**

### Q7 — Scoped note/evidence isolation

`knowledge_note_list({repo:"FPMS-NT", limit:5})` and `knowledge_note_list({repo:"casino-plus", limit:5})`.

- Both returned `items: []` — but **scope application is proven**, not assumed: each response echoes
  its own `scope`, `revision` (distinct repoId/branchId/commit/snapshot/worktreeFingerprint),
  `freshness` and repo-specific `coverage` block (FPMS-NT 3340/3333/7/84024 vs casino-plus
  2352/2222/130/43500).
- Counters are truthful and non-absence-claiming: `completeness:"complete"`, `candidateCount:0`,
  `returnedCount:0`, `remainingCount:0`, `totalIsExact:true`, `truncated:false`,
  `nextCursor:null`, **`proofStatus:"not_proven"`**. The `not_proven` value is exactly the right
  answer — it says "no notes in this scope" without claiming "no knowledge exists elsewhere".
- **N/A sub-item:** sensitive/redaction metadata could not be exercised — there are zero notes in
  either scope, and creating one is a forbidden evaluator write. Marked
  `N/A_NO_NOTES_EXIST`. (`knowledge_search` does document an `include_sensitive` /
  "Sensitive pages are excluded unless include_sensitive" contract, but that is advertised, not
  demonstrated.) Stable pagination could likewise not be exercised on an empty list.
- **verdict: PASS (scope isolation proven; redaction/pagination N/A with evidence). confidence: high**

### Q8 — Endpoint identity and cursor continuity

Dynamic endpoint reached by following four emitted cursors (Section 2.8). All identity forms
replayed against `knowledge_flow`/`knowledge_context`:

| Identity form | Input | Resolved nodeId | identityKey | Verdict |
| --- | --- | --- | --- | --- |
| stable node ID | `node_7f61d503-720b-4923-b57b-e1b2c0297795` | `node_7f61d503-720b-4923-b57b-e1b2c0297795` | `grpc::CMS.BackendService.getresourceidlist` | converged |
| canonical protocol identity | `grpc::CMS.BackendService.getresourceidlist` | same | same | converged |
| documented title | `gRPC CMS.BackendService.GetResourceIdList` | same | same | converged |
| corrupted identity | `grpc::CMS.BackendService.getresourceidlistXX` | — | — | typed `INVALID_TARGET`, `retryable:false`, echoes the bad target, has `remediation` |

All three valid forms returned byte-comparable payloads (same root, same `steps`, same
`diagnostic.reason:"no_outgoing_edges"`, same trust block). No form silently selected a namesake.

- Cursor continuity across the four pages: strictly ascending `identityKey,nodeId`;
  `candidateCount` 608 constant, `totalIsExact:true`; `remainingCount` 603→598→593→588;
  20 distinct nodeIds, **0 duplicates**; identical `revision`/`snapshotId` on every page.
- **Defect (remediation is CLI-shaped):** the `INVALID_TARGET` remediation reads
  `"run penguin search to find a current target ID"` — a **local CLI command**, in a product whose
  whole Round 22 premise is MCP-only consumption. The MCP-callable equivalent
  (`knowledge_search`) is never named. Same pattern in every `nextActions` block
  (`"penguin index <repo-path>"`) and in `TARGET_AMBIGUOUS`
  (`"specify --repo and, when needed, --branch or an exact node ID"` — CLI flag syntax).
- **verdict: PASS on identity convergence and cursor continuity; PARTIAL overall for
  CLI-only remediation. confidence: high**

### Q9 — Endpoint-to-boundary flow

Attempted `endpoint → handler → service/use case → external or persistence boundary → tests`
for `node_7f61d503…` (`gRPC CMS.BackendService.GetResourceIdList`).

| Hop | Target | Label | Edge kind / locator | Origin / method / confidence | Scope / revision |
| ---: | --- | --- | --- | --- | --- |
| 0 | endpoint `node_7f61d503…` | **proven** (indexed) | `apps/payment/libs/utils/cmsService.ts:49-66` | parser / EXTRACTED / 1 | revision `snapshot_5225df3e…ee55` |
| 1a | handler (provider) | **not proven** | `knowledge_flow` → `diagnostic.reason:"no_outgoing_edges"`; `knowledge_endpoints` → `handlerStatus:"incomplete"`, `missingHandlerReason:"handler_not_proven_absent: endpoint coverage or generated wiring may be incomplete"`; membership `role:"consumer"` | — | — |
| 1b | locator symbol `getResourceIdList` `node_3e0709eb-28c2-42a1-8ec8-de4205b4ac99` | **proven** | `memberships[0].locatorNodeId`; `cmsService.ts:49-66` | parser / EXTRACTED / 1 | same |
| 2 | caller `getCcmsResources` `node_ef94d0cb-b8ac-4436-a36b-53af80bf58c8` | **proven** | `calls`, `apps/payment/src/mud/services/mud-admin.service.ts:305-314` | parser / EXTRACTED / 1 (`provenance: calls×2`) | same |
| 3 | controller `GetCcmsResources` `node_9373f90f-13c4-46f6-b552-755bb49ff213` | **proven** | `blastRadius`, `apps/payment/src/mud/mud-admin.controller.ts:125-127` | parser / EXTRACTED / 1 | same |
| 4 | external gRPC boundary → FPMS-NT-CCMS | **external** | `this.cmsService.getResourceIdList(data)`; diagnostic `"calls 1 remote gRPC endpoint(s) — cross-service dependency"`; `service_graph` edge `service:repo_a48ec7fb… → service:repo_8297b419…` `invokes`, `evidenceState:"proven"`, provenance `apps/payment/libs/utils/cmsService.ts` | parser / EXTRACTED / 1, `scope:"environment"` | cross-revision (declared) |
| 4b | rxjs runtime hop | **external** | `externalCalls:[{specifier:"rxjs", callees:[firstValueFrom@54, catchError@56]}]`, `completeness.externalCallCount:2` | — | — |
| 5 | tests | **not proven** | `tests: []`, `relatedTests: []`, `completeness.status:"partial"`, `unresolvedReferenceCount: 84024` | — | — |

- The chain stops honestly at the first unsupported hop in **both** directions: the *provider* side
  of the endpoint is `not proven` (this repo only holds the consumer stub, and the product says so
  in a typed field rather than returning an empty handler list), and the *external* hop is labelled
  `external` with the concrete remote service identified.
- **verdict: PASS** — every hop is labelled, no inferred hop is presented as proven, and the
  external boundary is named with graph evidence. **confidence: high**

### Q10 — Affected path/node parity and latency

| | `knowledge_affected({repo, path:"libs/tools/src/repositories/cms/article/article-repository.module.ts"})` | `knowledge_affected({repo, node:"node_da824730…d21"})` |
| --- | --- | --- |
| `files` | `["libs/tools/…/article-repository.module.ts"]` | same |
| `changed` | 1 × `ArticleRepositoryModule` (nodeId + title + nodeType only) | 1 × same node, **plus** `filePath`, `startLine/endLine`, full `source` block |
| `impacted` / `impactEdges` / `tests` / `routes` | `[]` / `[]` / `[]` / `[]` | `[]` / `[]` / `[]` / `[]` |
| `completeness` | `lower_bound` | `lower_bound` |
| `proofStatus` | `candidate` | `candidate` |
| **`candidateCount`** | **1** | **0** |
| **`totalIsExact`** | **false** | **true** |
| **`coverageGaps` / `gaps`** | `[]` | `["unresolved_reference_counts_not_persisted"]` |
| `truncated` | false | false |
| scope echo | `{branchId}` only | `{repoId, branchId}` |

- **Defect (`AFFECTED_PATH_NODE_PARITY_MISMATCH`):** the same change, expressed two documented
  ways, yields contradictory completeness metadata — `candidateCount` 1 vs 0 and
  `totalIsExact` false vs true — and only the node form discloses the unresolved-reference gap.
  A consumer choosing the path form is told the count is inexact and given **no** coverage gap;
  a consumer choosing the node form is told the count is exact **and zero** while a changed node
  is right there in the payload. Both cannot be right.
- **Latency:** measured twice (warm) for each form. No timeout, no partial warning, no truncation
  in any of the four calls. **Millisecond values are not obtainable** — unlike `knowledge_search`,
  `knowledge_affected` emits no `timingsMs`, and the harness exposes no clock to the evaluator.
  Recorded as an observability gap, not fabricated. (Where a server timing *is* emitted, this
  report quotes it: search ranged 26.5 ms (path) → 1974.5 ms (exact) → 1608.0 ms (auto+fallback).)
- **Fast-empty is correctly not sold as safety:** `impacted:[]` is accompanied by
  `completeness:"lower_bound"`, `proofStatus:"candidate"` and 84024 unresolved references, and
  `knowledge_context` prints the explicit note that constructor/interface/static/callback calls
  are not modelled.
- **verdict: PARTIAL. confidence: high**

### Q11 — Service graph usefulness and label collisions

`knowledge_service_graph({repo:"FPMS-NT"})` → 15 service nodes, 80 edges,
`candidateCount:80 == returnedCount:80`, `truncated:false`, `completeness:"lower_bound"`,
`proofStatus:"not_proven"`, `gaps:["service_graph_is_aggregated"]`.

- Dynamic service (serviceIndex = 0) = **`service:repo_a48ec7fb-5987-47df-9198-06969359cb50`
  (FPMS-NT)**. Followed it via `get_architecture({repo:"FPMS-NT"})` and via the outbound edges:
  8 `invokes` edges (→ Payment, CCMS, Auth-Player, Risk-Control, Provider, fpmsXcpms, Recommend,
  User-Engagement) and 3 `depends_on` edges (→ flyover, NT-Shared, Proposal-SDK), each with
  `evidenceState:"proven"`, `origin:"parser"`, `method:"EXTRACTED"`, `confidence:1` and a concrete
  `provenance.filePath`.
- **Aggregation is declared, not silent.** The graph deliberately spans services; it says so in
  `gaps:["service_graph_is_aggregated"]`, `graphEvidence.scope:"environment"` on `invokes` edges,
  and each edge carries its **own** `revisionId` (e.g. `branch_982d1a9b…` for Auth-Player's
  `depends_on` edges) rather than inheriting FPMS-NT's. This is correct cross-service modelling,
  not a scope leak: the root `scope`/`revision` remain FPMS-NT's.
- **Repeated display labels: `N/A_NO_LABEL_COLLISION` at service level** — all 15 service titles
  are distinct, so no same-labelled service pair exists to confuse. The *underlying guarantee* was
  therefore tested at symbol level instead, where collisions genuinely exist:
  - `knowledge_context({target:"constructor", repo:"FPMS-NT", branch:"brazil-v2"})` →
    typed **`TARGET_AMBIGUOUS`** listing 20 distinct candidate nodeIds with distinct
    `identityKey`s. It **refused to pick one silently.**
  - `knowledge_search({mode:"exact", query:"getImgUrl", repo:casino-plus})` — a label that appears
    4× in that repo's hub list — returned two hits with **distinct** nodeIds
    (`node_f00e975c…`, `node_3f62247c…`) and **distinct** filePaths, each with
    `evidence.status:"verified"`. No merging by label.
- **Defect (`TARGET_AMBIGUOUS` disambiguation is weak):** the 20 candidates all carry
  `filePath: null, branch: null, startLine: null` — the only distinguishing data is the opaque
  `identityKey`. And the remediation says *"specify --repo and, when needed, --branch"* even though
  the request **already** specified `repo:"FPMS-NT"` and `branch:"brazil-v2"` — the advice is both
  CLI-shaped and already satisfied.
- **Latency/truncation:** single response, `truncated:false`, no warnings; no `timingsMs` emitted
  by this tool (observability gap).
- **verdict: PARTIAL. confidence: high**

### Q12 — Three independent cursor families

| Family | Tool | Ordering key | Page 1 | Page 2 | Duplicates | Remaining count truthful? |
| --- | --- | --- | --- | --- | --- | --- |
| **Endpoints** | `knowledge_endpoints` limit 5 | `identityKey,nodeId` | 5 items, `candidateCount 608`, `remaining 603` | pages 2–4 continued → `remaining 598/593/588` | 0 across 20 items | ✔ exact (`totalIsExact:true`, −5 per page) |
| **File/symbol** | `knowledge_file_symbols` limit 2 on `apps/cms/src/article/article.controller.ts` | `startLine,nodeId` | `ArticleController`(13), `constructor`(14); `candidateCount 8`, `remaining 6` | cursor emitted, revision-pinned (`"revision":"branch_1d21f868…"`) | 0 | ✔ `totalIsExact:true` |
| **Dead-code/audit** | `find_dead_code` limit 3 | `filePath,startLine,nodeId` | 3 items, `candidateCount 5650`, `remaining 5647` | continued → `GameRepositoryModule`, `constructor`, `PlatformAnnouncementRepositoryModule`, `remaining 5644` | 0 | ✔ `totalIsExact:true` |

Negative cursor cases:

| Case | Input | Result |
| --- | --- | --- |
| malformed | `knowledge_endpoints(cursor:"not-a-real-cursor-round22")` | typed **`CURSOR_INVALID`**, `"malformed cursor"`, `retryable:false`, echoes the cursor |
| wrong-scope | FPMS-NT dead-code cursor replayed with `repo:"casino-plus"` | typed **`CURSOR_SCOPE_MISMATCH`**, `"invalid or mismatched dead-code cursor"`, `retryable:false`, remediation `"restart dead-code pagination from the first page using the same repo, path, and branch scope"` |
| exhausted | `knowledge_coverage(kind:"failed")`, `kind:"stale"`, `knowledge_file_symbols` on the 1-symbol module file | `truncated:false`, `nextCursor:null`, `remainingCount:0`, `totalIsExact:true` — exhaustion is signalled by cursor absence, so there is no stale cursor to replay |
| expired | endpoints page-1 cursor (`expiresAt 2026-08-31T15:39:36.896Z`) replayed **8 min 25.5 s** later (derived exactly from the delta between that stamp and the `expiresAt 15:48:02.425Z` the same response issued) | **Succeeded**, returning the identical page-2 content and a fresh cursor |

- **No offset reconstruction anywhere.** All cursors are opaque signed tokens whose payload
  (`orderingKey`, `lastKey`, `scope`, `revision`, `expiresAt`, `limit`, `capabilityHash`) is
  server-authored. Continuation never required computing a page number or offset. Replaying the
  same cursor twice was idempotent (identical page-2 content) — correct behaviour.
- **Defect (no `expired`/`stale` distinction obtainable):** the brief requires typed
  `invalid / stale / expired / wrong-scope` distinctions. `invalid` and `wrong-scope` are typed
  and excellent. **`expired`/`stale` are NOT PROVEN**: the cursor carries an `expiresAt` but no
  Penguin surface exposes the server's current time, so an MCP-only consumer cannot determine
  whether a cursor is expired, and the one reuse at +8m25s was accepted. Whether that reuse
  *should* have been rejected depends on the (undocumented, unobservable) TTL — so this is
  recorded as **unproven in both directions**, and the observability gap is the finding.
- **Defect (dead-code cursor is not revision-pinned):** its payload is
  `"scope":"FPMS-NT|*|*"` with **`"revision": null`** — it binds to the repo *display name*, not to
  `repoId` + `snapshotId`, unlike the endpoints cursor (`repoId|branchId|*`, `revision:snapshot_…`)
  and the file-symbols cursor (`revision:branch_…`). A dead-code cursor that survives a re-index
  could silently paginate a different revision. Scope crossing was still refused in the
  cross-repo test, so this is a latent risk, not an observed leak.
- **Agent-B continuation:** see Q17 — **not performed in a genuinely new MCP process**, so this
  requirement of Q12 is **NOT PROVEN**.
- **verdict: PARTIAL** — three independent families proven with stable ordering, zero duplicate
  stable IDs, truthful remaining counts and two of four typed cursor-error classes.
  **confidence: high**

### Q13 — Actionable coverage debt

| Category | Aggregate | Concrete item retrieved through a documented MCP read surface |
| --- | ---: | --- |
| discovered | 3340 | — (aggregate only, by definition) |
| admitted | 3333 | `knowledge_file_symbols` / `knowledge_files` reach admitted files individually |
| **excluded** | 7 | ✔ `knowledge_coverage({kind:"excluded", limit:3})` → `.env.example` (`reasonCode:"secret_policy"`, `classification:"secret"`), `apps/offline-casino/src/amla/assets/fonts/Roboto-Bold.ttf` and `-BoldItalic.ttf` (`reasonCode:"binary"`, `"NUL byte detected in content sample"`). `candidateCount:7`, `returnedCount:3`, `remainingCount:4`, `totalIsExact:true`, cursor emitted |
| failed | 0 | ✔ typed empty: `items:[]`, `candidateCount:0`, `totalIsExact:true`, `truncated:false`, `gaps:[]` |
| stale | 0 | ✔ typed empty, same shape |
| **unresolved** | 84024 | ✔ `knowledge_coverage` default page → 43 concrete unresolved rows with `filePath`, `startLine`, `rawTarget`, `reasonCode` ∈ {`no_enclosing_symbol`, `external_package`, `unresolved_member_or_type`, `platform_member`} and `sourceNodeId` where an enclosing symbol exists (e.g. `apps/admin/inteceptor/payment-external.service.ts:32 rawTarget "GetPaymentConfigs" unresolved_member_or_type`) |
| semantic ready/expected | 45007 / 45007 | ✔ `knowledge_semantic_status` per generation |

**Concrete-vs-aggregate reconciliation:** the product performs this itself and publishes the
result — `coverage.reconciliation = {status:"reconciled", revisionId:"snapshot_5225df3e…ee55",
itemCount: 84024, aggregateUnresolved: 84024, **delta: 0**}`. Independently,
`candidateCount 84031 = 84024 unresolved + 7 excluded`, and
`returnedCount 50 + remainingCount 83981 = 84031`. Every arithmetic identity holds.

Not `VISIBLE_BUT_NOT_ACTIONABLE`: each non-zero debt category yields concrete, individually
addressable items with reasons, and each zero category returns a typed exact empty rather than
silence.

- **verdict: PASS. confidence: high**

### Q14 — Semantic lifecycle integrity

Two reads separated by ~9 minutes of wall clock (bracketing the whole Q4–Q12 batch; far more than
the required 5 s) plus a third at preflight — three reads in total, all identical.

| Generation | State | ready/expected/running/pending/retryFail/termFail | active/staging/superseded | Served by search | Verdict |
| --- | --- | --- | --- | --- | --- |
| `generation_5c026dc4ef2ab3a3c43641d4ee1c1cea37e9c81c37ac440f` | `active` | 45007 / 45007 / 0 / 0 / 0 / 0 | **active** (and `activeGenerationId` on every row points here) | **YES** — `diagnostics.semantic.activeGenerationIds` in all four semantic queries, and `embeddingSpaceId space_00646ffa…6432c` == this generation's `modelHash` | PASS |
| `generation_ff0a09f7094a5c3f4d6105fbbe5dfcb6d2ac050e095843d6` | `superseded` | 0 / 38392 / 0 / 0 / 0 / 0, reason `SEMANTIC_CHUNK_SET_REPLACED` | superseded | no | PASS |
| `generation_2c7948d8c46feb8af0bf67f6e444733361671dcb14dcfc35` | `superseded` | 0 / 68893 / … same reason | superseded | no | PASS |
| `generation_f364498533d43b745f7dfb6b7134df7fca895b7cf50e27e5` | `superseded` | 0 / 380141 / … same reason | superseded | no | PASS |
| `generation_legacy_v16` (scope `legacy`) | `superseded` | 0 / 45007 / …, reason `"legacy semantic rows are not activation-eligible"`, `activeGenerationId: null` | superseded | no | PASS |

- **Exactly one complete active generation** for the FPMS-NT space. No `staging` row exists. No
  historical generation is mislabelled `stalled` or `failed` — every one carries an explicit
  `superseded` state **and** a machine-readable reason. Zero `retryableFailed`, zero
  `terminalFailed` anywhere.
- **No staging/superseded leakage into search:** every semantic query returned
  `activeGenerationIds` containing only the active generation, and every returned hit's
  `embeddingSpaceId` matched the active generation's model hash. The three superseded model hashes
  (`5d2ceeba…`, `9acfbda2…`, `ba040970…`) and the legacy space never appeared in a single hit.
- **Defect (`SEMANTIC_OBSERVABILITY_INCOMPLETE`):** Section 4 requires worker identity,
  lease/heartbeat, rate and ETA, plus dimensions. `workerBuildId: null`, `lastHeartbeatAt: null`,
  `ratePerSecond: null`, `etaSeconds: null` — and there is **no key at all** for embedding
  `dimensions` or for a worker `lease`. With no active job these nulls are defensible for rate/ETA,
  but worker identity, heartbeat and lease are properties of the *worker*, not of a job, and
  `dimensions` is a static property of the space. An MCP-only consumer cannot verify a worker
  exists at all.
- **verdict: PASS on lifecycle integrity; PARTIAL on observability. confidence: high**

### Q15 — Graph-first responsiveness

Sequence: `knowledge_semantic_status` → `knowledge_search`(deterministic) → `knowledge_context` →
`knowledge_flow` → `knowledge_affected` → `knowledge_service_graph` → `knowledge_semantic_status`.

| Step | Result | Server timing | Timeout / partial warning |
| --- | --- | ---: | --- |
| semantic_status (before) | 4 FPMS-NT rows, active gen 45007/45007 | n/a | none |
| search `mode:"path"` | 1 verified hit | 26.540 ms | none |
| search `mode:"exact"` | 3 hits + cursor | 1974.468 ms | none |
| context (node) | focus + importers | n/a | none |
| flow (endpoint) | root + typed `no_outgoing_edges` | n/a | none |
| affected (path + node) | changed 1 | n/a | none |
| service_graph | 15 nodes / 80 edges, `truncated:false` | n/a | none |
| semantic_status (after) | **identical** to before | n/a | none |

- Graph/Lexical was **never blocked** by semantic state. Structurally it cannot be: no graph tool
  accepts a semantic parameter, and `knowledge_search` exposes `options.semantic:"off"` plus seven
  deterministic modes. Behaviourally it was proven twice more: (a) on `casino-plus`, where the
  semantic lane is **unavailable**, the exact lane still returned two verified symbol hits with a
  cursor (`candidateCount 528`) and the auto lane returned three verified source hits
  (`candidateCount 832`) while explicitly reporting
  `skippedLanes:[{lane:"semantic", reason:"async_semantic_lane_required"}]`; (b) all FPMS-NT graph
  calls above ran while the semantic space was fully materialised.
- Hard cap "Graph blocked by semantic work" — **not triggered**.
- **verdict: PASS. confidence: high**

### Q16 — MCP-only startup/wake readiness

- **New MCP process: NOT PROVEN.** Starting a genuinely new MCP client process requires a
  terminal/CLI action (forbidden by Section 1) or a second client the evaluator cannot launch. A
  harness sub-agent would share this session's existing MCP connection and would therefore *not*
  be a new MCP process — using one would have produced a false positive, so it was deliberately
  not used.
- **Queued work: `N/A_NO_QUEUED_WORK`, evidenced.** Across three `knowledge_semantic_status` reads
  spanning ~9 minutes, every generation reported `running: 0`, `pending: 0`, `retryableFailed: 0`,
  `terminalFailed: 0`, `paused: false`, `pauseRequested: false`, `progressPercent: 100` for the
  active generation. There is no queued work to wake, and creating some (index/rebuild/watch) is a
  forbidden evaluator mutation.
- **Worker/runtime readiness verified without creating work:** `mcp_health` reports all eight
  native dependencies `ready` — including the three that the embedding worker needs
  (`sqlite-vec` `193e480c…`, `onnxruntime-node` `ffa33e57…`, and the
  `nomic-embed-text-v1.5` model `b4342336…` + tokenizer `d241a60d…` + manifest `4193e4f8…`) —
  `initializeHealthy: true`, `status: "ok"`, `queryRuntime {workers: 2, hardTimeoutMs: 30000}`,
  `restartRequired: false`. `mcp_health` itself is documented as deliberately avoiding package /
  environment / database scans so it stays responsive during a slow query, and it returned
  promptly at the start of this session — i.e. initialize is not blocked by knowledge work.
- **What is still unproven:** whether MCP *detects and wakes* queued work, because no such work
  exists and none may be created. And with `workerBuildId`/`lastHeartbeatAt` both `null`, there is
  no positive evidence that a background worker process is alive at all — only that its
  dependencies are installed.
- **verdict: N/A on wake execution (`N/A_NO_QUEUED_WORK`, evidenced); PARTIAL on readiness;
  NOT PROVEN on new-process startup. confidence: high**

### Q17 — Fresh Agent-A/Agent-B handoff

**FRESH PROCESS HANDOFF: NOT PROVEN.** The handoff requires "one second genuinely new MCP client
process". This evaluator cannot start one without a terminal (forbidden), and a sub-agent inside
this harness would reuse this same MCP connection — replaying the packet through it would prove
nothing about a fresh process and would be a false claim. Rather than manufacture that, the packet
is published below in full, and every item was **replayed in-process** so the *data* is verified
even though the *process boundary* is not.

**Agent-A packet (all values emitted in this Round 22 process):**

```text
runtime:            appVersion 1.16.0, buildId 1.16.0-696f5732bd1f8911 (running == available)
contract:           contractVersion 2, schemaVersion 18 (graph trust blocks say 17 — see defect)
capabilityHash:     e38ea18f3da0cd3a3f68941a8c8adc2e13bc76d8fa898461160fa847d56365fb
repo:               FPMS-NT = repo_a48ec7fb-5987-47df-9198-06969359cb50
revision:           brazil-v2 / branch_1d21f868-3252-4b74-8289-8f7c4735247f
                    commit 3f0f1984b9e4337668529a13bad5264501729908
                    snapshot snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55
symbol ID:          node_da824730-86ab-4f8e-b1a0-06a986b50d21  (ArticleRepositoryModule)
endpoint ID:        node_7f61d503-720b-4923-b57b-e1b2c0297795  (grpc::CMS.BackendService.getresourceidlist)
service ID:         service:repo_a48ec7fb-5987-47df-9198-06969359cb50  (FPMS-NT)
cursor (endpoints): <opaque JWS, orderingKey identityKey,nodeId, lastKey grpc::CMS.BackendService.getsectionnamelist>
cursor (filesyms):  <opaque JWS, orderingKey startLine,nodeId, scope branch_1d21f868…|apps/cms/src/article/article.controller.ts>
cursor (deadcode):  <opaque JWS, orderingKey filePath,startLine,nodeId, scope "FPMS-NT|*|*", revision null>
proven relation:    node_5019bd2a-fd8f-4d1c-bfae-e4492f0ea9a8 (ArticleRepository)
                    --references--> node_1387ff4a-52d9-46b3-9b97-f2a3f1d30e65 (Article)
                    evidenceState "proven", method EXTRACTED, confidence 1
semantic generation: generation_5c026dc4ef2ab3a3c43641d4ee1c1cea37e9c81c37ac440f (active, 45007/45007)
restart required:   false (clientRestartRequired false, runtimeOutdated false)
```

In-process replay parity: **11/11 items replayed successfully, 0 repairs, 0 scope mismatches**
(details in §8). Because the replay did not cross a process boundary, it earns **no** credit for
"Fresh Agent-A/Agent-B replay" (Environment Readiness, 15 pts) or "Fresh-process handoff without
manual setup" (MCP UX, 10 pts).

- **verdict: NOT PROVEN. confidence: high**

### Q18 — Error taxonomy and remediation

| Scenario | Input | Code | Category | Retryable | Remediation | Transport |
| --- | --- | --- | --- | --- | --- | --- |
| empty query | `knowledge_search({query:""})` | `INVALID_QUERY` | input | false | `"provide a non-empty query string"` | typed JSON error |
| unknown repo | `knowledge_search(scope.revisions[0].repoName:"NO-SUCH-REPO-R22")` | **`BRANCH_NOT_FOUND`** | ✗ **mis-categorised** | false | **none** | typed JSON error |
| missing target | `knowledge_context({target:"…-CORRUPT"})` | `INVALID_TARGET` | target | false | `"run penguin search…"` (CLI) | typed JSON error |
| ambiguous name | `knowledge_context({target:"constructor", repo, branch})` | `TARGET_AMBIGUOUS` | target | false | `"specify --repo and, when needed, --branch…"` (CLI, **already satisfied**) + 20 candidates with null filePath/branch/line | typed JSON error |
| invalid node ID | `get_node({node:…})`, `{target:…}`, `{nodeId:…}` | `INVALID_TARGET` "node was not found", `details.target: null` | ✗ **misleading** — the input was a *valid* node ID; only the parameter key was wrong | false | none | typed JSON error |
| wrong-repository node ID | `knowledge_context({target:node_da824730…, repo:"casino-plus"})` | **`SCOPE_MISMATCH`** | scope | false | `"specify the repository that owns the target"` + requested vs actual repoId/branchId/revisionId + `membershipRepoIds` | typed JSON error — **best-in-class** |
| malformed cursor | `knowledge_endpoints({cursor:"not-a-real-cursor-round22"})` | `CURSOR_INVALID` | cursor | false | none, but echoes the cursor | typed JSON error |
| wrong-scope cursor | FPMS-NT dead-code cursor + `repo:"casino-plus"` | `CURSOR_SCOPE_MISMATCH` | cursor | false | `"restart dead-code pagination from the first page using the same repo, path, and branch scope"` | typed JSON error |
| corrupted endpoint identity | `knowledge_context({target:"grpc::CMS.BackendService.getresourceidlistXX"})` | `INVALID_TARGET` | target | false | `"run penguin search…"` (CLI) | typed JSON error |
| unknown workspace | `knowledge_semantic_status({scopeKey:"FPMS-NT"})` | **none** — `{"statuses":[]}` | ✗ **silently empty** | — | none | HTTP-200-equivalent success |
| unsupported semantic selection | `knowledge_search({mode:"semantic", scope: casino-plus})` (repo has no vector generation) | **none** — bare string `"0 hits · lanes"` | ✗ **untyped** | — | none | **untyped error string, not JSON** |

- **`no_match` does not erase invalid input or ambiguity** in the eight typed cases — every one
  returns a distinct code rather than a zero-result. That part is genuinely strong, and
  `SCOPE_MISMATCH` is exemplary.
- **Three failures of the taxonomy:**
  1. **Unknown repo is reported as `BRANCH_NOT_FOUND`** — `"branch main was not found in the
     indexed repository"` when the *repository* `NO-SUCH-REPO-R22` does not exist. The message
     misdirects the consumer at the branch, and carries no remediation.
  2. **`knowledge_semantic_status` with an unrecognised scope key returns `{"statuses":[]}`** with
     no scope echo, no `candidateCount`, no `totalIsExact`, no diagnostic — the only surface in the
     entire product that returns a bare empty collection. It is indistinguishable from "this scope
     has no semantic work", violating truth rule 6.
  3. **Unsupported semantic selection returns the untyped string `"0 hits · lanes"`** (reproduced
     twice). No code, no category, no retryability, no remediation, no scope, no `queryStatus`, not
     even valid JSON. And the *text asserts a zero result* for a lane that was never run. The
     honest behaviour exists elsewhere in the same tool — `mode:"auto"` on the same repo returns
     hits plus `skippedLanes:[{lane:"semantic", reason:"async_semantic_lane_required"}]` and
     `warnings:[{code:"SEMANTIC_LANE_UNAVAILABLE", message:"semantic search requires the async
     provider runtime; deterministic lanes are partial results"}]` — so `mode:"semantic"` is simply
     failing to route through it.
- **Systemic remediation defect:** four distinct error/diagnostic surfaces recommend the local CLI
  (`penguin search`, `penguin index <repo-path>`, `--repo`/`--branch` flags) to a consumer who by
  the product's own deployment model may have no shell. Not one names the MCP-callable equivalent.
- **verdict: PARTIAL, trending FAIL on the three untyped/mis-typed cases. confidence: high**

### Q19 — Adversarial negative tri-state

| # | Claim | Evidence lane | Coverage / completeness | Verdict | Missing evidence |
| ---: | --- | --- | --- | --- | --- |
| 1 | No production caller exists for `ArticleRepositoryModule` (`node_da824730…`) | graph (`callers`, `context`, `explore`, `affected`) | `completeness:"lower_bound"`, `resultStatus:"no_static_edge"`, `unresolvedReferenceCount: 84024`, `incomingByType:{defines:1}` | **not proven** | `knowledge_context` *did* return an importer (`apps/cms/src/article/article.module.ts`) and `explore` returned a `provides` edge to `ArticleRepository` with `method:"DI_MODULE_PROVIDER"` — i.e. NestJS DI wiring exists. Static call edges are explicitly documented as not modelling constructor/interface/static/callback calls. Needs runtime/source review of the Nest module graph. |
| 2 | No test covers the dynamic endpoint `grpc::CMS.BackendService.GetResourceIdList` | graph (`flow.relatedTests`, `locate.tests`, `affected.tests`) | all `[]`, but `completeness:"partial"`, `edgeCounts.tests: 1620` exist repo-wide, `endpoint_coverage_incomplete` gap declared | **not proven** | The endpoint node itself has `no_outgoing_edges`; a test could exercise `getCcmsResources`/`GetCcmsResources` transitively without a `tests` edge to the endpoint. Needs the test-file view or a source read. |
| 3 | The endpoint never reaches an external/persistence boundary | graph + service graph | `externalCalls` non-empty; diagnostic `"calls 1 remote gRPC endpoint(s) — cross-service dependency"`; `service_graph` edge FPMS-NT→FPMS-NT-CCMS `invokes` `evidenceState:"proven"` with provenance `apps/payment/libs/utils/cmsService.ts` | **contradicted** | none — this negative is disproved by proven graph evidence |
| 4 | Repeated service labels cannot affect selection | graph + typed errors | 15/15 FPMS-NT service titles distinct → no service-level collision exists; symbol-level collisions tested instead | **not proven (service level) / proven (symbol level)** | At service level the hypothesis is untestable in this environment (`N/A_NO_LABEL_COLLISION`). At symbol level it *is* proven: `constructor` → typed `TARGET_AMBIGUOUS` with 20 distinct nodeIds, and `getImgUrl` in casino-plus → 2 distinct nodeIds with distinct paths. A service-label collision has never been observed here, so no claim is made about it. |
| 5 | No better semantic match exists beyond the returned top three | vector (inference lane only) | `candidateCount: 50`, `returnedCount: 3`, `truncated: true`, **`cursor: null`**, `totalIsExact: false` | **not proven** | 47 candidates were withheld and the semantic lane emits **no continuation cursor**, so the result set is structurally unexhaustible. Even if it could be exhausted, `evidence[].status:"inference"` means it could never prove a graph fact. |
| 6 | All unresolved references are harmless | coverage | 84024 unresolved, `reconciliation.delta: 0`, `completeness:"lower_bound"`, `gaps:["coverage_debt_requires_remediation"]` | **not proven** | Sampled reasons are mostly benign (`external_package` for `@nestjs/*`, `rxjs`, `mongoose`; `platform_member`), but `unresolved_member_or_type` rows such as `GetPaymentConfigs`, `BaseRepository`, `getService` are in-repo-shaped and could hide real edges. Only 50 of 84024 were inspected; the product itself labels this `requires_remediation`. |
| 7 | Closing Tauri stops MCP semantic capability | runtime | `mcp_health` reports `configured: null`, `launcherHealthy: null`, `signing.status: "unknown"`; no MCP field reports UI presence | **not proven** | The Penguin UI's state was never observed by this evaluator (Section 7 not performed), and no MCP surface exposes whether Tauri is running. Circumstantially the runtime is a standalone bundled Node process under `/Users/shieng/.penguin/runtimes/current` with its own embedding model, and every semantic query in this run succeeded — but "Tauri was closed" was never established, so neither direction is proven. |

- **verdict: PASS on discipline** — every answer is tri-state and cites lane + coverage +
  missing proof; the one `contradicted` is backed by proven graph edges, and no `proven` negative
  was asserted anywhere. **confidence: high**

### Q20 — Private-owner boundary and useful verdict

| State | Verdict | Evidence |
| --- | --- | --- |
| **Installed** | **YES** | `mcp_health` → appVersion 1.16.0, `runtimeRoot /Users/shieng/.penguin/runtimes`, 8/8 native dependencies `ready` with sha256 |
| **Configured** | **YES (with a caveat)** | `configPath /Users/shieng/.penguin/config.json`, 20 repositories registered with roots and branches. Caveat: `mcp_health.configured` is literally `null` — the product does not answer its own configured question |
| **Loaded** | **YES** | `runningBuildId == availableBuildId == 1.16.0-696f5732bd1f8911`, `outdated:false`, `clientRestartRequired:false`, and a live query echoes the same `capabilityHash` and active generation |
| **Healthy** | **YES, with an identity blemish** | `status:"ok"`, `initializeHealthy:true`, 101/101 capabilities `implemented`, DB connected (schema 18, 5.10 GB); blemish = graph `trust.schemaVersion: 17` vs 18 everywhere else |
| **Useful** | **YES for graph/lexical/coverage work; QUALIFIED for semantic; NO for absence proofs** | Graph, exact/path/lexical retrieval, endpoint identity, coverage debt and scope isolation are genuinely production-useful and honest about limits. Semantic is deterministic and well-provenanced but unexhaustible and untyped when unavailable. No surface can prove a negative — and the product consistently says so |

**Owner-only operations correctly outside an MCP-only consumer's authority**, and why that is right
for this private deployment: indexing/rebuild/watch (`knowledge.index`, `knowledge.rebuild`,
`knowledge.watch`), repository registration/removal and branch pinning, snapshot materialisation,
migration/repair (`knowledge.evidence.repair`, `knowledge.api_doc.repair`), semantic control
(`knowledge.semantic_control` — pause/resume/retry), all note/memory/ontology/link writes, artifact
import/export, package install/uninstall and CLI install. These mutate a **single owner-local
5.1 GB SQLite corpus indexing 20 private repositories at absolute filesystem paths**; a consumer
that could trigger a re-index or a semantic-generation swap could degrade every other consumer's
evidence and burn the owner's machine. Read/write separation is the correct boundary. It is
notable that these capabilities are all *registered and callable* — the boundary is enforced by
evaluation discipline here, not by the server, and there are **no `readOnlyHint`/`destructiveHint`
annotations** to help a well-behaved client enforce it automatically. That is the one place where
the private-owner boundary is weaker than it should be.

**Separation of knowledge types in this report:**

| Type | Examples from this run | Trust |
| --- | --- | --- |
| Current graph facts | `ArticleRepository --references--> Article` (`EXTRACTED`, confidence 1); endpoint→locator symbol→`getCcmsResources`→`GetCcmsResources`; FPMS-NT `invokes` FPMS-NT-CCMS | usable as proof, revision-pinned |
| Framework-inferred graph facts | `ArticleRepositoryModule --provides--> ArticleRepository` (`DI_MODULE_PROVIDER`, `evidenceState:"inferred"`, `origin:"framework_adapter"`) | usable as a strong lead; labelled inferred by the product |
| Semantic candidates | `article.service.ts`, `article-repository.module.ts`, the free-spin spec file | discovery leads only — `status:"inference"`, `untrustedContent:true`, never converted to proof here |
| Generated notes | the onboarding markdown (`revision-hash 29d9be89…`) | orientation only; contains at least one wrong code example |
| Manual notes | none exist (`knowledge_note_list` empty in both scopes) | n/a |
| Runtime / log / source verification boundary | rxjs `firstValueFrom`/`catchError`; the remote CMS gRPC call; NestJS DI resolution; 84024 unresolved references; whether any test exercises the endpoint | **outside Penguin** — requires source, logs or a running system |

- **verdict: PASS. confidence: high**

---

## 5. B1–B8 workflows

### B1 — Cold CMS article incident

Starting only from *"An FPMS-NT API is returning the wrong CMS article configuration."*

**Candidate entry points (all revision-pinned to `snapshot_5225df3e…ee55`):**

| Entry point | nodeId | Location | Handler evidence |
| --- | --- | --- | --- |
| `gRPC CMS.BackendService.GetConfigArticle` | `node_7a5eff36-c2ba-473f-a6d6-dc4bd5d73043` | `apps/cms/src/article/article.controller.ts:17-19` | handler `GetConfigArticle` `node_24f51b47…`, `evidenceState:"proven"`, `EXTRACTED` |
| `gRPC CMS.BackendService.GetConfigArticleById` | `node_db67ced0-2ebe-4a6a-9796-7055ffd1c595` | `article.controller.ts:37-39` | handler `node_6eb94c01…`, proven |
| `gRPC CMS.BackendService.DeleteConfigArticle` | `node_230694fb-950e-4a7d-b735-6d9d4ba99e43` | `article.controller.ts:27-29` | handler `node_44322d8a…`, proven |
| `gRPC CMS.BackendService.GetSectionNameList` | `node_384714af-e152-42b8-ba91-c0fce6a631b8` | `article.controller.ts:42-44` | handler `node_ef6750df…`, proven |
| `gRPC CMS.BackendService.GetResourceIdList` (consumer stub) | `node_7f61d503-720b-4923-b57b-e1b2c0297795` | `apps/payment/libs/utils/cmsService.ts:49-66` | `handlerStatus:"incomplete"`, `handler_not_proven_absent` |
| `gRPC CMS.BackendService.GetComponent` / `GetCpmsGameList` / `GetGameImageUrl` / `AssignTicketEvent` | see §2.8 pages 3–4 | `libs/tools/src/client-grpc/cms-client-grpc*.ts` | consumer role, handler not proven absent |

**Bounded exact-vs-semantic comparison** (same concept, one bounded call each):

| Lane | Top result | Evidence status | Adds |
| --- | --- | --- | --- |
| semantic (`limit 3`) | `apps/cms/src/article/article.service.ts` (byte 14546-14605) | `inference` | surfaced the *service* layer and `libs/tools/src/repositories/cms/article/article-repository.module.ts` from natural language; also returned one irrelevant free-spin spec |
| lexical (`"CMS article configuration"`) | `libs/tools/src/redisCms/redisCms.service.ts:14` (`RedisCmsService`) | `verified` | surfaced a **Redis CMS cache layer** the semantic lane missed entirely — a prime suspect for "wrong configuration returned" |
| exact / path | `article-repository.module.ts`, `ArticleRepositoryModule` `node_da824730…` | `verified` | pinned exact nodeIds for graph traversal |

**Graph trace (proven unless marked):** `ArticleRepositoryModule` → *(provides, **inferred**,
DI_MODULE_PROVIDER)* → `ArticleRepository` (`node_5019bd2a…`,
`libs/tools/src/repositories/cms/article/article-repository.ts:15-97`) → *(references, **proven**)*
→ `Article` schema (`node_1387ff4a…`, `apps/cms/libs/repositories/schemas/article.schema.ts:25-65`).
Separately, `apps/cms/src/article/article.module.ts` imports the module (file-level importer edge).

**Evidence frontier — where Penguin stops:**
- the CMS article *controller → service → repository* call edges were not traversed in this run
  beyond the module/repository/schema chain; `calls` lists are `lower_bound` by contract;
- `RedisCmsService` was surfaced lexically but its relationship to the article read path is
  **not proven** here;
- 84024 unresolved references repo-wide, `completeness:"lower_bound"`;
- no notes, no tests edges on the inspected nodes.

**Exact source/log/runtime checks a human must run (no root cause is claimed):**
1. Read `apps/cms/src/article/article.service.ts` and `libs/tools/src/repositories/cms/article/article-repository.ts:15-97` — confirm which one shapes the returned config.
2. Read `libs/tools/src/redisCms/redisCms.service.ts` — determine whether article config is cached and whether a stale/incorrectly-keyed cache entry can serve wrong data.
3. Inspect the `Article` schema (`apps/cms/libs/repositories/schemas/article.schema.ts:25-65`) versus the gRPC response DTO for field-mapping drift.
4. Runtime: capture the actual `GetConfigArticle` / `GetConfigArticleById` request and response for one failing case; compare with the Mongo document.
5. Logs: FPMS-NT has 3027 `log_site` nodes and 2903 `emits_log` edges — pull the CMS article read path logs for the failing request id.
6. Environment: confirm which CMS backend the failing environment points at, since `GetResourceIdList` and friends cross into FPMS-NT-CCMS.

**No root cause is asserted.** — **verdict: PASS. confidence: high**

### B2 — Player operation investigation

Starting only from *"An FPMS-NT player operation does not complete."*

- **Onboarding first** (`knowledge_onboarding_generate`) gave the CLI-free sequence and named the
  entry points; two of the six advertised REST entry points are player-facing:
  `POST /promotion/GetPlayerFreeSpinInfo` and `POST /provider/notifyJackpotPlayer`
  (plus `POST /provider/handPayKycInfo`, `POST /provider/handPayKycSubmit`).
- **Scoped retrieval → stable IDs:** the endpoint enumeration (608 endpoints,
  `totalIsExact: true`) yields player-operation candidates with stable nodeIds; the
  `AdminGrowthTaskController` family from pages 1–2
  (`node_b532eeda…` CreateTaskConfig, `node_dba69c40…` UpdateTaskConfig,
  `node_102a8f36…` SetTaskConfigStatus, `node_34182942…` QueryUserTaskReport,
  `node_7cbb51dd…` UpdateTestUserIds) are all `handlerStatus:"handled"` with `proven` handler edges
  into `apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts`.
- **Cross-service reality (proven, service graph):** a player operation in FPMS-NT can span
  FPMS-NT-Payment, FPMS-NT-CCMS, FPMS-NT-Auth-Player, FPMS-NT-Risk-Control, FPMS-NT-Provider,
  fpmsXcpms, FPMS-NT-Recommend and FPMS-NT-User-Engagement — eight `invokes` edges, each `proven`
  with a concrete provenance file (e.g. Auth-Player via
  `apps/payment/src/external/player-external.service.ts`, Risk-Control via
  `apps/payment/src/payment/top-up/services/deposit-limit.service.ts`). "Does not complete" is
  therefore a distributed-transaction question, not a single-repo one.
- **Context / flow / affected evidence:** demonstrated end-to-end on the CMS chain in Q5/Q9/Q10 —
  `knowledge_locate` returns verbatim source plus callers, calls, blastRadius, externalCalls and
  per-edge provenance in one bounded call; `knowledge_flow` labels dead ends with typed reasons;
  `knowledge_affected` returns changed/impacted/tests/routes with `lower_bound` honesty.
- **Known:** the endpoint inventory, which handlers are proven, which endpoints are consumer stubs,
  the eight downstream services and the exact files that create each dependency, and the
  repo-wide hub list (`VaultFetcher` 287, `PlayerClientGrpc` 63, `PromotionRedisService` 90).
- **Candidate-only:** any semantic hit; the free-spin spec file that the concept query surfaced;
  every `find_dead_code` candidate (5650, explicitly gapped
  `dynamic_dispatch_and_di_not_proven`).
- **Requires logs/source/runtime:** which hop actually stalls; retry/timeout configuration;
  queue/processor state (FPMS-NT has 1167 `publishes` and 68 `subscribes` edges — asynchronous
  completion is in play and Penguin models the wiring, not the runtime); the 84024 unresolved
  references that could hide a call edge.
- **Not executed:** no specific player-operation incident was investigated to a conclusion, because
  the prompt supplies no operation name and inventing one would fabricate evidence.
- **verdict: PARTIAL (method demonstrated and scoped; no concrete operation named in the prompt).
  confidence: high**

### B3 — Hybrid retrieval audit

Full lane table in Q4. Response-count/status consistency audit for the dynamic concept target:

| Lane | hits.length | root returnedCount | evidence.returnedCount | candidateCount | root truncated | diagnostics truncated | queryStatus | cursor | Consistent? |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| semantic ×3 | 3 | 3 | 3 | 50 | true | true | MATCH | **null** | counts ✔ / **continuation ✘** |
| exact p1 | 3 | 3 | 3 | 4 | true | **false** | MATCH | emitted | **✘ contradiction** |
| exact p2 | 1 | 1 | 1 | 4 | false | false | MATCH | null | ✔ (and confirms p1's `truncated:true` was the correct value) |
| path | 1 | 1 | 1 | 1 | false | false | MATCH | null | ✔ |
| lexical | 3 | 3 | 3 | 1971 | true | true | MATCH | emitted | ✔ |
| semantic on casino-plus | — | — | — | — | — | — | **absent** | — | **✘ untyped `"0 hits · lanes"`** |

**Ranking and provenance, without treating similarity as execution proof:** the deterministic lanes
publish an auditable `rank_tuple` (`exactRank/symbolRank/score/laneCount/finalScore`) plus a reason
string (`exact symbol name; exact boost=0.1`, `exact full path; exact boost=0.2`,
`business intent term coverage=3/3`). The vector lane publishes raw cosine similarity, a separate
code-token affinity used only for bounded reranking, `rrf(60) hybrid fusion`, the
`embeddingSpaceId`, the `chunkId` and a `retrievalFingerprint` — and stamps every hit
`status:"inference"`, `untrustedContent:true`, plus the literal sentence
*"vector is a recall candidate; exact/source lanes retain truth precedence"*. No vector hit in this
report is used as evidence of a call edge, a runtime behaviour, an absence or a safe change.

- **verdict: PARTIAL** — provenance and precedence are excellent; two count/status defects.
  **confidence: high**

### B4 — Safe-change decision for `ArticleRepositoryModule` (`node_da824730…`)

Evidence considered (current MCP only): `callers` → `nodes:[]` with `resultStatus:"no_static_edge"`;
`callees` → `nodes:[]`; `context` → 1 file-level importer (`apps/cms/src/article/article.module.ts`);
`explore` → `provides` edge to `ArticleRepository` with `evidenceState:"inferred"`,
`method:"DI_MODULE_PROVIDER"`; `affected` (both forms) → `impacted:[]`, `tests:[]`, `routes:[]`;
`completeness:"lower_bound"` on every one; `unresolvedReferenceCount: 84024`;
`find_dead_code` lists sibling `*RepositoryModule` classes as dead-code candidates with the gap
`dynamic_dispatch_and_di_not_proven`.

**Decision: `NO-GO` (as an unconditional change) → `CONDITIONAL`.**

Blocking factors, each mapped to the brief's disqualifiers:
1. **Incomplete coverage** — `coverage.status:"partial"`, 84024 unresolved references,
   `gaps:["coverage_debt_requires_remediation"]`.
2. **Unresolved references** — includes in-repo-shaped `unresolved_member_or_type` targets.
3. **Dynamic dispatch / DI** — the only outgoing relation is an **inferred** NestJS
   `DI_MODULE_PROVIDER` edge; `find_dead_code` explicitly warns that DI and framework magic make
   these candidates false positives. A module class is *resolved by the framework*, never called.
4. **Unsupported boundary** — `tests: []` and `routes: []` mean there is **no** regression signal;
   `affected` cannot tell you what breaks.
5. **Contradictory parity** — `affected` by path and by node disagree on `candidateCount` and
   `totalIsExact` (Q10), so even the blast-radius metadata is not trustworthy for this target.

Conditions that would upgrade this to GO: read `apps/cms/src/article/article.module.ts` and the
Nest module graph to confirm every importer; confirm no dynamic/`forRoot`/`forFeature` registration
references the class by name; add or locate a test covering the CMS article read path; and re-run
`affected` after coverage debt for `libs/tools/src/repositories/cms/**` is remediated.

- **verdict: PASS (a correct, evidence-grounded refusal to say GO). confidence: high**

### B5 — Cursor and identity handoff

**Agent-B in a genuinely new MCP process: NOT PERFORMED** (see Q17 — no permitted way to start one).
All three cursor families and all three IDs were nevertheless replayed **in this process**:

| Item | Emitted by | Replay | Scope / revision preserved | Result | Repairs |
| --- | --- | --- | --- | --- | ---: |
| symbol `node_da824730…d21` | `knowledge_search` exact | `context`, `callers`, `callees`, `explore`, `get_node`, `affected` (6 surfaces) | FPMS-NT / brazil-v2 / `snapshot_5225df3e…ee55` on every one | identityKey identical on all | 0 (3 param-name guesses on `get_node` counted separately as tool-discovery workarounds) |
| endpoint `node_7f61d503…795` | `knowledge_endpoints` page 4 | `flow` ×3 (nodeId, identityKey, title) | same | all three converged to one nodeId | 0 |
| service `service:repo_a48ec7fb…cb50` | `knowledge_service_graph` | `get_architecture`, edge traversal | same | resolved, 11 outbound edges | 0 |
| endpoints cursor | page 1 | continued to pages 2, 3, 4; page-1 cursor replayed a 5th time | `revision:"snapshot_5225df3e…ee55"` embedded in every cursor | stable ordering, 0 duplicate nodeIds, remaining 603→598→593→588 | 0 |
| file-symbols cursor | `knowledge_file_symbols` | emitted, revision-pinned to `branch_1d21f868…` | ✔ | `candidateCount 8`, `remaining 6` | 0 |
| dead-code cursor | `find_dead_code` | continued to page 2 | scope `"FPMS-NT|*|*"`, **`revision: null`** | remaining 5647→5644, 0 duplicates | 0 |
| dead-code cursor, wrong repo | — | replayed with `repo:"casino-plus"` | — | typed `CURSOR_SCOPE_MISMATCH` | 0 |

**Duplicates: 0. Scope mismatches: 0 (one deliberate mismatch correctly rejected). Repairs: 0.**
Build/generation identity was compared before accepting continuity: every replay carried
`capabilityHash e38ea18f…65fb` (embedded in the search cursors themselves) and, where semantic was
involved, `activeGenerationIds:["generation_5c026dc4…c440f"]`.

- **verdict: NOT PROVEN as a fresh-process handoff; PASS as an in-process identity/cursor
  integrity test. confidence: high**

### B6 — Scoped cross-repository comparison

FPMS-NT (`repo_a48ec7fb…`, `brazil-v2`, `3f0f1984…`, `snapshot_5225df3e…`) vs
casino-plus (`repo_c5cb9c2b…`, `main`, `606364ba…`, `snapshot_095ae5c0…`). Every query carried an
explicit `repo` or `scope.revisions[]`; both `get_architecture` calls and both
`knowledge_note_list` calls returned exactly one repo in `repos[]`/`scope`.

| Dimension | FPMS-NT | casino-plus |
| --- | --- | --- |
| Role | backend monorepo (NestJS, gRPC + REST) | web/UI monorepo (React/tsx) |
| symbols / files / admitted | 13710 / 3306 / 3333 | 6431 / 2105 / 2222 |
| excluded / unresolved | 7 / 84024 | 130 / 43500 |
| Languages | ts only | ts 4377, tsx 2038, js 16 |
| Entry points | 6 REST routes | `[]` (no server entry points — consistent with a client) |
| Distinctive edges | `handles` 7, `injects` 1308, `publishes` 1167, `subscribes` 68, `emits_log` 2903, `throws` 1046 | `renders` 554, **`invokes_dynamic` 836**, `publishes` 1778, `exposes` 1 |
| Semantic generation | active, 45007/45007 | **none** |

**Useful cross-service observations (from the service graph, edges revision-tagged individually):**
casino-plus `invokes` FPMS-NT, FPMS-NT-Payment, FPMS-NT-CCMS, FPMS-NT-Auth-Player,
FPMS-NT-Provider, FPMS-NT-Recommend, FPMS-NT-Risk-Control, FPMS-NT-User-Engagement and fpmsXcpms —
nine outbound edges, each `proven` with a concrete provenance file
(e.g. `libs/components/src/lib/deposit3/components/voucher-widget/component/code-voucher/code-voucher-view-model.ts`
for the FPMS-NT edge). So casino-plus is a direct consumer of the same FPMS-NT surface an incident
would touch, and its 836 `invokes_dynamic` edges mean its call graph is materially less statically
provable than FPMS-NT's (which has none) — a real, actionable asymmetry when reasoning about blast
radius across the pair.

**No mixing:** no casino-plus node, file, hub or count appeared in an FPMS-NT-scoped result or vice
versa; revisions were never blended (each architecture response carried its own `commitSha`,
`snapshotId` and `worktreeFingerprint`); and the one deliberate cross-repo node lookup was rejected
with `SCOPE_MISMATCH` rather than resolving a namesake.

- **verdict: PASS. confidence: high**

### B7 — Degradation honesty

**Naturally present degraded state:** casino-plus is indexed (2222 admitted files, fresh) but has
**no semantic generation at all** — `knowledge_semantic_status` returns rows only for
`repo:repo_a48ec7fb…` (FPMS-NT) and `legacy`.

| Step | Call | Result |
| --- | --- | --- |
| 1. degraded semantic, explicit mode | `knowledge_search({mode:"semantic", scope: casino-plus, options:{semantic:"blend"}})` | **untyped error string `"0 hits · lanes"`** — reproduced twice, byte-identical. No code, no category, no retryability, no remediation, no scope echo, no `queryStatus`, not JSON |
| 2. degraded semantic, auto mode | `knowledge_search({mode:"auto", scope: casino-plus, options:{semantic:"fallback"}})` | **Honest**: 3 verified source hits, `candidateCount 832`, cursor emitted, `skippedLanes:[{lane:"semantic", reason:"async_semantic_lane_required"}]`, `warnings:[…, {code:"SEMANTIC_LANE_UNAVAILABLE", message:"semantic search requires the async provider runtime; deterministic lanes are partial results"}]`, `queryStatus:"MATCH"` |
| 3. Graph/Lexical immediately afterwards | `knowledge_search({mode:"exact", query:"getImgUrl", scope: casino-plus})` | **Succeeded**: 2 hits, both `evidence.status:"verified"` with distinct nodeIds/paths, `candidateCount 528`, cursor emitted, 752.68 ms |
| 4. safe invalid input | `knowledge_search({query:""})` | typed `INVALID_QUERY` + remediation |

- **No false-ready:** in step 2 the product did **not** claim semantic was applied — it reported
  `applied:false` and named the missing runtime. In FPMS-NT, where semantic genuinely is ready,
  it reported `applied:true, ready:45007, expected:45007` with the correct generation. The hard
  cap "semantic claimed applied while inactive/unavailable" is **not triggered**.
- **But there is a no-match contradiction:** step 1 and step 2 are the *same* query against the
  *same* repo. Step 2 proves 832 deterministic candidates exist. Step 1 answered `"0 hits"`. An
  MCP-only consumer who used `mode:"semantic"` — the mode whose name matches their intent — would
  conclude casino-plus has nothing, when it has 832 matching candidates and simply lacks a vector
  index.
- **Remediation specificity:** step 2's warning is specific and correct. Step 1 offers none.
  A related metadata bug: step 2 reports `semantic.requested:false` even though
  `options.semantic:"fallback"` was explicitly passed.
- **verdict: PARTIAL — the honest degradation path exists and works, but the most obvious
  invocation bypasses it and emits an untyped zero-result. confidence: high**

### B8 — Exact final packet

See §14.

---

## 6. Semantic response-consistency table

| Repeated semantic run | Hits | Returned root/evidence | Query status | Semantic applied/generation | Top identities | Verdict |
| --- | ---: | --- | --- | --- | --- | --- |
| Run 1 — `search_01c5aa063e679789`, 558.538 ms | 3 | 3 / 3 (candidateCount 50) | `MATCH`, warning `COVERAGE_INCOMPLETE` only | applied `true`, reason `null`, ready 45007 / expected 45007, `generation_5c026dc4…c440f`, space `space_00646ffa…6432c` | `vector_ed077e8074d66c26` `apps/cms/src/article/article.service.ts` (0.24664) · `vector_175d27a76b9d6be4` `…create-community-free-spin-config.service.spec.ts` (0.25212) · `vector_048b647a1c3e54e8` `libs/tools/src/repositories/cms/article/article-repository.module.ts` (0.24514) | PASS |
| Run 2 — `search_f50b916f95fb47ff`, 557.205 ms | 3 | 3 / 3 (candidateCount 50) | `MATCH`, same single warning | identical | identical hitIds, scores, chunkIds, contentHashes, retrievalFingerprints | PASS |
| Run 3 — `search_f7af45c4944c253b`, 325.534 ms | 3 | 3 / 3 (candidateCount 50) | `MATCH`, same single warning | identical | identical | PASS |
| **Delta across runs** | 0 | 0 | 0 | 0 | 0 — `stats.sentBytes` 7808 in all three; only `requestId` and `timingsMs` differ | **SEMANTIC RESPONSE CONSISTENCY: PROVEN** |
| Control — nonsense query, `search_31befb697a37db66`, 138.573 ms | 3 | 3 / 3 (candidateCount 50) | `MATCH` | applied `true`, same generation | junk at similarity 0.1591 / 0.1586 / 0.1490 | Counts consistent, but **`MATCH` with no low-similarity signal** — clarity defect |
| Control — same concept on `casino-plus` (no vector generation), ×2 | — | — | **absent** | — | untyped string `"0 hits · lanes"` | **FAIL** |

Caveat carried forward: all three passing runs report `truncated: true` with `cursor: null` and
`page.totalIsExact: false`, so 47 of 50 candidates are unreachable. Repeatability is proven;
exhaustibility is not.

---

## 7. Scope-isolation and coverage-actionability verdicts

| Scope check | Requested repo/revision | Returned membership | Leak/ambiguity | Verdict |
| --- | --- | --- | --- | --- |
| Architecture A | FPMS-NT / `brazil-v2` / `3f0f1984…` / `snapshot_5225df3e…` | `repos:[{FPMS-NT,1}]`, `alignment:"explicit"`, hubs and 13710 ts symbols all FPMS-NT | none | PASS |
| Architecture B | casino-plus / `main` / `606364ba…` / `snapshot_095ae5c0…` | `repos:[{casino-plus,1}]`, `alignment:"aligned"`, 6431 symbols across ts/tsx/js | none | PASS |
| Notes A | FPMS-NT | `items:[]` + FPMS-NT revision & coverage echo, `proofStatus:"not_proven"` | none | PASS |
| Notes B | casino-plus | `items:[]` + casino-plus revision & coverage echo (2352/2222/130/43500) | none | PASS |
| Cross-repo node lookup | node from FPMS-NT requested under casino-plus | refused | **typed `SCOPE_MISMATCH`** with requested vs actual repoId/branchId/revisionId + `membershipRepoIds` | PASS (strongest result in the run) |
| Cross-repo cursor | FPMS-NT dead-code cursor under casino-plus | refused | typed `CURSOR_SCOPE_MISMATCH` + remediation | PASS |
| Search scope | `scope.revisions[{repoName,branch}]` on every search | `scopeApplied:true`, `requestedScope` + `resolvedScope` + `resolvedScopes` all echoed with resolved repoId/snapshot/commit | none | PASS |
| Service graph | FPMS-NT | 15 services / 80 edges spanning repos | **declared, not silent** — `gaps:["service_graph_is_aggregated"]`, `graphEvidence.scope:"environment"`, per-edge `revisionId` | PASS with note |
| Semantic scope key | `scopeKey:"FPMS-NT"` (repo name) | `{"statuses":[]}` | **silent empty, no scope echo** | FAIL |

**Coverage actionability: PASS (not `VISIBLE_BUT_NOT_ACTIONABLE`).** Every non-zero debt category
resolves to concrete items with reason codes through `knowledge_coverage`; every zero category
returns a typed exact empty; the product publishes its own concrete-vs-aggregate reconciliation
(`delta: 0`) and all count identities hold (84031 = 84024 + 7 = 50 + 83981).

---

## 8. Stable identity, cursor and handoff verdicts

| Dynamic ID/cursor | Emitted by | Agent-B replay | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |
| `node_da824730-86ab-4f8e-b1a0-06a986b50d21` (`ArticleRepositoryModule`) | `knowledge_search mode:"exact"` | **NOT PERFORMED** — no permitted new MCP process; replayed in-process across `context`/`callers`/`callees`/`explore`/`get_node`/`affected` | FPMS-NT / `brazil-v2` / `snapshot_5225df3e…ee55` on all six | identityKey identical everywhere; wrong-repo form rejected | 3 (guessing `get_node`'s parameter key: `node`, `target`, `nodeId` all failed; `id` worked) |
| `node_7f61d503-720b-4923-b57b-e1b2c0297795` (endpoint) | `knowledge_endpoints` page 4 index 3 | NOT PERFORMED; replayed in-process via 3 identity forms | same | all converged to one nodeId + one identityKey | 0 |
| `service:repo_a48ec7fb-5987-47df-9198-06969359cb50` | `knowledge_service_graph` | NOT PERFORMED; replayed in-process | same | resolved; 8 `invokes` + 3 `depends_on`, all `proven` | 0 |
| Endpoints cursor family | `knowledge_endpoints` | NOT PERFORMED; continued in-process pages 1→4 and replayed page-1 a second time | `revision:"snapshot_5225df3e…ee55"` embedded | stable ordering, 0 duplicates, remaining −5/page, idempotent replay | 0 |
| File/symbol cursor family | `knowledge_file_symbols` | NOT PERFORMED; emitted and inspected in-process | `revision:"branch_1d21f868…"` embedded | `candidateCount 8`, `remaining 6`, `totalIsExact:true` | 0 |
| Dead-code cursor family | `find_dead_code` | NOT PERFORMED; continued in-process to page 2 | scope `"FPMS-NT|*|*"`, **`revision:null`** | remaining 5647→5644, 0 duplicates | 0 |
| Malformed cursor | evaluator | — | — | typed `CURSOR_INVALID` | 0 |
| Wrong-scope cursor | evaluator | — | — | typed `CURSOR_SCOPE_MISMATCH` + remediation | 0 |
| Expired cursor | endpoints page 1, reused at +8 min 25.5 s | — | — | **accepted** — no expired/stale class observed; no server clock exposed to judge it | 0 |
| Proven relation `ArticleRepository --references--> Article` | `knowledge_explore` | NOT PERFORMED; re-derived in-process | same | `evidenceState:"proven"`, `EXTRACTED`, confidence 1 | 0 |
| `generation_5c026dc4…c440f` | `knowledge_semantic_status` | NOT PERFORMED; re-read 3× in-process | FPMS-NT space | identical all three reads; echoed by every semantic query | 0 |

**Verdicts.** THREE CURSOR FAMILIES: **PARTIAL** (three families proven independently with stable
ordering, zero duplicate stable IDs and truthful remaining counts; only two of the four required
typed cursor-error classes are obtainable, and the semantic lane has no cursor at all).
FRESH PROCESS HANDOFF: **NOT PROVEN**. Total workarounds in the run: **4** — three `get_node`
parameter guesses and one `scopeKey` format discovery for `knowledge_semantic_status`.

---

## 9. Lifecycle / background / restart verdicts

| Capability | Advertised | Real MCP call | Build/generation | Runtime state | Verdict |
| --- | --- | --- | --- | --- | --- |
| Runtime identity | `knowledge.capabilities` | `mcp_health` + `knowledge_capabilities` | `1.16.0-696f5732bd1f8911` running == available | `ok`, `initializeHealthy:true` | PASS |
| Restart signalling | `generation.restartRequired`, `clientRestartRequired`, `runtimeOutdated` | all three read | all `false`, `outdated:false` | no newer build exists, so `false` is truthful | **RESTART REQUIRED/HANDLED: NO-CURRENT** |
| Semantic lifecycle | `knowledge.semantic_status` | read 3× over ~9 min | 1 active + 4 superseded, all pointing at the same `activeGenerationId` | ready 45007/45007, running 0, pending 0, failed 0, paused false | PASS |
| Vector serving integrity | `diagnostics.semantic.activeGenerationIds` | 4 semantic queries | only `generation_5c026dc4…c440f`; every hit's `embeddingSpaceId` == its `modelHash` | no staging/superseded/legacy leakage | PASS |
| Background worker | `workerBuildId`, `lastHeartbeatAt`, `ratePerSecond`, `etaSeconds`, `paused`, `pauseRequested` | read 3× | `workerBuildId: null`, `lastHeartbeatAt: null` | no active job; **no positive proof a worker process exists** | **BACKGROUND WORKER: NOT PROVEN** (idle-consistent, but unobservable) |
| Worker dependencies | `mcp_health.nativeDependencies` | read | `sqlite-vec`, `onnxruntime-node`, `nomic-embed-text-v1.5` model + tokenizer + manifest all `ready` with sha256 | installed and verified | PASS |
| Wake on queued work | — | `knowledge_semantic_status` ×3 | running 0 / pending 0 / retryableFailed 0 / terminalFailed 0 throughout | no queued work exists; creating some is forbidden | **MCP-ONLY WAKE: N/A-NO-QUEUED-WORK** |
| Semantic control (pause/resume/retry) | `knowledge.semantic_control` registered | **not called** — owner-only mutation, forbidden by Section 1 | — | — | Out of MCP-only consumer authority (correctly) |
| Schema identity | `schemaVersion` | `mcp_health` 18, `capabilities` 18, `status_panel.db` 18, graph `trust` blocks **17** | — | — | **FAIL — `MIXED_SCHEMA_IDENTITY`** |

---

## 10. Owner UI evidence (isolated)

**OWNER UI CONTROL: NOT TESTED.** Section 7 is explicitly owner-only and its five checks require
opening the Penguin Wiki Tauri application — a desktop UI action outside this MCP-only evaluator's
permitted actions in this non-interactive session. No screenshot, no timestamp, no
`OWNER_UI_EVIDENCE` is recorded, and **nothing in Sections 3–9 or 11–14 depends on the UI**.

Additionally, `N/A_NO_ACTIVE_JOB` applies to Section 7 items 3 and 4 regardless of who runs them:
`knowledge_semantic_status` shows `running: 0`, `pending: 0`, `paused: false`,
`pauseRequested: false` and `progressPercent: 100` across three reads spanning ~9 minutes, so no
active work exists for Pause/Resume/Retry/Cancel to act on, and creating some would be a forbidden
mutation.

Per the brief, this section contributes **zero** to the three MCP-only scores.

---

## 11. Safe-without-source versus source/log/DB/human boundary

**Safe without source (proven by MCP alone in this run):**

- Runtime identity and parity — build, schema, contract, capability hash, generation, restart need.
- Repository inventory (20 repos), per-repo branch, indexed commit, head commit, dirty count,
  parser version, index errors, last-indexed timestamp, root path.
- FPMS-NT revision pinning: commit `3f0f1984…`, snapshot `snapshot_5225df3e…`, worktree fingerprint,
  trust `exact_commit`, freshness `fresh`.
- Coverage debt as concrete items: 7 excluded (with `secret_policy` / `binary` reasons), 0 failed,
  0 stale, 84024 unresolved (with per-reference file, line, raw target and reason code),
  reconciled with delta 0.
- The endpoint inventory: 608 endpoints, exact count, protocol, identity key, source location,
  provider-vs-consumer role, and whether a handler is proven or `handler_not_proven_absent`.
- Symbol identity and verbatim source for any indexed symbol, with content hash and per-branch
  freshness status.
- Call/reference/import/DI relations **with an explicit evidence state per edge**
  (`proven` / `inferred`), origin, extraction method, confidence, provenance file and line.
- Blast radius as a *lower bound*, with the reasons it is a lower bound stated in the payload.
- Cross-service topology: which repos invoke which, and the exact file that creates each dependency.
- Which lane produced a result and whether that lane is truth-bearing or a recall candidate.
- Semantic generation lifecycle: which generation serves queries and which are superseded and why.

**Requires source / log / DB / human:**

- Any *negative*: no caller, no test, no boundary, no better match — all `not proven` (Q19), because
  coverage is `partial`, completeness is `lower_bound`, 84024 references are unresolved and the
  semantic lane cannot be exhausted.
- NestJS DI resolution: the only relation from the concept target is an **inferred**
  `DI_MODULE_PROVIDER` edge; which provider a container actually binds at runtime needs source.
- Dynamic dispatch generally — and acutely for casino-plus, which has 836 `invokes_dynamic` edges.
- External package behaviour: `rxjs` (`firstValueFrom`, `catchError`), `mongoose`, `@nestjs/*` —
  all `external_package`, no in-repo target.
- The remote side of every cross-service gRPC call (e.g. the actual CMS `GetResourceIdList`
  implementation lives in FPMS-NT-CCMS, not here).
- Runtime configuration, environment targeting, cache contents — e.g. whether `RedisCmsService`
  is serving a stale article config.
- Actual request/response payloads, error rates and timings — Penguin indexes 3027 `log_site`
  nodes but holds no log data.
- Root cause of any incident. Penguin narrows the search space; it does not diagnose.
- Whether the Penguin UI is running, and anything about the owner's desktop session.
- Whether a background embedding worker process is currently alive (`workerBuildId`,
  `lastHeartbeatAt` both `null`).

---

## 12. Product defects, environment failures, unproven claims

### 12.1 Product defects (reproducible, MCP-observable)

| # | Severity | Defect | Reproduction |
| ---: | --- | --- | --- |
| P1 | **Critical** | `knowledge_search({mode:"semantic"})` against a repo with no vector generation returns the **untyped string `"0 hits · lanes"`** — no code, category, retryability, remediation, scope, `queryStatus` or JSON structure — while the same query in `mode:"auto"` proves 832 deterministic candidates exist. Empty presented as absence. | `knowledge_search({query:"CMS article configuration retrieval", mode:"semantic", scope:{revisions:[{repoName:"casino-plus",branch:"main"}]}, page:{limit:3}, options:{semantic:"blend"}})` — reproduced twice |
| P2 | **High** | `diagnostics.truncated` contradicts root `truncated` in the same response. Root said `true` + cursor; diagnostics said `false`; continuing the cursor returned a real 4th hit. | `knowledge_search({query:"ArticleRepositoryModule", mode:"exact", scope:FPMS-NT, page:{limit:3}})` |
| P3 | **High** | Semantic lane reports `truncated:true` with `cursor:null` and no `page.nextCursor` — 47 of 50 candidates are structurally unreachable, so semantic output can never be exhausted. | any `mode:"semantic"` query with `limit < candidateCount` |
| P4 | **High** | `knowledge_semantic_status({scopeKey:<repo name>})` returns bare `{"statuses":[]}` — no scope echo, no counts, no diagnostic — for an unrecognised scope key. The only surface in the product that returns an unqualified empty collection. Correct form (`repo:<repoId>`) is undocumented in the tool schema. | `knowledge_semantic_status({scopeKey:"FPMS-NT"})` vs `{scopeKey:"repo:repo_a48ec7fb-5987-47df-9198-06969359cb50"}` |
| P5 | **High** | `get_node` is published with `properties:{}` / `additionalProperties:true` and is uncallable without guessing: `node`, `target`, `nodeId` all fail with `INVALID_TARGET / details.target:null` (which actively points at the wrong key); only `id` works. Same empty-schema pattern on `knowledge_doctor`, `knowledge_files`, `knowledge_explain`, `knowledge_local_graph`, `knowledge_onboarding_generate`. | `get_node({node:"node_da824730-86ab-4f8e-b1a0-06a986b50d21"})` |
| P6 | **Medium** | `MIXED_SCHEMA_IDENTITY` — graph tools' `trust.schemaVersion` is `17` while `mcp_health`, `knowledge_capabilities` and `status_panel.db` all report `18`. | compare `mcp_health` with `knowledge_context`/`explore`/`flow`/`locate` |
| P7 | **Medium** | `AFFECTED_PATH_NODE_PARITY_MISMATCH` — same change by path vs by node gives `candidateCount` 1 vs 0 and `totalIsExact` false vs true, and only the node form discloses the unresolved-reference gap. | `knowledge_affected({repo,path:…})` vs `knowledge_affected({repo,node:…})` |
| P8 | **Medium** | `ENDPOINT_COUNT_DISAGREEMENT` — `get_architecture` reports `nodeCounts.endpoint: 6` and `edgeCounts.handles: 7` for a revision where `knowledge_endpoints` reports `candidateCount: 608, totalIsExact: true` with many proven handlers. | `get_architecture({repo:"FPMS-NT"})` vs `knowledge_endpoints({repo:"FPMS-NT"})` |
| P9 | **Medium** | Unknown repository is reported as **`BRANCH_NOT_FOUND`** — `"branch main was not found in the indexed repository"` — with no remediation, misdirecting the consumer at the branch. | `knowledge_search({query:"x", scope:{revisions:[{repoName:"NO-SUCH-REPO-R22",branch:"main"}]}})` |
| P10 | **Medium** | Remediation strings assume a local CLI in an MCP-only product: `"run penguin search…"`, `"penguin index <repo-path>"`, `"specify --repo and, when needed, --branch…"`. The last is also *already satisfied* when it fires. None names the MCP-callable equivalent. | `INVALID_TARGET`, every `nextActions`, `TARGET_AMBIGUOUS` |
| P11 | **Medium** | Metadata that does not describe its own payload: `knowledge_context` `returnedCount:0`/`candidateCount:0` with a non-empty `importers`; `explore` `confidence.inferredEdges:0` with an `evidenceState:"inferred"` hop; `knowledge_callers` root `coverageGaps:["unresolved_reference_counts_not_persisted"]` in a response carrying `unresolvedReferenceCount: 84024`. | Q5 calls |
| P12 | **Medium** | Semantic metadata lies when semantic is off or unavailable: `semantic:{ready:0, expected:0, activeGenerationIds:[]}` whenever `semantic:"off"` (true state is 45007/45007), and `semantic.requested:false` even when `options.semantic:"fallback"` was explicitly passed. | any `semantic:"off"` search; the auto+fallback casino-plus search |
| P13 | **Low** | No expired/stale cursor class is obtainable and no server clock is exposed, so a consumer cannot reason about the `expiresAt` embedded in every cursor. A page-1 cursor replayed at +8 min 25.5 s was accepted. | Q12 |
| P14 | **Low** | Dead-code cursor binds to the repo **display name** with `"revision": null`, unlike the endpoints and file-symbols cursors which pin `repoId`/`snapshotId`/`branchId`. Latent cross-revision pagination risk. | decode any `find_dead_code` `nextCursor` |
| P15 | **Low** | No similarity floor or low-confidence warning: a deliberately meaningless query returns `queryStatus:"MATCH"` with three hits at cosine 0.149–0.159. | `knowledge_search({query:"zzqqxx nonexistent token round22 evaluation probe", mode:"semantic", scope:FPMS-NT})` |
| P16 | **Low** | Payload duplication inflates every response: `handlers` ≡ `firstHopRelations` per endpoint, root scope/revision/coverage/cursor ≡ the `evidence` block, `candidates` ≡ `items` in dead-code. `stats.compactRatio` is `1` even with `compact:true`. | `knowledge_endpoints({limit:5})` — ~8 KB for 5 rows |
| P17 | **Low** | No `readOnlyHint`/`destructiveHint` annotations on any tool, so a well-behaved client cannot mechanically separate the 26 read surfaces from the mutating ones (`knowledge.index`, `rebuild`, `semantic_control`, note/memory writes, `repository.remove`, …). Read/write intent is only inferable from prose. | inspect any tool schema |
| P18 | **Low** | Onboarding omits stable IDs, cursors and semantic status, and its §8 `knowledge_search` example uses keys (`contract_version`, top-level `semantic`, top-level `limit`) that the real schema rejects. | `knowledge_onboarding_generate({repo:"FPMS-NT"})` |

### 12.2 Environment failures

| # | Failure |
| ---: | --- |
| E1 | **`FRESH_SESSION_NOT_PROVEN`** — no MCP surface exposes a client/session ID, client start time or timezone, so a fresh-process claim cannot be evidenced from allowed evidence. Caps Environment Readiness at 69. |
| E2 | **Fresh Agent-A/Agent-B replay impossible** — an MCP-only consumer has no way to start a second MCP client process; the 15-point dimension is unreachable by design in this deployment. |
| E3 | **`CROSS_SURFACE_FRESHNESS_DISAGREEMENT`** — `FPMS-NT-CCMS` is `freshness:"fresh"` with `indexedCommit == headCommit` in `index_status` but `revisionAlignment:"behind"` with `staleReason:null` in `status_panel`. Neither surface says which is authoritative. (FPMS-NT itself is consistent, so Round 22 scope is uncontaminated.) |
| E4 | **`SEMANTIC_OBSERVABILITY_INCOMPLETE`** — no `dimensions` key, no worker `lease` key, and `workerBuildId`/`lastHeartbeatAt` null. Worker liveness is unobservable. |
| E5 | **Timing observability is inconsistent** — only `knowledge_search` emits `timingsMs`; `endpoints`, `coverage`, `context`, `callers`, `callees`, `explore`, `flow`, `affected`, `service_graph`, `architecture`, `semantic_status`, `dead_code` and `file_symbols` emit none, so latency requirements cannot be evidenced for most of the surface. |
| E6 | **Tri-state health fields unresolved** — `configured: null`, `launcherHealthy: null`, `signing.status: "unknown"`. |
| E7 | 2 of 20 repositories are `stale` (`FPMS-NT-Proposal` dirty 1, `grpc-web-debugger` dirty 2). Truthfully labelled; noted for completeness. |

### 12.3 Claims this report does NOT make (unproven)

| Claim | Evidence lane | Coverage/completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |
| A new MCP client process was used for this evaluation | none available | — | **not proven** | no client/session identity on any MCP surface |
| The Agent-B handoff succeeded across a process boundary | in-process replay only | — | **not proven** | no second MCP process obtainable |
| The reused cursor was expired when accepted | cursor `expiresAt` vs unknown server clock | — | **not proven** (either direction) | server current time; documented TTL |
| A background embedding worker process is alive | `semantic_status` | worker fields null | **not proven** | worker identity / heartbeat / lease |
| Closing Tauri stops MCP semantic capability | runtime | UI never observed | **not proven** | any MCP field reporting UI presence |
| The Penguin UI defaults to `Graph` and has no `Focus` tab | — | — | **not tested** | Section 7 is owner-only |
| `ArticleRepositoryModule` has no production caller | graph | `lower_bound`, 84024 unresolved | **not proven** | Nest DI module graph via source |
| No test covers the dynamic endpoint | graph | `partial`, `endpoint_coverage_incomplete` | **not proven** | test-file view or source |
| All 84024 unresolved references are harmless | coverage | 50 of 84024 inspected | **not proven** | full enumeration |
| Any root cause for B1 or B2 | — | — | **not claimed** | source, logs, runtime |
| Semantic ranking is deterministic under load/concurrency | 3 sequential runs | — | **not proven** for concurrency | concurrent-run test not performed |

---

## 13. Ordered improvements with exact MCP-only retests

| # | Fix | Exact MCP-only retest |
| ---: | --- | --- |
| 1 | Make `mode:"semantic"` route through the same unavailable-lane path `mode:"auto"` already uses: return a structured zero-result with `queryStatus`, `skippedLanes:[{lane:"semantic",reason:…}]` and `warnings:[{code:"SEMANTIC_LANE_UNAVAILABLE",…}]`, or a typed error with a code — never a bare string. | `knowledge_search({query:"CMS article configuration retrieval", mode:"semantic", scope:{revisions:[{repoName:"casino-plus",branch:"main"}]}, page:{limit:3}, options:{semantic:"blend"}})` → expect JSON with `diagnostics.queryStatus` and a semantic reason code |
| 2 | Fix `diagnostics.truncated` to mirror root `truncated`. | `knowledge_search({query:"ArticleRepositoryModule", mode:"exact", scope:{revisions:[{repoName:"FPMS-NT",branch:"brazil-v2"}]}, page:{limit:3}})` → expect `truncated:true` in **both** root and `diagnostics`; then continue `page.nextCursor` and expect exactly 1 more hit |
| 3 | Emit a continuation cursor for the vector lane whenever `truncated:true`. | same query as (1) but on FPMS-NT with `page:{limit:3}` → expect non-null `cursor`; continue it and expect hits 4–6 of `candidateCount 50` with no duplicate `hitId` |
| 4 | Make `knowledge_semantic_status` echo its scope and reject unknown scope keys with a typed error listing valid keys; accept repo names as well as `repo:<repoId>`. | `knowledge_semantic_status({scopeKey:"FPMS-NT"})` → expect either the 4 FPMS-NT rows or a typed `SCOPE_NOT_FOUND` with the valid key form |
| 5 | Publish real input schemas for `get_node`, `knowledge_doctor`, `knowledge_files`, `knowledge_explain`, `knowledge_local_graph`, `knowledge_onboarding_generate`; and make `INVALID_TARGET` name the parameter it actually read. | `get_node({node:"node_da824730-86ab-4f8e-b1a0-06a986b50d21"})` → expect either success or an error naming `id` as the required key |
| 6 | Unify `schemaVersion`: graph `trust` blocks must report the same value as `mcp_health`. | `mcp_health` then `knowledge_context({target:"node_da824730-86ab-4f8e-b1a0-06a986b50d21", repo:"FPMS-NT", branch:"brazil-v2"})` → expect both `18` |
| 7 | Make `knowledge_affected` path and node forms emit identical completeness metadata. | `knowledge_affected({repo:"FPMS-NT", path:"libs/tools/src/repositories/cms/article/article-repository.module.ts"})` vs `knowledge_affected({repo:"FPMS-NT", node:"node_da824730-86ab-4f8e-b1a0-06a986b50d21"})` → expect identical `candidateCount`, `totalIsExact` and gap list |
| 8 | Reconcile endpoint counts between `get_architecture` and `knowledge_endpoints`. | `get_architecture({repo:"FPMS-NT"})` → expect `nodeCounts.endpoint == 608` (or a documented, labelled sub-count) |
| 9 | Replace every CLI remediation with the MCP capability name, and drop `--flag` syntax. | `knowledge_context({target:"node_da824730-86ab-4f8e-b1a0-06a986b50d21-CORRUPT", repo:"FPMS-NT"})` → expect remediation naming `knowledge_search`; `knowledge_context({target:"constructor", repo:"FPMS-NT", branch:"brazil-v2"})` → expect remediation that does not ask for already-supplied `repo`/`branch`, and candidates carrying `filePath`/`startLine` |
| 10 | Report unknown repositories as `REPO_NOT_FOUND` with remediation. | `knowledge_search({query:"x", mode:"exact", scope:{revisions:[{repoName:"NO-SUCH-REPO-R22",branch:"main"}]}})` |
| 11 | Make root counters describe the payload (`knowledge_context.returnedCount` must count `importers` etc.), and fix `confidence.inferredEdges`. | `knowledge_context({target:"node_da824730…", repo:"FPMS-NT", branch:"brazil-v2"})` → expect `returnedCount ≥ 1`; `knowledge_explore` same target → expect `confidence.inferredEdges == 1` |
| 12 | Report true `ready`/`expected`/`activeGenerationIds` even when `semantic:"off"`, and set `semantic.requested` from the actual request. | `knowledge_search({query:"ArticleRepositoryModule", mode:"exact", scope:FPMS-NT, options:{semantic:"off"}})` → expect `ready:45007, expected:45007, reason:"not_requested"`; then `options:{semantic:"fallback"}` on casino-plus → expect `requested:true` |
| 13 | Expose `serverTimeUtc` (or `cursorTtlSeconds`) and add typed `CURSOR_EXPIRED`; pin the dead-code cursor to `repoId` + `snapshotId`. | replay any cursor after its `expiresAt` → expect `CURSOR_EXPIRED`; decode a `find_dead_code` cursor → expect non-null `revision` |
| 14 | Add `workerBuildId`, `lastHeartbeatAt`, a lease field and embedding `dimensions` to `knowledge_semantic_status`, populated even when idle. | `knowledge_semantic_status({scopeKey:"repo:repo_a48ec7fb-5987-47df-9198-06969359cb50"})` → expect non-null worker identity and heartbeat |
| 15 | Add `readOnlyHint`/`destructiveHint` MCP annotations to all 101 capabilities. | inspect the tool list → expect `readOnlyHint:true` on `knowledge_search`/`context`/`explore`/`coverage`/… and `destructiveHint:true` on `knowledge.index`/`rebuild`/`repository.remove`/`semantic_control` |
| 16 | Emit `timingsMs` from every read capability; resolve `configured`, `launcherHealthy`, `signing.status`. | `knowledge_endpoints({repo:"FPMS-NT", limit:5})` and `knowledge_affected({repo:"FPMS-NT", node:"node_da824730…"})` → expect `timingsMs.total`; `mcp_health` → expect non-null `configured`/`launcherHealthy` |
| 17 | Add a low-similarity signal to the vector lane. | `knowledge_search({query:"zzqqxx nonexistent token round22 evaluation probe", mode:"semantic", scope:FPMS-NT, page:{limit:3}})` → expect `queryStatus:"WEAK_MATCH"` or a `LOW_SIMILARITY` warning |
| 18 | Reconcile `index_status.freshness` with `status_panel.revisionAlignment`, or give `revisionAlignment:"behind"` a `staleReason`. | `index_status({mode:"detailed"})` and `status_panel()` → expect FPMS-NT-CCMS to agree, or a populated `staleReason` |
| 19 | De-duplicate payloads: drop `firstHopRelations` when identical to `handlers`, drop `candidates` when identical to `items`, and make `compact:true` actually elide the `evidence` mirror of the root. | `knowledge_endpoints({repo:"FPMS-NT", limit:5})` → expect materially smaller output and `stats.compactRatio < 1` |
| 20 | Add cursors, stable IDs and `knowledge_semantic_status` to the onboarding doc and fix its `knowledge_search` example to the real schema. | `knowledge_onboarding_generate({repo:"FPMS-NT"})` → expect §8 to include a `page:{limit,cursor}` example and a `knowledge_semantic_status` call |
| 21 | Expose a client/session identity on `mcp_health` (e.g. `sessionId`, `clientConnectedAt`, `serverTimeUtc`) so a fresh-process claim is evidenceable from MCP alone — without this, Environment Readiness is permanently capped at 69 for any honest evaluator. | `mcp_health` → expect `sessionId`, `clientConnectedAt`, `serverTimeUtc` |

---

## 14. Exact B8 packet

```text
ROUND: 22
PRODUCT CAPABILITY: 69/100
MCP-ONLY USER EXPERIENCE: 63/100
ENVIRONMENT READINESS: 68/100
PRODUCT TRUST: CONDITIONAL
ENVIRONMENT: DEGRADED
GRAPH/LEXICAL: 10/13 — STRONG. Exact/path/lexical/symbol lanes return verified locators with content
  hashes and auditable rank tuples; graph edges carry per-edge evidenceState, origin, method,
  confidence and provenance; dead ends are typed (no_static_edge, no_outgoing_edges,
  handler_not_proven_absent) rather than empty; completeness is always labelled lower_bound with the
  reason. Available independently of the vector lifecycle (proven on a repo with no vectors at all).
  Deductions: affected path/node parity mismatch, confidence.inferredEdges contradiction,
  architecture endpoint count off by two orders of magnitude.
SEMANTIC/VECTOR: PARTIAL — ready and correctly served for FPMS-NT (45007/45007, one active
  generation, no staging/superseded leakage, full retrieval provenance), but the lane is
  unexhaustible (truncated:true with cursor:null), returns an untyped "0 hits · lanes" string where
  unavailable, has no low-similarity signal, and misreports ready/expected/requested when off.
SEMANTIC RESPONSE CONSISTENCY: PROVEN — three identical runs, byte-identical apart from requestId
  and timingsMs (7808 bytes each); hits.length == returnedCount == evidence.returnedCount == 3;
  queryStatus MATCH; identical hitIds, scores, chunkIds, contentHashes, retrievalFingerprints,
  embeddingSpaceId and activeGenerationIds.
VECTOR PROGRESS: 45007 ready / 45007 expected / 0 failed (0 retryable, 0 terminal);
  active generation_5c026dc4ef2ab3a3c43641d4ee1c1cea37e9c81c37ac440f
  (nomic-ai/nomic-embed-text-v1.5, modelHash 00646ffa…6432c, chunker semantic-chunker-v6-precision);
  staging: NONE; superseded: 4 (generation_ff0a09f7…, generation_2c7948d8…, generation_f3644985…,
  generation_legacy_v16), each with an explicit reason.
BACKGROUND WORKER: NOT PROVEN — running 0 / pending 0 / failed 0 / paused false across three reads
  spanning ~9 min (idle-consistent), but workerBuildId and lastHeartbeatAt are both null and no lease
  field exists, so worker liveness is unobservable from MCP.
MCP-ONLY WAKE: N/A-NO-QUEUED-WORK — no queued work exists (running/pending/failed all 0 in three
  reads); creating work is a forbidden evaluator mutation. Readiness verified instead: 8/8 native
  dependencies ready incl. sqlite-vec, onnxruntime-node and the bundled nomic-embed model.
RESTART REQUIRED/HANDLED: NO-CURRENT — runningBuildId == availableBuildId == 1.16.0-696f5732bd1f8911,
  outdated false, restartRequired false, clientRestartRequired false, runtimeOutdated false.
MCP CONTRACT/PARITY: 8/13 — 101/101 capabilities registered "implemented"; buildId, schemaVersion,
  contractVersion and capabilityHash agree across mcp_health, knowledge_capabilities and live query
  diagnostics. Deductions: graph trust blocks report schemaVersion 17 vs 18 everywhere else; six
  capabilities publish empty input schemas (get_node uncallable without guessing); no
  readOnlyHint/destructiveHint annotations.
THREE CURSOR FAMILIES: PARTIAL — endpoints, file/symbol and dead-code all paginate independently with
  stable ordering keys, zero duplicate stable IDs, exact remaining counts and opaque server-authored
  tokens (no offset reconstruction). Typed CURSOR_INVALID and CURSOR_SCOPE_MISMATCH observed. Not
  proven: an expired/stale class (no server clock exposed; a cursor reused at +8m25.5s was accepted)
  and Agent-B continuation. The semantic lane emits no cursor at all.
FRESH PROCESS HANDOFF: NOT PROVEN — an MCP-only consumer has no permitted way to start a second MCP
  client process; a harness sub-agent would share this connection. Packet published and replayed
  in-process: 11/11 items, 0 repairs, 0 duplicates, 0 scope mismatches.
OWNER UI CONTROL: NOT TESTED — Section 7 is owner-only and outside this MCP-only evaluator's
  permitted actions; additionally N/A_NO_ACTIVE_JOB applies (running 0, pending 0, paused false).
SAFE WITHOUT SOURCE: runtime/build/generation identity and parity; 20-repo inventory with per-repo
  branch, indexed vs head commit, dirty count, parser version and index errors; FPMS-NT revision
  pinning (commit 3f0f1984…, snapshot snapshot_5225df3e…, worktree fingerprint, trust exact_commit);
  concrete coverage debt (7 excluded with reason codes, 0 failed, 0 stale, 84024 unresolved with
  file/line/rawTarget/reasonCode, reconciliation delta 0); the 608-endpoint inventory with protocol,
  identity key, source location, provider-vs-consumer role and proven-vs-not-proven handlers; symbol
  identity, verbatim source and content hash; call/reference/import/DI relations with per-edge
  evidence state, origin, method, confidence and provenance; lower-bound blast radius with its
  limitations stated in-payload; cross-service topology with the exact file creating each dependency;
  which retrieval lane produced each result and whether it is truth-bearing; semantic generation
  lifecycle and which generation serves queries.
REQUIRES SOURCE/LOG/DB/HUMAN: every negative claim (no caller / no test / no boundary / no better
  match) — all not proven under partial coverage, lower_bound completeness, 84024 unresolved
  references and an unexhaustible vector lane; NestJS DI resolution behind the inferred
  DI_MODULE_PROVIDER edge; dynamic dispatch (casino-plus alone has 836 invokes_dynamic edges);
  external package behaviour (rxjs, mongoose, @nestjs/*); the remote side of every cross-service gRPC
  call; runtime configuration, environment targeting and cache contents (e.g. RedisCmsService);
  actual request/response payloads, error rates and timings; root cause of any incident; whether the
  Penguin UI is running; whether a background embedding worker process is alive.
TOP 5 PRODUCT GAPS:
  1. mode:"semantic" against a repo with no vector generation returns the untyped string
     "0 hits · lanes" — no code, scope, queryStatus, warning or remediation — while the same query in
     mode:"auto" proves 832 deterministic candidates exist. Empty presented as absence.
  2. diagnostics.truncated contradicts root truncated in the same exact-search response; continuing
     the emitted cursor returned a real 4th hit, proving diagnostics wrong.
  3. The semantic lane reports truncated:true with cursor:null — 47 of 50 candidates are permanently
     unreachable, so semantic results can never be exhausted and can never support a negative.
  4. Six capabilities publish empty input schemas; get_node needed three wrong parameter guesses
     (node/target/nodeId) before `id` worked, and its error's details.target:null points at the wrong
     key. No readOnlyHint/destructiveHint annotations anywhere.
  5. Cross-surface metadata disagreements: schemaVersion 17 vs 18; affected path vs node
     (candidateCount 1 vs 0, totalIsExact false vs true); architecture endpoint 6 vs endpoints 608;
     context returnedCount 0 with a non-empty importers list; confidence.inferredEdges 0 with an
     inferred hop.
TOP 3 ENVIRONMENT GAPS:
  1. No MCP surface exposes client/session identity, client start time or server current time, so
     FRESH_SESSION_NOT_PROVEN is unavoidable and Environment Readiness is capped at 69 for any honest
     MCP-only evaluator. The same gap makes cursor expiry unjudgeable.
  2. Background worker is unobservable: workerBuildId and lastHeartbeatAt are null, there is no lease
     field and no embedding dimensions field; and an MCP-only consumer cannot start a second MCP
     process, making the Agent-A/Agent-B replay dimension (15 pts) structurally unreachable.
  3. Timing observability is inconsistent (only knowledge_search emits timingsMs); tri-state health
     fields are unresolved (configured null, launcherHealthy null, signing "unknown"); and
     index_status vs status_panel disagree on FPMS-NT-CCMS (fresh vs behind, staleReason null).
EXACT MCP RETEST TOOLS/INPUTS:
  knowledge_search({query:"CMS article configuration retrieval", mode:"semantic",
    scope:{revisions:[{repoName:"casino-plus",branch:"main"}]}, page:{limit:3},
    options:{compact:true,semantic:"blend"}})            -> expect typed JSON, not "0 hits · lanes"
  knowledge_search({query:"ArticleRepositoryModule", mode:"exact",
    scope:{revisions:[{repoName:"FPMS-NT",branch:"brazil-v2"}]}, page:{limit:3}})
                                                          -> expect diagnostics.truncated == true
  knowledge_search({query:"<Section-3 concept question>", mode:"semantic",
    scope:{revisions:[{repoName:"FPMS-NT",branch:"brazil-v2"}]}, page:{limit:3}})
                                                          -> expect non-null cursor; continue it
  knowledge_semantic_status({scopeKey:"FPMS-NT"})          -> expect rows or a typed SCOPE_NOT_FOUND
  get_node({node:"node_da824730-86ab-4f8e-b1a0-06a986b50d21"})
                                                          -> expect success or an error naming `id`
  mcp_health() + knowledge_context({target:"node_da824730-86ab-4f8e-b1a0-06a986b50d21",
    repo:"FPMS-NT", branch:"brazil-v2"})                   -> expect schemaVersion 18 in both
  knowledge_affected({repo:"FPMS-NT",
    path:"libs/tools/src/repositories/cms/article/article-repository.module.ts"})
  knowledge_affected({repo:"FPMS-NT", node:"node_da824730-86ab-4f8e-b1a0-06a986b50d21"})
                                                          -> expect identical completeness metadata
  get_architecture({repo:"FPMS-NT"}) + knowledge_endpoints({repo:"FPMS-NT", limit:5})
                                                          -> expect endpoint counts to reconcile
  knowledge_search({query:"x", mode:"exact",
    scope:{revisions:[{repoName:"NO-SUCH-REPO-R22",branch:"main"}]}})
                                                          -> expect REPO_NOT_FOUND, not BRANCH_NOT_FOUND
  knowledge_context({target:"constructor", repo:"FPMS-NT", branch:"brazil-v2"})
                                                          -> expect candidates with filePath/startLine
                                                             and non-CLI remediation
  knowledge_endpoints({repo:"FPMS-NT", limit:5})           -> expect timingsMs and compactRatio < 1
  find_dead_code({repo:"FPMS-NT", limit:3})                -> expect cursor revision != null
  index_status({mode:"detailed"}) + status_panel()         -> expect FPMS-NT-CCMS to agree
```

---

### Completion gate (Section 11 of the brief)

| Requirement | Status |
| --- | --- |
| Q1–Q20 executed or individually justified N/A | ✔ (Q16 wake `N/A_NO_QUEUED_WORK` evidenced; Q17 NOT PROVEN with justification; Q7 redaction/pagination `N/A_NO_NOTES_EXIST`; Q11 service-label collision `N/A_NO_LABEL_COLLISION` with symbol-level substitute) |
| B1–B8 executed or justified | ✔ (B5 Agent-B portion NOT PERFORMED with justification; B2 limited by the prompt supplying no operation name) |
| All IDs/cursors freshly emitted in this process | ✔ |
| Repeated semantic responses internally consistent | ✔ PROVEN |
| Graph works independently of vector lifecycle | ✔ PROVEN |
| Exact truth outranks semantic inference | ✔ — no vector hit used as proof anywhere |
| Architecture, notes and service data remain scoped | ✔ |
| Coverage debt concrete or honestly limited | ✔ concrete |
| Three cursor families and symbol/endpoint/service identity survive Agent-B | ✘ **NOT PROVEN** — no permitted second MCP process |
| Every negative is tri-state and coverage-aware | ✔ |
| Owner UI evidence separate | ✔ (§10, NOT TESTED, zero score weight) |
| No forbidden fallback or mutation | ✔ — no CLI, shell, source, SQLite, Git, old report or Codex report was read; the only write is this file |

**Round 22 is therefore COMPLETE but NOT PASSING**: acceptance requires 95–100 on Product Capability
and MCP-only User Experience; this run earns **69** and **63**.
