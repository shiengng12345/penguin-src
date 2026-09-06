# Penguin Wiki / Knowledge Evaluation Brief — Fresh Round 21

> Created: 2026-08-31  
> Purpose: independent black-box verification of the installed fire-and-forget semantic runtime, graph-first usability, restart recovery, and MCP-only engineering value.  
> Audience: one completely new Claude Code session or one completely new Codex session.  
> Deployment boundary: Penguin Wiki is private to the owner's Mac. A fresh evaluator is a new MCP-only Knowledge consumer. It must not compensate with the local CLI, source tree, database, Git, old reports, or Penguin UI. Owner-only Tauri checks are isolated in Section 7 and never replace MCP evidence.

## 0. Fresh-session proof is mandatory

1. Fully quit the AI client process used for any earlier Penguin evaluation.
2. Start a new client process and a new conversation. Give it only this immutable file.
3. Do not provide old scores, reports, commands, IDs, cursors, screenshots, hashes, or conclusions.
4. Discover Penguin from MCP initialize and `tools/list`; do not assume copied tool names are valid.
5. Record client/model/version, session start time and timezone, process/session ID when exposed, MCP server name/version, running and available build IDs, generation, schema, contract, capability hash, and repository revision.
6. Prove this process initialized Penguin. Installed/configured/healthy/loaded/useful are separate claims.

If a new process cannot be evidenced, mark `FRESH_SESSION_NOT_PROVEN` and cap Environment Readiness at 69/100. If Penguin MCP cannot initialize after one clean retry, continue only with an environment report; never use CLI as a substitute.

## 1. Allowed and forbidden evidence

The evaluator may use only:

- Penguin MCP initialize, `tools/list`, annotations, health, capability and Knowledge tools;
- bounded data returned by those calls;
- a second genuinely new MCP process for the explicit handoff/restart scenarios;
- owner-observed Tauri actions only in Section 7, clearly labelled `OWNER_UI_EVIDENCE`.

The evaluator must not use:

- terminal, local `penguin` CLI, filesystem/source reads, `rg`, `grep`, SQLite, Git, browser search, or external documentation;
- old evaluation reports, plans, closure files, remembered IDs/cursors, or hidden answer keys;
- repository registration/removal, index/rebuild/watch, migration, repair, MCP reconfiguration, note/memory/API writes, export, delete, build, or install;
- a semantic/vector candidate as proof of a call edge, runtime behavior, absence, or safe change.

The only permitted write is a new Round 21 report. Owner actions in Section 7 may pause/resume a currently advertised semantic generation through Tauri; the evaluator itself remains MCP-only and must not mutate Knowledge state.

## 2. Evidence template and truth rules

Use this block for every Q and B scenario:

```text
scenario:
MCP tool and exact bounded inputs:
raw result or exact typed error:
elapsed time:
running/available build and generation:
capability/schema/contract identity:
repo/branch/revision/snapshot:
coverage and freshness:
candidateCount/returnedCount/totalIsExact:
cursor/hasMore/truncated:
retrieval lanes:
evidence origin/method/confidence:
dynamic IDs and the result that emitted them:
workarounds:
verdict: PASS | PARTIAL | FAIL | N/A
confidence: high | medium | low
```

Truth rules:

1. Every ID, cursor, target, and claim must originate in this Round 21 session.
2. Keep FPMS-NT scope through every follow-up. A silent scope expansion is a product failure.
3. `ready`, `staging`, `paused`, `superseded`, `failed`, and `unavailable` are different lifecycle states.
4. Only an active generation may serve vector results. Partial/staging vectors are not queryable evidence.
5. Empty, truncated, stale, excluded, failed, unresolved, inferred, external, unexhausted, or partially vectorized output cannot prove absence.
6. A listed tool is usable only after a real bounded call succeeds or returns a truthful structured unavailable/degraded result.
7. One query embedding per request is expected; background document embedding must not block graph/lexical calls.
8. A client loading an older generation must expose `restartRequired=true`; configuration presence never proves reload.
9. Count every guessed ID, manual scope repair, CLI/source fallback, and client restart as a workaround.

## 3. Dynamic targets — no fixed answer key

After preflight, use the final two hexadecimal characters of the current capability hash:

```text
endpointPage = 2 + (penultimateHexValue mod 2)
endpointIndex = finalHexValue mod 5
conceptIndex = penultimateHexValue mod 3
```

1. Enumerate FPMS-NT endpoints with `limit=5` and follow emitted cursors until `endpointPage`.
2. Select `endpointIndex` from that page.
3. Run this new concept question exactly once:

   > Which FPMS-NT code paths coordinate a player/account operation before an external service or persistence boundary, and which results are only retrieval candidates?

4. Select `conceptIndex` from the first three actionable, in-scope symbol results.
5. If the requested page or index does not exist, select the final available item and record `DYNAMIC_SELECTION_FALLBACK`; do not choose an easier target.

## 4. Preflight

From an empty prompt, discover and execute the current equivalents of:

- MCP initialize and `tools/list`;
- health and runtime-generation status;
- Knowledge onboarding/capabilities;
- FPMS-NT repository resolution, freshness and coverage;
- semantic/vector status including provider, model revision/hash, dimensions, backend, chunker, active/staging generation, ready/total/failed, rate, ETA, control state and unavailable reason.

Record duplicate tool IDs, missing read/write annotations, protocol errors, timeout/cancellation behavior, mixed identities, stale runtime, hidden partial state, and whether graph/lexical remains advertised independently of semantic readiness.

## 5. Independent questions — Q1–Q20

### Q1 — Zero-memory MCP onboarding

Without quoting commands from this file, ask Penguin how a new AI should investigate an unfamiliar FPMS-NT production symptom safely. Execute the discovered read-only sequence. It must establish scope, freshness, bounded search, stable-ID continuation, evidence limits, and the source/log/runtime escalation boundary.

### Q2 — Exact process/runtime identity

Prove whether this session loaded the currently available runtime. Correlate initialize, health, capabilities and one real Knowledge call. Compare running/available build ID, generation, schema, contract and capability hash. If any identity differs, verify that `restartRequired` is explicit and actionable.

### Q3 — Graph-first availability

Before any semantic query, execute repository discovery, exact/path search, context and endpoint pagination. Record latency and evidence. These operations must work whether semantic state is active, staging, paused, failed or unavailable.

### Q4 — Semantic lifecycle truth

Read semantic status twice at least five seconds apart. Record state, generation IDs, expected/ready/running/pending/failed/terminal counts, progress, rate, ETA, lease/retry information, active pointer, backend and model identity. Explain whether work is progressing, idle, complete, paused, superseded, failed, or honestly unavailable.

### Q5 — Exact versus conceptual retrieval

Use the dynamic concept target. Query it by exact ID, exact path-qualified identity, one returned symbol name, and one paraphrase based only on current MCP output. Compare rank, lane, provenance, revision, candidate status and timing. Exact evidence must retain truth precedence over vector recall.

### Q6 — Semantic recall with code-language variation

Ask three bounded conceptual questions using natural-language/code-language pairs discovered in current output, such as protocol name versus decorator/identifier, singular versus plural, or snake_case versus prose. For each, record top five candidates and whether code-token reranking is disclosed without replacing the original vector similarity/evidence status.

### Q7 — Semantic unavailable honesty

Use only documented read-only inputs to request an unsupported semantic mode, unavailable space, or otherwise invalid semantic selection. Penguin must return a typed reason and preserve graph/lexical availability. It must not silently report semantic success after falling back.

### Q8 — Endpoint page and stable identity

Follow emitted cursors to the dynamic endpoint page and select the dynamic endpoint. Replay every identity form Penguin emits: stable node ID, canonical protocol identity, route/title if documented, plus one intentionally corrupted form. Valid forms must converge on one repo/revision/node; invalid input must be typed and actionable.

### Q9 — Endpoint-to-boundary flow

For Q8, attempt `endpoint -> handler -> service/use case -> external or persistence candidate -> tests`. Label each hop `proven`, `inferred`, `external`, `unresolved`, or `not proven`. Preserve edge kind, locator, origin, confidence, scope and revision. Stop at the first unsupported hop.

### Q10 — Context continuity

Carry the same endpoint and handler IDs through context, callers, callees and source-pack/evidence retrieval. Confirm no silent target switch, repository leak or revision drift. Explain what is current graph proof versus display metadata.

### Q11 — Affected path/node parity

Run affected/impact for both the dynamic concept target's defining path and stable node ID. Compare changed/impacted nodes, routes, tests, proof state, completeness, truncation and ordering. An empty result is not proof of safety unless the contract explicitly establishes completeness.

### Q12 — Coverage debt is actionable

Record discovered/admitted/indexed/excluded/failed/stale/unresolved files or symbols and vector-ready counts. When a count is non-zero, retrieve one concrete item through a documented MCP read surface. If only aggregates are exposed, mark `VISIBLE_BUT_NOT_ACTIONABLE` and reduce the score.

### Q13 — Service-label collision continuity

Inspect service inventory/map for repeated display labels. For every repeated label, record stable service ID, repository identity/path, kind, revision and edge counts. Carry one stable ID into a follow-up and verify it cannot silently switch to another same-labelled node.

### Q14 — Background progress does not block engineering

Read semantic status, immediately execute a bounded `search -> context -> flow -> affected` chain, then read status again. If work is incomplete, progress may continue in the background but graph operations must remain responsive. If complete, mark the progress branch N/A while still proving the graph chain.

### Q15 — MCP-only worker wake

In a genuinely new MCP process with Penguin UI closed, initialize and read semantic status, then perform one scoped conceptual request. Record whether queued work is detected/woken by the MCP runtime, whether the call remains bounded, and whether lifecycle state changes are truthful. If no queued work exists, mark wake observation N/A and verify the exposed worker/runtime readiness instead; do not create work.

### Q16 — Restart and stale-session recovery

Agent A records running/available identity, one node ID, one endpoint ID, one cursor, one proven relation and semantic generation. Fully close Agent A. Agent B starts as a new client process using only that packet. Replay all items and record continuity. If an upgrade is available, Agent A must say restart required and Agent B must load the available generation without manual MCP reconfiguration.

### Q17 — Three cursor families

Test endpoint, file/symbol and dead-code or equivalent audit pagination independently. Continue each emitted cursor in Agent B. Also test malformed, exhausted and wrong-repository cursors. Record duplicate IDs, stable order, typed errors and workaround count. Manually reconstructing offsets is a failure.

### Q18 — Error taxonomy

Trigger bounded read-only failures for empty query, missing target, unknown repo, ambiguous target, invalid node ID, wrong-repo node ID, malformed cursor, wrong-scope cursor, corrupted endpoint identity and unsupported semantic selection. Compare code, category, retryable, remediation and transport behavior. `no_match` must not erase ambiguity, invalid input or incomplete coverage.

### Q19 — Adversarial negative tri-state

Judge only `proven`, `contradicted`, or `not proven`:

1. no production caller exists for the dynamic concept target;
2. no test covers the dynamic endpoint;
3. the endpoint never reaches an external/persistence boundary;
4. duplicate service labels cannot affect target selection;
5. no better conceptual match exists outside current active-vector coverage;
6. closing Penguin UI stops all MCP semantic work.

Every answer must include coverage/completeness, evidence lane and missing proof.

### Q20 — Installed/configured/loaded/useful and provenance boundary

Give separate verdicts for Installed, Configured, Loaded and Useful. Then read one currently emitted Wiki/API/note/memory/evidence object without mutation. Separate remembered/manual/generated knowledge from current code graph evidence and report source, scope, revision, freshness, confidence and sensitive/redaction metadata.

## 6. End-to-end workflows — B1–B8

### B1 — Cold player/account incident

Start only with: `An FPMS-NT player/account operation is not progressing.` Produce candidate entry points, a bounded graph trace, evidence frontier and exact source/log/runtime checks without claiming a root cause.

### B2 — Graph while semantics is busy or unavailable

Complete a real scoped search -> context -> endpoint/flow -> affected chain. Record semantic state before/after. The graph chain must not wait for full vector completion and must remain available during truthful semantic degradation.

### B3 — Hybrid recall audit

Compare exact ID/path, lexical/graph and conceptual semantic queries for the dynamic concept target. State what semantic retrieval adds, how code-token reranking influenced order, and what remains only a candidate.

### B4 — Safe-change decision

Using only current MCP callers/callees/affected/tests/routes evidence, return `GO`, `CONDITIONAL` or `NO-GO`. Missing source truth, stale/incomplete coverage, dynamic dispatch or unresolved boundaries must prevent unconditional GO.

### B5 — Fresh-process handoff

Agent A hands Agent B only current MCP-emitted IDs/cursors/identity/status. Agent B replays context, flow, affected, cursor continuation, one semantic query and one typed-error remediation. Count every repair and compare build/generation parity.

### B6 — Collision-safe service investigation

Use one repeated service label to reach a related endpoint or edge through stable identity. Explain whether a new user can distinguish same-labelled nodes without local source or guessed repository paths.

### B7 — Failure and recovery honesty

Using naturally present state or safe invalid read inputs only, demonstrate one semantic unavailable/degraded/invalid case and one successful graph/lexical call immediately afterward. Report whether remediation is specific and whether the product avoids false-ready claims.

### B8 — Final decision packet

Output exactly:

```text
ROUND: 21
PRODUCT CAPABILITY: <0-100>/100
MCP-ONLY USER EXPERIENCE: <0-100>/100
ENVIRONMENT READINESS: <0-100>/100
PRODUCT TRUST: GO | CONDITIONAL | NO-GO
ENVIRONMENT: READY | DEGRADED | NOT READY
GRAPH/LEXICAL: score and verdict
SEMANTIC/VECTOR: READY | PARTIAL | DEGRADED | UNAVAILABLE | MISLEADING
VECTOR PROGRESS: ready/total/failed and active/staging generation
BACKGROUND WORKER: ACTIVE | IDLE | PAUSED | RECOVERED | UNAVAILABLE | NOT PROVEN
MCP-ONLY WAKE: PROVEN | N/A-NO-QUEUED-WORK | NOT PROVEN
RESTART REQUIRED/HANDLED: YES-HANDLED | NO-CURRENT | NOT PROVEN
MCP CONTRACT/PARITY: score and verdict
FRESH PROCESS HANDOFF: PROVEN | NOT PROVEN
OWNER UI CONTROL: PROVEN | NOT TESTED | FAILED
SAFE WITHOUT SOURCE:
REQUIRES SOURCE/LOG/DB/HUMAN:
TOP 5 PRODUCT GAPS:
TOP 3 ENVIRONMENT GAPS:
EXACT MCP RETEST TOOLS/INPUTS:
```

## 7. Owner-only Tauri checks — separate evidence lane

These checks are performed by the owner while the evaluator remains MCP-only. They do not add MCP-only points and cannot repair an MCP failure.

1. Open Penguin Wiki. Graph must be the default tab and Focus must be absent.
2. Confirm semantic status is visible without opening a terminal: state, progress, ready/total/failed, rate/ETA, generation and reason.
3. If active work exists, click Pause once. MCP status must show persisted paused state and graph calls must still work.
4. Close and reopen Penguin. Paused state must remain honest.
5. Click Resume once. MCP status must show resumed/background progress without forcing the owner to wait in the UI.
6. Retry/Cancel are tested only when their documented state permits them; never create a destructive condition merely to expose a button.
7. Record screenshots/timestamps as `OWNER_UI_EVIDENCE`; do not give the evaluator direct GUI access or score them as MCP evidence.

If no active/staging job exists, mark Pause/Resume `N/A_NO_ACTIVE_JOB` and rely on packaged acceptance evidence only outside the black-box score. Never pause a different repository merely to satisfy this brief.

## 8. Scoring

Give three separate scores; do not average them.

### Product capability — 100

| Dimension | Points |
| --- | ---: |
| Fresh discovery and scope safety | 8 |
| Exact/path/concept retrieval | 12 |
| Context/source-pack usefulness | 8 |
| Graph/flow/affected quality | 14 |
| Endpoint identity and pagination | 10 |
| Coverage/completeness honesty | 9 |
| Service/cross-repo identity | 7 |
| Semantic recall and provenance | 12 |
| Background lifecycle/recovery truth | 10 |
| Runtime identity, errors and parity | 7 |
| Wiki/API provenance boundary | 3 |

### MCP-only user experience — 100

| Dimension | Points |
| --- | ---: |
| New-session discoverability | 18 |
| Callable annotated surface | 15 |
| Bounded output and speed | 12 |
| Stable IDs and three cursor families | 15 |
| Engineering evidence/actionability | 18 |
| Semantic status and degradation clarity | 12 |
| Restart/handoff without manual reconfiguration | 10 |

### Environment readiness — 100

| Dimension | Points |
| --- | ---: |
| MCP initialize/tools/health | 20 |
| Running/available build-generation identity | 20 |
| Fresh Agent-A/Agent-B replay | 15 |
| FPMS-NT freshness/coverage | 15 |
| Active semantic generation integrity | 15 |
| Worker progress/wake/restart observability | 10 |
| Timeout/error observability | 5 |

Target acceptance is **95–100** for Product Capability and MCP-only User Experience in both an independent Claude Code report and an independent Codex report.

## 9. Hard caps

| Failure | Cap |
| --- | ---: |
| MCP unavailable after one clean retry | MCP UX 20; Environment 39 |
| Fresh process not proven | Environment 69 |
| Silent repository scope crossing | Product 69; MCP UX 69 |
| Emitted node/endpoint ID cannot round-trip | Product 79; MCP UX 79 |
| Empty/partial result presented as absence | Product 69 |
| Semantic claimed ready while inactive/unavailable | Product 79 |
| Staging vectors queried or active pointer inconsistent | Product 69 |
| Graph blocked by semantic backfill | Product 79 |
| Background state hidden or false progress shown | Product 79 |
| Old session silently uses old runtime | Environment 59 |
| MCP-only wake requires manual CLI/Tauri workaround | MCP UX 84 |
| Source/DB/Git/CLI/old-report fallback or evaluator mutation | Non-compliant; no 95+ score |

## 10. Required report

Create one new file; never overwrite a brief or older report:

```text
docs/quality/index-evaluation-<model>-round21.md
```

Required order:

1. Compliance and fresh-process proof.
2. MCP/runtime/repository/semantic preflight.
3. Three scores and applied hard caps.
4. Q1–Q20 evidence records.
5. B1–B8 workflows.
6. Graph-first and semantic lifecycle verdicts.
7. Background worker, MCP-only wake and restart verdicts.
8. Stable identity, cursor and service-collision verdicts.
9. Owner-only Tauri evidence, clearly isolated.
10. Safe-without-source versus source/log/DB/human boundary.
11. Product defects, environment failures and unproven claims separated.
12. Ordered improvements with executable MCP-only retests.
13. Exact B8 packet.

Include these tables:

| Dynamic ID/cursor | Emitted by | Agent-B replay | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |

| Claim | Evidence lane | Coverage/completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |

| Capability | Advertised | Real MCP call | Build/generation | Runtime state | Verdict |
| --- | --- | --- | --- | --- | --- |

| Semantic state | Model/space | Ready/total/failed | Active/staging | Graph available | Verdict |
| --- | --- | --- | --- | --- | --- |

| Background event | Before | Action/trigger | After | Persisted across restart | Verdict |
| --- | --- | --- | --- | --- | --- |

## 11. Completion gate

Round 21 is complete only when Q1–Q20 and B1–B8 are executed or individually justified as N/A; all IDs/cursors are fresh; Graph works independently of semantic progress; semantic retrieval is real or truthfully unavailable; active/staging generations cannot mix; background status is observable; MCP-only wake is proven or honestly N/A because nothing is queued; old-session restart behavior is handled; three cursor families and stable service identity survive Agent-B replay; every negative is tri-state and coverage-aware; owner-only UI evidence remains separate; and no prohibited fallback or mutation is used.

Two independent reports are required for final program closure: one fresh Claude Code report and one fresh Codex report, each targeting 95–100 without reading the other's report.

<!-- Immutable fresh-session packet. No fixed IDs, old answers, or hidden answer key. -->
