# Penguin Index / Knowledge Evaluation — Opus 5, Fresh Round 16

> Executed against `docs/quality/index-evaluation-brief-round16.md`.
> Evaluation only. No source file was opened, no `git`/`grep`/browser/DB query was used,
> no index/rebuild/mutation/release command was run. All evidence below comes from the
> installed Penguin CLI and the Penguin MCP server.

---

## 1. Fresh-session environment and exact runtime/client paths

| Item | Value | How obtained |
|---|---|---|
| Client | Claude Code (CLI), interactive session | — |
| Model | Opus 5 (1M context), `claude-opus-5[1m]` | — |
| Session start (UTC) | `2026-08-30T11:19:12Z` | `date -u` |
| Stable launcher on `PATH` | `/Users/shieng/.local/bin/penguin` (POSIX sh shim) | `which penguin` |
| Launcher body | `exec "$HOME/.penguin/runtimes/current/node" "$HOME/.penguin/bin/penguin-cli-launcher.mjs" "$@"` | `head` of the shim |
| Resolved runtime | `/Users/shieng/.penguin/runtimes/1.16.0-4e7941ddc215e0f1` (via `current` symlink) | `readlink` |
| Other runtime present | `1.16.0-1e715e93c828afbe` (not selected) | `ls ~/.penguin/runtimes` |
| App bundle | `/Applications/Penguin.app` present; dev-fallback bundle **not used** | `ls` |
| MCP server command | `/Users/shieng/.penguin/bin/penguin-mcp` | `claude mcp list` |
| MCP status in client | `penguin: /Users/shieng/.penguin/bin/penguin-mcp - Connected` | `claude mcp list` |
| MCP `serverInfo` | `{"name":"penguin-mcp","version":"1.16.0-4e7941ddc215e0f1"}` | stdio `initialize` |
| MCP protocolVersion | `2024-11-05` | stdio `initialize` |
| MCP `instructions` | `{"contractVersion":"2","schemaVersion":14,"capabilityHash":"40ae95...87d0"}` | stdio `initialize` |
| MCP `tools/list` count | **82**, zero duplicates | stdio `tools/list` |
| Node version in MCP | `v22.23.1`, `darwin` | `mcp_health` |
| Global ledger | `ledgerSeq 12348 == materializedSeq 12348`, `status: ok`, 1,006,436 nodes / 4,583,623 edges | `penguin doctor --json` |

**No CLI/MCP surface was unavailable.** The dev fallback in section 2 of the brief was not
needed. Four *unrelated* MCP servers in this client failed to connect (`alibaba-sls`,
`github-om`, `github-sre`, `pencil`); none of them is Penguin and none affected this
evaluation.

### Fresh-session accounting (brief section 1, item 5 / section 11)

- This Claude Code session is new, but **the client process itself was not quit and
  reopened by the evaluator** — the client's reload state is not exposed to me.
  Therefore Claude Code client reload is recorded as **`not proven`** (see Q14).
- To satisfy "at least two fresh MCP sessions", **three independent fresh stdio MCP
  sessions** (A, B, C) were spawned as separate OS processes against the installed
  `penguin-mcp` binary, each doing its own `initialize` then `notifications/initialized`
  then calls, and each fully torn down before the next. This is the installed product's own
  MCP surface, so it is in scope; it is *not* a substitute for proving that a long-lived
  Claude Code process reloaded, and it is not reported as one.
- Every CLI invocation is a fresh OS process by construction.
- Codex client: **`N/A — not exercised in this round`** (this session is Claude Code).

---

## 2. Capability / readiness split and scores

Product capability and environment health are scored separately, per brief section 9.

| Dimension | Score /100 | One-line justification |
|---|---:|---|
| Agent discoverability | 78 | `knowledge_explore` is tool #0 and self-describes as "call this before grep/Read"; but 82 MCP tools carry two incompatible naming conventions and 17 declared capabilities have no addressable tool. |
| Context usefulness | 88 | One `explore` call returned verbatim focus source plus 3 callers, 1 callee, a 5-hop endpoint-to-cache call path and edge provenance — enough to write a review checklist without opening a file. |
| Accuracy | 62 | IDs, repo scope and revisions are exact and stable, but four cross-surface contradictions were reproduced (freshness, unresolvedReferences, tests/routes, proofStatus). |
| Completeness | 71 | `affected` and `flow` expose routes, tests, repositories and Redis boundaries; `context`/`explore` silently omit the same tests and routes. |
| Honesty | 84 | `lower_bound` notes, `no_static_edge`, `COVERAGE_INCOMPLETE`, `unresolved_references_present` and DI/reflection warnings are all present and correct — undermined by `totalIsExact:true` on a scope-bugged empty `deadcode` result. |
| MCP/CLI parity | 55 | Manifests are byte-identical, but `knowledge_endpoints` silently ignores the `page` object and `knowledge_search` returns 0 hits for any explicit scope. |
| Continuity | 92 | 6/6 packet items replayed across fresh CLI processes and a third fresh MCP session with **zero** manual reconstruction; a CLI-issued cursor was accepted by MCP. |
| Usability | 66 | Error codes and remediation are copyable where they exist, but `filesymbols --file` silently misroutes, subcommand `--help` is absent, and ambiguity over CLI is plain text under `--json`. |
| Speed | 63 | Every node-scoped op was 0.36 s or faster; unscoped `search` took 63–87 s (CLI) and 11 s (MCP) with no timeout warning. |
| **Product overall** | **72** | Best-in-class evidence envelope and graph accuracy; held back by cross-surface contradictions and two MCP defects that manufacture false negatives. |
| **Environment readiness** | **95** | Stable launcher on PATH, one selected runtime, MCP connected, three fresh MCP sessions agree on generation and capability hash; only the client-reload proof is missing. |

---

## 3. Q1–Q15

### Q1 — Capability truth and first move

Commands (all exit 0):

```
penguin help --json                      0.09s   42 commands
penguin capabilities --json              0.09s   99 capabilities
penguin status --compact --json          0.59s   26 repos
penguin doctor --json                    4.28s
penguin coverage --repo FPMS-NT --json   0.17s
penguin onboarding FPMS-NT               4.35s
```

MCP (fresh stdio session A): `initialize` ok, `tools/list` = 82, `mcp_health` ok,
`knowledge_capabilities` ok.

Raw evidence:

```json
// doctor
{"ledgerSeq":12348,"materializedSeq":12348,"status":"ok","ledgerTruncatedAtLine":null,
 "nodes":1006436,"edges":4583623,"pendingSuggestions":1,"verify":false}

// coverage --repo FPMS-NT
{"discovered":3340,"admitted":3333,"excluded":7,"failed":0,"stale":0}

// status --compact (FPMS-NT row)
{"repo":"FPMS-NT","liveBranch":"brazil-v2","freshness":"fresh","dirtyFileCount":0,
 "indexedCommit":"3f0f1984b9e4337668529a13bad5264501729908",
 "headCommit":"3f0f1984b9e4337668529a13bad5264501729908",
 "parserVersion":"tree-sitter-wasm-v8-wrapper-allowlist","indexErrorCount":0}

// status summary
{"totalRepos":26,"fresh":19,"dirty":0,"stale":6,"unknown":1,"errors":31}
```

`capabilities`: `schemaVersion 14`, `contractVersion 2`,
`buildId 1.16.0-4e7941ddc215e0f1`,
`capabilityHash 40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`.
99 capability IDs, **0 duplicates**, 99/99 `registrations[].status == "implemented"`,
99/99 `requiredOn` includes both `cli` and `mcp`, 47 also `wiki`, 38 `mutating`,
61 `supportsCursor`.

**Advertised vs implemented vs runtime.** 42 CLI commands, 99 canonical capabilities,
82 MCP tools. The three inventories never line up, and nothing in any of the three outputs
maps one to another. `help --json` gives every command the same useless usage string
(`"penguin endpoints ..."`), so the CLI cannot teach its own argument shapes.

**Answer to "what can Penguin reliably do / not prove" for FPMS-NT:**

*Reliably (proven this session, no source read):*

- Resolve a path-qualified `file.ts#symbol` to a stable node ID and return verbatim source.
- Enumerate a file's symbols with line ranges and per-symbol freshness.
- Return parser-confirmed callers/callees with edge provenance and confidence.
- Trace gRPC endpoint to controller to processor to service to repository/Redis, 60 steps.
- Return blast radius plus related tests and routes for a symbol (`affected`).
- Page endpoints/filesymbols/deadcode with signed, portable, scope-checked cursors.
- Refuse a cross-repository target with a typed `REPO_SCOPE_MISMATCH`.

*Cannot prove:*

- That any relation list is closed — `completeness` is `lower_bound` or `partial` on every
  graph op, and `queryDiagnostics.evidence.unresolvedReferenceCount = 103925`.
- That a gRPC endpoint has a real handler (see Q7 — "handled" can mean a proto stub).
- That a symbol is dead (`deadcode` note explicitly disclaims DI/reflection/dynamic import).
- Semantic correctness of anything — source review is still required.
- That a long-lived Claude/Codex process reloaded the current generation.

**Recommended first investigation command:** `penguin explore <file>#<symbol> --repo <R> --json`
(MCP: `knowledge_explore`). It is the only surface returning focus source, callers, callees,
call path, provenance and freshness in a single sub-300 ms call.

**Three read-only ops:** `context`, `filesymbols`, `coverage`.
**Two graph ops:** `callers`, `affected`.
**One paged op:** `endpoints --limit 3 --cursor <c>`.
**One negative-result op:** `deadcode --repo FPMS-NT`.

**Not proven / unavailable:** the 17 capabilities that declare `requiredOn:["cli","mcp"]`
and `status:"implemented"` but have no entry in `tools/list` (99 minus 82) — I could not
prove whether they are multiplexed behind another tool or simply unreachable over MCP.

---

### Q2 — Generation and launcher identity

| Source | buildId | capabilityHash | outdated | clientRestartRequired |
|---|---|---|---|---|
| CLI `capabilities --json` | `1.16.0-4e7941ddc215e0f1` | `40ae95...87d0` | — | — |
| Claude Code MCP `mcp_health` | `1.16.0-4e7941ddc215e0f1` | — | `false` | `false` |
| Fresh MCP session A | `1.16.0-4e7941ddc215e0f1` | `40ae95...87d0` | `false` | `false` |
| Fresh MCP session B | `1.16.0-4e7941ddc215e0f1` | `40ae95...87d0` | `false` | `false` |
| Fresh MCP session C | `1.16.0-4e7941ddc215e0f1` | — | `false` | `false` |

```json
// mcp_health (identical in A and B)
{"status":"ok","initializeHealthy":true,"clientRestartRequired":false,"runtimeOutdated":false,
 "serverGeneration":{"runningBuildId":"1.16.0-4e7941ddc215e0f1",
                     "availableBuildId":"1.16.0-4e7941ddc215e0f1","outdated":false},
 "queryRuntime":{"workers":2,"hardTimeoutMs":15000}}
```

Canonicalised (`json.dumps(..., sort_keys=True)`) the CLI and MCP capability manifests are
**byte-identical**: `sha256` prefix `21cd1ad9aed7696b` on both sides, 99 = 99 capability IDs,
symmetric difference of the ID sets is empty.

**Q2 verdict: PASS.** Two (three) fresh MCP sessions agree with each other and with the CLI
on generation and capability hash, and `tools/list` ordering was identical across A and B.

Caveats recorded rather than glossed:

- `launcherHealthy` and `configured` are both `null` in `mcp_health` — the field exists but
  proves nothing.
- `clientRestartRequired:false` is a server-side statement; it is **not** evidence that the
  Claude Code process reloaded.

---

### Q3 — MCP listing integrity

| Check | Result |
|---|---|
| 1. `knowledge_explore` first discovery tool | **PASS** — index 0 in `tools/list` |
| 2. Core tools discoverable | **PASS** — `knowledge_search` #1, `knowledge_file_symbols` #4, `index_status` #7, `knowledge_callers` #8, `knowledge_affected` #11, `knowledge_flow` #12, `knowledge_context` #15, `knowledge_endpoints` #18, `knowledge_capabilities` #58, `mcp_health` #73 |
| 3. Bounded enough to scan | **MARGINAL** — 82 tools, 43,127 characters of schema (about 11k tokens) |
| 4. Duplicate tool names | **PASS** — 82 names, 82 unique |
| 5. Duplicate capability IDs | **PASS** — 99 IDs, 99 unique |
| 6. Aliases callable without a second advertised capability | **PASS, with a wrong error class** |
| 7. Full manifest via `knowledge_capabilities` | **PASS in protocol, FAIL in practice** |

Check 6 evidence — two names absent from `tools/list` are nonetheless callable:

```json
// tools/call knowledge_dead_code {"repo":"FPMS-NT"}   -> real results, not advertised
{"candidates":[{"nodeId":"node_68b158d4-...","title":"useFactory",
  "filePath":"apps/admin/inteceptor/external.module.ts","startLine":14}]}

// tools/call knowledge_architecture {"repo":"FPMS-NT"} -> real results, not advertised
{"repos":[{"name":"FPMS","branches":4},{"name":"FPMS-CCMS","branches":1}]}
```

But the canonical dotted ID is rejected with the **wrong** code:

```json
// tools/call "knowledge.search" {"query":"x"}
{"error":{"code":"CAPABILITY_NOT_IMPLEMENTED",
          "message":"capability not implemented: knowledge.search","retryable":false},
 "isError":true}
```

`knowledge.search` *is* implemented (`registrations[].status == "implemented"`). The correct
class is "unknown tool name". An agent that reads the manifest, tries the canonical ID and
gets `CAPABILITY_NOT_IMPLEMENTED` will conclude the feature is missing.

Check 7 failure in practice — in the Claude Code client:

```
Error: result (65,077 characters) exceeds maximum allowed tokens.
Output has been saved to .../mcp-penguin-knowledge_capabilities-1788088820038.txt
```

The manifest is un-consumable inline over MCP despite `supportsCompact:true` on the
capability. (`options.compact` was separately proven to be a no-op — see Q11 and section 7.)

**Listed vs callable vs manifest mismatch:** 99 manifest IDs, 82 listed tools, at least 2
unlisted tools proven callable. 44 listed tools use informal names (`get_node`,
`find_dead_code`, `explore_graph`, `index_status`, `status_panel`, and others) that do not
correspond to any capability ID; the manifest is therefore not a usable index into
`tools/list`.

---

### Q4 — Path-qualified source-pack usefulness

Target: `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#getActiveEventConfigByObjId`

```
penguin search "getActiveEventConfigByObjId" --repo FPMS-NT --json   exit 0  1.13s
penguin filesymbols FPMS-NT "<file>" --json                          exit 0  0.26s
penguin context "<file>#<symbol>" --repo FPMS-NT --json              exit 0  0.61s
penguin explore "<file>#<symbol>" --repo FPMS-NT --json              exit 0  0.73s
```

Resolution is exact and consistent: all three surfaces resolved to
**`node_af26e1f8-17f5-473b-b76c-e33a150abfac`** (lines 135-156, `status:"fresh"`).

```json
// explore.queryDiagnostics
{"resolutionStatus":"resolved","resultStatus":"has_results",
 "target":{"requested":"apps/promotion/.../color-land-event-config.service.ts#getActiveEventConfigByObjId",
           "resolvedNodeId":"node_af26e1f8-17f5-473b-b76c-e33a150abfac",
           "repo":"FPMS-NT","branch":"brazil-v2"},
 "evidence":{"incomingByType":{"calls":3,"defines":1},
             "outgoingByType":{"calls":1,"reads_field":6,"writes_field":2},
             "unresolvedReferenceCount":103925},
 "candidateCount":17,"totalIsExact":false,"completeness":"partial",
 "coverageGaps":["unresolved_references_present"]}

// explore.provenance
[{"edgeType":"calls","origin":"parser","method":"EXTRACTED","confidence":1,"count":4},
 {"edgeType":"defines","origin":"parser","method":"EXTRACTED","confidence":1,"count":1},
 {"edgeType":"reads_field","origin":"parser","method":"EXTRACTED","confidence":1,"count":6},
 {"edgeType":"writes_field","origin":"parser","method":"EXTRACTED","confidence":1,"count":2}]

// explore.confidence
{"level":"high","minimum":1,"inferredEdges":0,"totalEdges":13}
```

Pack contents scorecard:

| Element | Present? | Evidence |
|---|---|---|
| Usable focus node | yes | `focus.nodeId`, `nodeType:"symbol"`, `kind:"method"` |
| File/line locator | yes | `filePath` plus `startLine 135` / `endLine 156` |
| Kind / signature | partial | `"signature":"async getActiveEventConfigByObjId("` — truncated at the open paren, no params, no return type |
| Callers | yes | 3, each with nodeId, file and lines |
| Callees | yes | 1 (`getColorLandEventConfigByIdFromCache`) |
| Tests | **no** | `tests: []` — **wrong**, `affected` on the same node returns 6 test files (Q6) |
| Routes | **no** | `routes: []` — **wrong**, `affected` returns 2 gRPC routes (Q6) |
| External calls | yes | `externalCalls: []`, `completeness.externalCallCount: 0` |
| Source blocks | yes | 5 blocks, `role` focus/callee/caller x3, 562-3,966 chars, per-block `truncated` flag |
| Omitted-source reasons | yes | `sourcesOmitted: []`, `truncated: []`; 2 caller blocks flagged `truncated:true` inline |
| Revision | yes | `commitSha 3f0f1984...`, `branch brazil-v2`, `trust "exact_commit"`, `worktreeFingerprint 073264f8...` |
| Freshness | yes | `{"stale":false,"reason":null,"indexedAt":"2026-08-30T04:23:32.546Z","coverageGaps":[]}` |
| Coverage | yes | `3340/3333/7/0/0` |
| Completeness | yes | `"partial"` plus `coverageGaps:["unresolved_references_present"]` |
| Next commands | **no** | none in `explore`/`context`; only `search` emits `diagnostics.nextActions` |

Focus source returned verbatim:

```ts
  async getActiveEventConfigByObjId(
    data: GetEventConfigById_Service_Interface,
  ): Promise<GetEventConfigById_Service_Response_Interface> {
    const eventConfig = await this.getColorLandEventConfigByIdFromCache(
      data.eventConfigObjId?.toString(),
    );
    if (eventConfig == null) { ...
```

**Decision: yes, sufficient to prepare a source-review checklist** — but only if the reviewer
also runs `affected`, because `explore` alone claims there are no tests and no routes when
there are 6 and 2. Semantic correctness is **not** decided here; no source file was opened.

**Search-lane defect found here.** For this query the symbol lane returned 8 hits, *all* of
them `kind:"field"` mock properties inside `*.spec.ts`, all with `"nodeId": null`. The real
method definition surfaced only in the *source* lane. So symbol-lane ranking prefers test
mocks over the definition, and symbol-lane hits are not usable as follow-up IDs.

---

### Q5 — Collision containment

| Query | Scope | Latency | candidateCount | returned | totalIsExact | truncated | repos on page 1 |
|---|---|---:|---:|---:|---|---|---|
| `constructor` | global | **65.34 s** | 10,772 | 50 | false | true | casino-plus 1, casino-plus-app 3, claude_code 26, flyover 20 |
| `constructor` | `--repo FPMS-NT` | 2.19 s | 1,325 | 50 | false | true | FPMS-NT 50 |
| `execute` | global | **63.18 s** | 7,789 | 50 | false | true | **casino-plus 50** |
| `execute` | `--repo FPMS-NT` | 2.15 s | 373 | 50 | false | true | FPMS-NT 50 |
| `update` | global | **87.00 s** | 35,154 | 50 | false | true | **casino-plus 50** |
| `update` | `--repo FPMS-NT` | 2.99 s | 4,169 | 50 | false | true | FPMS-NT 50 |

**Does the global result disclose multi-repository scope?** Per hit, yes —
`locator.repoName` and `locator.repoId` are on every hit. At the envelope level, **no**:
global search returns `"scope": {}` and omits the `warnings` key entirely (the scoped
response has `"warnings": []`). An agent cannot learn from the global envelope which
repositories were searched.

Worse for a collision query: for `execute` and `update`, **all 50 page-one hits came from a
single unrelated repo (`casino-plus`)** out of 7,789 / 35,154 candidates. FPMS-NT does not
appear on page one at all. Global collision search is actively misleading.

**Does the scoped result preserve repo identity?** Yes, fully:

```json
"scope":{"revisions":[{"repoId":"repo_c58d58a2-bb7f-4696-bd45-2c0c29634c67",
                       "snapshotId":"snapshot_804a4c86-b397-447a-9066-a51d36f2511a"}]}
```

Selected result (scoped `execute`, emitted node ID only):
`node_22eb1647-ef13-46f0-ae57-780e501c2431` — `executeCallback`,
`apps/admin/src/jackpot/executors/jackpot.executor.ts:89`.

```
penguin context node:node_22eb1647-... --repo FPMS-NT --json   0.32s exit 0
penguin callers node:node_22eb1647-... --repo FPMS-NT --json   0.26s exit 0  -> 2 callers
penguin flow    node:node_22eb1647-... --repo FPMS-NT --json   0.36s exit 0  -> 4 steps
```

All three preserved `repoName "FPMS-NT"`, `branchName "brazil-v2"`,
`commitSha 3f0f1984b9e4337668529a13bad5264501729908`.

**Can a path-qualified follow-up resolve a different repository?** No — and it fails loudly:

```json
// penguin context "libs/providers/src/lib/aiLivechatProvider/aiLivechatProvider.store.ts#constructor" --repo FPMS-NT
{"error":{"code":"REPO_SCOPE_MISMATCH",
  "message":"target ... belongs to another repository","retryable":false,
  "details":{"expectedRepoId":"repo_c58d58a2-bb7f-4696-bd45-2c0c29634c67",
             "actualRepoId":"repo_64480bcf-5373-42ba-9482-33b221d4394c",
             "remediation":"specify the repository that owns the target"}}}
```

The same code is returned for a cross-repo *node ID*; and the same node ID with
`--repo casino-plus` resolved cleanly. **Cross-repo containment: PASS.**

Unknown totals stayed unknown: `totalIsExact:false` on all six searches.

---

### Q6 — Dynamic ID matrix

All IDs were emitted by this session. No ID was ever substituted after a failure.

| # | ID source | Emitted node ID | `context` | `flow` | `callers` | `callees` | `affected` | Repo / branch / revision |
|---|---|---|---|---|---|---|---|---|
| 1 | `filesymbols` | `node_af26e1f8-17f5-473b-b76c-e33a150abfac` (`getActiveEventConfigByObjId`, `:135-156`) | OK, 3 callers, `proven` | OK, 5 steps | OK, 3, `exact:true` | OK, 1 | OK: 1 file / 9 impacted / 6 tests / 2 routes | FPMS-NT / brazil-v2 / `3f0f1984...` |
| 2 | `search` (scoped) | `node_22eb1647-ef13-46f0-ae57-780e501c2431` (`executeCallback`, `jackpot.executor.ts:89`) | OK, 2, `proven` | OK, 4 steps | OK, 2, `exact:true` | OK, 1 | OK | FPMS-NT / brazil-v2 / `3f0f1984...` |
| 3 | ambiguous candidate | `node_58520468-d6c0-48c6-ba27-fcf35168a1f5` (`field ... withdrawalActivities.ts::autoAuditActivity::execute`) | FAIL `UNSUPPORTED_TARGET_KIND` | FAIL same | RISK `[]` with `totalIsExact:true` | RISK `[]` with `totalIsExact:true` | FAIL `UNSUPPORTED_TARGET_KIND` | FPMS-NT / brazil-v2 |
| 4 | `endpoints` page 2 | `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` (`AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs`) | OK exit 0 but everything empty, `not_proven` | OK, 2 steps, `proven` | RISK `[]`, `exact:true` | RISK `[]`, `exact:true` | RISK 0 files / 0 impacted / 0 tests / 0 routes | FPMS-NT / brazil-v2 / `3f0f1984...` |

Error shape for row 3 (identical on `context`, `flow`, `affected`):

```json
{"error":{"code":"UNSUPPORTED_TARGET_KIND","retryable":false,
  "details":{"remediation":"use a symbol, endpoint, service, file, or note target"}}}
```

Typed, non-retryable, copyable — good. But `callers` and `callees` **accept** the same
unsupported `field` node and answer `[]` with `totalIsExact:true`. That is the one
combination in this matrix that can manufacture a false "no callers".

Accidental extra case (empty node target, `context "node:"`):

```
Multiple symbols found for "node:":
1. topic channel::kafka::${label} must be a valid Obj...
```

An empty or `node:`-only target is **not rejected**; it degrades into fuzzy search and
matches Kafka topic names. Plain text under `--json`, exit 1.

`affected` shape (row 1) — note that it is the *only* surface exposing tests and routes:

```json
{"files":["apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts"],
 "changed":[{"nodeId":"node_af26e1f8-...","title":"getActiveEventConfigByObjId"}],
 "impacted":[ 9 symbols across 8 files ],
 "routes":["gRPC promotion.v1.RecaptchaColorLandService.VerifyPlayerColorLand",
           "gRPC promotion.v1.FrontendColorLandService.RollColorLandDice"],
 "tests":[6 spec files with nodeIds],
 "candidateCount":9,"totalIsExact":true,"completeness":"lower_bound",
 "coverageGaps":["unresolved_reference_counts_not_persisted"]}
```

`routes` are bare strings with no `nodeId`, so a route cannot be carried forward directly —
it must be re-resolved through `endpoint-identity` or `context`.

---

### Q7 — Endpoint queue and page-two handoff

```
penguin endpoints FPMS-NT --protocol grpc --limit 3 --json           0.18s exit 0
penguin endpoints FPMS-NT --protocol grpc --limit 3 --cursor <c1>    0.20s exit 0
penguin endpoints FPMS-NT --protocol grpc --limit 3 --cursor <c2>    0.18s exit 0
```

| Page | returned | candidateCount | totalIsExact | truncated | nextCursor | repeated IDs |
|---|---:|---:|---|---|---|---|
| 1 | 3 | 1535 | false | true | set | — |
| 2 | 3 | 1532 | false | true | set | **none** |
| 3 | 3 | 1529 | false | true | set | **none** |

Ordering is stable and declared. Decoded cursor payload (base64 of the segment before the
`.`; the token is `payload.HMAC`):

```json
{"schemaVersion":"1","contractVersion":"2","operation":"endpoints","scope":"FPMS-NT|grpc",
 "orderingKey":"title,nodeId",
 "lastKey":"AccumulativeEventConfigAdminService.CreateAccumulativeEventConfig <NUL> node_bf3d2b4d-...",
 "revision":null,"expiresAt":"2026-08-30T11:45:30.682Z"}
```

Two observations: `candidateCount` is *remaining*, not total (it decrements 1535, 1532,
1529), which reads as a total unless you page; and **`"revision": null`** — the cursor is not
pinned to a snapshot, so a re-index mid-pagination would silently change the underlying set.
`expiresAt` gives a 15-minute TTL.

**Page-two endpoint selected (not page one):**
`node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` — `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs`.

```json
// as emitted on page 2
{"nodeId":"node_ec762949-fbcc-4387-aa8e-f1ba65f6d626",
 "title":"AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs",
 "identityKey":"grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs",
 "protocol":"grpc",
 "handlers":[{"title":"proto","repoId":"repo_e3c88b3d-1f5c-43d4-9420-e1f685ae7a56"}],
 "handlerStatus":"handled","missingHandlerReason":null}
```

Carried through:

```json
// context node:node_ec762949-...  (exit 0)
{"focus":{"nodeType":"endpoint","kind":null,"filePath":null,"signature":null,"source":null,
          "branches":[]},
 "callers":[],"calls":[],"invokedBy":[],"routes":[],"tests":[],"importers":[],
 "candidateCount":0,"returnedCount":0,"proofStatus":"not_proven"}

// flow node:node_ec762949-...  (exit 0)
{"proofStatus":"proven","candidateCount":2,"returnedCount":2,"warnings":[],
 "steps":[{"depth":0,"nodeId":"node_ec762949-...","nodeType":"endpoint","via":"root"},
          {"depth":1,"parentNodeId":"node_ec762949-...",
           "nodeId":"node_0fb2fbd0-1160-4b5c-b60a-28a62dc57463",
           "title":"proto","nodeType":"service","via":"handles"}]}
```

**This is the most misleading output in the round.**
`handlerStatus:"handled"`, `missingHandlerReason:null`, `proofStatus:"proven"` — yet the
"handler" is a node of `nodeType:"service"` titled **`proto`**, living in
`repo_e3c88b3d-...` (**not** FPMS-NT's `repo_c58d58a2-...`), with no file, no line and no
implementation. Meanwhile `context` on the same node finds *nothing* and correctly says
`not_proven`. An agent reading `endpoints` plus `flow` would report "handler found, proven".

- Handler status: `handled` — **not proven** as an implementation.
- Handler IDs: only via MCP (`handlers[].nodeId` is present over MCP, **absent over CLI** —
  see section 7).
- Root/parent: `root` is the endpoint; step 1 carries `parentNodeId` correctly.
- Edge origin / confidence: **absent from `flow` steps entirely** (only `via`). `explore` is
  the only surface with `provenance`.
- **First incomplete evidence boundary:** depth 1, the `handles` edge to a proto-package
  service node. Everything past it is unproven.

Envelope gap: `endpoints` returns only
`{candidateCount, items, nextCursor, returnedCount, totalIsExact, truncated}` — **no
revision, no locator, no freshness, no coverage, no proofStatus, no warnings**. It is the
only paged surface that violates the brief's evidence contract.

---

### Q8 — Five-form endpoint identity

`penguin endpoint-identity` requires **three positional arguments** (rendered title,
canonical identity, node id) or the flags `--title`/`--identity`/`--node`. Called with one
argument it prints, in plain text, `endpoint-identity needs rendered title, canonical
identity, and node id` — the *same* string for a valid title and for a garbage identity, so
a usage error is indistinguishable from a miss.

| # | Form | `endpoint-identity` | `context` | `flow` |
|---|---|---|---|---|
| 1 | `AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs` | `resolved` | same node | 2 steps |
| 2 | `grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs` | `resolved` | same node | 2 steps |
| 3 | `node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | `resolved` | same node | 2 steps |
| 4 | `node:node_ec762949-fbcc-4387-aa8e-f1ba65f6d626` | `resolved` | same node | 2 steps |
| 5 | `/AccumulativeEventConfigAdminService/GetAccumulativeEventConfigs` | `resolved` | same node | 2 steps |

**All five forms resolve to the identical node.**

```json
{"forms":[{"value":"AccumulativeEventConfigAdminService.GetAccumulativeEventConfigs",
           "nodeId":"node_ec762949-...","status":"resolved"},
          {"value":"grpc::...getaccumulativeeventconfigs","nodeId":"node_ec762949-...","status":"resolved"},
          {"value":"node_ec762949-...","nodeId":"node_ec762949-...","status":"resolved"}],
 "equal":true,"rootNodeId":"node_ec762949-...","parentNodeId":null,"completeness":"complete"}
```

Invalid input:

```json
// endpoint-identity with a bogus method  -> exit 0 (!)
{"forms":[{"value":"AccumulativeEventConfigAdminService.NoSuchMethod","nodeId":null,"status":"no_match"},
          {"value":"grpc::...nosuchmethod","nodeId":null,"status":"no_match"},
          {"value":"node_ec762949-...","nodeId":"node_ec762949-...","status":"resolved"}],
 "equal":false,"rootNodeId":null,"completeness":"unknown"}

// context / flow "grpc::NoSuchService.NoSuchMethod"  -> exit 1
{"error":{"code":"TARGET_NOT_FOUND","retryable":false,
  "details":{"remediation":"run penguin search to find a current target ID"}}}
```

`context` and `flow` give a **typed, non-retryable, copyable** remediation.
`endpoint-identity` does **not**: it exits 0, emits no error code, no `retryable` and no
remediation for a completely invalid endpoint. A caller checking exit codes sees success.

---

### Q9 — Bounded request-trace chain

Root: `node_3f34eb5d-65ae-4778-b663-4b45d9278eb3` —
`gRPC promotion.v1.FrontendColorLandService.RollColorLandDice`
(obtained from `explore.callPath` in Q4; not typed by hand).

```
penguin flow node:node_3f34eb5d-... --repo FPMS-NT --json   0.29s exit 0
-> proofStatus "proven", candidateCount 60, returnedCount 60, warnings [], maxDepth 4
-> via counts: root 1, handles 1, calls 39, references 18, uses 1
```

| Hop | Node | Locator | Edge | Origin | Confidence | Status |
|---|---|---|---|---|---|---|
| endpoint | `gRPC ...FrontendColorLandService.RollColorLandDice` | endpoint node, no file | `root` | — | — | confirmed |
| handler | `rollColorLandDice` `node_d2b9aad0-...` | `color-land.controller.ts:103-127` | `handles` | not stated in `flow`; `parser/EXTRACTED/1.0` per `explore.provenance` | 1.0 | confirmed |
| processor | `playDice` `node_60f4c2d2-...` | `dice.processor.ts:51-485` | `calls` | parser | 1.0 | confirmed |
| service | `getActiveEventConfigByObjId` `node_af26e1f8-...` | `color-land-event-config.service.ts:135-156` | `calls` | parser | 1.0 | confirmed |
| **data — repository** | `createPlayerEventRewardTicket` | `apps/promotion/src/repositories/event-reward-tickets.repository.ts:68` | `calls` | parser | 1.0 | confirmed |
| **data — Redis** | `hget`, `hincrby`, `incrby`, `incrbyWithTTL` | `apps/promotion/libs/redis/promotion-redis/promotion-redis.service.ts:1250 / 1314 / 215 / 234` | `calls` | parser | 1.0 | confirmed |
| **data — schema** | `EventConfigs`, `Term`, `EventCreationSetting` | `apps/promotion/src/schemas/event-configs.schema.ts:659 / 381 / 421` | `references` | parser | 1.0 | confirmed |
| tests | 16 files incl. `event-reward-tickets.repository.spec.ts`, `color-land/processors/dice.processor.spec.ts` | `relatedTests[]` with nodeIds | — | — | — | confirmed as *related*, not as coverage |

All 60 steps carry `filePath` plus a line range and inline `source`; only the depth-0 endpoint
and one `entity` node (`DISABLE_SIGNATURE_VERIFICATION`) lack a locator.

**First evidence frontier: depth 4.** The traversal stops there and the response contains
**no `truncated`, no `totalIsExact` and no `completeness` field at all** — yet it asserts
`proofStatus:"proven"`. Concretely, `getColorLandEventConfigByIdFromCache` (depth 4) is a
cache read; whatever populates that cache (`loadCacheFromDatabase`, visible in `filesymbols`
at `:69-98`) is at depth 5 and simply absent, with no signal that the walk was cut.

Per the brief this chain is a **lower bound**. It does prove reachability to a data boundary
(a real `*.repository.ts` symbol and real Redis primitives with file and line, not a
repository-*like* title), but it does not prove that these are the only data boundaries.

---

### Q10 — Four adversarial negative claims

**Claim 1 — "This function has no callers."**
Target `node_9c3b7866-b9ca-4cf5-b9b9-9d6f9b95c262` (`GameRepositoryModule`,
`apps/admin/libs/repositories/fpms/admin/game/game-repository.module.ts:19`), taken from
`deadcode`.

```json
{"mode":"who_calls","nodes":[],"candidateCount":0,"totalIsExact":true,
 "completeness":"lower_bound","coverageGaps":["unresolved_reference_counts_not_persisted"],
 "diagnostics":{"resolutionStatus":"resolved","resultStatus":"no_static_edge",
   "evidence":{"incomingByType":{"defines":1},"outgoingByType":{},
               "unresolvedReferenceCount":103925}}}
```

Verdict **`not proven`.** `resultStatus:"no_static_edge"` (not "no result"),
`completeness:"lower_bound"`, 103,925 unresolved references. And `context` on the same node
supplies the counter-evidence: `importers: 2` — the file *is* imported twice. Penguin does the
right thing here.

**Claim 2 — "This endpoint has no handler."**
Target `node_ec762949-...` (Q7). `endpoints` says `handlerStatus:"handled"`; `context` says
`callers:[] invokedBy:[] routes:[] proofStatus:"not_proven"`; `flow` says `proven` and lands
on a `proto` service node with no file.
Verdict **`not proven` in both directions.** The surfaces contradict each other and neither
produces an implementation locator.

**Claim 3 — "This symbol is unused."**
Same node as claim 1. `affected` returns `impacted: []`, `tests: []`, `routes: []`,
`totalIsExact:true`, `completeness:"lower_bound"`. `deadcode` attaches:

> "no inbound calls/references/handles/tests — verify: DI, reflection, framework magic,
> dynamic import, and public entry points are false positives. Scope: under FPMS-NT."

Verdict **`not proven`.** `GameRepositoryModule` is a NestJS module — exactly the DI/decorator
case the note disclaims. The note is correct and load-bearing.

**Claim 4 — "This request never reaches a data boundary."**
Two contrasting targets, same session:

- `node_ec762949-...` — `flow` stops at depth 1 on a proto node, so **`not proven`** (absence
  of a traversal is not absence of a data path).
- `node_3f34eb5d-...` (`RollColorLandDice`) — **disproven**: reaches
  `event-reward-tickets.repository.ts:68` and `promotion-redis.service.ts:1250` with
  parser-confirmed `calls` edges at confidence 1.0.

**Result: 4/4 correctly resolvable to `not proven` (or positively disproven) using only
Penguin's own coverage, completeness and diagnostics fields.** No empty array had to be
trusted.

**Two defects that undercut this:**

1. **`context.coverage.unresolvedReferences` is `0`** on every call, while
   `explore`, `callers` and `callees` report `unresolvedReferenceCount: 103925` for the same
   node at the same revision. `context` is the surface most likely to be used for a negative
   claim, and it is the one that reports the reassuring number.
2. **Positional scope silently becomes a path filter.**

   ```
   penguin deadcode FPMS-NT --limit 5 --json
   -> {"candidates":[],"candidateCount":0,"totalIsExact":true,"truncated":false,
       "scope":{"repo":null,"path":"FPMS-NT","branch":null}}

   penguin deadcode --repo FPMS-NT --limit 5 --json
   -> 5 candidates, candidateCount 5647, totalIsExact true
   ```

   The first form reads as "FPMS-NT has exactly zero dead code". Only `scope.repo:null` gives
   it away. The same repo argument is positional-and-correct for `filesymbols` and
   `endpoints`, so the inconsistency is not guessable.

Global coverage relevant to any negative claim (from MCP `knowledge_search`):
`discovered 63178, admitted 36524, excluded 26654, failed 6` — **42% of discovered files are
excluded corpus-wide**, and search correctly warns:

```json
"warnings":[{"code":"COVERAGE_INCOMPLETE",
  "message":"coverage includes excluded or failed files; an empty result is not proof of absence"}],
"nextActions":[{"command":"penguin index <repo-path>",
  "reason":"refresh stale or failed coverage before relying on a negative result"}]
```

---

### Q11 — Error taxonomy and remediation

CLI:

| Case | Code | exit | retryable | Remediation | Verdict |
|---|---|---:|---|---|---|
| missing target | `TARGET_REQUIRED` | 1 | false | "provide a target from penguin search or specify --target" | good |
| unknown repository | `SCOPE_NOT_FOUND` | 4 | false | "specify branch, commit, or snapshot" | wrong remediation; `details.candidates: []`, no did-you-mean |
| ambiguous symbol | **none** | 1 | — | — | **FAIL — plain text under `--json`** |
| invalid node ID (valid UUID) | `TARGET_NOT_FOUND` | 1 | false | "run penguin search to find a current target ID" | good |
| malformed node ID (`node:not-a-node`) | `TARGET_NOT_FOUND` | 1 | false | same | malformed not distinguished from absent |
| stale / wrong-revision ID | — | — | — | — | **not proven** — index is `fresh`, `dirtyFileCount 0`; no stale ID could be produced without mutating |
| malformed cursor | `CURSOR_INVALID` | 2 | false | **absent** | no `details`, no next step |
| cursor from another scope | `CURSOR_SCOPE_MISMATCH` | 2 | false | **absent** | correct code, no remediation |
| invalid endpoint identity (`endpoint-identity`) | **none** | **0** | — | — | **FAIL — success exit, `status:"no_match"` only** |
| invalid endpoint identity (`context`/`flow`) | `TARGET_NOT_FOUND` | 1 | false | copyable | good |
| empty query | **none** | **0** | — | `diagnostics.nextActions` | see below |
| unsupported target kind | `UNSUPPORTED_TARGET_KIND` | 1 | false | "use a symbol, endpoint, service, file, or note target" | good |

Ambiguity over CLI, with `--json` explicitly passed:

```
Multiple symbols found for "execute":

1. field field::apps/payment/src/activities/withdrawalActivities.ts::autoAuditActivity::execute
   (no file)  node:node_58520468-d6c0-48c6-ba27-fcf35168a1f5
2. field field::apps/promotion/.../community-free-spin-create.handler.spec.ts::<object>::execute
   (no file)  node:node_422c6ba6-0fcf-4f4a-a4df-403ff844370c
```

Copyable `node:` IDs, but not JSON, no error code, no `retryable` — and every candidate is
labelled `(no file)` even though the qualified name embeds the file path.

Empty query on CLI is exit 0 with an empty result set, but the envelope is honest:
`proofStatus:"not_proven"`, `diagnostics.queryStatus:"NO_MATCH_INCOMPLETE"`, plus
`nextActions`. It should still be an argument-validation error — the capability's own input
schema says *"Non-empty deterministic or semantic query"*.

MCP (fresh stdio session), same cases:

| Case | MCP code | `isError` | Parity with CLI |
|---|---|---|---|
| invalid node ID | `TARGET_NOT_FOUND` plus identical `details.remediation` | true | identical |
| missing target | `TARGET_REQUIRED` plus identical remediation | true | identical |
| **ambiguous symbol** | `TARGET_AMBIGUOUS` plus `details.candidates[]` with `nodeId`/`nodeType`/`identityKey` | true | **DIFFERS — MCP structured, CLI plain text** |
| unknown repository | `SCOPE_NOT_FOUND`, message `"repository not found: NOPE"`, remediation `"specify a registered repository"` | true | **DIFFERS — different message and remediation from CLI** |
| **empty query** | `INTERNAL` — `"knowledge_search requires a non-empty query"` | true | **DIFFERS — CLI exit 0; MCP errors, with the wrong class (`INTERNAL`, not a validation code)** |
| malformed cursor (top-level `cursor`) | `CURSOR_INVALID` | true | identical |
| **malformed cursor inside `page{}`** | **no error — page one returned** | false | **DIFFERS — see Q12** |

Nothing generic was called "handled": `CURSOR_INVALID` and `CURSOR_SCOPE_MISMATCH` are
genuinely distinct, and `no_static_edge`, `UNSUPPORTED_TARGET_KIND` and
`REPO_SCOPE_MISMATCH` are correctly separated. The taxonomy's failures are *omissions*
(cursor errors have no remediation) and *disagreements between surfaces*, not blanket
handling.

---

### Q12 — Cursor continuity and scope safety

Every continuation below ran in a **new OS process** using only page-one JSON. No hidden
session state was required.

**`endpoints`** — see Q7. 3 + 3 + 3, stable `title,nodeId` ordering, no repeats,
`candidateCount` decrements, exhausted state proven on the HTTP protocol slice:

```
penguin endpoints --repo FPMS-NT --protocol http --limit 6 --json
-> returnedCount 6, candidateCount 6, totalIsExact true, truncated false, nextCursor null
```

This matches `help --json`'s documented contract `"exhausted":"nextCursor:null"`,
`"invalidExitCode":2`.

**`filesymbols`** — 4 + 4 + 2 = 10, exactly the file's symbol count, no repeats:

| Page | returned | candidateCount | totalIsExact | truncated | nextCursor |
|---|---:|---:|---|---|---|
| 1 | 4 | 10 | false | true | set |
| 2 | 4 | 6 | false | true | set |
| 3 | 2 | 2 | **true** | false | **null** |

Replaying the page-2 cursor a second time returned the identical four items — cursors are
idempotent, not consuming.

**`deadcode`** — 3 + 3, no repeats, `candidateCount` 5647 then 5644. Exhausted state proven on
a narrow path scope:

```
penguin deadcode --path "apps/admin/inteceptor" --limit 50 --json
-> returnedCount 3, candidateCount 3, totalIsExact true, truncated false, nextCursor null
```

Error matrix (all three surfaces, all four cases):

| Surface | normal continuation (new process) | exhausted | malformed cursor | wrong-scope cursor |
|---|---|---|---|---|
| `endpoints` | 3 + 3 + 3, no repeats | `nextCursor null`, `truncated false`, `totalIsExact true` | `CURSOR_INVALID` exit 2 | `CURSOR_SCOPE_MISMATCH` exit 2 (FPMS-NT cursor on casino-plus) |
| `filesymbols` | 4 + 4 + 2 = 10, no repeats | `nextCursor null`, `truncated false`, `totalIsExact true` | `CURSOR_INVALID` exit 2 (`"invalid or mismatched filesymbols cursor"`) | `CURSOR_SCOPE_MISMATCH` exit 2 — caught for a different repo **and** for a different file in the same repo |
| `deadcode` | 3 + 3, no repeats | `nextCursor null`, `truncated false`, `totalIsExact true` | `CURSOR_INVALID` exit 2 | `CURSOR_SCOPE_MISMATCH` exit 2 |

All `retryable:false`, all operation-named in the message. **None carries a `details` or
`remediation` field**, so the next action is not copyable.

**Two defects.**

1. **`filesymbols` changes response shape based on `--limit`.** Without `--limit` it returns
   a **bare JSON array** with no envelope — no `candidateCount`, no `totalIsExact`, no
   `nextCursor`, no revision. With `--limit` it returns
   `{items, returnedCount, candidateCount, totalIsExact, truncated, nextCursor}`. Code that
   omits `--limit` cannot detect truncation.
2. **MCP `knowledge_endpoints` silently ignores the `page` object.** Detailed in section 7 —
   this is the round's most dangerous defect.

Exactness flags are consistently conservative: `filesymbols` reports `totalIsExact:false`
even when `candidateCount 10` is in fact exact. Under-claiming is the right direction.

---

### Q13 — Fresh-session replay

**Session A packet (Penguin output only):**

```json
{"capabilityHash":"40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0",
 "buildId":"1.16.0-4e7941ddc215e0f1",
 "repo":"FPMS-NT","branch":"brazil-v2",
 "commitSha":"3f0f1984b9e4337668529a13bad5264501729908",
 "symbolNodeId":"node_af26e1f8-17f5-473b-b76c-e33a150abfac",
 "endpointNodeId":"node_ec762949-fbcc-4387-aa8e-f1ba65f6d626",
 "cursor":"eyJzY2hlbWFWZXJzaW9uIjoiMSIsImNvbnRyYWN0VmVyc2lvbiI6IjIiLCJvcGVyYXRpb24iOiJlbmRwb2ludHMi...",
 "invalidCursorErrorCode":"CURSOR_INVALID","invalidCursorExitCode":2}
```

**Exact next commands in the packet:**

```
penguin capabilities --json
penguin context node:node_af26e1f8-17f5-473b-b76c-e33a150abfac --repo FPMS-NT --json
penguin flow    node:node_ec762949-fbcc-4387-aa8e-f1ba65f6d626 --repo FPMS-NT --json
penguin endpoints --repo FPMS-NT --protocol grpc --limit 3 --cursor <cursor> --json
penguin endpoints --repo FPMS-NT --limit 3 --cursor BOGUS --json
```

**Session B (fresh CLI processes) results:**

| Step | Outcome |
|---|---|
| capability hash and buildId | both **match** |
| `context` symbol ID | `focus getActiveEventConfigByObjId`, commit `3f0f1984b9e4`, branch `brazil-v2`, `proofStatus proven` |
| `flow` endpoint ID | 2 steps, `proven`, commit `3f0f1984b9e4` |
| cursor continuation | page 2 = `GetAccumulativeEventConfigs`, `UpdateAccumulativeEventConfig`, `AdminGrowthTaskService.CreateTaskConfig` — **identical to Session A page 2** |
| invalid-cursor error | `CURSOR_INVALID`, `retryable:false`, `exitCode:2` — **identical shape** |

**Session C (third fresh stdio MCP session), same packet:**

| Step | Outcome |
|---|---|
| `mcp_health` | `runningBuildId == availableBuildId == 1.16.0-4e7941ddc215e0f1`, `outdated:false` |
| `knowledge_context` symbol ID | same focus, same commit, `proven` |
| `knowledge_flow` endpoint ID | 2 steps, `proven` |
| **CLI-issued cursor over MCP** | **accepted** — returned the same page 2 |
| bogus cursor over MCP (top-level) | `CURSOR_INVALID`, `retryable:false` |

**Manually reconstructed values: 0. Workarounds: 0.** IDs, scope, revision, cursor, error
shape and terminology all survived, and cursors proved portable **across surfaces**
(CLI to MCP), which the brief did not even require.

One failure inside Session C, using the documented scope shape:

```
knowledge_search {"query":"getActiveEventConfigByObjId",
                  "scope":{"revisions":[{"repoName":"FPMS-NT"}]}}
-> hits 0, candidateCount 0
```

See section 7 — this is a defect, not a handoff failure, since the packet's node IDs still
worked.

---

### Q14 — Claude/Codex client continuity

**Claude Code:**

| # | Check | Result |
|---|---|---|
| 1 | client fully quit before this session | **not proven** — a new conversation was started, but I cannot observe or control the client process lifecycle |
| 2 | MCP initialize succeeded | **PASS** — `claude mcp list` reports `penguin: ... Connected`; `mcp_health` answered with `initializeHealthy:true` |
| 3 | `tools/list` non-empty and duplicate-free | **PASS** — 82 tools, 82 unique |
| 4 | `mcp_health` generation equals CLI | **PASS** — `1.16.0-4e7941ddc215e0f1` on both |
| 5 | one `knowledge_search` succeeds | **PASS** — 3 hits, `requestId search_a7908d08a7f4ca59`, `capabilityHash 40ae95...87d0` matching CLI, `timingsMs.total 10957.004` |
| 6 | a second completely fresh session sees the same generation and hash | **PASS at the server level / `not proven` at the client level** — three independent fresh MCP server sessions (A, B, C) agreed on `buildId` and `capabilityHash`, but no second Claude Code *client* session was created |

**Codex: `N/A — not exercised in this round`.**

No green Settings badge was used as evidence anywhere; every PASS above is backed by a call
result quoted in this report.

---

### Q15 — GO / NO-GO engineering packet

**Target:** `getActiveEventConfigByObjId`
**Node:** `node_af26e1f8-17f5-473b-b76c-e33a150abfac`
**Defining locator:** `apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135-156`
**Selected revision:** FPMS-NT / `brazil-v2` / `3f0f1984b9e4337668529a13bad5264501729908`,
`snapshot_804a4c86-b397-447a-9066-a51d36f2511a`, `worktreeState clean`, `dirtyFiles []`,
`worktreeFingerprint 073264f852ac84af...`, `trust "exact_commit"`, `alignment "aligned"`,
`parserVersion tree-sitter-wasm-v8-wrapper-allowlist`, `schemaVersion 14`,
`indexedAt 2026-08-30T04:23:32.546Z`, `reusePercent 100`, `changedFiles 0`,
`cacheState ready`.

**Direct callers (3) — parser-confirmed, confidence 1.0:**

| Node | Locator | Status |
|---|---|---|
| `verifyPlayerColorLand` `node_79307c9d-...` | `color-land-auth.service.ts:30-182` | confirmed |
| `playDice` `node_60f4c2d2-...` | `dice.processor.ts:51-485` | confirmed |
| `buildContext` `node_2f61a74d-...` | `color-land-base-rule.service.ts:27-134` | confirmed |

**Direct callee (1):** `getColorLandEventConfigByIdFromCache` `node_0a9ea225-...`,
`color-land-event-config.service.ts:111-115` — confirmed.

**Affected (9 impacted symbols across 8 files), `totalIsExact:true`,
`completeness:"lower_bound"`:** `color-land.controller.ts` (x2),
`color-land-auth.service.ts`, `dice.processor.ts`, `color-land-base-rule.service.ts`,
`color-land-mission-rule.service.ts`, `color-land-reward-rule.service.ts`,
`color-land-reward.service.ts`, `color-land-base-rule.service.spec.ts`.

**Related tests (6, from `affected` only):**
`color-land/controllers/color-land.controller.spec.ts`,
`color-land/processors/dice.processor.spec.ts`,
`color-land/services/color-land-auth.service.spec.ts`,
`color-land/rule-engine/color-land-base-rule.service.spec.ts`,
`color-land/rule-engine/color-land-mission-rule.service.spec.ts`,
`color-land/rule-engine/color-land-reward-rule.service.spec.ts`.

**Routes possibly related (2, from `affected` only):**
`gRPC promotion.v1.FrontendColorLandService.RollColorLandDice`,
`gRPC promotion.v1.RecaptchaColorLandService.VerifyPlayerColorLand`.

**External and unresolved edges:**
`externalCalls: []`, `remoteCalls: []`, `invokedDynamicallyBy: []`, `invokesDynamic: []`,
`renders`/`renderedBy: []`, `notes: []`, `signals: []`, `envs: []`, `errors: []`,
`assemblyError: null`, `warnings: []` — but `unresolvedReferenceCount: 103925` and
`coverageGaps: ["unresolved_references_present"]`.

**Coverage / pagination / truncation limits:** repo coverage
`3340 discovered / 3333 admitted / 7 excluded / 0 failed / 0 stale`;
`explore.candidateCount 17` with `totalIsExact:false`; caller and callee lists carry
`coverageGaps:["unresolved_reference_counts_not_persisted"]`; the calls list is explicitly a
lower bound:

> "The calls list is a lower bound: constructor calls, interface dispatch, static-method
> calls and calls inside callback bodies are not modelled, so a short list may mean few calls
> or few visible calls."

**Exact source-review checklist (no file opened to produce it):**

1. `color-land-event-config.service.ts:135-156` — the null-cache branch after
   `getColorLandEventConfigByIdFromCache(data.eventConfigObjId?.toString())`; confirm every
   caller handles the null/throw path.
2. `color-land-event-config.service.ts:111-115` — the only callee; a signature change is
   contained here.
3. `color-land-event-config.service.ts:65-98` — `refreshFromDatabase` and
   `loadCacheFromDatabase` (from `filesymbols`); the cache-fill path is **outside** the
   depth-4 `flow` and must be read by hand.
4. `dice.processor.ts:51-485` — largest caller; its `source` block was `truncated:true` in the
   pack and must be read in full.
5. `color-land-auth.service.ts:30-182` — caller, `truncated:true` in the pack.
6. `color-land-base-rule.service.ts:27-134` — caller, source complete in the pack.
7. Both gRPC routes above — re-derive handlers via `flow`; do not trust `endpoints`'
   `handlerStatus`.
8. Run the 6 test files; treat them as *related*, not as coverage.
9. Re-check `constructor`, interface-dispatch and callback call sites by hand — declared
   unmodelled.

**Decision: NO-GO for an autonomous change; GO for a human-reviewed change.**

Revision alignment *is* proven (`alignment "aligned"`, `trust "exact_commit"`, clean
worktree, 0 dirty files, `indexedCommit == headCommit`). Sufficiency of evidence is **not**:
`completeness` is `lower_bound` on every relation list and 103,925 references are unresolved,
so the 3-caller / 9-impacted set is a floor, not a closure. Per the brief's rule
("GO only when aligned revision **and** sufficient evidence are proven"), this is NO-GO.

**Does Penguin prevent an agent from treating the candidate list as complete? Mostly yes.**
`completeness:"lower_bound"`, the explicit prose note, `coverageGaps`, `no_static_edge` and
the `deadcode` DI disclaimer all push the right way. Two things push the wrong way and are
the reason Honesty is 84 and not 95: `context.coverage.unresolvedReferences: 0` contradicting
`103925`, and `totalIsExact:true` on the scope-bugged empty `deadcode` result.

---

## 4. Session A to Session B handoff packet and replay results

See Q13. **Packet items: 6. Replayed successfully: 6. Manually reconstructed values: 0.
Workarounds: 0.** Additionally proven beyond the brief: a cursor minted by the CLI was
accepted by a fresh MCP session and produced an identical page two.

One packet-durability caveat worth recording: cursors carry `"expiresAt"` about **15 minutes**
out and `"revision": null`. A packet handed off after the TTL, or across a re-index, will not
replay — and because `revision` is null, a re-index would not even be *detected*; it would
just silently return a different page two.

---

## 5. Reliable operations without source reading

Proven this session, sub-second, with a complete evidence envelope:

1. `explore <file>#<symbol>` — focus source, callers, callees, call path, provenance, confidence. **0.26 s.**
2. `context node:<id>` — relations, trust block, coverage, `proofStatus`. **0.25 s.**
3. `filesymbols <repo> <path>` — full symbol inventory with line ranges and per-symbol freshness. **0.26 s.**
4. `callers` / `callees node:<id>` — parser edges with `resultStatus`, `completeness`, `coverageGaps`. **0.26 s.**
5. `affected node:<id>` — **the only** source of tests, routes and blast radius. **0.24 s.**
6. `flow node:<endpoint>` — endpoint-to-data-boundary chain, 60 steps with per-step source. **0.29 s.**
7. `endpoints --repo <R> --protocol <p> --limit N [--cursor c]` — stable, portable, scope-checked pagination. **0.18-0.20 s.**
8. `endpoint-identity <title> <canonical> <nodeId>` — five-form identity equality. **instant.**
9. `deadcode --repo <R>` — candidates with an honest DI/reflection disclaimer. **0.43 s.**
10. `coverage --repo <R>` / `status --compact` / `doctor` — freshness and ledger health. **0.17 / 0.59 / 4.28 s.**
11. Scoped `search --repo <R>` — verified source occurrences with `contentHash` and byte offsets. **2.1-3.0 s.**
12. Cross-repo containment — `REPO_SCOPE_MISMATCH` with `expectedRepoId` and `actualRepoId`.

## 6. Operations requiring source reading or human intervention

1. **Any semantic judgement** — Penguin returns text and edges, never behaviour.
2. **gRPC handler identity** — `handlerStatus:"handled"` may mean a proto stub in another
   repo; the implementation must be found by hand or via `flow` on the *route*, not the
   endpoint.
3. **Anything past `flow` depth 4** — for example the cache-fill path behind
   `getColorLandEventConfigByIdFromCache`.
4. **Dead-code confirmation** — DI, decorators, reflection and dynamic import are unmodelled
   by design.
5. **Constructor calls, interface dispatch, static-method calls, callback-body calls** —
   declared unmodelled.
6. **CLI argument shapes** — `help --json` emits `"penguin <cmd> ..."` for all 42 commands and
   subcommand `--help` does not exist; I had to probe four forms to discover that
   `filesymbols` wants `<repo> <path>` or `--repo`/`--path`.
7. **Reconciling contradictory surfaces** — `tests`/`routes` (empty in `context` and
   `explore`, populated in `affected`), `freshness` (stale in `search`, fresh everywhere
   else), `unresolvedReferences` (0 vs 103,925), `proofStatus` (`not_proven` in `context`,
   `proven` in `flow`, same node).
8. **The 17 capabilities with no MCP tool** — reachability unknown.

## 7. Misleading, ambiguous, failed, unavailable or non-actionable outputs

Ordered by how likely each is to make an agent state a falsehood.

**S1 — MCP `knowledge_endpoints` silently ignores the `page` object.**

```
knowledge_endpoints {"repo":"FPMS-NT","protocol":"grpc","page":{"limit":3}}
  -> returnedCount 100        (limit ignored)
knowledge_endpoints {"repo":"FPMS-NT","protocol":"grpc","page":{"limit":3,"cursor":"<valid p1 cursor>"}}
  -> returnedCount 100, page ONE again, no error
knowledge_endpoints {"repo":"FPMS-NT","protocol":"grpc","page":{"limit":3,"cursor":"BOGUS"}}
  -> returnedCount 100, page ONE again, no error
knowledge_endpoints {"repo":"FPMS-NT","protocol":"grpc","limit":3,"cursor":"BOGUS"}
  -> {"error":{"code":"CURSOR_INVALID","retryable":false}}   <- only the top-level form validates
```

`page:{cursor,limit}` is the shape the capability manifest documents for paged operations. An
agent that follows it re-reads page one forever, with duplicate items and no signal. Both
`isError` and `warnings` are clean. The top-level `limit`/`cursor` form works correctly and
matches CLI exactly.

**S2 — MCP `knowledge_search` returns 0 hits for any explicit scope.**

```
knowledge_search {"query":"getActiveEventConfigByObjId"}                                   -> 20 hits (FPMS-NT 18, penguin-src 2)
knowledge_search {"query":...,"scope":{"revisions":[{"repoId":"repo_c58d58a2-..."}]}}      -> 0 hits
knowledge_search {"query":...,"scope":{"revisions":[{"repoName":"FPMS-NT","branch":"brazil-v2"}]}} -> 0 hits
```

CLI `search --repo FPMS-NT` for the same query returns 26 hits. The echoed scope shows the
cause: MCP resolves to `"snapshotId":"legacy:branch_10012ad4-..."`, whereas the CLI's scoped
search resolves to the real `"snapshot_804a4c86-..."`. Over MCP the only working search is
unscoped — which is both slow and cross-repo contaminated. **This manufactures false
"symbol does not exist" conclusions.**

**S3 — `endpoints` overclaims handler resolution.** `handlerStatus:"handled"`,
`missingHandlerReason:null` for endpoints whose only handler is a `nodeType:"service"` node
titled `proto` / `promotion` / `payment` / `userEngagement` in a *different* `repoId`, with no
file and no line. 200 of 200 sampled gRPC endpoints reported `handled`. The 6 HTTP endpoints,
by contrast, resolve to real handler symbols in FPMS-NT's own repo with `totalIsExact:true` —
so the defect is specific to gRPC handler resolution.

**S4 — `deadcode <REPO>` positional silently becomes a path filter.** Returns
`candidates:[] totalIsExact:true truncated:false` with `scope.repo:null`. Reads as a proven
"no dead code". `filesymbols` and `endpoints` accept the same positional as a repo, so the
inconsistency is unguessable.

**S5 — Four cross-surface contradictions at the same node and revision.**

| Field | `search` | `context` | `explore` | `flow` | `affected` |
|---|---|---|---|---|---|
| freshness | **`stale`** | `fresh` | `stale:false` | `fresh` | — |
| unresolvedReferences | — | **`0`** | **`103925`** | — | gap flag only |
| tests | — | **`[]`** | **`[]`** | 16 related | **6** |
| routes | — | **`[]`** | **`[]`** | — | **2** |
| proofStatus (endpoint node) | — | **`not_proven`** | — | **`proven`** | — |
| revision.trust | `exact_worktree` | `exact_commit` | `exact_commit` | `exact_commit` | — |

`search` reported `freshness:"stale"` on **every** call including scoped ones, while
`status --compact` reports FPMS-NT `fresh` with `indexedCommit == headCommit` and 0 dirty
files.

**S6 — Ambiguity is plain text on CLI under `--json`.** No error code, no `retryable`,
candidates labelled `(no file)`. MCP handles the same case correctly with `TARGET_AMBIGUOUS`
and a structured `candidates[]`.

**S7 — `filesymbols --file <path>` silently misroutes.** The path lands in the *branch* slot:
`repo "FPMS-NT" has no branch "apps/promotion/.../color-land-event-config.service.ts" indexed`.
No unknown-option error. `--path` is correct.

**S8 — `filesymbols` response shape depends on `--limit`.** Bare array without it, enveloped
object with it. Truncation is undetectable in the bare form.

**S9 — `knowledge_capabilities` is un-consumable over MCP.** 65,077 characters; the client
refuses it inline. `options.compact:true` is a no-op — measured `compactRatio: 1`,
`sentBytes == rawBytesEstimate == 15852` on `knowledge_search`.

**S10 — Canonical capability IDs rejected as `CAPABILITY_NOT_IMPLEMENTED`.** Wrong class for
"unknown tool name", and no "did you mean `knowledge_search`" hint.

**S11 — `context "node:"` (empty ID) degrades to fuzzy search** and matched Kafka topic names
instead of raising a validation error.

**S12 — `endpoint-identity` exits 0 on a total miss** with no error code and no remediation.

**S13 — Cursor errors carry no remediation.** `CURSOR_INVALID` and `CURSOR_SCOPE_MISMATCH`
have `code`, `message`, `retryable` and nothing else.

**S14 — Unscoped `search` is 63-87 s on CLI with no timeout warning.** `constructor` 65.34 s,
`execute` 63.18 s, `update` 87.00 s (scoped: 2.19 / 2.15 / 2.99 s). `mcp_health` advertises
`hardTimeoutMs: 15000`, which these calls exceed by 4-6x without being cut or flagged.

**S15 — Onboarding's "high-degree nodes" are all test files.** The top 6 of 8 entries in
`penguin onboarding FPMS-NT` are `*.spec.ts` (degrees 3217, 2649, 1024, 1001, 993, 929). A new
agent is pointed at the test suite, not at the architecture.

**S16 — `search` symbol lane ranks test mocks above definitions.** All 8 symbol-lane hits for
`getActiveEventConfigByObjId` were `kind:"field"` mocks in `*.spec.ts` with `nodeId:null`.

**S17 — Envelope inconsistency between global and scoped search.** Global omits the `warnings`
key entirely and returns `"scope": {}`; scoped includes `"warnings": []` and a populated scope.

## 8. Product failures versus environment failures

**Environment failures: none for Penguin.** Stable launcher on `PATH`, exactly one selected
runtime, MCP connected in the client, three fresh MCP server sessions in agreement, ledger
`ok` with `ledgerSeq == materializedSeq`. The dev fallback was never needed. (Four unrelated
non-Penguin MCP servers failed to connect in this client; irrelevant to Penguin.)

**Product failures:** S1 through S17 above. S1, S2, S3, S4 and S5 are correctness defects, not
environment artefacts — each was reproduced against a `fresh`, `aligned`, clean-worktree index
at a single commit, in more than one process.

Two items are genuinely environment-shaped and are **not** charged against product capability:

- Claude Code client reload (Q14 items 1 and 6) — unobservable from inside the session,
  `not proven`.
- Stale/wrong-revision ID error handling (Q11) — untestable without mutating the index, which
  the brief forbids. `not proven`.

## 9. Ordered improvements

| # | Improvement | Impact | Cost | Directly testable acceptance criteria |
|---:|---|---|---|---|
| 1 | Honour `page:{limit,cursor}` in `knowledge_endpoints` (and every paged MCP tool), or reject it with `CURSOR_INVALID` / `INVALID_ARGUMENT` | **Critical** — silent duplicate pages, possible infinite loop | S | `knowledge_endpoints {repo,protocol,page:{limit:3}}` gives `returnedCount == 3`; with page 1's cursor gives page 2 IDs with zero overlap; with `"BOGUS"` gives `isError:true`, `code:"CURSOR_INVALID"` |
| 2 | Fix MCP `knowledge_search` scope resolution (`legacy:branch_...` to real `snapshot_...`) | **Critical** — silent false negatives | S | `knowledge_search {query:"getActiveEventConfigByObjId", scope:{revisions:[{repoName:"FPMS-NT"}]}}` returns at least 20 hits, all `locator.repoName == "FPMS-NT"`, and `scope.revisions[0].snapshotId` matches CLI's `snapshot_804a4c86-...` |
| 3 | Stop reporting `handlerStatus:"handled"` for proto/package-only handlers | **Critical** — the most misleading claim found | M | For `grpc::AccumulativeEventConfigAdminService.getaccumulativeeventconfigs`, `handlerStatus != "handled"` **or** `handlers[0]` carries `filePath` and `startLine`; add `handlerKind:"implementation"` vs `"declaration"` |
| 4 | Make `context.coverage.unresolvedReferences` report the real count | **High** — the field that licenses negative claims | S | `context node:<any FPMS-NT symbol>` gives `coverage.unresolvedReferences == 103925` (matching `explore.queryDiagnostics`), and `coverageGaps` includes `unresolved_references_present` |
| 5 | Reject unknown positional scope instead of silently treating it as a path | **High** — false "zero dead code" | S | `penguin deadcode FPMS-NT --json` either returns the same 5647 candidates as `--repo FPMS-NT`, or errors `SCOPE_AMBIGUOUS` with `retryable:false` and a remediation naming `--repo` / `--path` |
| 6 | Emit structured JSON for ambiguity on CLI when `--json` is passed | **High** — CLI breaks JSON consumers | S | `penguin context execute --repo FPMS-NT --json` parses as JSON and yields `error.code == "TARGET_AMBIGUOUS"` with `details.candidates[].nodeId`, matching MCP |
| 7 | Populate `tests` and `routes` in `context` and `explore` from the same source as `affected` | **High** — recommended-first tool under-reports | M | `explore <file>#getActiveEventConfigByObjId` returns `tests.length == 6` and `routes.length == 2`, equal to `affected` on the same node |
| 8 | Fix `search.freshness` for scoped queries | **High** — contradicts `status` | S | `penguin search "x" --repo FPMS-NT --json` gives `freshness.status == "fresh"` while `status --compact` reports FPMS-NT `fresh` |
| 9 | Add `totalIsExact`, `truncated`, `completeness` and a depth marker to `flow` | High — `proven` on a truncated walk | S | `flow node:<endpoint>` includes `"maxDepthReached":true` and `completeness:"lower_bound"` whenever `depth == limit`; `proofStatus` is not `proven` for a 2-step proto-only chain |
| 10 | Give `endpoints` the standard evidence envelope | High | S | `endpoints --repo FPMS-NT --limit 3 --json` includes `locator`, `revision.commitSha`, `freshness`, `coverage`, `proofStatus`, `warnings` |
| 11 | Add `remediation` and `details` to cursor errors | Medium | S | `CURSOR_INVALID` and `CURSOR_SCOPE_MISMATCH` both carry `details.remediation` naming the re-issuing command |
| 12 | Real per-subcommand usage in `help --json` and a working `<cmd> --help` | Medium — cost me four probes on one command | M | `penguin help --json` gives `filesymbols` a usage string naming `<repo> <path>` / `--repo` / `--path`; `penguin filesymbols --help` exits 0 with that usage |
| 13 | Reject unknown flags instead of swallowing them as positionals | Medium | S | `penguin filesymbols --repo FPMS-NT --file <p>` gives `UNKNOWN_OPTION`, not a branch-not-found error |
| 14 | Make `filesymbols` always return the enveloped shape | Medium | S | `penguin filesymbols FPMS-NT <path> --json` (no `--limit`) returns an object with `items`, `totalIsExact`, `nextCursor` |
| 15 | Scope-aware ranking or disclosure for global `search`, plus a latency guard | Medium — 50/50 hits from one unrelated repo; 87 s | M | Global `search "update"` page 1 spans at least 3 repos **or** the envelope carries `scope.searchedRepos[]`; wall time under 15 s or a `TIMEOUT_PARTIAL` warning is emitted |
| 16 | Implement `options.compact` and add a compact capability manifest | Medium — manifest un-consumable over MCP | M | `knowledge_capabilities {compact:true}` under 8,000 characters listing IDs and status only; `knowledge_search {options:{compact:true}}` gives `stats.compactRatio < 0.6` |
| 17 | Return `UNKNOWN_TOOL` (not `CAPABILITY_NOT_IMPLEMENTED`) for dotted IDs, with a suggestion | Low | S | `tools/call "knowledge.search"` gives `code:"UNKNOWN_TOOL"`, `details.didYouMean:"knowledge_search"` |
| 18 | Validate empty and `node:`-only targets | Low | S | `context "node:" --repo FPMS-NT --json` gives `INVALID_TARGET`, exit 1, JSON; `search "" --json` gives `INVALID_ARGUMENT`, not exit 0 |
| 19 | Non-zero exit and error object from `endpoint-identity` on `equal:false` with all forms `no_match` | Low | S | exit 1 and `error.code == "TARGET_NOT_FOUND"` for `NoSuchService.Nope` |
| 20 | Pin `revision` into cursors | Low, but silent when it bites | S | Decoded `endpoints` cursor payload has `"revision":{"snapshotId":"snapshot_804a4c86-..."}`; reusing it after a re-index yields `CURSOR_STALE` |
| 21 | Rank definitions above test mocks in the symbol lane; give symbol hits a `nodeId` | Low | M | `search "getActiveEventConfigByObjId" --repo FPMS-NT` puts the method at `:135` as the top symbol hit, with a non-null `nodeId` |
| 22 | Exclude `*.spec.ts` from onboarding's high-degree list | Low | S | `penguin onboarding FPMS-NT` section 6 contains no `*.spec.ts` entry |

## 10. Final recommendation (Claude/Codex internal use only)

**Adopt, with three guardrails.**

Penguin 1.16.0 is the strongest evidence layer measured here so far. Node identity is stable
and portable across processes, surfaces and protocols; five endpoint identity forms converge
on one node; cross-repo targets are refused with a typed error carrying both repo IDs; the
handoff packet replayed 6/6 with zero reconstruction, including a CLI-minted cursor accepted
by a fresh MCP session. All four adversarial negative claims were correctly resolved to
`not proven` using Penguin's own `completeness`, `resultStatus`, `coverageGaps` and
`unresolvedReferenceCount` fields — the honesty machinery genuinely works. Node-scoped queries
run in 0.18-0.36 s, fast enough to make "query before grep" the default.

The three guardrails, until improvements 1-3 land:

1. **Do not paginate over MCP using `page:{}`.** Use top-level `limit` and `cursor`, or use
   the CLI. The `page` form returns page one silently, forever.
2. **Do not scope MCP `knowledge_search`.** It returns zero. Scope searches through the CLI
   (`--repo`), which is also about 30x faster than the unscoped MCP path.
3. **Never report a gRPC endpoint as "handled" from `endpoints` alone.** Confirm with `flow`
   and require a handler node that has a `filePath` and a `startLine`.

Two standing rules for any agent consuming Penguin:

- **`affected` is mandatory** in any change-impact packet. `context` and `explore` report
  `tests: []` and `routes: []` for nodes that demonstrably have 6 tests and 2 routes.
- **Treat every relation list as a floor.** `completeness` was `lower_bound` or `partial` on
  every graph operation in this round, and 103,925 references are unresolved in FPMS-NT alone.

Recommended default first call, unchanged from Penguin's own advice and confirmed by
measurement: `penguin explore <file>#<symbol> --repo <R> --json`, followed by
`penguin affected node:<id> --repo <R> --json`.

**Product overall 72 / 100. Environment readiness 95 / 100.**
The gap is not infrastructure. It is a small number of surfaces that quietly return a
confident-looking wrong answer — and those are exactly the ones an autonomous agent will
believe.
