# Penguin Wiki / Knowledge Evaluation Brief — Fresh Round 22

> Created: 2026-08-31  
> Purpose: independent black-box verification of the installed Penguin MCP after semantic response-consistency, scope, cursor, coverage, performance, background-worker and runtime-alignment fixes.  
> Audience: one completely new Claude Code process or one completely new Codex process.  
> Deployment boundary: Penguin Wiki is private owner-operated infrastructure on this Mac. Every evaluator is a fresh **MCP-only consumer**. The evaluator must not depend on Tauri, a source checkout, terminal commands, SQLite, Git, old reports or remembered answers.

## 0. Mandatory fresh-process proof

1. Fully quit any AI client process used for an earlier Penguin evaluation.
2. Start a new client process and a new conversation. Give it only this immutable Round 22 file.
3. Do not provide previous reports, scores, IDs, cursors, screenshots, commands or conclusions.
4. Discover Penguin through MCP initialize and `tools/list`; do not assume tool names from this document are callable.
5. Record client/model/version, process or session ID when exposed, start time/timezone, MCP server name/version, running and available build IDs, runtime generation, schema, contract, capability hash and FPMS-NT revision.
6. Distinguish `installed`, `configured`, `loaded`, `healthy` and `useful`; none proves the next.

If a new process cannot be evidenced, mark `FRESH_SESSION_NOT_PROVEN` and cap Environment Readiness at 69. If Penguin MCP cannot initialize after one clean client restart, produce an environment-only report. Never substitute the local CLI.

## 1. Allowed and forbidden evidence

Allowed:

- Penguin MCP initialize, `tools/list`, annotations, health, onboarding, capabilities and Knowledge read tools;
- bounded structured results returned by those calls;
- one second genuinely new MCP client process for the explicit Agent-A/Agent-B handoff;
- owner-observed Tauri checks in Section 7, labelled `OWNER_UI_EVIDENCE` and excluded from MCP-only scoring.

Forbidden:

- terminal, shell, local `penguin` CLI, filesystem/source reads, SQLite, Git, browser/search engine or external documentation;
- old evaluation reports, plans, closure files, copied IDs/cursors or hidden answer keys;
- indexing, rebuilding, watching, registration, migration, repair, MCP reconfiguration, note/memory/API writes, export, delete, build or install;
- semantic/vector candidates used as proof of call edges, runtime behavior, absence or safe changes.

The only evaluator write is its new Round 22 report. Owner UI controls are permitted only in Section 7.

## 2. Evidence record and truth rules

Use this record for every Q and B scenario:

```text
scenario:
MCP tool and exact bounded input:
raw structured result or exact typed error:
elapsed time:
running/available build and generation:
capability/schema/contract identity:
repo/branch/revision/snapshot:
coverage/freshness/unresolved references:
hits/candidateCount/returnedCount/totalIsExact:
cursor/hasMore/truncated/remainingCount:
retrieval lane and evidence state:
origin/method/confidence:
dynamic IDs and emitting call:
workarounds:
verdict: PASS | PARTIAL | FAIL | N/A
confidence: high | medium | low
```

Binding truth rules:

1. Every target and cursor must be emitted in this Round 22 process.
2. Every follow-up must preserve FPMS-NT and the selected revision unless scope expansion is explicit.
3. `hits.length`, `returnedCount`, nested evidence counts and `queryStatus` must agree. Hits with `NO_MATCH`, `returnedCount=0` or a `NO_MATCH` warning are a product failure.
4. Exact graph/source evidence outranks semantic inference. Vector candidates are discovery leads only.
5. Only a verified active semantic generation may serve vector results. Staging, paused, failed or superseded generations must never leak into search.
6. Empty, partial, stale, excluded, unresolved, inferred, timed-out, truncated or unexhausted output cannot prove absence.
7. A tool is usable only after one real bounded call succeeds or returns a truthful typed unavailable/degraded result.
8. Configuration presence does not prove that this process loaded the current runtime. A stale process must expose `restartRequired=true`.
9. Count guessed identifiers, reconstructed offsets, manual scope repair, CLI/source fallback and extra client restarts as workarounds.

## 3. Fresh dynamic targets — no fixed answer key

After preflight, take the first eight hexadecimal characters of the current capability hash:

```text
endpointPage  = 2 + (hex[0] mod 3)
endpointIndex = hex[1] mod 5
serviceIndex  = hex[2] mod 4
conceptIndex  = hex[3] mod 3
```

1. Enumerate FPMS-NT endpoints with `limit=5`, following only emitted cursors to `endpointPage`.
2. Select `endpointIndex` from that page.
3. Enumerate the FPMS-NT service map/inventory with a bounded page or limit and select `serviceIndex` from the first four stable-ID entries.
4. Ask this concept question exactly once:

   > Which FPMS-NT components retrieve or transform CMS article configuration before returning it to an API caller, and which links are only semantic retrieval candidates?

5. Select `conceptIndex` from the first three actionable in-scope results.
6. If a requested page/index does not exist, choose the final available item and record `DYNAMIC_SELECTION_FALLBACK`; never choose an easier result.

## 4. Preflight

From an empty prompt, discover and call the current equivalents of:

- initialize, `tools/list`, health and runtime-generation status;
- Knowledge onboarding and capabilities;
- repository/service discovery for FPMS-NT;
- freshness, coverage and concrete coverage debt;
- semantic status: backend, provider/model revision/hash, dimensions, chunker, active/staging generations, ready/expected/running/pending/failed, state, reason, rate, ETA, lease/control and restart requirement.

Record duplicate tool IDs, missing read/write annotations, protocol errors, mixed identities, hidden partial state and whether Graph/Lexical is independently available.

## 5. Independent questions — Q1–Q20

### Q1 — Zero-memory safe onboarding

Ask Penguin how a first-time MCP consumer should investigate an unfamiliar FPMS-NT issue. Execute the discovered bounded read-only sequence. It must establish repository/revision scope, freshness, coverage, search, stable-ID continuation, evidence limits and the source/log/runtime escalation boundary without requiring CLI knowledge.

### Q2 — Loaded runtime identity

Correlate initialize, health, capabilities, semantic status and one real Knowledge query. Compare running/available build, generation, schema, contract and capability hash. State whether this process loaded the current installed runtime and whether restart guidance is truthful.

### Q3 — Repeated semantic result consistency

Run the Section 3 concept query three times with identical FPMS-NT scope, semantic mode, `limit=3` and compact output. For each run record latency, top-three file/symbol identities, `hits.length`, root/nested `returnedCount`, `candidateCount`, `queryStatus`, warnings, semantic applied/reason, ready/expected and generation. Results may differ only where the contract explicitly documents ranking nondeterminism. Metadata must describe the returned hits exactly.

### Q4 — Exact, lexical and semantic precedence

For the dynamic concept target, compare an exact symbol/ID query, a path-qualified query, a lexical phrase and one natural-language paraphrase. Record lane, rank reason, locator, revision, evidence state and provenance. Explain what semantic recall adds without converting inference into graph proof.

### Q5 — Stable symbol round-trip

Take one real symbol ID emitted by Q3/Q4. Carry it through context, callers, callees, graph exploration and source/evidence-pack retrieval where advertised. The target, repo and revision must remain stable. Corrupted and wrong-repository forms must return typed errors rather than silently selecting a namesake.

### Q6 — Scoped architecture isolation

Request FPMS-NT architecture, then a second currently indexed repository architecture using separately emitted IDs. Compare repository membership, revision and counts. No node/service/file from the other repository may leak into either scoped result.

### Q7 — Scoped note/evidence isolation

Discover a read-only note/evidence/wiki listing surface. Query it once for FPMS-NT and once for a different emitted repository. Verify repository filtering, sensitive/redaction metadata, stable pagination and provenance. If no notes exist, the empty result must still prove scope application but not absence of knowledge outside the selected scope.

### Q8 — Endpoint identity and cursor continuity

Follow endpoint cursors to the dynamic page and select the dynamic endpoint. Replay every emitted identity form—stable node ID, canonical protocol identity and route/title only where documented—plus one corrupted identity. Valid forms must converge; invalid forms must be typed and actionable.

### Q9 — Endpoint-to-boundary flow

For Q8, attempt `endpoint -> handler -> service/use case -> external or persistence boundary -> tests`. Label each hop `proven`, `inferred`, `external`, `unresolved` or `not proven`, preserving edge kind, locator, origin, confidence, scope and revision. Stop at the first unsupported hop.

### Q10 — Affected path/node parity and latency

Run affected/impact for both the defining file path and stable node ID from Q4/Q5. Compare changed/impacted nodes, routes, tests, proof state, completeness, truncation and order. Record warm latency twice. A fast empty result is not proof of safety.

### Q11 — Service graph usefulness and label collisions

Read the scoped FPMS-NT service graph/inventory and follow the dynamic service ID. For repeated display labels, preserve stable service ID, repository/path, kind, revision and edge counts. A label-only follow-up must not switch silently between same-labelled services. Record warm response latency and truncation.

### Q12 — Three independent cursor families

Test endpoint, file/symbol and dead-code/audit pagination independently with small limits. Continue every emitted cursor, including one continuation in Agent B. Test malformed, exhausted and wrong-scope cursors. Require stable ordering, no duplicate stable IDs, typed `invalid/stale/expired/wrong-scope` distinctions and a truthful remaining count when advertised.

### Q13 — Actionable coverage debt

Record discovered/admitted/indexed/excluded/failed/stale/unresolved and semantic ready/expected counts. For each non-zero debt category, retrieve one concrete item through a documented MCP read surface. Compare concrete unresolved-item total with aggregate unresolved count. If only an aggregate is available, mark `VISIBLE_BUT_NOT_ACTIONABLE`.

### Q14 — Semantic lifecycle integrity

Read semantic status twice at least five seconds apart. Record all active/staging/superseded states, progress counters, failures, worker identity, lease/heartbeat, rate/ETA and reason. Confirm historical replaced generations are `superseded`, not falsely `stalled`, and exactly one complete generation is active for the selected space.

### Q15 — Graph-first responsiveness

Read semantic status, immediately execute bounded `search -> context -> flow -> affected -> service graph`, then read status again. Graph/Lexical operations must remain available whether semantic work is active, complete, paused or unavailable. Record each latency and any timeout/partial warning.

### Q16 — MCP-only startup/wake readiness

With Penguin UI closed, start a genuinely new MCP process and read health plus semantic status before any other action. Perform one scoped conceptual query. If queued work naturally exists, verify MCP detects/wakes it without blocking initialize. If no queued work exists, mark wake execution `N/A_NO_QUEUED_WORK` and verify worker/runtime readiness without creating work.

### Q17 — Fresh Agent-A/Agent-B handoff

Agent A records current identity, one symbol ID, endpoint ID, service ID, one cursor from each family, one proven relation and semantic generation, then fully exits. Agent B receives only that MCP-emitted packet and this brief. Replay each item and report parity, repairs and restart requirement. No MCP reconfiguration is allowed.

### Q18 — Error taxonomy and remediation

Trigger bounded read-only errors for empty query, unknown repo, missing target, ambiguous name, invalid node ID, wrong-repository node ID, malformed cursor, wrong-scope cursor, corrupted endpoint identity, unknown workspace and unsupported semantic selection. Compare code, category, retryability, remediation and transport behavior. `no_match` must not erase invalid input, ambiguity or incomplete coverage.

### Q19 — Adversarial negative tri-state

Answer only `proven`, `contradicted` or `not proven`:

1. no production caller exists for the selected symbol;
2. no test covers the dynamic endpoint;
3. the endpoint never reaches an external/persistence boundary;
4. repeated service labels cannot affect selection;
5. no better semantic match exists beyond the returned top three;
6. all unresolved references are harmless;
7. closing Tauri stops MCP semantic capability.

Every answer must cite coverage/completeness, evidence lane and missing proof.

### Q20 — Private-owner boundary and useful verdict

Give separate verdicts for Installed, Configured, Loaded, Healthy and Useful. Explain which owner-only operations remain outside an MCP-only consumer's authority and why that is correct for the private deployment. Then separate current graph facts, semantic candidates, generated/manual notes and runtime/log/source verification boundaries.

## 6. End-to-end workflows — B1–B8

### B1 — Cold CMS article incident

Start only with: `An FPMS-NT API is returning the wrong CMS article configuration.` Produce candidate entry points, one bounded exact/semantic comparison, a graph trace, evidence frontier and exact source/log/runtime checks without claiming a root cause.

### B2 — Player operation investigation

Start only with: `An FPMS-NT player operation does not complete.` Use onboarding, scoped retrieval, stable IDs, context, flow and affected evidence. Return what is known, what is candidate-only and what requires logs/source/runtime.

### B3 — Hybrid retrieval audit

Compare exact ID/path, lexical/graph and conceptual semantic results for the dynamic concept target. Verify response-count/status consistency and describe ranking/provenance without treating vector similarity as execution proof.

### B4 — Safe-change decision

Using only current MCP callers/callees/affected/tests/routes evidence, return `GO`, `CONDITIONAL` or `NO-GO` for changing the selected concept target. Incomplete coverage, unresolved references, dynamic dispatch or unsupported boundaries must prevent unconditional GO.

### B5 — Cursor and identity handoff

Agent B continues all three cursor families and replays symbol, endpoint and service IDs from Agent A. Count every repair, duplicate or scope mismatch. Compare build/generation identity before accepting continuity.

### B6 — Scoped cross-repository comparison

Compare FPMS-NT with one other currently indexed repository using architecture/service evidence, while keeping every query explicitly scoped. Explain useful cross-service observations without mixing same-labelled nodes or revisions.

### B7 — Degradation honesty

Use naturally present state or safe invalid read inputs to demonstrate one degraded/unavailable/invalid semantic case and a successful Graph/Lexical call immediately afterward. Verify specific remediation and no false-ready/no-match contradiction.

### B8 — Exact final packet

Output exactly:

```text
ROUND: 22
PRODUCT CAPABILITY: <0-100>/100
MCP-ONLY USER EXPERIENCE: <0-100>/100
ENVIRONMENT READINESS: <0-100>/100
PRODUCT TRUST: GO | CONDITIONAL | NO-GO
ENVIRONMENT: READY | DEGRADED | NOT READY
GRAPH/LEXICAL: score and verdict
SEMANTIC/VECTOR: READY | PARTIAL | DEGRADED | UNAVAILABLE | MISLEADING
SEMANTIC RESPONSE CONSISTENCY: PROVEN | FAILED | NOT PROVEN
VECTOR PROGRESS: ready/total/failed and active/staging generation
BACKGROUND WORKER: ACTIVE | IDLE | PAUSED | RECOVERED | UNAVAILABLE | NOT PROVEN
MCP-ONLY WAKE: PROVEN | N/A-NO-QUEUED-WORK | NOT PROVEN
RESTART REQUIRED/HANDLED: YES-HANDLED | NO-CURRENT | NOT PROVEN
MCP CONTRACT/PARITY: score and verdict
THREE CURSOR FAMILIES: PROVEN | PARTIAL | FAILED
FRESH PROCESS HANDOFF: PROVEN | NOT PROVEN
OWNER UI CONTROL: PROVEN | NOT TESTED | FAILED
SAFE WITHOUT SOURCE:
REQUIRES SOURCE/LOG/DB/HUMAN:
TOP 5 PRODUCT GAPS:
TOP 3 ENVIRONMENT GAPS:
EXACT MCP RETEST TOOLS/INPUTS:
```

## 7. Owner-only Tauri checks — isolated evidence

These checks never repair MCP scores:

1. Open Penguin Wiki. `Graph` must be the default and `Focus` must be absent.
2. Confirm semantic state/progress/generation/model/reason and actions are visible without Terminal.
3. When active work naturally exists, Pause must persist across app restart, Graph must remain usable, and Resume must continue in the background without making the owner wait.
4. Retry/Cancel are used only when the current state advertises them; do not create failure merely to expose a button.
5. Record screenshot/timestamp as `OWNER_UI_EVIDENCE`.

If no active work exists, record `N/A_NO_ACTIVE_JOB`; packaged fault-injection evidence is outside this black-box score.

## 8. Scoring — three independent scores

### Product Capability — 100

| Dimension | Points |
| --- | ---: |
| Fresh discovery and scope safety | 8 |
| Exact/path/lexical/concept retrieval | 12 |
| Semantic response consistency and recall | 12 |
| Context/source evidence usefulness | 7 |
| Graph/flow/affected quality | 13 |
| Endpoint identity and pagination | 9 |
| Three cursor families | 8 |
| Coverage actionability and honesty | 9 |
| Architecture/service/note scope isolation | 8 |
| Lifecycle/background/runtime truth | 10 |
| Private-owner/provenance boundary | 4 |

### MCP-only User Experience — 100

| Dimension | Points |
| --- | ---: |
| New-session discoverability | 17 |
| Callable annotated surface | 13 |
| Bounded output and speed | 12 |
| Stable IDs and three cursors | 16 |
| Engineering evidence/actionability | 18 |
| Semantic status/result clarity | 14 |
| Fresh-process handoff without manual setup | 10 |

### Environment Readiness — 100

| Dimension | Points |
| --- | ---: |
| MCP initialize/tools/health | 20 |
| Running/available identity parity | 20 |
| FPMS-NT freshness/coverage | 15 |
| Active semantic generation integrity | 15 |
| Fresh Agent-A/Agent-B replay | 15 |
| Worker/wake/restart observability | 10 |
| Timeout/error observability | 5 |

Acceptance requires **95–100 Product Capability and 95–100 MCP-only User Experience** in both one independent Claude Code report and one independent Codex report.

## 9. Hard caps

| Failure | Cap |
| --- | ---: |
| MCP unavailable after one clean restart | MCP UX 20; Environment 39 |
| Fresh process not proven | Environment 69 |
| Silent repository/revision scope crossing | Product 69; MCP UX 69 |
| Emitted symbol/endpoint/service ID cannot round-trip | Product 79; MCP UX 79 |
| Hits/count/queryStatus/warnings contradict each other | Product 79; MCP UX 79 |
| Empty/partial result presented as absence | Product 69 |
| Semantic claimed applied while inactive/unavailable | Product 79 |
| Staging/superseded vectors queried or active pointer inconsistent | Product 69 |
| Graph blocked by semantic work | Product 79 |
| Architecture/note/service scope leak | Product 79 |
| Cursor requires reconstructed offset or silently changes scope | MCP UX 79 |
| Old session silently uses old runtime | Environment 59 |
| MCP-only wake needs CLI/Tauri workaround | MCP UX 84 |
| CLI/source/DB/Git/old-report fallback or evaluator mutation | Non-compliant; no 95+ score |

## 10. Required report

Create exactly one new file and never edit this brief or an older report:

```text
docs/quality/index-evaluation-<model>-round22.md
```

Required order:

1. Compliance and fresh-process proof.
2. MCP/runtime/repository/semantic preflight.
3. Three scores and hard caps.
4. Q1–Q20 evidence records.
5. B1–B8 workflows.
6. Semantic response-consistency table.
7. Scope-isolation and coverage-actionability verdicts.
8. Stable identity, cursor and handoff verdicts.
9. Lifecycle/background/restart verdicts.
10. Owner UI evidence, isolated.
11. Safe-without-source versus source/log/DB/human boundary.
12. Product defects, environment failures and unproven claims separated.
13. Ordered improvements with exact MCP-only retests.
14. Exact B8 packet.

Include these tables:

| Repeated semantic run | Hits | Returned root/evidence | Query status | Semantic applied/generation | Top identities | Verdict |
| --- | ---: | --- | --- | --- | --- | --- |

| Dynamic ID/cursor | Emitted by | Agent-B replay | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |

| Claim | Evidence lane | Coverage/completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |

| Capability | Advertised | Real MCP call | Build/generation | Runtime state | Verdict |
| --- | --- | --- | --- | --- | --- |

| Scope check | Requested repo/revision | Returned membership | Leak/ambiguity | Verdict |
| --- | --- | --- | --- | --- |

| Semantic generation | State | Ready/expected/failed | Active/staging/superseded | Served by search | Verdict |
| --- | --- | --- | --- | --- | --- |

## 11. Completion gate

Round 22 is complete only when Q1–Q20 and B1–B8 are executed or individually justified as N/A; all IDs/cursors are freshly emitted; repeated semantic responses have internally consistent counts/status/warnings; Graph works independently of vector lifecycle; exact truth outranks semantic inference; architecture, notes and service data remain scoped; coverage debt is concrete or honestly limited; three cursor families and symbol/endpoint/service identity survive Agent-B; every negative is tri-state and coverage-aware; owner UI evidence remains separate; and no forbidden fallback or mutation occurs.

Two independent fresh reports are required for program closure: one Claude Code and one Codex, each 95–100, neither reading the other's report.

<!-- Immutable fresh-session packet. No fixed IDs, old answers or hidden answer key. -->
