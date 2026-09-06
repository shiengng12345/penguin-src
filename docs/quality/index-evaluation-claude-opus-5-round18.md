# Penguin Wiki / Knowledge — Round 18 Independent Evaluation

> **Evaluator:** Claude Opus 5 (1M context) via Claude Code CLI
> **Executed:** 2026-08-31 07:24–08:05 +08 (2026-08-30T23:24Z–2026-08-31T00:05Z)
> **Brief:** `docs/quality/index-evaluation-brief-round18.md`
> **Nature:** read-only black-box evaluation. No source reads, no DB, no Git, no mutation.

---

## 1. Compliance statement and fresh-session evidence

### 1.1 Fresh-session verdict: `FRESH_SESSION_NOT_PROVEN`

This must be stated first and without softening.

The session that executed this evaluation is a Claude Code session whose **global auto-memory index was loaded into context at session start**, and that index contains a prior-round Penguin memory file (`project_penguin_mcp_perf_diagnosis.md`) recording earlier conclusions about Penguin MCP behaviour — specifically that `call_method` with `environmentName` can hang, that `search` was repaired via checkpoint+ANALYZE, and that scope filtering was observed not to take effect.

Consequences, applied honestly:

- Per Brief §0.4, **environment readiness cannot exceed 69/100**.
- Per Brief §7.3 last row, because prior-round conclusions were present in context, **no 95+ verdict is claimed or claimable for this run**.
- One of those recalled conclusions (scope filtering not taking effect) overlaps a finding reproduced independently below in Q10. That finding is nevertheless **supported entirely by evidence emitted in this session** (two `knowledge_service_graph` calls and one `index_status` call, quoted verbatim), not by the memory.
- No node ID, endpoint ID, cursor, capability hash, revision, command result, or score from any earlier round was pasted into this session. Every identifier in this report was emitted by a Penguin call made between 07:24 and 08:05 on 2026-08-31.

### 1.2 Source and mutation boundary — compliance

| Rule | Status | Evidence |
| --- | --- | --- |
| Only Penguin MCP / installed CLI / Penguin output used | **Compliant** | All findings trace to `penguin …` CLI calls or `mcp__penguin__*` tool calls |
| No source-file reads, grep, rg, filesystem search over repos | **Compliant** | `find` was used once, only to locate the brief itself; `grep -ril Pengvi` was run only against Penguin's own JSON output in the scratchpad, never against an indexed repo |
| No DB/SQLite inspection | **Compliant** | none |
| No Git commands | **Compliant** | none |
| No old evaluation report / roadmap / answer key read | **Compliant** | no file under `docs/quality/` was read except the Round 18 brief; the directory was listed only to confirm the new filename does not overwrite history |
| No index / rebuild / repair / watch / register / remove | **Compliant** | none |
| No note / memory / link / API / ontology / suggestion writes | **Compliant** | none |
| No build, install, MCP reconfiguration, signing, config edit | **Compliant** | none |
| Only permitted write | **This report** | `docs/quality/index-evaluation-claude-opus-5-round18.md` (new file) |
| CLI path discovery method | recorded | `which penguin` gives `/Users/shieng/.local/bin/penguin`; `readlink -f` returns the same path (not a symlink); `ls -l` shows a 179-byte regular file. The launcher's **contents were deliberately not read** (Brief Q3 forbids bundle inspection). |

### 1.3 Section 3 dynamic target selection (executed, not assumed)

```
capabilityHash = 40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0
last hex character = '0'  ->  value = 0
endpointSelectionIndex = 0 mod 5 = 0
symbolSelectionIndex   = 0 mod 3 = 0
```

- **Endpoint** = index 0 of endpoints page 2 (limit 5, continued by the page-1 cursor):
  `node_34182942-61ef-40a1-82b8-720902e799ba` — gRPC `AdminGrowthTaskController.QueryUserTaskReport`
- **Symbol** = index 0 of the first three actionable FPMS-NT results of the scoped discovery required by Q5:
  `node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7` — `BalanceCheckHandler`

`DYNAMIC_SELECTION_FALLBACK` was **not** required. Neither target was replaced. Workaround count for selection: **0**.

---

## 2. Client / runtime / MCP / CLI preflight table

| Field | Evidence emitted this session |
| --- | --- |
| Client | Claude Code CLI, model `claude-opus-5[1m]` (Opus 5, 1M context), shell PID 65528, darwin 25.5.0 |
| Session | started 2026-08-31T07:24:20+0800 (2026-08-30T23:24:20Z). **Not proven new** — see 1.1 |
| Penguin CLI launcher | `/Users/shieng/.local/bin/penguin` (via `which`); regular file, 179 bytes, mtime Aug 30 12:47 |
| Penguin CLI version surface | **No `--version` command.** `penguin --version` returns `unknown command: --version (try 'penguin help')` with exit 0. Build ID is only obtainable from `penguin capabilities --json` |
| Penguin CLI buildId | `1.16.0-caf621d03b0402b6` |
| Penguin MCP server | `penguin`; `mcp_health` gives `status: ok`, `initializeHealthy: true`, `clientRestartRequired: false`, `runtimeOutdated: false` |
| MCP runtime generation | `serverGeneration.runningBuildId = 1.16.0-caf621d03b0402b6`, `availableBuildId = 1.16.0-caf621d03b0402b6`, `outdated: false` |
| MCP runtime environment | `nodeVersion v22.23.1`, `platform darwin`, `penguinRoot /Users/shieng/.penguin`, `cwd /Users/shieng`, `queryRuntime {workers: 2, hardTimeoutMs: 30000}` |
| Contract (CLI) | `schemaVersion 15`, `contractVersion 2`, `capabilityHash 40ae9528…4487d0`, 99 capabilities / 99 registrations, all `status: implemented`, 38 mutating, 61 cursor-supporting |
| Contract (MCP) | byte-identical on `schemaVersion` / `contractVersion` / `buildId` / `capabilityHash`; 99/99 capabilities identical field-for-field |
| MCP tools exposed to this client | **81** `mcp__penguin__*` tools (manifest advertises 99 `advertisedTool` names) |
| Repository under test | `FPMS-NT`, `repo_a48ec7fb-5987-47df-9198-06969359cb50`, branch `brazil-v2` (`branch_1d21f868-3252-4b74-8289-8f7c4735247f`) |
| Revision | commit `3f0f1984b9e4337668529a13bad5264501729908`, `snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3`, worktreeFingerprint `073264f852ac…0544c5`, `trust: exact_commit` |
| Freshness | `fresh`; indexedCommit == headCommit; `dirtyFileCount 0`; `worktreeState clean`; `stale: false`; `parserVersion tree-sitter-wasm-v9-canonical-endpoints` |
| Coverage (FPMS-NT) | discovered **3340**, admitted **3333**, excluded **7**, failed **0**, stale **0**, unresolvedReferences **103958**, `status: partial` |
| Coverage (global, from `tags` / `evidence list`) | discovered **47406**, admitted **30335**, excluded **17071**, failed **4**, unresolvedReferences **625497** |
| Ledger / graph | `doctor`: `ledgerSeq 12348 / materializedSeq 12348`, `status ok`, nodes **748840**, edges **1724945**, pendingSuggestions **1**, `verify: false` |
| Non-zero exits during preflight | `penguin endpoint-identity` with no args gives exit 2 (correct); `penguin --version` gives exit 0 with an error message (incorrect: error reported on the success path) |
| Duplicate tool/capability IDs | **none** — 99 unique capability IDs, 99 unique registration IDs, 99 unique advertisedTool names |

---

## 3. Scores

### 3.1 Product capability — **65 / 100**

| Dimension | Max | Score | Basis |
| --- | ---: | ---: | --- |
| Discoverability / onboarding | 8 | 6 | help + onboarding are complete and copyable; no `--version`; `coverage --help` prints a broken stub |
| Scoped search quality | 10 | 4 | exact-identifier ranking is inverted (Q6); concept query returns 0 (Q5) |
| Context and source-pack usefulness | 10 | 7 | 30+ relation classes, excellent `lower_bound` note; `tests` / `notes` empty for both targets |
| Graph / flow / affected quality | 14 | 8 | hop 1 proven and CLI/MCP-identical; hops 2+ carry no per-edge evidence at all |
| Endpoint investigation | 10 | 8 | dynamic page-2 target, 3 identity forms converge, handler is a real proven edge |
| Cross-repo / service identity | 8 | 3 | no label duplicates exist to disambiguate, but `repo` scope is a silent no-op on two surfaces and the service map carries no evidence envelope |
| Pagination and handoff | 10 | 8 | all four cursor surfaces portable across fresh processes; `CURSOR_*` errors carry no remediation |
| Accuracy and revision integrity | 8 | 7 | every targeted result carries repo/branch/snapshot/commit/fingerprint/trust/freshness |
| Completeness and honesty | 10 | 7 | pervasive `completeness` / `proofStatus` / warnings; coverage debt is not actionable; `totalIsExact:true` contradicts `lower_bound` |
| Semantic / vector usefulness | 7 | 3 | honestly unavailable with a named reason and a working graph/lexical fallback |
| Wiki / API provenance | 3 | 2 | stale previews are explicitly flagged; `revisionIds` / `sourceCommits` are empty |
| Recovery and speed | 2 | 2 | typed, actionable errors; acceptable latency, no timeouts |
| **Total** | **100** | **65** | |

### 3.2 Environment readiness — **59 / 100** (60 raw, capped)

| Dimension | Max | Score | Basis |
| --- | ---: | ---: | --- |
| Installed stable launcher / runtime | 20 | 14 | launcher + buildId discoverable; no `--version`, no runtime path, `doctor` omits build ID |
| MCP initialize / tools / health | 20 | 18 | health ok, generation current, 81 tools callable, real calls succeed |
| CLI / MCP build / schema parity | 20 | 9 | build/hash/schema/contract identical, but 61 advertised tool names are not callable and two MCP tools publish empty schemas |
| Fresh two-session generation proof | 20 | 10 | CLI half fully proven with fresh PIDs and a zero-repair replay; second MCP session not achievable from inside |
| Installed-runtime self-containment | 10 | 5 | no workspace dependency observable, but no runtime path or native health is exposed at all, so not proven |
| Error / timeout observability | 5 | 3 | typed errors with exit codes on main paths; four surfaces bypass the JSON error contract |
| Release / signing evidence | 5 | 1 | no current surface proves signing, notarization, or artifact identity beyond a build ID string |
| **Raw total** | **100** | **60** | |

### 3.3 Hard caps applied

| Cap | Triggered? | Effect |
| --- | --- | --- |
| Repository scope silently crosses to another repo | **Yes** — `knowledge_service_graph(repo=…)` and `index_status(repo=FPMS-NT)` return all 20 repositories; an unknown repo name is silently accepted | Product max 69. Score is 65; cap **not binding** but declared |
| Emitted node ID cannot round-trip without title/path reconstruction | No — every emitted `node_*` round-tripped through `context`, `flow`, `affected`, `callers`, `endpoint-identity` | none |
| Empty / partial result presented as proven absence | No — every empty result carried `lower_bound` / `candidate` / `not_proven` plus a `COVERAGE_INCOMPLETE` warning | none |
| Semantic claimed ready but read unavailable or silent fallback | No — the semantic lane is reported skipped with a named reason and the fallback lane is named | none |
| CLI and MCP return different build/hash/schema with no stale warning | **Yes (applied)** — build/hash/schema strings are identical, but the manifest's `advertisedTool` names disagree with the MCP tool layer for 61/99 capabilities, and `knowledge_endpoints` / `knowledge_file_symbols` publish empty input schemas while the manifest declares full ones | Environment max 59, so **59** |
| Fresh-session boundary not proven | **Yes** | Environment max 69; already below |
| Evaluation used source / DB / Git / old reports / mutation | **Partially** — no old report was read and no ID was reused, but prior-round conclusions were present in the session's auto-memory | **No 95+ verdict claimed** |

---

## 4. Q1–Q20

### Q1 — zero-memory discovery test

```
scenario: safest first sequence for an unfamiliar FPMS-NT production symptom
surface: CLI
exact command/tool and exact inputs:
  penguin help
  penguin capabilities --json
  penguin status --json
  penguin doctor --json
  penguin coverage --repo FPMS-NT --json
  penguin onboarding FPMS-NT
bounded raw evidence: help lists 60+ commands plus 99 canonical capability IDs; onboarding emits
  "<!-- penguin:onboarding revision-hash=ca4f0a08... capability-hash=40ae9528... -->" and a
  copy-pasteable section 8 first-round check block
elapsed time: help 0.1s; capabilities 0.104s; status 0.555s; doctor 6.199s; coverage 0.222s; onboarding 12.560s
exit/status/error code: all 0
repo/branch/snapshot/revision: repo_a48ec7fb... / brazil-v2 / snapshot_289e6a29... / 3f0f1984b9e4...
freshness: fresh (indexed == head, 0 dirty)
coverage: 3340 / 3333 / 7 / 0 / 0, unresolvedReferences 103958
candidateCount/returnedCount/totalIsExact: n/a for help; coverage returnedCount 0, totalIsExact false
cursor/hasMore/truncated: none
evidence origin/method/confidence: Penguin-generated help + onboarding, high confidence
dynamic IDs and the result that emitted them: capabilityHash from `penguin capabilities --json`
workaround count: 0
verdict: PASS
confidence: high
```

**Answer Penguin actually supports.** The safe sequence, entirely derivable from `penguin help` and `penguin onboarding <repo>` without any prior knowledge:

1. `penguin status --json` — pick the repo and read `trust.stale`, `staleReason`, `worktreeState`, `dirtyFiles`, `indexedCommit` vs `headCommit`.
2. `penguin coverage --repo <repo> --json` — read `coverage.status`, `excluded`, `failed`, `unresolvedReferences`. **Stop point 1:** if `status != complete` or `unresolvedReferences > 0`, no absence claim is permitted from here on.
3. Positive discovery: `penguin search "<term>" --repo <repo> --limit N --json`, then read `diagnostics.queryStatus`, `diagnostics.searchedLanes`, `diagnostics.skippedLanes`.
4. Dynamic-ID continuation: carry `locator.nodeId` (or `identityKey` for endpoints) into `penguin context|flow|affected|callers <id> --repo <repo> --json`. Continue lists with the emitted `cursor` / `nextCursor`, never a reconstructed offset.
5. **Stop point 2 — negative-result rule:** `candidateCount: 0` combined with `completeness: lower_bound` and `proofStatus: candidate|not_proven` means *not proven*, never *absent*. Penguin itself emits this rule as `warnings[].COVERAGE_INCOMPLETE`: `"coverage includes excluded or failed files; an empty result is not proof of absence"`.
6. **Stop point 3 — causality:** `flow` beyond hop 1 carries no per-edge evidence (Q8/Q9). Penguin's own `context.completeness.note` states: *"The calls list is a lower bound: constructor calls, interface dispatch, static-method calls and calls inside callback bodies are not modelled."* Causality therefore requires source or runtime review, always.
7. MCP-unavailable fallback: identical CLI commands; `which penguin` for the launcher; `penguin capabilities --json` for the build ID.

**Capability classes are clearly distinguished:** `penguin capabilities --json` marks each of 99 capabilities with `mutating: true|false` (38 mutating) and `requiredOn: ["cli","mcp"]`; `status: implemented` for all 99. This part is genuinely good.

**Gap:** the manifest advertises capability *names*, and 61 of the 99 `advertisedTool` names are not callable in this MCP session (Q4). An agent following the manifest literally would call tools that do not exist.

---

### Q2 — capability honesty, including semantic / vector search

```
scenario: does Penguin tell the truth about semantic/vector retrieval?
surface: CLI + MCP
exact command/tool and exact inputs:
  penguin search "how is a withdrawal approved" --repo FPMS-NT --limit 10 --mode semantic --json
  penguin search "where do we decide if a withdrawal can proceed" --repo FPMS-NT --limit 10 --semantic blend --json
  penguin search "withdraw" --repo FPMS-NT --limit 10 --mode lexical --json
bounded raw evidence:
  mode=semantic   -> "searchedLanes": [],                  "skippedLanes": [{"lane":"semantic","reason":"async_semantic_lane_required"}]
  semantic=blend  -> "searchedLanes": ["source","symbol"], "skippedLanes": [{"lane":"semantic","reason":"async_semantic_lane_required"}]
  mode=lexical    -> "searchedLanes": ["symbol"],          "skippedLanes": []
elapsed time: 0.343s / 0.807s / 0.454s (semantic warm median 0.323s)
exit/status/error code: 0 / 0 / 0
repo/branch/snapshot/revision: repo_a48ec7fb... / brazil-v2 / snapshot_289e6a29... / 3f0f1984b9e4...
freshness: fresh
coverage: partial, 3333/3340 admitted, 103958 unresolved
candidateCount/returnedCount/totalIsExact: 0/0/false ; 0/0/false ; 1/1/false
cursor/hasMore/truncated: none
evidence origin/method/confidence: Penguin diagnostics block, high
dynamic IDs: requestId search_345181bf0bc25db0 / search_d7addfbf90cd862e / search_e44de6853c95ed4f
workaround count: 0
verdict: PASS (capability honesty) / semantic power NOT IMPLEMENTED-UNAVAILABLE
confidence: high
```

1. **Status.** Semantic is **advertised but unavailable**. `knowledge.search.input.v2` declares `mode` enum including `"semantic"` and `options.semantic` enum `["off","fallback","blend"]`. Both are accepted. Neither performs retrieval.
2. **Model / space / dimensions / provider / chunk counts.** **None are exposed anywhere.** A full-text scan of the 65,642-byte capability manifest returns zero occurrences of `vector`, `embed`, `model`, `hybrid`, `rerank`. `mcp_health` exposes no vector or native-extension readiness field. The only machine-readable signal is the per-request `skippedLanes[].reason = "async_semantic_lane_required"`.
3. **Permitted read-only semantic query attempted:** yes, twice (`--mode semantic` and `--semantic blend`).
4. **Comparison with graph/lexical-only:** `--mode lexical "withdraw"` searched the `symbol` lane and returned 1 hit, `WithdrawRange` at `apps/payment/src/payment/withdrawal/checks/handlers/payment-type.check.ts:19`, node `node_dcdc2b38-a9c4-49b9-97f0-33c4427b5ac9`. Lexical works.
5. **Does the result identify the lane?** **Yes, per-request and per-hit.** Every hit carries `lane` and `rankReasons` (e.g. `["verified exact source occurrence; exact boost=0.1","lane_rank=1"]`), and the envelope carries `searchedLanes` / `skippedLanes`. Nothing is presented as a proven graph fact.

**Verdict.** Capability honesty **PASS** — there is no silent fallback and no false readiness claim. Semantic power **UNAVAILABLE**. Per the Brief's own guidance this scores 2–3/7; awarded **3/7** because the fallback lane is explicitly named rather than merely occurring.

**Defect found anyway.** `--mode semantic` returns `searchedLanes: []` — it searches **nothing** — with `queryStatus: "NO_MATCH_INCOMPLETE"`, `exitCode 0`, and no typed error. An agent that reads only `queryStatus` will interpret "the semantic lane does not exist" as "nothing matched". This is the one place where the semantic honesty is structurally weaker than it should be: an unsupported mode deserves a typed `MODE_UNSUPPORTED` error with remediation, not a successful empty result. This is also the Q15 "unsupported semantic mode" row.

No database or model file was inspected.

---

### Q3 — installed runtime self-containment

```
scenario: does the installed CLI/MCP depend on /Users/shieng/Desktop/Pengvi?
surface: CLI + MCP
exact command/tool and exact inputs:
  which penguin ; readlink -f $(which penguin) ; ls -l /Users/shieng/.local/bin/penguin
  penguin capabilities --json      (buildId)
  penguin doctor --json
  mcp__penguin__mcp_health
  penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5 --json   (real CLI read)
  mcp__penguin__knowledge_search  {query, scope.revisions[0].repoName=FPMS-NT, page.limit 5}  (real MCP read)
  grep -ril "Pengvi" <scratchpad of all Penguin JSON output>
bounded raw evidence:
  launcher = /Users/shieng/.local/bin/penguin, regular file 179 bytes, not a symlink
  CLI  buildId = 1.16.0-caf621d03b0402b6
  MCP  serverGeneration.runningBuildId = 1.16.0-caf621d03b0402b6, availableBuildId identical, outdated=false
  mcp_health.penguinRoot = /Users/shieng/.penguin   (data root, not a workspace)
  mcp_health.cwd = /Users/shieng ; nodeVersion v22.23.1 ; platform darwin
  doctor = {"ledgerSeq":12348,"materializedSeq":12348,"status":"ok","nodes":748840,"edges":1724945,"pendingSuggestions":1,"verify":false}
  grep for "Pengvi" across every Penguin JSON output collected this session: 0 matches
  indexed repository list (20 repos): /Users/shieng/Desktop/Pengvi is NOT among them
elapsed time: capabilities 0.089-0.093s; doctor 4.093s median; CLI search 2.417s median; MCP search 0.169s server-side
exit/status/error code: all 0
repo/branch/snapshot/revision: n/a (runtime scope) except the two real reads, both snapshot_289e6a29...
freshness: fresh
coverage: n/a
candidateCount/returnedCount/totalIsExact: CLI search 13/5/false ; MCP search 14/5/false
cursor/hasMore/truncated: both truncated:true with a cursor
evidence origin/method/confidence: Penguin health + real calls, medium confidence (absence of a path is not proof)
dynamic IDs: buildId 1.16.0-caf621d03b0402b6 from `penguin capabilities --json`
workaround count: 0
verdict: PARTIAL - not proven
confidence: medium
```

| Check | Result |
| --- | --- |
| Launcher / runtime identity | Launcher path exposed. **Runtime path never exposed by any Penguin surface.** |
| Build ID and generation | `1.16.0-caf621d03b0402b6` on both CLI and MCP; MCP additionally reports `availableBuildId` and `outdated: false` |
| Native dependency health reported by Penguin | **None.** `doctor` reports only ledger/node/edge counts. No native module, sqlite, wasm, or extension health field exists anywhere |
| Real CLI search succeeds | Yes — 13 candidates, 5 returned, full revision envelope |
| Real MCP search succeeds | Yes — 14 candidates, 5 returned, full revision envelope |
| Semantic / vector native-extension readiness reported separately | **No.** Only the per-request `skippedLanes` reason |
| Output exposes a workspace path as an execution dependency | **No.** Zero occurrences of `Pengvi` in any Penguin output; `penguinRoot` is `~/.penguin` |

**Verdict: `not proven`.** No Penguin surface exhibits a dependency on `/Users/shieng/Desktop/Pengvi`, and both real reads succeed — but Penguin also exposes no runtime path, no bundle identity, and no native-dependency health, so self-containment cannot be *positively* observed. Absence of a visible path is not proof of absence of a load-time dependency. No directory was renamed, no file disconnected, no bundle inspected, and self-containment is explicitly **not** inferred from the fact that an app build exists.

---

### Q4 — canonical CLI/MCP contract parity

```
scenario: field-by-field CLI vs MCP comparison across six capability classes
surface: CLI + MCP
exact command/tool and exact inputs:
  penguin capabilities --json                    (CLI manifest, 65,642 bytes)
  mcp__penguin__knowledge_capabilities            (MCP manifest, 72,436 bytes)
  plus one real call per class on both surfaces
elapsed time: CLI 0.104s ; MCP result exceeded the inline token cap and was written to a file
exit/status/error code: 0 / 0
evidence origin/method/confidence: Penguin manifests + real calls, high
workaround count: 1 (MCP capabilities output had to be read from the spill file the harness wrote)
verdict: PARTIAL
confidence: high
```

**Identical across surfaces:** `schemaVersion 15`, `contractVersion "2"`, `buildId 1.16.0-caf621d03b0402b6`, `capabilityHash 40ae9528…4487d0`, and all 99 capability descriptors compared field-for-field (`id`, `version`, `title`, `coreOperation`, `requiredOn`, `supportsCompact`, `supportsCursor`, `mutating`, `confirmation`, `inputSchemaId`, `outputSchemaId`) — **zero differences**. All 99 registrations have identical `inputSchema`, `inputSchemaId`, `outputSchemaId`, `status`. The only registration-level deltas are MCP-only annotations `advertisedTool` and `invocationMode: "direct"`, which is legitimate surface metadata.

Per-class comparison:

| Class | Capability | CLI | MCP | Verdict |
| --- | --- | --- | --- | --- |
| Discovery | `knowledge.capabilities` | `penguin capabilities --json` | `knowledge_capabilities` | **PASS** — identical payload |
| Search | `knowledge.search` | `penguin search … --repo --limit --mode` | `knowledge_search {query, scope, page, options, mode}` | **FAIL** — see below |
| Graph | `knowledge.flow` | `penguin flow <identityKey> --repo` | `knowledge_flow {target, repo, compact}` | **PASS** — 29 identical steps, identical node IDs, identical revision |
| Pagination | `knowledge.endpoints` | `penguin endpoints FPMS-NT --limit 5 --cursor` | `knowledge_endpoints` | **PARTIAL** — CLI works; the MCP tool publishes an **empty input schema** (`properties: {}`) |
| Wiki/API | `knowledge.api_doc.list` | `penguin api-doc list --json` | `knowledge_api_doc_list` advertised but **not exposed** to this client (`api_doc_list` is) | **FAIL** — advertised name not callable |
| Structured error | any | typed JSON on stdout with `exitCode` | typed JSON in an error envelope | **PASS** on shape; see Q15 for four surfaces that bypass it |

**Defect 1 — 61 of 99 advertised tool names are not callable.** The manifest's `advertisedTool` values include `knowledge_get_node`, `knowledge_dead_code`, `knowledge_architecture`, `knowledge_communities`, `knowledge_index_status`, `knowledge_status_panel`, `knowledge_api_doc_list`, `knowledge_dependency_path`, `knowledge_package_dependencies`, `knowledge_evidence_note_list`, and 51 more. **None of them exists in this MCP session.** The actually-exposed equivalents are `get_node`, `find_dead_code`, `get_architecture`, `find_communities`, `index_status`, `status_panel`, `api_doc_list`, `dependency_path`, `package_dependencies`, `list_evidence_notes`. Conversely, 43 exposed tools appear under no `advertisedTool` name, and seven of them (`call_method`, `compare_environments`, `describe_method`, `list_environments`, `get_default_headers`, `install_package`, `search_methods`) correspond to **no capability in the 99-item manifest at all**. Brief section 2.7 is decisive here: a capability listed in a manifest is not usable until a real call succeeds, and for these 61 names no call is even possible.

**Defect 2 — two MCP tools publish empty schemas.** `mcp__penguin__knowledge_endpoints` and `mcp__penguin__knowledge_file_symbols` advertise `{"properties": {}, "additionalProperties": true}` while the manifest declares full `knowledge.endpoints.input.v2` / `knowledge.file_symbols.input.v2` schemas. An agent has no way to learn the parameter names from the tool surface.

**Defect 3 — different default `mode`, producing different results for an identical query.** `penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5` gives cursor payload `"mode":"auto"`, `searchedLanes ["source","symbol"]`, `candidateCount 13`, hit scores 1.0. The MCP call with the same query and scope gives cursor payload `"mode":"exact"`, `searchedLanes ["source"]`, `candidateCount 14`, hit scores 1.1. Same five top hits by file/line, but different totals, different lanes, and different scores. Additionally, MCP's fifth hit carries `nodeId` + `symbol` fields that the CLI's identical hit omits.

**Defect 4 — `options.compact: true` is a no-op.** MCP returned `stats: {"rawBytesEstimate":10661,"sentBytes":10661,"compactRatio":1}`. The flow call with `compact: true` returned the full 29-step payload.

**Duplicate IDs:** none. **Aliases that dispatch differently:** none observed among callable tools.

---

### Q5 — concept query versus exact query

```
scenario: "Where does FPMS-NT decide whether a withdrawal or payout operation may proceed?"
surface: CLI
exact command/tool and exact inputs:
  (a) penguin search "withdrawal payout approval decision" --repo FPMS-NT --limit 10 --json
  (b) penguin search "withdrawal" --repo FPMS-NT --limit 8 --json
  (c) penguin search "apps/payment/src/payment/withdrawal/checks" --mode path --repo FPMS-NT --limit 8 --json
  (d) penguin filesymbols branch_1d21f868-... "apps/payment/src/payment/withdrawal/services/withdrawal-check.service.ts" --limit 10 --json
  (e) penguin callers node_b10e39c8-1399-4856-9904-d23bab2e08e6 --repo FPMS-NT --json
bounded raw evidence:
  (a) queryStatus NO_MATCH_INCOMPLETE, searchedLanes ["source","symbol"], candidateCount 0
  (b) queryStatus MATCH, candidateCount 445, top-8 all source_occurrence with nodeId null
  (c) queryStatus MATCH, searchedLanes ["path"], candidateCount 7, returns the checks/ directory
  (d) candidateCount 4 -> WithdrawalCheckService(14) / constructor(18) / runChecks(39) / runChecksWithLock(45)
  (e) candidateCount 1 -> initiateWithdrawal, node_85c5afc5-89b1-433b-8a36-f41f4d20b39f,
      apps/payment/src/payment/withdrawal/processor/withdrawal-initiate-processor.ts
elapsed time: (a) 1.945s (b) 0.770s (c) 0.263s (d) 0.205s (e) 0.9s
exit/status/error code: all 0
repo/branch/snapshot/revision: repo_a48ec7fb... / brazil-v2 / snapshot_289e6a29... / 3f0f1984b9e4...
freshness: fresh
coverage: partial 3333/3340, unresolvedReferences 103958
candidateCount/returnedCount/totalIsExact: see above; totalIsExact false on every search
cursor/hasMore/truncated: (b) truncated true with cursor; (c),(d) exhausted
evidence origin/method/confidence: path + symbol lanes, verified source occurrences; medium
dynamic IDs: node_93ffec7e / node_b10e39c8 / node_a9a89493 / node_85c5afc5 all emitted by (d) and (e)
workaround count: 1 (the business-intent query returned nothing; the target had to be reached through the path lane)
verdict: PARTIAL
confidence: medium
```

**What Penguin can support.** The decision point is `WithdrawalCheckService` at `apps/payment/src/payment/withdrawal/services/withdrawal-check.service.ts`, specifically `runChecks` (line 39, `node_b10e39c8-1399-4856-9904-d23bab2e08e6`) and `runChecksWithLock` (line 45, `node_a9a89493-60e2-46a0-a9a4-aff60cd498de`), reached from `initiateWithdrawal` in `withdrawal-initiate-processor.ts`. The gate implementations live in `apps/payment/src/payment/withdrawal/checks/handlers/` — six handlers emitted by Penguin: `BalanceCheckHandler`, `FpmsInternalCheckHandler`, `PaymentTypeCheckHandler`, `PlayerInfoCheckHandler`, `PropersoalCheckHandler` (sic, Penguin-reported title), `WithdrawalBankCheckHandler` — behind the interface `WithdrawalCheckHandler` (`node_f2ef39f4-2ba7-48ec-9730-516e843fbb78`).

**Which returned evidence is only a candidate.** All of it, at the level of *business meaning*. `search` hits are `proofStatus: candidate` with `totalIsExact: false`. The `runChecks` to handlers linkage is **not in the graph at all** — it is interface dispatch, which Penguin explicitly does not model. The only *proven* edge on this whole path is nothing: `callers(runChecks)` returns 1 candidate under `completeness: lower_bound`, not a proven edge. **No claim about the correctness of the business rule is made; that requires source review.**

**Comparison.**

| Dimension | Concept query (a) | Exact/path query (c)+(d) |
| --- | --- | --- |
| Retrieval lane | `["source","symbol"]` — both searched, both empty | `["path"]`, then `file_symbols` |
| Result ordering | n/a (0 results) | deterministic, definition order |
| Repository precision | correct (scope applied, `scopeApplied: true`) | correct |
| Locator / node ID quality | none | full: `nodeId`, `filePath`, `startLine`, `endLine`, `kind`, `status: fresh` |
| Proven / inferred / unresolved | `not_proven` | `candidate`; the 103,958 unresolved references bound every negative |
| Semantic mode adds candidates? | No — lane unavailable | No |
| Exact result ahead of weaker candidates? | **No** — see Q6 | **No** |

**Failure.** The business-intent question, phrased as a natural-language query, returns **zero results** from a repository that contains a directory literally named `withdrawal/checks/`. Multi-word intent queries are not tokenised into an OR/AND retrieval; they behave as a single literal. This is the single largest usability gap in the search surface, and it is exactly the gap the semantic lane was meant to close.

---

### Q6 — metamorphic search stability

```
scenario: three equivalent queries for node_fd129f7d... BalanceCheckHandler, twice each, plus MCP
surface: CLI (2 runs each, fresh process per run) + MCP (1 run)
exact command/tool and exact inputs:
  F1 penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5 --json
  F2 penguin search "apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts" --mode path --repo FPMS-NT --limit 5 --json
  F3 penguin search "balance check handler withdrawal" --repo FPMS-NT --limit 5 --json
  MCP knowledge_search {query:"BalanceCheckHandler", scope.revisions[0].repoName:"FPMS-NT", page.limit:5}
bounded raw evidence:
  F1 run1 == run2 exactly: MATCH, lanes ["source","symbol"], cand 13, top-5 = 4x payment.module.ts + 1x top-up-balance.check.ts, all nodeId null
  F2 run1 == run2 exactly: MATCH, lanes ["path"], cand 1, nodeId null
  F3 run1 == run2 exactly: MATCH, lanes ["source","symbol"], cand 4,
     #1 = symbol node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7 BalanceCheckHandler
     #2 = node_04c042fa-... constructor  #3 = node_d7a97975-... handle  #4 = node_8020f049-... transferFund
  MCP: mode resolved "exact", lanes ["source"], cand 14, same top-5 files/lines, scores 1.1 vs CLI 1.0
  Full pagination of F1 (3 pages, 3 fresh processes): the symbol node ranks #13 of 13, score 0.95,
     behind 12 source_occurrence hits at score 1.0, nine of which are TopUpBalanceCheckHandler
elapsed time: F1 2.753s / 0.660s ; F2 0.269s / 0.251s ; F3 0.959s / 0.810s ; MCP 0.169s server-side
exit/status/error code: all 0
repo/branch/snapshot/revision: identical across all seven runs - snapshot_289e6a29...
freshness: fresh ; coverage partial 3333/3340
candidateCount/returnedCount/totalIsExact: F1 13/5/false ; F2 1/1/false ; F3 4/4/false ; MCP 14/5/false
cursor/hasMore/truncated: F1 truncated with cursor, exhausted after 3 pages, no duplicates
evidence origin/method/confidence: verified source occurrences + symbol lane; high
dynamic IDs: node_fd129f7d..., node_04c042fa..., node_d7a97975..., node_8020f049..., node_3eacfcfe... (TopUp)
workaround count: 0
verdict: FAIL
confidence: high
```

**Determinism: PASS.** Every form produced byte-identical results across two fresh processes. No scope crossed a repository boundary. No form manufactured stronger proof than its lane supports.

**Ranking: FAIL, decisively.** The Brief's pass condition requires the exact form to resolve deterministically *and* the exact result to remain ahead of weaker candidates. Full pagination of the exact query gives:

| Rank | Lane | Score | Symbol / file |
| ---: | --- | ---: | --- |
| 1–4 | source | 1.00 | `payment.module.ts` — imports of **TopUp**BalanceCheckHandler |
| 5 | source | 1.00 | `top-up/checks/handlers/top-up-balance.check.ts:13` |
| 6–9 | source | 1.00 | `top-up/services/top-up-check.service.ts` |
| 10 | source | 1.00 | `withdrawal/checks/handlers/balance.check.ts:23` (`nodeId: null`) |
| 11–12 | source | 1.00 | `withdrawal/services/withdrawal-check.service.ts` |
| **13** | **symbol** | **0.95** | **`BalanceCheckHandler`, `node_fd129f7d-…`** |

The symbol lane is scored strictly below the source lane (`lane_rank`), so **the definition of the exact identifier you searched for is the last of thirteen results**, behind nine substring matches on a *different* class in a *different* module. Meanwhile the natural-language paraphrase (F3) put the correct symbol node at **rank 1**. Natural language outperforming an exact identifier is an inverted ranking contract.

Secondary finding: `source_occurrence` hits carry `locator.nodeId: null`. The most-returned hit kind is not round-trippable to a node; only `filePath:startLine` is usable.

---

### Q7 — dynamic endpoint selection and identity

```
scenario: page-2 endpoint selection and identity convergence
surface: CLI
exact command/tool and exact inputs:
  penguin endpoints FPMS-NT --limit 5 --json                                  (page 1)
  penguin endpoints FPMS-NT --limit 5 --cursor "<page-1 nextCursor>" --json   (page 2, fresh process)
  penguin endpoint-identity "gRPC AdminGrowthTaskController.QueryUserTaskReport" \
      "grpc::AdminGrowthTaskController.queryusertaskreport" \
      "node_34182942-61ef-40a1-82b8-720902e799ba" --repo FPMS-NT --json
  penguin endpoint-identity "<same three, corrupted>" --repo FPMS-NT --json
bounded raw evidence:
  page 1 -> candidateCount 610, totalIsExact TRUE, truncated true, nextCursor is a signed JWT-like token whose
    payload decodes to {"operation":"endpoints","scope":"repo_a48ec7fb...|branch_1d21f868...|*|identityKey,nodeId",
    "orderingKey":"identityKey,nodeId","lastKey":"grpc::AdminGrowthTaskController.previewsegmenthitcount node_82c838f4...",
    "revision":"snapshot_289e6a29...","expiresAt":"2026-08-30T23:42:03.716Z"}
  page 2 index 0 -> node_34182942-61ef-40a1-82b8-720902e799ba
  identity -> {"forms":[3x status "resolved" -> same nodeId],"equal":true,
               "rootNodeId":"node_34182942...","parentNodeId":null,"completeness":"complete"}
  corrupted -> {"error":{"code":"TARGET_NOT_FOUND","message":"endpoint identity could not resolve any supplied form",
               "retryable":false,"details":{"forms":[3x status "no_match"],
               "remediation":"use `penguin endpoints --json` to copy an indexed endpoint identity"}},"exitCode":1}
elapsed time: page 1 6.617s (cold) ; page 2 5.558s ; identity 0.212s ; corrupted 0.2s
exit/status/error code: 0 / 0 / 0 / 1
repo/branch/snapshot/revision: snapshot_289e6a29... on every item
freshness: fresh ; coverage partial
candidateCount/returnedCount/totalIsExact: 610 / 5 / TRUE (both pages)
cursor/hasMore/truncated: scoped, signed, expiring; ordering key `identityKey,nodeId`; alphabetical, stable, no duplicates
evidence origin/method/confidence: endpoint inventory + graph, high
dynamic IDs: node_34182942... (endpoint), node_865365a4-384c-4150-a9c0-374dc6d92386 (handler)
workaround count: 0
verdict: PASS
confidence: high
```

| Identity form | Emitted / documented? | Result |
| --- | --- | --- |
| Rendered title `gRPC AdminGrowthTaskController.QueryUserTaskReport` | emitted by `endpoints` | resolved to `node_34182942…` |
| Canonical protocol identity `grpc::AdminGrowthTaskController.queryusertaskreport` | emitted as `identityKey` | resolved to `node_34182942…` |
| `node:<id>` / bare `node_34182942…` | emitted as `nodeId` | resolved to `node_34182942…`; `context` reports `target: "node:node_34182942…"` |
| Route form | **not applicable** — `protocol: "grpc"`, no route field emitted. Recorded as N/A, not as a failure |
| Corrupted identity (all three forms mangled) | — | `TARGET_NOT_FOUND`, per-form `no_match`, copyable remediation, exit 1 |

All valid forms converge on the same node and the same revision. Invalid input returns a structured, actionable error.

**Minor defect:** `endpoint-identity` output carries **no** `scope` / `revision` / `freshness` / `coverage` / `completeness` envelope — it is the only read capability tested that breaks the evidence-envelope convention. It reports `completeness: "complete"` with no revision to anchor that claim to.

---

### Q8 — endpoint handler truth versus inventory decoration

```
scenario: is the reported handler a real current-revision graph relation?
surface: CLI + MCP
exact command/tool and exact inputs:
  penguin endpoints FPMS-NT --limit 5 --cursor <p1> --json          -> items[0].handlers
  penguin flow "grpc::AdminGrowthTaskController.queryusertaskreport" --repo FPMS-NT --json
  mcp__penguin__knowledge_flow {target: same identityKey, repo: FPMS-NT, compact: true}
  penguin context "node_34182942-61ef-40a1-82b8-720902e799ba" --repo FPMS-NT --json
bounded raw evidence (verbatim, from the endpoints inventory):
  "handlers":[{"nodeId":"node_865365a4-384c-4150-a9c0-374dc6d92386","title":"queryUserTaskReport","nodeType":"symbol",
   "filePath":"apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts",
   "startLine":230,"endLine":241,
   "source":{"repoId":"repo_a48ec7fb...","branchId":"branch_1d21f868...","revisionId":"snapshot_289e6a29...", ...},
   "edgeType":"handles","evidenceState":"proven",
   "edgeEvidence":{"origin":null,"method":"EXTRACTED","confidence":1,
     "provenance":{"filePath":"apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts"},
     "scope":"revision"}}]
  "handlerStatus":"handled", "missingHandlerReason":null,
  "memberships":[{"endpointId":"node_34182942...","role":"provider","locatorNodeId":"node_865365a4..."}]
  flow step depth 1: identical nodeId, via "handles", evidenceState "proven", identical edgeEvidence
elapsed time: endpoints 5.558s ; CLI flow 10.909s (cold) / 3.342s (warm median) ; MCP flow ~1s ; context 0.783s
exit/status/error code: 0 across all four
repo/branch/snapshot/revision: snapshot_289e6a29... / commit 3f0f1984b9e4... on every hop
freshness: fresh ; coverage partial 3333/3340, 103958 unresolved
candidateCount/returnedCount/totalIsExact: flow 29/29/null
cursor/hasMore/truncated: flow truncated false, no cursor
evidence origin/method/confidence: EXTRACTED, confidence 1.0, scope "revision" - but origin is null
dynamic IDs: node_34182942... (endpoint), node_865365a4... (handler)
workaround count: 0
verdict: PASS (first hop) / PARTIAL (deeper hops)
confidence: high
```

**The handler is a real graph relation, not inventory decoration.** It carries `edgeType: "handles"`, `evidenceState: "proven"`, `method: "EXTRACTED"`, `confidence: 1`, `scope: "revision"`, and a file-level `provenance` — and the identical object appears in three independent surfaces (`endpoints.handlers`, `endpoints.firstHopRelations`, `flow.steps[1]`) on both CLI and MCP.

**First-hop agreement: PASS.** CLI `endpoints` == CLI `flow` == MCP `flow`, byte-for-byte on nodeId, edgeType, evidenceState, and edgeEvidence.

**Deeper hops: evidence frontier, honestly bounded but under-instrumented.** Of the 29 flow steps, **exactly one** (`depth 1`, `via handles`) carries `evidenceState` and `edgeEvidence`. The other 28 carry `via` (`calls` x12, `references` x15, `root` x1) and **no `evidenceState` and no `edgeEvidence` at all** — no origin, no method, no confidence, no provenance. The envelope compensates with `completeness: "partial"` and `proofStatus: "not_proven"`, so nothing is fabricated. But an agent cannot distinguish an extracted call edge from an inferred one at any depth beyond 1. **No fabricated chain was produced.**

`edgeEvidence.origin` is `null` even on the proven edge, while `method` is populated — an origin field that is never filled.

---

### Q9 — bounded request-flow reconstruction

Starting from `node_34182942-61ef-40a1-82b8-720902e799ba`.

| # | Hop | Node | Locator | Edge | Classification |
| ---: | --- | --- | --- | --- | --- |
| 1 | endpoint | `node_34182942-61ef-40a1-82b8-720902e799ba` gRPC `AdminGrowthTaskController.QueryUserTaskReport` | `apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts:230-241` | `root` | **proven** (inventory + graph agree; `handlerStatus: handled`) |
| 2 | handler | `node_865365a4-384c-4150-a9c0-374dc6d92386` `queryUserTaskReport` | same file `:230-241` | `handles`, `EXTRACTED`, confidence 1.0, scope `revision` | **proven** |
| 3 | service / use case | `node_f1e90f30-8154-45dd-82ff-118d7d04c785` `query` | `apps/promotion/src/modules/growth-task/services/v2-task-report.service.ts:112-156` | `calls` (depth 2) | **inferred** — `via: "calls"` present, `evidenceState` absent |
| 4 | repository | `node_ca45eae1-92c2-4546-8c1f-257de6d200f8` `aggregateReportRows` | `apps/promotion/src/modules/growth-task/repositories/user-task-campaign.repository.ts:206-293` | `calls` (depth 3) | **inferred** |
| 5 | data candidate | `node_66424dbe-90c0-4497-8fe6-f61d01478689` `aggregate` | `libs/common/base-repository/base-repository.ts:258-275` | `calls` (depth 4) | **inferred** — a Mongo aggregation boundary by name only |
| 6 | external boundary | — | — | — | **not proven** — `context.completeness.externalCallCount = 0`; `flow` emits no `external` edge type; the actual driver call is not in the graph |
| 7 | tests | `node_ff666136-a1a6-44ae-9221-20d863c6f391` `apps/promotion/src/modules/growth-task/services/v2-task-report.service.spec.ts` | file node | `relatedTests` | **candidate** — a file-level association, no `covers` edge, no assertion-level linkage |

**Stopped at hop 6.** The chain is honest to hop 5 and stops at the external/data boundary.

**Evidence required to continue past hop 6:** (a) source review of `libs/common/base-repository/base-repository.ts:258-275` to confirm the driver call and the collection name; (b) the Mongoose/Mongo schema binding for `UserTaskCampaign` (`node_5ebc7043-9175-49c0-95c3-fef0f663257c`, `user-task-campaign.schema.ts:42-116`) to resolve the physical collection; (c) runtime evidence — a captured response (`penguin samples <endpoint>`) or an SLS trace — to prove the path executes. None of these is available from the static graph, and Penguin does not claim otherwise.

---

### Q10 — duplicate service labels and cross-repository identity

```
scenario: repeated service display labels, with attention to FPMS-NT-Auth-Player
surface: MCP + CLI
exact command/tool and exact inputs:
  mcp__penguin__knowledge_service_graph {repo: "FPMS-NT"}
  mcp__penguin__knowledge_service_graph {repo: "NO-SUCH-REPO-ROUND18"}
  mcp__penguin__index_status {repo: "FPMS-NT"}
  penguin status --json
  penguin context "node_fd129f7d-..." --repo FPMS-CCMS --json      (cross-scope probe)
bounded raw evidence:
  service_graph -> 20 service nodes, 92 edges. Titles are unique; "FPMS-NT-Auth-Player" appears EXACTLY ONCE,
    nodeId repo_5513e90d-a231-455e-9feb-d15d69e93b38, rootPath /Users/shieng/Desktop/Projects/auth,
    branch aug-30-1825-master, snapshot_0ffdce0e-c540-413b-bd4d-986ab0ece9c5, commit 055c37dd4354...
  service_graph(repo="NO-SUCH-REPO-ROUND18") -> byte-identical full 20-node / 92-edge output, exit ok, NO error
  index_status(repo="FPMS-NT") -> all 20 repositories returned
  cross-scope probe -> {"error":{"code":"SCOPE_MISMATCH","message":"target node_fd129f7d... is outside the requested
    repository scope","retryable":false,"details":{"requestedRepoId":"repo_18c909a4-...","requestedRevisionId":
    "snapshot_141515e3-...","actualRepoId":"repo_a48ec7fb-...","actualRev..."}},"exitCode":1}
elapsed time: service_graph ~1s each ; index_status ~0.6s ; context probe 0.8s
exit/status/error code: 0 / 0 / 0 / 1
repo/branch/snapshot/revision: service_graph emits NONE - no scope, no revision, no freshness, no coverage
freshness: not reported by service_graph
coverage: not reported by service_graph
candidateCount/returnedCount/totalIsExact: not reported by service_graph
cursor/hasMore/truncated: not reported by service_graph
evidence origin/method/confidence: NONE - every one of the 92 edges is a bare {src,dst,edgeType}
dynamic IDs: repo_5513e90d-... , repo_a48ec7fb-... , repo_18c909a4-...
workaround count: 0
verdict: FAIL (identity/usability of the service surface)
confidence: high
```

**Premise contradicted.** There are **no repeated service display labels** in this environment. All 20 service titles are unique; `FPMS-NT-Auth-Player` occurs exactly once, backed by a stable `repoId`, a distinct `rootPath` (`/Users/shieng/Desktop/Projects/auth`), its own branch, snapshot, and commit. There is no duplicate to disambiguate, and none was invented. `penguin status --json` independently confirms 20 repositories with 20 distinct `repoId`s and 20 distinct root paths.

**Two real defects found in the process, both worse than the hypothesised one:**

1. **`repo` scope is a silent no-op on list-shaped surfaces.** `knowledge_service_graph(repo: "FPMS-NT")` returns all 20 repositories. So does `index_status(repo: "FPMS-NT")`. Passing `repo: "NO-SUCH-REPO-ROUND18"` returns **byte-identical full global output with no error** — while `penguin search --repo NO-SUCH-REPO-ROUND18` correctly returns `REPOSITORY_NOT_FOUND`. The same scope parameter is enforced on one capability class and ignored on another, with no warning field to tell them apart. This is what triggers the Product max-69 cap declaration in 3.3.
2. **The service map carries no evidence at all.** `service_graph` returns `{focus, nodes[], edges[]}` and nothing else — no `scope`, `revision`, `freshness`, `coverage`, `completeness`, `proofStatus`, `candidateCount`, or `cursor`, and every edge is a bare `{src, dst, edgeType}` with no origin, method, confidence, or locator. You cannot tell whether `FPMS-NT invokes FPMS-NT-Payment` is an extracted gRPC client call or a package-manifest inference, nor at which revision it was true.

**Stable-ID follow-through: PASS.** Carrying `node_fd129f7d-…` into `context` under the wrong repository produced `SCOPE_MISMATCH` naming both `requestedRepoId` and `actualRepoId` — Penguin refused to silently switch to a same-titled node in another repo. Targeted capabilities are scope-safe; list capabilities are not.

**GUI comparison:** not performed (no GUI session was opened). Recorded as `N/A: GUI not exercised`, not as a pass.

---

### Q11 — file-target versus node-target affected parity

```
scenario: affected with a file target vs the emitted node ID
surface: CLI
exact command/tool and exact inputs:
  penguin affected "apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts" --repo FPMS-NT --json
  penguin affected "node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7" --repo FPMS-NT --json
bounded raw evidence:
  FILE -> changed 4 (node_fd129f7d BalanceCheckHandler / node_04c042fa constructor /
          node_d7a97975 handle / node_8020f049 transferFund), impacted 0, tests 0, routes 0,
          completeness "lower_bound", proofStatus "candidate", candidateCount 4, totalIsExact FALSE,
          coverageGaps null, target null
  NODE -> changed 1 (node_fd129f7d only, with filePath/startLine/endLine), impacted 0, tests 0, routes 0,
          completeness "lower_bound", proofStatus "candidate", candidateCount 0, totalIsExact TRUE,
          coverageGaps ["unresolved_reference_counts_not_persisted"],
          target {"requested":"node_fd129f7d...","nodeId":"node_fd129f7d...","nodeType":"symbol"}
elapsed time: file 4.805s ; node 0.777s
exit/status/error code: 0 / 0
repo/branch/snapshot/revision: identical, snapshot_289e6a29... / 3f0f1984b9e4...
freshness: fresh ; coverage partial
candidateCount/returnedCount/totalIsExact: 4/4/false vs 0/0/true
cursor/hasMore/truncated: neither truncated, no cursor
evidence origin/method/confidence: graph reverse edges; low confidence on the empty impacted set
dynamic IDs: all four node IDs emitted by the FILE call and by `filesymbols`
workaround count: 0
verdict: PARTIAL
confidence: high
```

**Round-trip: PASS.** The node ID emitted by `search` / `filesymbols` was accepted directly by `affected` and echoed back in `target.requested` == `target.nodeId`. No title or path reconstruction was needed anywhere in this evaluation.

**Documented semantic difference.** The file target treats every symbol defined in the file as changed (4 nodes); the node target treats only that symbol as changed (1 node). Both stay inside `repo_a48ec7fb…`. **Neither crossed a repository.** The difference is legitimate but is **not documented in any Penguin help or schema text** — it must be inferred from the results.

**Empty set is not treated as safety, and Penguin says so.** Both report `completeness: "lower_bound"` and `proofStatus: "candidate"`; the node variant additionally surfaces `coverageGaps: ["unresolved_reference_counts_not_persisted"]`.

**Two real defects:**

1. **`impacted: 0` is wrong in substance.** `BalanceCheckHandler` is imported and constructor-injected in `apps/payment/src/payment/withdrawal/services/withdrawal-check.service.ts` (Penguin's own search returned occurrences at lines 7 and 24) and registered in `apps/payment/src/payment/payment.module.ts` (lines 54, 71, 211, 224). `callers`, `calls`, and `impact` on the same node all return `candidateCount: 0`. NestJS DI and interface dispatch edges are absent from the graph. Penguin's `context.completeness.note` names this exact limitation, which makes the behaviour honest — but the blast radius of a withdrawal gate reads as empty.
2. **`totalIsExact: true` with `completeness: "lower_bound"` is self-contradictory.** The node variant asserts an exact total of zero while simultaneously declaring the result a lower bound. `callers`, `calls`, and `impact` do the same, and additionally omit `proofStatus` and `returnedCount` entirely (both `null`), breaking the envelope shape that `search` / `flow` / `affected` honour.

---

### Q12 — coverage debt as actionable evidence

```
scenario: explain and act on FPMS-NT coverage debt using only read-only surfaces
surface: CLI + MCP
exact command/tool and exact inputs:
  penguin coverage --repo FPMS-NT --json
  penguin coverage --repo FPMS-NT --limit 20 --json
  penguin coverage --help
  penguin search "check" --repo FPMS-NT --limit 3 --include-excluded-metadata --json
  (capability input schema for knowledge.coverage, from `penguin capabilities --json`)
bounded raw evidence:
  coverage.status "partial"; discovered 3340; admitted 3333; excluded 7; failed 0; stale 0;
    unresolvedReferences 103958
  items [] ; gaps [] ; nextCursor null ; returnedCount 0 ; candidateCount null ; totalIsExact false ;
    completeness "unknown" ; proofStatus "not_proven"
  `--limit 20` changes nothing: items still []
  `penguin coverage --help` prints: "usage: penguin penguin coverage ..."   (doubled word, no flag list)
  knowledge.coverage inputSchema = {"type":"object","properties":{},"additionalProperties":true}
  `--include-excluded-metadata` is accepted and returns hits, but none is marked excluded
elapsed time: 0.222s / 0.2s / instant / 0.5s
exit/status/error code: all 0
repo/branch/snapshot/revision: repo_a48ec7fb... / brazil-v2 / snapshot_289e6a29... / 3f0f1984b9e4..., trust exact_commit
freshness: fresh, indexed == head, 0 dirty
coverage: as above
candidateCount/returnedCount/totalIsExact: null / 0 / false
cursor/hasMore/truncated: nextCursor null, truncated false
evidence origin/method/confidence: Penguin coverage envelope, high on the aggregates, none on the items
dynamic IDs: none emitted (this is the defect)
workaround count: 3 (limit, help, include-excluded-metadata - all failed to surface an item)
verdict: FAIL (actionability) / PASS (visibility)
confidence: high
```

**The debt, stated precisely.** Of 3340 discovered files, 3333 are admitted, **7 are excluded**, 0 failed, 0 stale, and there are **103,958 unresolved references**. Globally across all 20 repositories the picture is far worse: 47,406 discovered / 30,335 admitted / **17,071 excluded** / 4 failed / **625,497 unresolved references** (from the `tags` and `evidence list` envelopes).

**Attempt to retrieve at least one concrete excluded / stale / unresolved item: FAILED after three attempts.**
- `coverage --repo FPMS-NT --json` gives `items: []`, `gaps: []`, `nextCursor: null`.
- `--limit 20` gives the same.
- `penguin coverage --help` prints a broken stub (`usage: penguin penguin coverage ...`) that documents no flag.
- The canonical `knowledge.coverage` input schema is **empty** (`properties: {}`), so the contract itself publishes no way to request exclusion detail.
- `--include-excluded-metadata` on `search` is accepted but surfaced no item marked excluded.

**Verdict: the coverage debt is "visible but not actionable."** You are told 7 files are excluded and 103,958 references are unresolved; you cannot learn which files, for what reason, of what type, or in what path — from any documented read-only surface.

**Which query classes remain useful despite the debt.**
- Positive, revision-anchored location: `search` (source/symbol/path lanes), `filesymbols`, `endpoints`, `node`, `endpoint-identity`. Every result carries a commit, snapshot, and worktree fingerprint.
- Proven first-hop endpoint-to-handler resolution (`evidenceState: proven`, `EXTRACTED`, confidence 1.0).
- Forward `calls` / `references` traversal via `flow` as an **inferred** skeleton.
- Cross-scope safety: `SCOPE_MISMATCH` reliably blocks cross-repo confusion on targeted calls.

**Which claims are blocked outright.**
- Any "no caller / no test / no route / not used anywhere" claim — 103,958 unresolved references plus unmodelled DI and interface dispatch make every reverse-edge zero a lower bound.
- Any "this endpoint never reaches an external or data boundary" claim — `externalCallCount: 0` with no external edge type modelled.
- Any exhaustive inventory claim — `totalIsExact: false` on all search results.
- Any claim about the 7 excluded files, since they cannot be identified.

---

### Q13 — adversarial negative tri-state

For symbol `node_fd129f7d-…` (`BalanceCheckHandler`) and endpoint `node_34182942-…` (`QueryUserTaskReport`).

| # | Claim | Verdict | Evidence and caveats | Extra evidence needed |
| ---: | --- | --- | --- | --- |
| 1 | No production caller exists for `BalanceCheckHandler` | **not proven** | `callers` / `calls` / `impact` all return `candidateCount: 0` under `completeness: "lower_bound"`. Directly contradicted in substance by Penguin's own source lane, which returns occurrences in `withdrawal-check.service.ts:7,24` and `payment.module.ts:54,71,211,224`. `context.completeness.note` states constructor calls and interface dispatch are not modelled. 103,958 unresolved references. `totalIsExact: true` here is not trustworthy given `lower_bound` | Source review of `withdrawal-check.service.ts` and `payment.module.ts`; a DI-aware or interface-dispatch-aware index pass |
| 2 | No test covers `BalanceCheckHandler` | **not proven** | `affected` (both targets) returns `tests: 0`; `context` returns `tests: []`. But test association elsewhere is file-level only (`flow` on the endpoint returned `relatedTests` as a bare `.spec.ts` **file** node, never a `covers` edge). A zero here means "no modelled test edge", not "no test" | Test-runner coverage output, or source review of `apps/payment/**/withdrawal/**/*.spec.ts` |
| 3 | The endpoint `QueryUserTaskReport` never reaches an external / data boundary | **contradicted** | `flow` reaches `aggregateReportRows` (`user-task-campaign.repository.ts:206-293`) at depth 3 and `aggregate` (`libs/common/base-repository/base-repository.ts:258-275`) at depth 4, plus the Mongoose schema `UserTaskCampaign` (`user-task-campaign.schema.ts:42-116`). A data boundary is reached. Caveat: these are `via: "calls"` with **no** `evidenceState`, and `context.externalCallCount` is 0 because Penguin models no external edge type — so the boundary is contradicted-as-absent but only **inferred** as present | Source review of `base-repository.ts:258-275` to confirm the driver call and collection |
| 4 | The service-label duplicate in Q10 has no effect on query routing | **proven — vacuously** | There is no duplicate label. All 20 service titles are unique with distinct `repoId`s and root paths. Separately, targeted routing was tested directly and is safe: a foreign node under `--repo FPMS-CCMS` produced `SCOPE_MISMATCH` with `requestedRepoId` and `actualRepoId` both named. **Important caveat:** routing safety does **not** extend to `service_graph` and `index_status`, where the `repo` parameter is ignored entirely (Q10) | none for the stated claim; the scope no-op is a separate defect |

---

### Q14 — cursor portability without hidden process state

```
scenario: endpoint, filesymbol, deadcode (and search) pagination across fresh processes
surface: CLI (a new OS process per invocation, by construction)
exact command/tool and exact inputs:
  endpoints:   penguin endpoints FPMS-NT --limit 5 --json  ->  --cursor <p1> (new process)
  filesymbols: penguin filesymbols branch_1d21f868-... "apps/promotion/.../admin-growth-task.controller.ts" --limit 3 --json -> --cursor <p1>
  deadcode:    penguin deadcode --repo FPMS-NT --limit 3 --json -> --cursor <p1>
  search:      penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5 --json -> --cursor <p1> -> --cursor <p2>
  malformed:   --cursor "NOT-A-CURSOR"
  exhausted:   3rd search page -> truncated false, cursor absent
  wrong-op:    the endpoints cursor passed to `penguin search`
bounded raw evidence:
  endpoints   p1 = Create/Delete/GetById/List/PreviewSegmentHitCount ; p2 = QueryUserTaskReport/RequestImportListUploadUrl/
              SetTaskConfigStatus/UpdateTaskConfig/UpdateTestUserIds  - alphabetical by identityKey, no duplicates
  filesymbols p1 = AdminGrowthTaskController / constructor / listTaskConfig ; p2 = getTaskConfigById / createTaskConfig /
              updateTaskConfig - definition order, no duplicates, candidateCount 12
  deadcode    p1 = useFactory / ExternalModule / constructor(payment-external.service) ;
              p2 = GameRepositoryModule / constructor(game-repository) / PlatformAnnouncementRepositoryModule - no duplicates
  search      p1 ranks 1-5, p2 ranks 6-10, p3 ranks 11-13 then exhausted (truncated false, no cursor)
  malformed   -> {"error":{"code":"CURSOR_INVALID","message":"CURSOR_INVALID","retryable":false},"exitCode":2}
  wrong-op    -> {"error":{"code":"CURSOR_INVALID","message":"CURSOR_INVALID","retryable":false},"exitCode":2}
  limit change (5 -> 10 on the same cursor)
              -> {"error":{"code":"CURSOR_STALE","message":"CURSOR_STALE","retryable":false},"exitCode":2}
elapsed time: endpoints p2 5.558s ; filesymbols p2 0.2s ; deadcode p2 ~0.5s ; search p2/p3 <1s
exit/status/error code: 0 on all valid continuations; 2 on all three invalid cursors
repo/branch/snapshot/revision: every page pinned to snapshot_289e6a29...; the cursor payload itself carries
  "revision":"snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3" and an "expiresAt"
freshness: fresh ; coverage partial
candidateCount/returnedCount/totalIsExact: endpoints 610/5/TRUE ; filesymbols 12/3/TRUE ;
  deadcode 5647/3/TRUE (p1) then 5644 (p2) ; search 13/5/false
cursor/hasMore/truncated: signed, scope-bound, ordering-key-bound, expiring
evidence origin/method/confidence: Penguin cursor payloads decoded from their own base64 header, high
dynamic IDs: all node IDs above emitted this session
workaround count: 0 - no offset or title was ever reconstructed by hand
verdict: PASS
confidence: high
```

**All four cursor surfaces are portable across fresh OS processes.** No continuation required reconstructing an offset or a title. Ordering is stable and duplicate-free on every surface. Cursors are signed and self-describing: the endpoints cursor payload decodes to `{"schemaVersion":"1","contractVersion":"2","operation":"endpoints","scope":"repo_a48ec7fb…|branch_1d21f868…|*|identityKey,nodeId","orderingKey":"identityKey,nodeId","lastKey":"…","revision":"snapshot_289e6a29…","expiresAt":"2026-08-30T23:42:03.716Z"}`, and the search cursor additionally carries `queryHash`, `normalizedRequestHash`, `scopeHash`, `mode`, `lanes`, `lastRank`, `lastHitId`, and `capabilityHash`. This is a genuinely strong design.

**Three defects:**

1. **`CURSOR_STALE` is the wrong code for a changed request.** Continuing the same cursor with `--limit 10` instead of `--limit 5` yields `CURSOR_STALE`. Nothing is stale — the revision is unchanged and the cursor is unexpired; the `normalizedRequestHash` simply differs. The correct signal would be `CURSOR_REQUEST_MISMATCH`.
2. **`CURSOR_STALE` and `CURSOR_INVALID` carry no `details` and no `remediation`,** unlike `UNKNOWN_OPTION`, `TARGET_NOT_FOUND`, `REPOSITORY_NOT_FOUND`, `INVALID_TARGET`, `SCOPE_MISMATCH`, and `TARGET_AMBIGUOUS`, all of which do. The `message` is a bare repeat of the `code`.
3. **A wrong-operation cursor is reported as `CURSOR_INVALID`, not as a scope mismatch.** Passing an `endpoints` cursor to `search` is rejected — correctly — but the error does not say that the cursor belongs to a different operation, even though the cursor payload contains `"operation":"endpoints"` in plaintext.

Minor: `deadcode` `candidateCount` **decrements** across pages (5647 to 5644) while `totalIsExact: true`, so the "total" is actually a remaining count.

---

### Q15 — typed-error discrimination

All ten cases triggered without mutation.

| # | Case | Command | Exit | Code | Human message | Retryable | Remediation | Verdict |
| ---: | --- | --- | ---: | --- | --- | --- | --- | --- |
| 1 | Missing target | `penguin context "ZZZ_NoSuchSymbol_R18" --repo FPMS-NT --json` | 1 | `INVALID_TARGET` | `target was not found: ZZZ_NoSuchSymbol_R18` | false | `run penguin search to find a current target ID` | **PASS** — also returns a full `locator` block |
| 2 | Empty query | `penguin search "" --repo FPMS-NT --json` | 2 | `INVALID_QUERY` | `search requires a non-empty query` | false | `provide a non-empty search query` | **PASS** |
| 3 | Unknown repository (search) | `penguin search "BalanceCheckHandler" --repo NO-SUCH-REPO-ROUND18 --json` | 2 | `REPOSITORY_NOT_FOUND` | `unknown repo: NO-SUCH-REPO-ROUND18` | false | `run 'penguin status --json' and choose an indexed repository` | **PASS** |
| 3b | Unknown repository (coverage) | `penguin coverage --repo NO-SUCH-REPO-ROUND18 --json` | 2 | — | plain text `unknown repo: NO-SUCH-REPO-ROUND18` | — | none | **FAIL** — not JSON despite `--json` |
| 3c | Unknown repository (endpoints) | `penguin endpoints NO-SUCH-REPO-ROUND18 --json` | 2 | — | plain text `no indexed repo matches "NO-SUCH-REPO-ROUND18"` | — | none | **FAIL** — not JSON despite `--json` |
| 3d | Unknown repository (MCP service_graph) | `knowledge_service_graph {repo:"NO-SUCH-REPO-ROUND18"}` | ok | — | **no error at all** | — | — | **FAIL** — silently returns the full global map |
| 4 | Ambiguous target | `penguin context "handle" --repo FPMS-NT --json` | 1 | `TARGET_AMBIGUOUS` | `target is ambiguous: handle` | false | `details.candidates[]` with `nodeId`, `nodeType`, `identityKey` (e.g. `node_22e37e2b-abf0-4fe7-bb2d-4685b8f4de11`, identityKey `repo_a48ec7fb…::field::apps/livechat/src/grpc-logger.ts::next::handle`) | **PASS** — best-in-class |
| 5 | Invalid node ID | `penguin context "node_00000000-0000-0000-0000-000000000000" --repo FPMS-NT --json` | 1 | `INVALID_TARGET` | `target was not found: node_0000…` | false | `run penguin search to find a current target ID` | **PASS** |
| 5b | Invalid node ID (via `node`) | `penguin node "node_34182942-61ef-40a1-82b8-DEADBEEF" --repo FPMS-NT --json` | 1 | — | plain text `no node found for "…" — not indexed, or the name doesn't match any symbol/note title or qualified name` | — | none | **FAIL** — not JSON despite `--json` |
| 6 | Wrong-repository node ID | `penguin context "node_fd129f7d-…" --repo FPMS-CCMS --json` | 1 | `SCOPE_MISMATCH` | `target node_fd129f7d… is outside the requested repository scope` | false | `details` names `requestedRepoId`, `requestedRevisionId`, `actualRepoId`, `actualRevisionId` | **PASS** — best-in-class |
| 7 | Malformed cursor | `penguin search … --cursor "NOT-A-CURSOR" --json` | 2 | `CURSOR_INVALID` | `CURSOR_INVALID` | false | **none** | **PARTIAL** — typed but bare |
| 8 | Wrong-scope / wrong-operation cursor | endpoints cursor passed to `penguin search` | 2 | `CURSOR_INVALID` | `CURSOR_INVALID` | false | **none** | **PARTIAL** — does not say the cursor is for another operation |
| 8b | Stale-request cursor | same cursor with `--limit 10` | 2 | `CURSOR_STALE` | `CURSOR_STALE` | false | **none** | **PARTIAL** — misleading code |
| 9 | Invalid endpoint identity | `penguin endpoint-identity <3 corrupted forms> --repo FPMS-NT --json` | 1 | `TARGET_NOT_FOUND` | `endpoint identity could not resolve any supplied form` | false | `use 'penguin endpoints --json' to copy an indexed endpoint identity`; `details.forms[]` marks each form `no_match` | **PASS** |
| 10 | Unsupported semantic mode | `penguin search "…" --repo FPMS-NT --mode semantic --json` | **0** | — | **no error**; `queryStatus: "NO_MATCH_INCOMPLETE"`, `searchedLanes: []`, `skippedLanes: [{"lane":"semantic","reason":"async_semantic_lane_required"}]` | — | none | **PARTIAL** — the skipped lane is disclosed, but an unsupported mode returns success |
| bonus | Unknown option | `penguin search "…" --mode "path" --repo FPMS-NT` (quoted as one token) | 2 | `UNKNOWN_OPTION` | `unknown option --mode path` | false | `run 'penguin help --json' or '<command> --help' for the accepted grammar` | **PASS** |
| bonus | Missing required args | `penguin endpoint-identity` (no args) | 2 | — | `endpoint-identity needs at least rendered title and canonical identity` on stderr | — | — | **PARTIAL** — correct exit, unstructured |
| bonus | Bad MCP page.limit | `knowledge_search {limit: 5}` (wrong shape) | err | `INVALID_SEARCH_REQUEST` | `request.page.limit must be an integer from 1 to 200` | false | `details.path = "request.page.limit"` | **PASS** |

**Does `no_match` hide invalid / ambiguous / scope / stale / unavailable cases?** **Mostly no — with one exception.** Invalid, ambiguous, scope, and cursor cases all receive distinct typed codes rather than an empty result. The exception is **case 10**: an unavailable retrieval lane is reported as `NO_MATCH_INCOMPLETE` with exit 0. It is not silent — `skippedLanes` names the lane and the reason — but it is classified as "no match" rather than "unavailable".

**Systemic defect:** four surfaces (`coverage`, `endpoints`, `node` on the CLI; `knowledge_service_graph` on MCP) bypass the typed-error contract entirely despite `--json`. The core query paths are excellent; the periphery is not.

---

### Q16 — Wiki / API knowledge freshness boundary

```
scenario: enumerate and read Wiki/API knowledge objects, check provenance and staleness
surface: CLI
exact command/tool and exact inputs:
  penguin api-doc list --json ; penguin api-doc show "<previewId>" --json
  penguin note list --json ; penguin tags --json ; penguin evidence list --json
  penguin suggestions --json ; penguin snapshots --json
bounded raw evidence:
  api-doc list -> 2 items, both mode "preview", coverage "partial",
    evidenceState "stale", proofStatus "not_proven", gaps ["preview_revision_stale"],
    revisionIds [] , subjects [] , sourceCommits {} , protectedBy [] ,
    createdAt == updatedAt 2026-07-18T10:11:26.829Z / 2026-07-18T10:11:40.115Z,
    currentRevisionIds = all 20 repo:snapshot pairs including
      "repo_a48ec7fb-...:snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3"
    envelope also carries unreadableCount / unreadable / scope / revision / freshness / coverage / gaps
  note list  -> 1 item "Redis ClusterAllFailedError" (redis-clusterallfailederror.md),
    nodeId null, revision null, scope.repoId null, timestamp 2026-07-12T03:59:08.553Z,
    sensitivity "normal", permission.mcpAccess "allowed", provenanceGaps ["index_node_unavailable"]
  tags        -> items [] , gaps ["revision_provenance_unavailable","tag_item_provenance_in..."]
  evidence    -> items [] , gaps ["revision_provenance_unavailable"]
  suggestions -> BARE ARRAY, 1 item: {"edgeId":"edge_led_e7b633c9-...","src":"MCP Wiki Test Page",
                 "dst":"materialize","edgeType":"mentions","confidence":0.7,
                 "suggestionEventId":"led_e7b633c9-b2d9-4d3f-bf5f-4d8f3955f236"}
  snapshots   -> BARE ARRAY, empty []
elapsed time: api-doc list 0.193s ; show 0.2s ; note list 0.236s ; tags 0.510s ; evidence 0.242s ;
  suggestions 3.648s ; snapshots 0.236s
exit/status/error code: all 0
repo/branch/snapshot/revision: api-doc anchors to currentRevisionIds; notes/tags/evidence anchor to NOTHING
freshness: "unknown" on note/tags/evidence ; api-doc explicitly "stale"
coverage: global 47406/30335/17071/4, unresolvedReferences 625497
candidateCount/returnedCount/totalIsExact: api-doc 2/2 ; note 1/1 ; tags 0/0/true ; evidence 0/0/true
cursor/hasMore/truncated: nextCursor null everywhere, nothing truncated
evidence origin/method/confidence: suggestion confidence 0.7 (the only confidence score in this surface)
dynamic IDs: preview:v1:0f638a792d12e21e9851f49a4bed76c3:a117288688ad59388f308b82aa30755b (read back)
workaround count: 0
verdict: PARTIAL
confidence: high
```

**Object read: `preview:v1:0f638a792d12e21e9851f49a4bed76c3:a117288688ad59388f308b82aa30755b` — "API Documentation - FrontendRegisterService".**

| Attribute | Value | Assessment |
| --- | --- | --- |
| Source | `documentKey: api-doc:v1:frontend:zh-cn:fe127642794cb0d0` | present |
| Author / type | `mode: "preview"`; no author field | **missing author** |
| Scope | `subjects: []` | **missing** — bound to no node |
| Revision | `revisionIds: []`, `sourceCommits: {}` | **missing** — the preview never recorded what it was generated from |
| Freshness | `evidenceState: "stale"`, `proofStatus: "not_proven"`, `gaps: ["preview_revision_stale"]`, plus 20 `currentRevisionIds` | **excellent** |
| Generated / manual | `mode: "preview"` distinguishes generated previews from bound documents | present |
| Sensitive / redaction | absent on api-doc; **present on notes** (`sensitivity: "normal"`, `permission.mcpAccess: "allowed"`) | inconsistent |
| Backlinks | not returned by `show`; `penguin backlinks <node>` exists but the preview has no node | **not reachable** |

**Is a stale note clearly separated from current code truth? YES — this is the strongest result in the Wiki surface.** A 44-day-old preview is marked `evidenceState: "stale"` with `proofStatus: "not_proven"`, an explicit `gaps: ["preview_revision_stale"]`, and the full list of current revision IDs so the drift is measurable. Nothing generated in July is presented as current. Notes are equally careful: the one indexed note declares `provenanceGaps: ["index_node_unavailable"]` rather than pretending to be graph-anchored, and `tags` / `evidence list` both declare `revision_provenance_unavailable`.

**Provenance gaps that reduce the score:**
1. `revisionIds: []` and `sourceCommits: {}` — you can learn that a preview is stale but never *what it was generated from*, so no diff against current truth is possible.
2. `subjects: []` — no binding to any node, so an API doc cannot be reached from the code it documents, nor vice versa.
3. `penguin suggestions` returns a **bare array with no envelope** — no scope, revision, freshness, coverage, or completeness — and identifies its edge endpoints by **title strings** rather than node IDs. This is the one place in the whole product where an emitted identifier is not round-trippable.
4. `penguin snapshots` returns a bare `[]` even though every one of the 20 repositories reports a live `snapshotId`, and `doctor` reports 748,840 nodes. Either the snapshot manifest surface is unimplemented or it silently reports nothing.
5. No author, no sensitivity, and no redaction metadata on api-doc objects, though notes have all three.

Nothing was created, updated, exported, synced, bound, deleted, or repaired.

---

### Q17 — runtime-generation two-session replay

```
scenario: Agent A records a packet, Agent B replays it in a new session
surface: MCP (Agent A) + CLI (Agent B, fresh OS processes)
verdict: PARTIAL - CLI half PASS, second MCP session NOT ACHIEVED
confidence: high
```

**Agent A packet (recorded this session):**

| Item | Value |
| --- | --- |
| MCP initialize / health | `status ok`, `initializeHealthy true`, `clientRestartRequired false`, `runtimeOutdated false` |
| Server generation | `runningBuildId 1.16.0-caf621d03b0402b6`, `availableBuildId 1.16.0-caf621d03b0402b6`, `outdated false` |
| tools/list | 81 `mcp__penguin__*` tools exposed to this client (manifest advertises 99 names) |
| Capability hash | `40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0` |
| Schema / contract | `schemaVersion 15`, `contractVersion "2"` |
| Search node ID | `node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7` (`BalanceCheckHandler`) |
| Structured error | `SCOPE_MISMATCH` on `context node_fd129f7d-… --repo FPMS-CCMS` |

**Agent B replay: the second genuinely new MCP session was NOT achieved.** This evaluation ran inside a single Claude Code process holding one persistent stdio MCP connection to the Penguin server. Closing and reopening that connection requires a client restart or MCP reconfiguration, both of which Brief section 1 explicitly forbids. Recorded as **`SECOND_MCP_SESSION_NOT_ACHIEVED`**, not as a pass, and scored accordingly (10/20 on the Fresh two-session dimension). Re-calling the MCP tools inside the same connection would be a same-session repeat and is **not** claimed as a second session.

**What was proven instead — CLI generation replay across genuinely new OS processes.** Every `penguin` invocation forks a new process; three were spawned with observed distinct PIDs (83288, 83290, 83292) to make this explicit. Replaying Agent A's packet through fresh processes:

| Replay step | Input (Agent A packet only) | Result |
| --- | --- | --- |
| Build/hash continuity | `penguin capabilities --json` in a fresh process | `buildId 1.16.0-caf621d03b0402b6`, `capabilityHash 40ae9528…4487d0` — identical to the MCP-reported generation |
| Node continuity | `penguin context node_34182942-… --repo FPMS-NT` | resolved, `target: "node:node_34182942…"`, `snapshot_289e6a29…` |
| Graph continuity | `penguin flow grpc::AdminGrowthTaskController.queryusertaskreport --repo FPMS-NT` | 29 steps, root `node_34182942…`, hop 1 `node_865365a4…` `handles` `proven` — identical to the MCP flow |
| Blast-radius continuity | `penguin affected node_fd129f7d-… --repo FPMS-NT` | changed 1, impacted 0, `lower_bound`, `coverageGaps ["unresolved_reference_counts_not_persisted"]` |
| Cursor continuity | Agent A's endpoints page-1 cursor | page 2 returned, first item `node_34182942…` — identical to Agent A's page 2 |
| Error shape continuity | `context node_fd129f7d-… --repo FPMS-CCMS` | `SCOPE_MISMATCH`, `retryable false`, `actualRepoId repo_a48ec7fb-…` — identical |
| Remediation applied | `context node_fd129f7d-… --repo FPMS-NT` | resolved, `target: "node:node_fd129f7d-…"` |

**Manual repairs: 0. Substituted identifiers: 0. Configuration presence is not used as reload proof anywhere in this section.**

---

### Q18 — timeout and latency honesty

Three runs per operation, each in a fresh CLI process. Median (of 3) and maximum observed:

| Operation | Cold (first observed) | Run 1 / 2 / 3 (ms) | Median | Max |
| --- | ---: | --- | ---: | ---: |
| `capabilities` | 104 | 93 / 92 / 89 | **92** | 93 |
| Scoped search | 2753 | 2584 / 946 / 2417 | **2417** | 2584 |
| Endpoint page | 6617 | 2670 / 909 / 683 | **909** | 2670 |
| `context` | 783 | 783 / 759 / 804 | **783** | 804 |
| `flow` | 10909 | 3654 / 3342 / 3215 | **3342** | 3654 |
| `affected` | 4805 | 3990 / 1904 / 2880 | **2880** | 3990 |
| `doctor` | 6199 | 5364 / 4021 / 4093 | **4093** | 5364 |
| Semantic / blend query | 343 | 532 / 318 / 323 | **323** | 532 |
| `onboarding` (single run) | 12560 | — | — | 12560 |
| `suggestions` (single run) | 3648 | — | — | 3648 |

**Cold-vs-warm penalty is large and real:** `flow` 10.9s cold to 3.3s warm (3.3x); endpoints 6.6s cold to 0.9s warm (7.3x); `affected` 4.8s to 2.9s. `capabilities` and `context` are consistently fast. `onboarding` at 12.6s is the slowest single operation measured and is the first command a new agent runs.

**Timeout behaviour: `N/A — no timeout occurred`.** `queryRuntime.hardTimeoutMs = 30000` with `workers: 2`. The slowest observed operation used 42% of that budget. No operation was forced to time out, because forcing one would require mutation or configuration change, which Brief section 1 forbids. Therefore **whether a timeout preserves `timedOut`, exit status, partial evidence, and a safe retry path is `not proven` in this run** — it is neither credited nor penalised. What *is* observable: no operation returned an empty successful graph result in place of a slow one, and every long call (`flow` 10.9s, `onboarding` 12.6s) completed with a full, correctly-populated envelope. `doctor` reports `verify: false`, indicating the deep verification pass is not part of the 4.1s cost.

---

### Q19 — agent-to-agent investigation packet

**Packet handed to Agent B (current Penguin output only):**

```
repo:      FPMS-NT / repo_a48ec7fb-5987-47df-9198-06969359cb50
branch:    brazil-v2 / branch_1d21f868-3252-4b74-8289-8f7c4735247f
revision:  commit 3f0f1984b9e4337668529a13bad5264501729908
           snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3
           worktreeFingerprint 073264f852ac84af18fb68cb22b56c5bdb3801e578c69510f638e13a0b0544c5
           trust exact_commit ; freshness fresh ; dirtyFileCount 0
coverage:  partial - 3340 discovered / 3333 admitted / 7 excluded / 0 failed / 0 stale
           103958 unresolvedReferences
Q5 symbol: node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7  BalanceCheckHandler
           apps/payment/src/payment/withdrawal/checks/handlers/balance.check.ts:23
Q7 endpoint: node_34182942-61ef-40a1-82b8-720902e799ba
           identityKey grpc::AdminGrowthTaskController.queryusertaskreport
Q7 handler:  node_865365a4-384c-4150-a9c0-374dc6d92386  queryUserTaskReport
           apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts:230-241
cursor:    the endpoints page-1 nextCursor (signed; scope repo_a48ec7fb...|branch_1d21f868...;
           orderingKey identityKey,nodeId; revision snapshot_289e6a29...)
proven edge:      node_34182942... --handles--> node_865365a4...
                  evidenceState proven, method EXTRACTED, confidence 1, scope revision
inferred/unresolved boundary:
                  node_ca45eae1-92c2-4546-8c1f-257de6d200f8 aggregateReportRows
                  -> node_66424dbe-90c0-4497-8fe6-f61d01478689 aggregate
                     (libs/common/base-repository/base-repository.ts:258-275)
                  via "calls", NO evidenceState, NO edgeEvidence - inferred, not proven
typed error + remediation:
                  SCOPE_MISMATCH - "target node_fd129f7d... is outside the requested repository scope"
                  details.requestedRepoId repo_18c909a4-... ; details.actualRepoId repo_a48ec7fb-...
                  remediation: re-issue with --repo FPMS-NT
exact next commands:
  penguin context  node_34182942-61ef-40a1-82b8-720902e799ba --repo FPMS-NT --json
  penguin flow     grpc::AdminGrowthTaskController.queryusertaskreport --repo FPMS-NT --json
  penguin affected node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7 --repo FPMS-NT --json
  penguin endpoints FPMS-NT --limit 5 --cursor "<cursor>" --json
  penguin callers  node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7 --repo FPMS-NT --json
```

**Agent B replay result (fresh OS processes; PIDs 83288 / 83290 / 83292 observed):**

| Replay | Outcome | Manual repairs |
| --- | --- | ---: |
| `context` by node ID | resolved, `target "node:node_34182942…"`, `snapshot_289e6a29…`, `completeness.status "lower_bound"` with the interface-dispatch note | 0 |
| `flow` by identityKey | 29 steps, root and hop-1 node IDs identical to Agent A, hop 1 `handles`/`proven` | 0 |
| `affected` by node ID | changed 1, impacted 0, `lower_bound`, `coverageGaps ["unresolved_reference_counts_not_persisted"]` | 0 |
| Cursor continuation | page 2 first item `node_34182942…` `gRPC AdminGrowthTaskController.QueryUserTaskReport` | 0 |
| Negative audit | `callers` = 0 candidates under `lower_bound`, correctly reported as **not proven**, not as absence | 0 |
| Error remediation | `SCOPE_MISMATCH` reproduced with identical `details`; applying the remediation resolved the target | 0 |

**Total manual repairs: 0. Substituted identifiers: 0.** Every identifier in the packet round-tripped. Caveat: Agent B ran in fresh **OS processes**, not a fresh **MCP session** (see Q17).

---

### Q20 — installed, configured, loaded, and useful are four different claims

| Claim | Verdict | Current-session observation that supports it (and nothing else) |
| --- | --- | --- |
| **1. Installed** | **PROVEN** | `which penguin` gives `/Users/shieng/.local/bin/penguin`; the file exists (179 bytes, mtime Aug 30 12:47) and `penguin capabilities --json` returns `buildId 1.16.0-caf621d03b0402b6`. This is proven **only** by the launcher responding — no DMG, app bundle, or release artifact was observed, and none is claimed. |
| **2. Configured** | **PROVEN** | `mcp_health` returns `configPath: /Users/shieng/.penguin/config.json` and the MCP server named `penguin` appears in this client's tool list with 81 callable tools. This proves configuration points at a Penguin server; it proves nothing about which build that server loaded. |
| **3. Loaded** | **PROVEN for MCP, PROVEN for CLI, each independently** | MCP: `mcp_health.serverGeneration.runningBuildId = 1.16.0-caf621d03b0402b6` with `availableBuildId` identical and `outdated: false`, returned by a live call in this process. CLI: `penguin capabilities --json` in fresh processes returns the same `buildId` and the same `capabilityHash 40ae9528…4487d0`. Both surfaces were exercised by real calls, not read from configuration. **Caveat:** this is loaded-ness of *this* MCP connection; the second-session reload proof required by Q17 was not achieved. |
| **4. Useful** | **PARTIAL** | Useful: from a cold start with no prior knowledge, this session located the withdrawal decision point (`WithdrawalCheckService.runChecks`, `node_b10e39c8-…`) and its single caller (`initiateWithdrawal`, `node_85c5afc5-…`); reconstructed a 5-hop endpoint-to-data-boundary chain with a proven first hop; carried IDs and cursors across processes with zero repairs; and received honest `lower_bound` / `not_proven` / `COVERAGE_INCOMPLETE` labels on every weak result. Not useful: the business-intent query returned 0 results; the exact-identifier query ranked its own symbol last of 13; the blast radius of a withdrawal gate reads as empty because DI and interface dispatch are unmodelled; and the coverage debt cannot be enumerated. |

**No verdict above is used as proof of another.** Installed does not imply configured; configured does not imply loaded (the `runningBuildId` call is what proves loaded); loaded does not imply useful (usefulness is judged only from answered engineering questions).

---

## 5. B1–B8 end-to-end workflows

### B1 — cold production-symptom triage

> *"A withdrawal or payout-related operation is not progressing in FPMS-NT."*

**Executed sequence, no prior knowledge, no source reads:**

1. `penguin status --json` gives FPMS-NT, brazil-v2, `stale: false`, `worktreeState: clean`, indexed == head at `3f0f1984b9e4…`. **Index is trustworthy.**
2. `penguin coverage --repo FPMS-NT --json` gives `partial`, 7 excluded, **103,958 unresolved references**. **No absence claim permitted from this point.**
3. `penguin search "withdrawal payout approval decision" --repo FPMS-NT --json` gives **0 results.** First dead end.
4. `penguin search "withdrawal" --repo FPMS-NT --json` gives 445 candidates, top hits are config/admin noise. Second weak result.
5. `penguin search "apps/payment/src/payment/withdrawal/checks" --mode path --repo FPMS-NT --json` gives **7 files**, the real gate directory. **Breakthrough — via the path lane, not the concept lane.**
6. `penguin filesymbols <branchId> "apps/payment/src/payment/withdrawal/services/withdrawal-check.service.ts" --json` gives `WithdrawalCheckService` (`node_93ffec7e-4fb7-4775-b037-b4595d0002b6`), `runChecks:39` (`node_b10e39c8-…`), `runChecksWithLock:45` (`node_a9a89493-…`).
7. `penguin callers node_b10e39c8-… --repo FPMS-NT --json` gives 1 candidate: `initiateWithdrawal`, `apps/payment/src/payment/withdrawal/processor/withdrawal-initiate-processor.ts` (`node_85c5afc5-…`).
8. `penguin flow node_b10e39c8-… --repo FPMS-NT --json` gives 15 steps, `completeness: partial`, `proofStatus: not_proven`, `relatedTests: []`. **The six check handlers do not appear** — interface dispatch, exactly as `context.completeness.note` warns.

**Likely code entry points (candidates, not causes):**

| Entry point | Node ID | Locator |
| --- | --- | --- |
| `initiateWithdrawal` | `node_85c5afc5-89b1-433b-8a36-f41f4d20b39f` | `apps/payment/src/payment/withdrawal/processor/withdrawal-initiate-processor.ts` |
| `WithdrawalCheckService.runChecks` | `node_b10e39c8-1399-4856-9904-d23bab2e08e6` | `withdrawal/services/withdrawal-check.service.ts:39` |
| `WithdrawalCheckService.runChecksWithLock` | `node_a9a89493-60e2-46a0-a9a4-aff60cd498de` | `withdrawal/services/withdrawal-check.service.ts:45` — **name implies a lock; a stuck withdrawal is a lock-contention hypothesis** |
| `BalanceCheckHandler.handle` / `.transferFund` | `node_d7a97975-…` / `node_8020f049-…` | `withdrawal/checks/handlers/balance.check.ts:33` / `:85` |
| `PropersoalCheckHandler.validateDailyWithdrawal` | `node_ae47e822-e56e-4f66-bed3-a075ef1510b3` | `withdrawal/checks/handlers/proposal.check.ts:53` |
| `PropersoalCheckHandler.validatePaymentInfoUpdatePending` | `node_ce663561-f1fb-4f10-9785-ec1aa3034976` | `withdrawal/checks/handlers/proposal.check.ts:83` — **"pending" is a strong stuck-state candidate** |
| `PaymentTypeCheckHandler.validateTurnOffWithdrawal` | `node_1d4237a0-6de9-4857-87db-1e22bde20bb5` | `withdrawal/checks/handlers/payment-type.check.ts:54` |
| `PaymentTypeCheckHandler.validateBankTypeMaintenance` | `node_64dd1847-b8a6-4700-b02e-ae61a1dda86b` | `payment-type.check.ts:107` — **maintenance flags block withdrawals** |
| `WithdrawalBankCheckHandler.validateWithdrawalInfo` | `node_3475e45e-00d0-4489-a19c-2d286c93e086` | `withdrawal-bank.check.ts:37` |

**Evidence frontier — everything below this line requires source, logs, or runtime:**
- Which of the six handlers actually ran, and in what order — `runChecks` dispatches through the `WithdrawalCheckHandler` interface; the graph contains no edge from `runChecks` to any handler.
- Whether `runChecksWithLock` is holding or waiting on a lock — no lock/mutex/Redis edge is modelled.
- Which check rejected — requires logs.
- Whether an external payment provider timed out — `context.externalCallCount: 0`; no external edge type exists.

**Next actions:**
1. Read `withdrawal-check.service.ts:39-60` to enumerate the handler list and the lock mechanism.
2. Read `proposal.check.ts:83-120` (`validatePaymentInfoUpdatePending`) — highest-prior stuck-state candidate.
3. Read `payment-type.check.ts:54-130` for the maintenance/turn-off flags.
4. Pull logs for `initiateWithdrawal` and correlate with the six handler names.
5. Check the runtime config/Vault flags the maintenance validators read — not indexed.

**No root cause is claimed.**

---

### B2 — dynamic gRPC request investigation memo

**Target (Section 3, index 0 of page 2):** `node_34182942-61ef-40a1-82b8-720902e799ba` — gRPC `AdminGrowthTaskController.QueryUserTaskReport`, `identityKey grpc::AdminGrowthTaskController.queryusertaskreport`, `apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts:230-241`.

**Revision:** `repo_a48ec7fb-…` / `brazil-v2` / commit `3f0f1984b9e4…` / `snapshot_289e6a29-…` / `trust: exact_commit` / freshness `fresh`.

| Hop | Node ID | Symbol | Locator | Edge origin | Status |
| ---: | --- | --- | --- | --- | --- |
| 0 | `node_34182942-61ef-40a1-82b8-720902e799ba` | endpoint | controller `:230-241` | `root` | proven (inventory + graph, `handlerStatus: handled`) |
| 1 | `node_865365a4-384c-4150-a9c0-374dc6d92386` | `queryUserTaskReport` | controller `:230-241` | `handles`, `EXTRACTED`, confidence 1.0, scope `revision`, provenance = controller file | **proven** |
| 2 | `node_f62426e4-1ca8-4eb0-b72e-5210b2a0ff06` | `decodeQueryUserTaskReportReq` | `transformers/admin-growth-task.transformer.ts:261-285` | `calls`, no evidenceState | inferred |
| 2 | `node_f1e90f30-8154-45dd-82ff-118d7d04c785` | `query` | `services/v2-task-report.service.ts:112-156` | `calls`, no evidenceState | inferred |
| 2 | `node_7947cb6d-f0b1-40a8-8c7b-64a8fd1e73cb` | `encodeReportRow` | `transformer.ts:336-360` | `calls` | inferred |
| 3 | `node_ca45eae1-92c2-4546-8c1f-257de6d200f8` | `aggregateReportRows` | `repositories/user-task-campaign.repository.ts:206-293` | `calls` | inferred |
| 3 | `node_5ebc7043-9175-49c0-95c3-fef0f663257c` | `UserTaskCampaign` (schema) | `repositories/user-task-campaign.schema.ts:42-116` | `references` | inferred |
| 4 | `node_66424dbe-90c0-4497-8fe6-f61d01478689` | `aggregate` | `libs/common/base-repository/base-repository.ts:258-275` | `calls` | inferred — **service boundary reached** |
| 5 | `node_b38eac89-6c43-4aec-ba79-d980676d00d1` | `async` | `libs/common/common.ts:754-788` | `calls` | inferred — a poorly-named node, likely an anonymous wrapper |
| — | external / driver | — | — | — | **not proven** |
| tests | `node_ff666136-a1a6-44ae-9221-20d863c6f391` | `v2-task-report.service.spec.ts` | file node | `relatedTests` | candidate (file-level only) |

**Incompleteness, stated plainly.** `completeness: partial`, `proofStatus: not_proven`, `candidateCount 29`, `truncated false`. Of 29 steps, **1 carries edge evidence and 28 do not**. `via` distribution: `references` 15, `calls` 12, `handles` 1, `root` 1. Depth distribution: d0 x1, d1 x1, d2 x4, d3 x7, d4 x10, d5 x6. Note that **15 of 29 steps are `references` (type usage), not execution** — a "linear execution chain" that is majority type-references overstates its own name.

**Source review required before acting:** (1) `base-repository.ts:258-275` to confirm the Mongo driver call and collection; (2) `v2-task-report.service.ts:112-156` for the actual query shape; (3) `admin-growth-task.controller.ts:230-241` for auth/authorization guards, which are **not modelled at all** — no guard, interceptor, or decorator edge appears anywhere in the flow.

---

### B3 — safe-change decision for `BalanceCheckHandler`

| Evidence class | Result | Source |
| --- | --- | --- |
| Callers (node) | 0 candidates, `completeness: lower_bound`, `totalIsExact: true` | `penguin callers node_fd129f7d-…` |
| Callers (by name) | 0 candidates; resolved to the same node | `penguin callers BalanceCheckHandler` |
| Callers of `handle` method | 0 candidates | `penguin callers node_d7a97975-…` |
| Callees | 0 candidates, `lower_bound` | `penguin calls node_fd129f7d-…` |
| Impact | 0 candidates, `lower_bound` | `penguin impact node_fd129f7d-…` |
| Affected (file) | changed 4, impacted 0, tests 0, routes 0 | `penguin affected balance.check.ts` |
| Affected (node) | changed 1, impacted 0, tests 0, routes 0, `coverageGaps ["unresolved_reference_counts_not_persisted"]` | `penguin affected node_fd129f7d-…` |
| Tests | `[]` on every surface; `flow` on `runChecks` returns `relatedTests: []` | multiple |
| Routes | `[]` | `affected` |
| Contradicting evidence from the source lane | occurrences in `withdrawal-check.service.ts:7,24` and `payment.module.ts:54,71,211,224` | `penguin search "WithdrawalCheck"` / `"BalanceCheckHandler"` |
| Revision | `snapshot_289e6a29-…`, `exact_commit`, fresh | all |

### Decision: **NO-GO**

Not `CONDITIONAL` — **NO-GO**, and the reasons are cumulative:

1. **A critical edge class is missing, not merely partial.** The graph reports zero callers for a class that Penguin's own source lane shows being imported and DI-registered in two files. NestJS constructor injection and interface dispatch are unmodelled (`context.completeness.note` says so explicitly). The blast radius is not small — it is invisible.
2. **Zero test coverage is visible for a money-movement gate.** `tests: []` everywhere, including on the orchestrating `runChecks`. Whether that means "untested" or "test edges unmodelled" is itself unresolved — and either answer forbids an unconditional GO.
3. **Coverage is partial with 103,958 unresolved references** and 7 unidentifiable excluded files.
4. **`BalanceCheckHandler.transferFund` (`node_8020f049-…`, `balance.check.ts:85`) moves funds** and has no visible caller, no test, and no impact set.

The only thing not blocking is revision integrity: the index is fresh, clean, and pinned to `3f0f1984b9e4…`.

**To convert NO-GO to CONDITIONAL:** read `withdrawal-check.service.ts` to enumerate the handler registration list; read `payment.module.ts:54,71,211,224` for the DI provider wiring; locate and run the withdrawal check test suite; confirm whether `transferFund` is reachable from production paths or is dead.

---

### B4 — semantic recall honesty

| Question | Type | Command | Result |
| --- | --- | --- | --- |
| "BalanceCheckHandler" | exact | `penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5` | 13 candidates; the symbol node ranks **13/13** |
| "where do we decide if a withdrawal can proceed" | conceptual | `penguin search … --semantic blend` | 0 candidates; `searchedLanes ["source","symbol"]`, `skippedLanes [{"lane":"semantic","reason":"async_semantic_lane_required"}]` |
| same conceptual | `--mode semantic` | 0 candidates; `searchedLanes []` | |

**Semantic retrieval is unavailable, and Penguin says so — per request, with a named lane and a named reason.** There is **no silent fallback**: with `--semantic blend` the product both names the lane it skipped *and* names the lanes it actually used (`["source","symbol"]`), and every hit carries its own `lane` plus `rankReasons` such as `"lane_rank=1"`. At no point did Penguin present a lexical hit as a semantic one, or claim readiness it did not have. **B4 verdict: PASS on honesty.**

Provenance comparison is `N/A — semantic lane unavailable`.

**The cost of that unavailability is concrete and measurable in this very workflow:** the conceptual question returns 0 results, and the exact question returns its own answer in last place. Both failure modes are precisely what a working semantic/blend lane exists to fix. Honest unavailability is the right behaviour; it is not a substitute for the capability.

**One residual honesty gap:** `--mode semantic` returns exit 0 and `queryStatus: NO_MATCH_INCOMPLETE` after searching nothing. "Unavailable" and "no match" should not share a status.

---

### B5 — service-map collision investigation

**No collision exists.** `knowledge_service_graph` returns 20 service nodes with 20 unique titles and 20 unique `repoId`s. `FPMS-NT-Auth-Player` is a single node, `repo_5513e90d-a231-455e-9feb-d15d69e93b38`, `rootPath /Users/shieng/Desktop/Projects/auth`, branch `aug-30-1825-master`, commit `055c37dd4354…`, `snapshot_0ffdce0e-…`. Independently corroborated by `penguin status --json`. No duplicate was manufactured to satisfy the scenario.

**Stable ID carried through a follow-up: PASS.** `node_fd129f7d-…` under `--repo FPMS-CCMS` produced `SCOPE_MISMATCH` naming `requestedRepoId repo_18c909a4-…` and `actualRepoId repo_a48ec7fb-…`; Penguin refused to resolve a foreign node rather than silently switching. Re-issuing with `--repo FPMS-NT` resolved it.

**Are UI labels sufficiently disambiguated?** For repository-level services in this environment, yes — titles are unique and every node carries a stable `repoId`. **But the service map itself is not audit-ready:** it returns no scope, no revision, no freshness, no coverage, no completeness, and no per-edge evidence. `FPMS-NT invokes FPMS-NT-Payment` is a bare assertion — you cannot tell whether it came from an extracted gRPC client call, a proto import, or a package manifest, nor at which revision. And its `repo` filter is a silent no-op (Q10). GUI comparison: `N/A — GUI not exercised`.

---

### B6 — three-surface continuity

| Surface | Page 1 (fresh process) | Page 2 (new process, cursor only) | Ordering | Duplicates | Verdict |
| --- | --- | --- | --- | --- | --- |
| `endpoints` | 5 items, `candidateCount 610`, `totalIsExact true` | 5 items, first = `node_34182942-…` | alphabetical by `identityKey,nodeId` | none | **PASS** |
| `filesymbols` | 3 items, `candidateCount 12` | 3 items: `getTaskConfigById` / `createTaskConfig` / `updateTaskConfig` | definition order | none | **PASS** |
| `deadcode` | 3 items, `candidateCount 5647` | 3 items, `candidateCount 5644` | file-path order | none | **PASS** (count semantics noted) |
| `search` (bonus) | 5 items, `candidateCount 13` | pages 2 and 3, exhausted cleanly | score then hitId | none | **PASS** |

**Node ID replayed through both CLI and MCP:** `node_34182942-61ef-40a1-82b8-720902e799ba` gives CLI `flow` (29 steps, hop 1 `node_865365a4-…` `handles` `proven`) and MCP `knowledge_flow` (29 steps, identical node IDs, identical `edgeEvidence`, identical `snapshot_289e6a29-…`). **Identical.**

**Hidden-state dependence: none detected.** Cursors are self-contained signed tokens carrying scope, ordering key, last key, revision, and expiry. The only sensitivity is to the request shape itself (a changed `--limit` invalidates the cursor as `CURSOR_STALE`), which is a labelling problem rather than hidden process state.

---

### B7 — degraded-environment recovery

Only naturally occurring conditions were used. No configuration was broken.

| Condition | Observed? | What remains usable | Classification |
| --- | --- | --- | --- |
| MCP unavailable | No — MCP healthy throughout | n/a | n/a |
| Semantic lane unavailable | **Yes** — `async_semantic_lane_required` on every request | Full graph/lexical fallback: `source`, `symbol`, and `path` lanes all functional and explicitly named in `searchedLanes` | **Product gap** (capability not implemented), honestly reported |
| Stale repository | **Yes** — two repos outside the test scope: `FPMS-NT-Proposal` (`staleReason: worktree_dirty`, 1 dirty file `CLAUDE.md`) and `grpc-web-debugger` (2 dirty files) | FPMS-NT itself is clean and fresh; staleness is per-branch and does not contaminate the target scope | **Environmental**, correctly surfaced |
| Stale knowledge artifact | **Yes** — both api-doc previews are `evidenceState: "stale"` with `gaps: ["preview_revision_stale"]` | Current code truth remains available via graph queries; the stale artifact is clearly fenced off | **Correct behaviour** |
| Result too large for the client | **Yes** — `knowledge_capabilities` (72,436 chars) exceeded the harness token cap and was spilled to a file | Recovered by reading the spill file; also fully available via the CLI | **Harness/environmental**, 1 workaround |
| Coverage debt | **Yes** — 7 excluded, 103,958 unresolved | Positive queries fully usable; all negatives correctly downgraded to `lower_bound` | **Product gap** — debt is visible but not enumerable |
| Timeout | **Not observed** | — | **not proven** |

**What remains unproven after degradation:** timeout behaviour, self-containment, and second-session MCP reload.

---

### B8 — final one-page decision packet

```
ROUND: 18
PRODUCT TRUST: CONDITIONAL
ENVIRONMENT: DEGRADED
GRAPH/LEXICAL: 65/100 - CONDITIONAL. Revision integrity, cursor portability, ID round-trip,
  typed errors and negative-result honesty are strong. Exact-identifier ranking is inverted,
  concept queries return nothing, DI/interface-dispatch edges are absent, and per-edge
  evidence stops after hop 1.
SEMANTIC/VECTOR: UNAVAILABLE (honestly reported - skippedLanes reason
  "async_semantic_lane_required"; no silent fallback; no false readiness claim; 3/7)
CLI/MCP PARITY: 9/20 - PARTIAL. buildId, capabilityHash, schemaVersion, contractVersion and all
  99 capability descriptors are byte-identical. But 61 of 99 advertised tool names are not
  callable, two MCP tools publish empty input schemas, and the default search `mode` differs
  (CLI auto / MCP exact), yielding different lane sets and candidate counts for one query.
FRESH SESSION: NOT PROVEN (session auto-memory contained prior-round Penguin conclusions;
  no prior ID, cursor, hash or score was reused)

SAFE WITHOUT SOURCE:
  - Repository / branch / revision selection and trust assessment (status, coverage, doctor)
  - Endpoint inventory, dynamic page-N selection, and endpoint identity resolution across
    title / identityKey / nodeId, with typed rejection of corrupted identities
  - Endpoint -> handler first hop (proven, EXTRACTED, confidence 1.0, revision-scoped)
  - Locating a symbol or file and enumerating its defined symbols (search path lane + filesymbols)
  - Forward calls/references traversal as an explicitly inferred skeleton
  - Cross-process, cross-agent handoff of node IDs and cursors (0 repairs measured)
  - Cross-repository safety on targeted queries (SCOPE_MISMATCH)
  - Distinguishing a stale knowledge artifact from current code truth

REQUIRES SOURCE/LOG/DB/HUMAN:
  - Any "no caller / no test / no route / unused" claim (lower_bound + 103,958 unresolved refs)
  - NestJS DI wiring and interface-dispatch call sites (unmodelled, named in context.completeness.note)
  - Auth guards, interceptors and decorators on endpoints (no edge type exists)
  - External service and database driver boundaries (externalCallCount 0, no external edge type)
  - Business-rule correctness of any withdrawal gate
  - Identity of the 7 excluded FPMS-NT files and the 103,958 unresolved references
  - Timeout behaviour, runtime self-containment, and release/signing provenance

TOP 5 PRODUCT GAPS:
  1. Exact-identifier search ranking is inverted: `BalanceCheckHandler` returns its own symbol
     node at rank 13 of 13 (score 0.95, lane `symbol`) behind 12 source occurrences (score 1.00),
     nine of them substring matches on TopUpBalanceCheckHandler in a different module. A natural-
     language paraphrase returns the correct node at rank 1. Symbol lane must outrank source lane
     on an exact symbol-name match.
  2. Concept / business-intent queries return zero results. "withdrawal payout approval decision"
     gives candidateCount 0 in a repo containing `withdrawal/checks/`. Multi-word queries are not
     tokenised, and the semantic lane that would cover this is unavailable.
  3. DI and interface-dispatch edges are absent, so blast radius is silently empty for the most
     safety-critical code. callers/calls/impact/affected all return 0 for a class Penguin's own
     source lane shows injected in two files. Honest (`lower_bound`) but not actionable.
  4. Per-edge evidence stops after hop 1. 28 of 29 flow steps carry no `evidenceState` and no
     `edgeEvidence` - no origin, method, confidence, or provenance. `edgeEvidence.origin` is
     `null` even on the one proven edge.
  5. Coverage debt is visible but not actionable. `excluded: 7` and `unresolvedReferences: 103958`
     with `items: []`, `gaps: []`, `nextCursor: null`, an empty `knowledge.coverage` input schema,
     and a broken `coverage --help`. No excluded, failed, stale, or unresolved item can be named.

TOP 3 ENVIRONMENT GAPS:
  1. 61 of 99 manifest `advertisedTool` names are not callable in this MCP session (manifest says
     `knowledge_get_node`, the server exposes `get_node`; `knowledge_dead_code` vs `find_dead_code`;
     `knowledge_architecture` vs `get_architecture`; and 58 more). Seven exposed tools correspond to
     no manifest capability at all. Plus `knowledge_endpoints` and `knowledge_file_symbols` publish
     empty input schemas while the manifest declares full ones.
  2. No runtime identity surface. `penguin --version` does not exist (and exits 0 on the error);
     `doctor` reports no build ID and no native-dependency health; no surface exposes a runtime or
     bundle path. Self-containment and release/signing are therefore `not proven`, not `false`.
  3. Four read surfaces bypass the typed-error contract despite `--json`: `penguin coverage`,
     `penguin endpoints`, and `penguin node` emit plain text on unknown repo / bad node, and MCP
     `knowledge_service_graph` accepts a nonexistent repo with no error at all, returning the full
     global map (as does `index_status`, whose `repo` filter is likewise a silent no-op).

EXACT RETEST COMMANDS/TOOLS:
  # Gap 1 - exact-identifier ranking. PASS = the symbol-lane hit is rank 1.
  penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5 --json \
    | python3 -c "import json,sys;h=json.load(sys.stdin)['hits'][0];print(h['lane'],h['locator'].get('nodeId'))"
  # expected: symbol node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7   (Round 18 actual: source None)

  # Gap 2 - concept query. PASS = candidateCount > 0 with a hit under withdrawal/.
  penguin search "withdrawal payout approval decision" --repo FPMS-NT --limit 10 --json \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['candidateCount'],d['diagnostics']['queryStatus'])"
  # expected: >0 MATCH                                            (Round 18 actual: 0 NO_MATCH_INCOMPLETE)

  # Gap 3 - DI blast radius. PASS = impacted includes withdrawal-check.service.ts.
  penguin affected node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7 --repo FPMS-NT --json \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['impacted']),d['completeness'])"
  # expected: >=1                                                 (Round 18 actual: 0 lower_bound)

  # Gap 4 - per-edge evidence depth. PASS = every step has a non-null evidenceState.
  penguin flow grpc::AdminGrowthTaskController.queryusertaskreport --repo FPMS-NT --json \
    | python3 -c "import json,sys;s=json.load(sys.stdin)['steps'];print(sum(1 for x in s if x.get('evidenceState')),'/',len(s))"
  # expected: 29 / 29                                             (Round 18 actual: 1 / 29)

  # Gap 5 - coverage actionability. PASS = at least one named excluded/unresolved item.
  penguin coverage --repo FPMS-NT --json \
    | python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['items']),d['coverage']['excluded'],d['coverage']['unresolvedReferences'])"
  # expected: items >= 7                                          (Round 18 actual: 0 7 103958)

  # Env Gap 1 - advertised tool names must be callable.
  #   compare every registrations[].advertisedTool from knowledge_capabilities against MCP tools/list
  # expected: 99/99 advertised names callable                     (Round 18 actual: 38/99)

  # Env Gap 2 - runtime identity.
  penguin --version          # expected: a version/build line, exit 0   (Round 18: "unknown command", exit 0)
  penguin doctor --json      # expected: buildId + native health fields (Round 18: neither)

  # Env Gap 3 - typed errors on every --json surface.
  penguin coverage  --repo NO-SUCH-REPO-ROUND18 --json   # expected: {"error":{"code":"REPOSITORY_NOT_FOUND",...}}
  penguin endpoints NO-SUCH-REPO-ROUND18 --json          # expected: same
  penguin node "node_00000000-0000-0000-0000-000000000000" --repo FPMS-NT --json  # expected: typed JSON
  # MCP: knowledge_service_graph {repo:"NO-SUCH-REPO-ROUND18"}    # expected: REPOSITORY_NOT_FOUND, not the global map
```

---

## 6. Graph / lexical capability verdict

**Score 65/100 — CONDITIONAL.**

**Strengths, all verified by call this session.** Revision integrity is excellent and universal: every targeted result carries `repoId`, `branchId`, `snapshotId`, `commitSha`, `worktreeFingerprint`, `trust`, and a `freshness` block with `indexedCommit` vs `headCommit` and `dirtyFileCount`. Cursors are signed, scope-bound, ordering-key-bound, expiring, and portable across fresh OS processes on all four paginated surfaces. Emitted node IDs round-trip through `context`, `flow`, `affected`, `callers`, and `endpoint-identity` without a single manual repair across a full agent-to-agent replay. Typed errors on the core query paths are best-in-class — `SCOPE_MISMATCH` names both requested and actual repo IDs, and `TARGET_AMBIGUOUS` returns a full candidate list with identity keys. Negative-result honesty is pervasive and structural: `completeness`, `proofStatus`, `COVERAGE_INCOMPLETE` warnings, `coverageGaps`, and an explicit `context.completeness.note` naming exactly which call classes are unmodelled.

**Weaknesses.** Exact-identifier ranking is inverted (rank 13/13 for the searched symbol). Concept queries return nothing. The most-returned hit kind, `source_occurrence`, carries `nodeId: null`. Reverse edges are missing wholesale for DI and interface dispatch, which makes blast radius unusable precisely where it matters most. Per-edge evidence exists only at hop 1. `totalIsExact: true` co-occurs with `completeness: lower_bound` on `affected` / `callers` / `calls` / `impact`. `callers` / `calls` / `impact` omit `proofStatus` and `returnedCount` entirely. Coverage debt cannot be enumerated. `flow` is 15/29 type-references despite being described as an execution chain.

---

## 7. Semantic / vector capability verdict

**Status: UNAVAILABLE. Honesty: PASS. Score: 3/7.**

The contract advertises `mode: "semantic"` and `options.semantic: "off"|"fallback"|"blend"`. Both are accepted. Neither retrieves. Every request discloses this in machine-readable form: `skippedLanes: [{"lane":"semantic","reason":"async_semantic_lane_required"}]`, alongside `searchedLanes` naming exactly which lanes did run and per-hit `lane` + `rankReasons`.

**There is no silent fallback and no false readiness claim** — the `--semantic blend` path names both the skipped lane and the substituted lanes. Under the Brief's own guidance this is the "honestly unavailable with a working graph/lexical fallback" band (2–3/7); **3/7** is awarded for the explicit lane attribution.

**What blocks a higher score:**
- No model, embedding space, dimension count, provider, chunk count, vector count, or degraded-reason field exists anywhere. A full scan of the 65,642-byte capability manifest returns zero hits for `vector`, `embed`, `model`, `hybrid`, `rerank`. `mcp_health` reports no vector or native-extension readiness.
- `--mode semantic` returns `searchedLanes: []` — searching nothing — with `exitCode 0` and `queryStatus: "NO_MATCH_INCOMPLETE"`. An unsupported mode should return a typed `MODE_UNSUPPORTED` error. As implemented, "the lane does not exist" is indistinguishable from "nothing matched" to any agent reading only `queryStatus`.
- No persisted retrieval, no scoping, no reproducibility, and no benchmark evidence exists to evaluate.

**The absence is load-bearing.** The two search failures that cost the most points in section 6 — concept queries returning zero, and exact queries burying their own answer — are precisely the failures a working blend lane exists to fix.

---

## 8. Cross-repo / service-label identity verdict

**Targeted queries: PASS. Service-map and list surfaces: FAIL.**

**No duplicate service labels exist in this environment.** 20 service nodes, 20 unique titles, 20 unique `repoId`s, 20 distinct root paths. `FPMS-NT-Auth-Player` occurs exactly once (`repo_5513e90d-a231-455e-9feb-d15d69e93b38`, `/Users/shieng/Desktop/Projects/auth`). Corroborated independently by `penguin status --json`. The Round 18 hypothesis is **contradicted**, and no duplicate was invented to satisfy it.

**Targeted cross-repo safety is genuinely strong.** Every scoped query in this evaluation — `search`, `flow`, `affected`, `context`, `callers`, `endpoints`, `filesymbols`, `deadcode` — stayed inside `repo_a48ec7fb-…`. A foreign node under `--repo FPMS-CCMS` produced `SCOPE_MISMATCH` naming `requestedRepoId`, `requestedRevisionId`, `actualRepoId`, and `actualRevisionId`. `search --repo NO-SUCH-REPO-ROUND18` produced `REPOSITORY_NOT_FOUND` with remediation. Penguin never silently switched to a same-titled node in another repository.

**But two list-shaped surfaces ignore repository scope entirely.** `knowledge_service_graph(repo: "FPMS-NT")` and `index_status(repo: "FPMS-NT")` both return all 20 repositories. `knowledge_service_graph(repo: "NO-SUCH-REPO-ROUND18")` returns **byte-identical full global output with no error**. The same parameter name is enforced on one capability class and silently discarded on another, with no warning field distinguishing them. Under Brief section 7.3 this is a repository-scope leak and triggers the Product max-69 cap declaration (not binding at 65).

**And the service map carries no evidence whatsoever.** `{focus, nodes[], edges[]}` and nothing else — no scope, revision, freshness, coverage, completeness, proofStatus, candidateCount, or cursor, and every one of the 92 edges is a bare `{src, dst, edgeType}` with no origin, method, confidence, or locator. **Identity is adequate; auditability is absent.**

---

## 9. Operations safe without source reading

1. Repository, branch, and revision selection with trust assessment — `status`, `coverage`, `doctor`.
2. Freshness and staleness determination per branch — `stale`, `staleReason`, `worktreeState`, `dirtyFiles`, `indexedCommit` vs `headCommit`.
3. Endpoint inventory with deterministic pagination — 610 endpoints in FPMS-NT, `totalIsExact: true`, alphabetical by `identityKey,nodeId`.
4. Endpoint identity resolution across rendered title, canonical `identityKey`, and `node:<id>`, with typed rejection of corrupted forms.
5. Endpoint to handler first hop, as a **proven** edge (`handles`, `EXTRACTED`, confidence 1.0, scope `revision`).
6. File and symbol location — `search --mode path`, `filesymbols`, `node`.
7. Forward `calls` / `references` traversal as an explicitly **inferred** skeleton (`flow`).
8. Cross-process and cross-agent handoff of node IDs and cursors — measured at 0 manual repairs.
9. Cross-repository safety on targeted queries — `SCOPE_MISMATCH`, `REPOSITORY_NOT_FOUND`.
10. Dead-code **candidate** enumeration, correctly labelled (5647 candidates with an explicit DI/reflection caveat in `note`).
11. Distinguishing a stale knowledge artifact from current code truth — `evidenceState: "stale"` + `currentRevisionIds`.
12. Determining that a negative result is *not* proven — the envelope tells you, every time.

---

## 10. Operations requiring source, logs, DB, runtime evidence, or human review

1. Any absence claim: no caller, no test, no route, unused, unreachable.
2. NestJS DI wiring and interface-dispatch call sites (`context.completeness.note` names this limitation).
3. Constructor calls, static-method calls, and calls inside callback bodies (same note).
4. Auth guards, interceptors, decorators, and middleware on endpoints — no edge type exists.
5. External service boundaries and database driver calls — `externalCallCount: 0`; no external edge type.
6. Business-rule correctness of any withdrawal gate, and the order in which gates run.
7. Lock/mutex/Redis contention (`runChecksWithLock`) — not modelled.
8. Test coverage in fact — `relatedTests` is a file-level association, never a `covers` edge.
9. Identity of the 7 excluded FPMS-NT files and the 103,958 unresolved references.
10. What an api-doc preview was generated from — `revisionIds: []`, `sourceCommits: {}`.
11. Runtime configuration and Vault flags read by the maintenance validators.
12. Timeout behaviour, runtime self-containment, and release/signing provenance.

---

## 11. Product defects vs environment failures vs unproven claims

### 11.1 Product defects (reproduced from Penguin output this session)

| # | Defect | Evidence | Severity |
| ---: | --- | --- | --- |
| P1 | Exact-identifier ranking inverted | `BalanceCheckHandler` symbol node ranks 13/13, score 0.95, behind 12 source hits at 1.00 | **critical** |
| P2 | Concept/business-intent queries return 0 | `"withdrawal payout approval decision"` gives `candidateCount 0`, `NO_MATCH_INCOMPLETE` | **critical** |
| P3 | DI + interface-dispatch edges absent, so blast radius is empty | `callers` / `calls` / `impact` / `affected` all 0 for a class injected in two files | **critical** |
| P4 | Per-edge evidence only at hop 1 | 1 of 29 flow steps has `evidenceState`; `edgeEvidence.origin` null even there | **high** |
| P5 | Coverage debt not actionable | `excluded 7`, `unresolvedReferences 103958`, `items []`, empty input schema, broken `--help` | **high** |
| P6 | `repo` scope is a silent no-op on `service_graph` and `index_status`; unknown repo silently accepted | nonexistent repo returns byte-identical global output, no error | **high** |
| P7 | `service_graph` has no evidence envelope | no scope/revision/freshness/coverage; 92 bare `{src,dst,edgeType}` edges | **high** |
| P8 | 4 surfaces bypass the typed-error contract despite `--json` | `coverage`, `endpoints`, `node` emit plain text; MCP `service_graph` emits nothing | **medium** |
| P9 | `totalIsExact: true` co-occurs with `completeness: lower_bound` | `affected`(node), `callers`, `calls`, `impact` | **medium** |
| P10 | `callers` / `calls` / `impact` omit `proofStatus` and `returnedCount` | both `null`, breaking the envelope other capabilities honour | **medium** |
| P11 | `source_occurrence` hits carry `locator.nodeId: null` | the most-returned hit kind is not node-round-trippable | **medium** |
| P12 | `CURSOR_STALE` / `CURSOR_INVALID` carry no `details` / `remediation`; `CURSOR_STALE` is the wrong code for a changed `--limit` | message is a bare repeat of the code | **medium** |
| P13 | `--mode semantic` returns exit 0 + `NO_MATCH_INCOMPLETE` after searching nothing | `searchedLanes: []` | **medium** |
| P14 | `endpoint-identity` emits no evidence envelope | claims `completeness: "complete"` with no revision to anchor it | **low** |
| P15 | `suggestions` returns a bare array with title-only endpoints | edge endpoints are display titles, not node IDs — not round-trippable | **low** |
| P16 | `snapshots` returns `[]` while all 20 repos report live snapshot IDs | — | **low** |
| P17 | api-doc previews record no `revisionIds` / `sourceCommits` | staleness is detectable but not diffable | **low** |
| P18 | `options.compact: true` is a no-op | `compactRatio: 1`, `sentBytes == rawBytesEstimate` | **low** |
| P19 | `deadcode` `candidateCount` decrements across pages while `totalIsExact: true` | 5647 to 5644 | **low** |
| P20 | `penguin coverage --help` prints `usage: penguin penguin coverage ...` | doubled word, no flags documented | **low** |
| P21 | `flow` is 15/29 type-`references`, not execution | overstates "linear execution chain" | **low** |

### 11.2 Environment failures

| # | Failure | Evidence | Severity |
| ---: | --- | --- | --- |
| E1 | 61 of 99 advertised tool names not callable; 7 exposed tools in no manifest capability | manifest `knowledge_get_node` vs exposed `get_node`, etc. | **critical** |
| E2 | `knowledge_endpoints` / `knowledge_file_symbols` publish empty input schemas | `{"properties":{},"additionalProperties":true}` vs full manifest schemas | **high** |
| E3 | Default search `mode` differs CLI vs MCP | `auto` (lanes source+symbol, cand 13) vs `exact` (lanes source, cand 14) | **high** |
| E4 | No runtime identity surface | no `--version`; `doctor` has no buildId or native health; no runtime path anywhere | **high** |
| E5 | Second MCP session unobtainable without a forbidden client restart | Q17 `SECOND_MCP_SESSION_NOT_ACHIEVED` | **medium** |
| E6 | `knowledge_capabilities` exceeds the MCP client token cap (72,436 chars) | had to be read from a spill file — 1 workaround | **medium** |
| E7 | Cold-start latency: `onboarding` 12.6s, `flow` 10.9s cold, `endpoints` 6.6s cold | first commands a new agent runs | **medium** |
| E8 | `penguin --version` returns an error message with exit 0 | error on the success path | **low** |
| E9 | No signing / notarization / artifact provenance in any surface | only a `buildId` string | **low** |

### 11.3 Unproven claims (neither credited nor penalised)

| Claim | Why unproven |
| --- | --- |
| Installed runtime is self-contained from `/Users/shieng/Desktop/Pengvi` | No Penguin output references it, but no runtime path or native health is exposed either. Absence of evidence is not evidence of absence. |
| Timeout preserves `timedOut`, exit status, partial evidence, and a safe retry path | No timeout occurred; forcing one requires forbidden mutation. |
| The fresh MCP session reloads the current generation | Second MCP session not achieved (Q17). |
| Release artifacts are signed / notarized | No current surface reports it. |
| The 7 excluded FPMS-NT files are benign | They cannot be identified (P5). |
| `BalanceCheckHandler` has no test | `tests: []` may mean unmodelled rather than absent (Q13 #2). |
| GUI labels are sufficiently disambiguated | GUI not exercised. |

---

## 12. Ordered improvements

| # | Improvement | Impact | Cost | Directly executable acceptance test |
| ---: | --- | --- | --- | --- |
| 1 | **Rank the symbol lane above the source lane on an exact symbol-name match.** Raise `lane_rank` for a `symbol` hit whose title equals the query, or apply an exact-title boost that exceeds the source-occurrence boost. | Fixes the single worst usability defect; makes the most common agent query correct | S — a scoring-rule change in the ranker | `penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5 --json \| python3 -c "import json,sys;h=json.load(sys.stdin)['hits'][0];print(h['lane'],h['locator'].get('nodeId'))"` gives **PASS** when it prints `symbol node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7` |
| 2 | **Tokenise multi-word queries in `auto` mode** — split on whitespace, OR the terms across the source and symbol lanes, rank by term coverage. This is the graph/lexical substitute for the missing semantic lane. | Unblocks all business-intent investigation; today it returns nothing | M — query planner change | `penguin search "withdrawal payout approval decision" --repo FPMS-NT --limit 10 --json \| python3 -c "import json,sys;d=json.load(sys.stdin);print(d['candidateCount'])"` gives **PASS** when > 0 and a hit lies under `apps/payment/src/payment/withdrawal/` |
| 3 | **Reconcile `advertisedTool` with the real MCP tool names**, and publish full input schemas for `knowledge_endpoints` and `knowledge_file_symbols`. Either rename the tools to match the manifest or correct the manifest. | Removes a contract lie that misroutes any agent that trusts the manifest | S — a naming table plus two schema registrations | For every `registrations[].advertisedTool` in `knowledge_capabilities`, assert the name appears in MCP `tools/list`. **PASS** at 99/99 (Round 18: 38/99). Separately assert `knowledge_endpoints.inputSchema.properties` is non-empty. |
| 4 | **Model NestJS DI and interface dispatch as first-class edges** — `injects`, `provides`, `implements`, `dispatches_to` — with `evidenceState: "inferred"` and a named method (e.g. `DI_MODULE_PROVIDER`). Inferred edges are far more useful than absent ones, provided they are labelled. | Makes blast radius usable for the safety-critical code where it currently reads empty | L — indexer work | `penguin affected node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7 --repo FPMS-NT --json \| python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['impacted']))"` gives **PASS** when >= 1 and the set includes `withdrawal-check.service.ts` |
| 5 | **Populate `evidenceState` and `edgeEvidence` on every flow/graph step, not just hop 1**, and fill `edgeEvidence.origin`. | Turns `flow` from a plausible chain into an auditable one; directly serves the Brief's proven/inferred/not-proven contract | M — plumb existing edge metadata through the traversal | `penguin flow grpc::AdminGrowthTaskController.queryusertaskreport --repo FPMS-NT --json \| python3 -c "import json,sys;s=json.load(sys.stdin)['steps'];print(sum(1 for x in s if x.get('evidenceState')),'/',len(s))"` gives **PASS** at `29 / 29` (Round 18: `1 / 29`) |
| 6 | **Make coverage debt enumerable**: give `knowledge.coverage` a real input schema (`kind: excluded\|failed\|stale\|unresolved`, `limit`, `cursor`) and return `items[]` with `path`, `reason`, `type`. Fix `coverage --help`. | Converts the most-cited caveat in every report from a number into a work queue | M — the data exists; only the read surface is missing | `penguin coverage --repo FPMS-NT --json \| python3 -c "import json,sys;d=json.load(sys.stdin);print(len(d['items']),d['coverage']['excluded'])"` gives **PASS** when `items >= 7` and each has `path` + `reason` |
| 7 | **Enforce `repo` scope on every capability that accepts it**; return `REPOSITORY_NOT_FOUND` for an unknown repo on `service_graph` and `index_status`, and filter the service map to the requested repo plus its direct neighbours. | Closes the only repository-scope leak found; removes the section 7.3 cap trigger | S — reuse the existing resolver used by `search` | MCP `knowledge_service_graph {repo:"NO-SUCH-REPO-ROUND18"}` gives **PASS** when it returns `REPOSITORY_NOT_FOUND`; `{repo:"FPMS-NT"}` gives **PASS** when `nodes.length < 20` |
| 8 | **Route every `--json` failure through the typed-error envelope** — `coverage`, `endpoints`, `node` — and add `details` + `remediation` to `CURSOR_INVALID` / `CURSOR_STALE`, renaming the latter `CURSOR_REQUEST_MISMATCH` when only the request shape changed. | Makes error handling uniform enough to automate | S | `penguin coverage --repo NO-SUCH-REPO-ROUND18 --json`, `penguin endpoints NO-SUCH-REPO-ROUND18 --json`, `penguin node "node_00000000-0000-0000-0000-000000000000" --repo FPMS-NT --json` give **PASS** when all three emit `{"error":{"code":…,"remediation":…}}` |
| 9 | **Add an evidence envelope to `service_graph`** (scope, revision, freshness, coverage, completeness) and per-edge `evidenceState` + `edgeEvidence`. | Makes the cross-service map auditable instead of decorative | M | MCP `knowledge_service_graph {repo:"FPMS-NT"}` gives **PASS** when the result has `revision.snapshotId` and every edge has a non-null `evidenceState` |
| 10 | **Add `penguin --version` / `penguin version`** printing buildId, contract, schema, capability hash, runtime path, and native-dependency health; mirror it in `doctor` and `mcp_health`. | Makes "installed / configured / loaded" separable in one command and gives self-containment an observable | S | `penguin --version` gives **PASS** when it exits 0 with `1.16.0-caf621d03b0402b6` and a runtime path; `penguin doctor --json` gives **PASS** when it contains `buildId` and a native-health field |
| 11 | **Fix `totalIsExact` and the envelope on `callers` / `calls` / `impact` / `affected`** — never emit `totalIsExact: true` alongside `completeness: "lower_bound"`; always emit `proofStatus` and `returnedCount`. | Removes a self-contradiction that could be read as proven absence | S | `penguin affected node_fd129f7d-… --repo FPMS-NT --json` gives **PASS** when `totalIsExact` is `false` while `completeness == "lower_bound"`; `penguin callers node_fd129f7d-… --repo FPMS-NT --json` gives **PASS** when `proofStatus` and `returnedCount` are non-null |
| 12 | **Give `source_occurrence` hits a `locator.nodeId`** when the occurrence falls inside a known symbol's line range. | Makes the most common hit kind round-trippable | S | `penguin search "BalanceCheckHandler" --repo FPMS-NT --limit 5 --json` gives **PASS** when every hit under a known symbol has a non-null `locator.nodeId` |
| 13 | **Return a typed `MODE_UNSUPPORTED` error for `--mode semantic` while the lane is unavailable**, instead of exit 0 + `NO_MATCH_INCOMPLETE`. | Separates "unavailable" from "no match" — the last semantic-honesty gap | XS | `penguin search "x" --repo FPMS-NT --mode semantic --json` gives **PASS** when exit != 0 and `error.code == "MODE_UNSUPPORTED"` with remediation |
| 14 | **Warm the graph cache on first use, or stream `onboarding`.** 12.6s for the first command a new agent runs is the worst first impression in the product. | Cold-start latency is 3–7x warm across `flow`, `endpoints`, `affected` | M | `time penguin onboarding FPMS-NT` in a fresh process gives **PASS** under 4s (Round 18: 12.56s) |
| 15 | **Implement the semantic/vector lane**, or remove `mode: "semantic"` and `options.semantic` from the contract until it exists. If implemented, expose model, dimensions, provider, vector count, and readiness in `capabilities` and `mcp_health`. | Improvements 1 and 2 are graph/lexical workarounds for this gap; this is the real fix | XL | `penguin search "where do we decide if a withdrawal can proceed" --repo FPMS-NT --semantic blend --json` gives **PASS** when `searchedLanes` includes `"semantic"`, `skippedLanes` is empty, and a hit under `withdrawal/` appears with a `lane: "semantic"` attribution |

---

## 13. Required tables

### 13.1 Dynamic IDs and cursors

| Dynamic ID / cursor | Emitted by | Follow-up | Scope / revision | Result | Workaround |
| --- | --- | --- | --- | --- | ---: |
| `capabilityHash 40ae9528…4487d0` | `penguin capabilities --json` | Section 3 selection indices (0, 0) | global contract | both indices = 0 | 0 |
| `buildId 1.16.0-caf621d03b0402b6` | `penguin capabilities --json` | compared with `mcp_health.serverGeneration` | global | identical | 0 |
| `repo_a48ec7fb-5987-47df-9198-06969359cb50` | `penguin status --json` | every scoped call | FPMS-NT | preserved throughout | 0 |
| `branch_1d21f868-3252-4b74-8289-8f7c4735247f` | `penguin status --json` | `filesymbols` targets | brazil-v2 | resolved | 0 |
| `snapshot_289e6a29-e1d3-483d-b72d-eed7f82075c3` | `penguin coverage --json` | asserted on every result | commit `3f0f1984b9e4…` | identical on all 40+ calls | 0 |
| endpoints page-1 `nextCursor` (signed) | `penguin endpoints FPMS-NT --limit 5 --json` | page 2 in a new process; replayed again in Agent B | `repo_a48ec7fb…\|branch_1d21f868…`, revision `snapshot_289e6a29…` | page 2 returned identically both times | 0 |
| `node_34182942-61ef-40a1-82b8-720902e799ba` (endpoint) | endpoints page 2, index 0 | `endpoint-identity`, `flow` (CLI+MCP), `context` | FPMS-NT / `snapshot_289e6a29…` | resolved on all four | 0 |
| `grpc::AdminGrowthTaskController.queryusertaskreport` | endpoints page 2 | `endpoint-identity`, `flow` CLI, `flow` MCP | same | converged on the same node | 0 |
| `node_865365a4-384c-4150-a9c0-374dc6d92386` (handler) | `endpoints.handlers` | `flow` depth 1 (CLI + MCP) | same | identical `edgeEvidence` on both surfaces | 0 |
| `node_fd129f7d-0ef3-4b8b-be61-0d4ff6a1a6f7` (`BalanceCheckHandler`) | `filesymbols balance.check.ts` | `affected`, `callers`, `calls`, `impact`, `context`, cross-scope probe | FPMS-NT / `snapshot_289e6a29…` | resolved everywhere; `SCOPE_MISMATCH` under FPMS-CCMS | 0 |
| search cursor (`queryHash`+`normalizedRequestHash`+`scopeHash`) | `penguin search … --limit 5` | pages 2 and 3 in new processes | same | 13 hits paginated cleanly, exhausted | 0 |
| same cursor with `--limit 10` | as above | continuation attempt | same | `CURSOR_STALE` | 1 |
| filesymbols cursor | `filesymbols admin-growth-task.controller.ts --limit 3` | page 2 in a new process | same | 3 more symbols, no duplicates | 0 |
| deadcode cursor | `deadcode --repo FPMS-NT --limit 3` | page 2 in a new process | same | 3 more candidates, no duplicates | 0 |
| `node_b10e39c8-1399-4856-9904-d23bab2e08e6` (`runChecks`) | `filesymbols withdrawal-check.service.ts` | `callers`, `flow` | same | 1 caller `node_85c5afc5-…`; 15-step flow | 0 |
| `preview:v1:0f638a792d12e21e9851f49a4bed76c3:…` | `penguin api-doc list --json` | `penguin api-doc show` | global, `evidenceState: stale` | read back, staleness confirmed | 0 |
| `requestId search_345181bf0bc25db0` etc. | search `diagnostics` | quoted as evidence | per-request | 4 distinct request IDs recorded | 0 |
| **Total workarounds across all follow-ups** | | | | | **1** |

### 13.2 Claims

| Claim | Evidence lane | Completeness | Proven / contradicted / not proven | Missing evidence |
| --- | --- | --- | --- | --- |
| Endpoint `QueryUserTaskReport` is handled by `queryUserTaskReport` | graph (`handles`, `EXTRACTED`, confidence 1.0) | complete for hop 1 | **proven** | none |
| The three endpoint identity forms denote the same node | identity resolver | `completeness: "complete"` | **proven** | endpoint-identity emits no revision envelope |
| The endpoint reaches a data boundary | graph `calls` depth 3–4 | `partial`, `not_proven` | **contradicted** (as "never reaches") / **inferred** (as "reaches") | source review of `base-repository.ts:258-275`; no per-hop evidenceState |
| `BalanceCheckHandler` has no production caller | graph reverse edges | `lower_bound`, cand 0, `totalIsExact` wrongly true | **not proven** — source lane shows it injected in 2 files | DI + interface-dispatch edges; 103,958 unresolved refs |
| `BalanceCheckHandler` has no test | `tests` / `relatedTests` | `lower_bound` | **not proven** | test-runner coverage; `covers` edges do not exist |
| FPMS-NT withdrawal gating lives in `withdrawal/checks/` + `WithdrawalCheckService` | path + symbol lanes | `candidate`, `totalIsExact: false` | **not proven** as a business claim; locations are proven-as-indexed | source review of the check list and dispatch |
| Semantic retrieval is unavailable | `skippedLanes` diagnostics | explicit per request | **proven** | none |
| No duplicate service labels exist | `service_graph` + `status` | 20/20 unique | **proven** (for repository-level services) | service_graph carries no revision, so this is true "as currently returned" |
| `repo` scope is ignored by `service_graph` / `index_status` | two calls with a nonexistent repo | byte-identical output, no error | **proven** | none |
| Targeted queries never cross repositories | 40+ scoped calls + `SCOPE_MISMATCH` | every result carried `repo_a48ec7fb…` | **proven** | none |
| The 7 excluded FPMS-NT files are benign | none available | `items: []` | **not proven** | an enumerable coverage surface |
| CLI and MCP run the same generation | `buildId` + `capabilityHash` on both | identical strings | **proven** | second-session reload not achieved |
| 61 advertised tool names are callable | manifest vs `tools/list` | 38/99 present | **contradicted** | none needed |
| The installed runtime is self-contained | health + real calls + zero `Pengvi` references | no runtime path exposed | **not proven** | a runtime-identity surface |
| A timeout preserves partial evidence and a safe retry path | none | no timeout occurred | **not proven** | a naturally occurring timeout |

### 13.3 Capabilities

| Capability | Advertised | Real call | CLI/MCP parity | Runtime status | Verdict |
| --- | --- | --- | --- | --- | --- |
| `knowledge.capabilities` | yes (99 descriptors) | yes, both surfaces | identical payload; MCP adds `advertisedTool` / `invocationMode` | loaded, 92ms | **PASS** |
| `knowledge.search` | yes | yes, both | **different default `mode`** (auto vs exact), so different lanes and totals | loaded, 2.4s median | **PARTIAL** |
| `knowledge.search` semantic lane | yes (`mode`, `options.semantic`) | accepted, retrieves nothing | same on both | `skippedLanes: async_semantic_lane_required` | **UNAVAILABLE (honest)** |
| `knowledge.coverage` | yes | yes | CLI only tested | **empty input schema; `items` always `[]`; plain-text error** | **PARTIAL** |
| `knowledge.endpoints` | yes | yes | CLI works; **MCP tool schema empty** | loaded, 0.9s median | **PARTIAL** |
| `knowledge.file_symbols` | yes | yes | CLI works; **MCP tool schema empty** | loaded, 0.2s | **PARTIAL** |
| `knowledge.flow` | yes | yes, both | **identical** 29 steps, node IDs, edge evidence | loaded, 3.3s median | **PASS** |
| `knowledge.context` | yes | yes | CLI tested | loaded, 0.78s median | **PASS** |
| `knowledge.affected` | yes | yes | CLI tested | `totalIsExact` contradiction | **PARTIAL** |
| `knowledge.callers` / `.callees` / `.impact` | yes | yes | CLI tested | missing `proofStatus` / `returnedCount`; 0 results due to unmodelled DI | **PARTIAL** |
| `knowledge.dead_code` | yes (`knowledge_dead_code`) | yes via CLI; MCP name is `find_dead_code` | **advertised name not callable** | 5647 candidates, honest `note` | **PARTIAL** |
| `knowledge.service_graph` | yes | yes via MCP | **`repo` ignored; unknown repo silently accepted; no envelope; no edge evidence** | loaded | **FAIL** |
| `knowledge.index_status` | yes (`knowledge_index_status`) | yes via MCP as `index_status` | **advertised name not callable; `repo` ignored** | loaded | **PARTIAL** |
| `knowledge.doctor` | yes | yes | CLI tested | 4.1s median, `verify: false` | **PASS** |
| `knowledge.onboarding.generate` | yes | yes | CLI tested | 12.56s | **PASS** (slow) |
| `knowledge.api_doc.list` / `.show` | yes (`knowledge_api_doc_list`) | yes via CLI; MCP name is `api_doc_list` | **advertised name not callable** | 2 stale previews, correctly flagged | **PARTIAL** |
| `knowledge.note.list` | yes (`knowledge_note_list`) | yes via CLI | advertised name not callable | 1 note, `provenanceGaps` declared | **PARTIAL** |
| `knowledge.tag.list` | yes | yes | CLI tested | empty, `revision_provenance_unavailable` | **PASS** (honest empty) |
| `knowledge.evidence.note.list` | yes (`knowledge_evidence_note_list`) | yes via CLI; MCP name is `list_evidence_notes` | advertised name not callable | empty, gap declared | **PARTIAL** |
| `knowledge.suggestion.list` | yes | yes via CLI | **bare array, no envelope, title-only endpoints** | 1 pending | **PARTIAL** |
| `knowledge.snapshot.list` | yes | yes via CLI | **bare `[]` despite 20 live snapshot IDs** | — | **PARTIAL** |
| `knowledge.status_panel` | yes (`knowledge_status_panel`) | not called (MCP name is `status_panel`) | advertised name not callable | — | **NOT EXERCISED** |
| 38 mutating capabilities | yes, all marked `mutating: true` | **not called — forbidden by section 1** | manifest identical on both | — | **N/A by design** |
| `endpoint-identity` (CLI-only surface) | in help, not in the 99-capability manifest | yes | CLI only | no evidence envelope | **PARTIAL** |

---

## 14. Completion gate

| Gate requirement | Status |
| --- | --- |
| Q1–Q20 executed or evidenced `N/A` | **Done** — all 20 executed; Q17's second MCP session and Q18's timeout half are individually marked with evidence |
| All IDs/cursors fresh, emitting result recorded | **Done** — 13.1, 18 rows |
| Dynamic endpoint selection follows section 3 | **Done** — hash tail `0`, index 0, `node_34182942-…`; no fallback, no substitution |
| Graph/lexical and semantic/vector scored separately | **Done** — section 6 (65/100) and section 7 (3/7, UNAVAILABLE) |
| Service-label duplicates investigated by stable identity | **Done** — none exist; investigated via `repoId` / `rootPath`, not title |
| endpoints / filesymbols / deadcode cursor portability tested | **Done** — plus `search`, all across fresh processes |
| Positive, negative, ambiguous, cross-scope, stale, inferred, external, unresolved, unavailable, timeout, structured-error cases represented | **Done except timeout** — timeout marked `not proven` (no natural occurrence; forcing one requires forbidden mutation) |
| CLI and MCP compared through real calls | **Done** — capabilities, search, flow, service_graph, index_status, health |
| Two genuinely new MCP sessions perform the runtime-generation replay | **NOT SATISFIED** — `SECOND_MCP_SESSION_NOT_ACHIEVED`; CLI half proven with observed distinct PIDs and 0 repairs. Scored 10/20. |
| Every negative claim carries coverage/completeness and uses `not proven` | **Done** — 13.2 |
| No source, DB, Git, old report, browser, config edit, build, re-index, repair, or knowledge write | **Done** — 1.2. One disclosed deviation: the session's auto-memory contained prior-round Penguin conclusions (1.1), so no 95+ verdict is claimed. |
| New report uses the Round 18 filename and does not overwrite history | **Done** — `docs/quality/index-evaluation-claude-opus-5-round18.md`, new file, 38 pre-existing files untouched |

**Round 18 is complete, with two requirements explicitly unmet and scored down rather than worked around: the fresh-session boundary and the second MCP session.**

> Round 18 is a broader benchmark than Round 17. This 65/100 product and 59/100 environment result does not retroactively invalidate the frozen Round 17 95/100 trust result. It identifies the next capability frontier: exact-identifier ranking, concept retrieval, DI-aware reverse edges, per-hop edge evidence, enumerable coverage debt, and manifest/tool-name truth.
