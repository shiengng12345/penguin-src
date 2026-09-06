# Penguin Wiki / Knowledge Evaluation Brief — Fresh Round 18

> **Created:** 2026-08-31  
> **Purpose:** give a completely new Claude Code, Codex, or other MCP-capable AI session an independent, read-only test of Penguin Wiki/Knowledge after the Round 17 trust closure.  
> **Nature:** this is a question packet, not an answer key, implementation task, release approval, or permission to repair anything.  
> **New focus:** installed-runtime self-containment, capability honesty, graph/lexical truth, semantic/vector availability, duplicated service labels, cross-repository identity, evidence continuity, and two-agent replay.

## 0. Mandatory fresh-session boundary

Give this whole file to an AI session that has never seen earlier Penguin conversations or reports.

Before testing:

1. Completely exit the old Claude Code, Codex, Claude Desktop, and Penguin MCP processes used for earlier tests.
2. Start a new client process and a new conversation.
3. Do not paste any old node ID, endpoint ID, cursor, capability hash, revision, command result, score, or conclusion into the new session.
4. If the evaluator cannot prove the process/session is new, mark `FRESH_SESSION_NOT_PROVEN`. The evaluation may continue, but environment readiness cannot receive more than 69/100.

The evaluator must record:

| Field | Required evidence |
| --- | --- |
| Client | product, model, version, PID/session identifier if exposed |
| Session | start timestamp, timezone, why this is considered new |
| Penguin MCP | server name, initialize result, tools/list, health, generation |
| Penguin CLI | launcher path, runtime path if exposed, version/build ID |
| Contract | capability hash, schema version, contract version, tool/capability counts |
| Repository | repo ID/name, branch, commit, snapshot/revision, freshness |
| Coverage | discovered, admitted, excluded, failed, stale, unresolved references |

## 1. Strict source and mutation boundary

This is a Penguin-only black-box evaluation. The evaluator may use only:

- Penguin MCP tools already exposed to the fresh session;
- the installed stable Penguin CLI discovered from Penguin or the current environment;
- Penguin GUI Wiki/Knowledge read-only surfaces, if needed;
- Penguin-generated help, capabilities, health, status, coverage, onboarding, search, graph, Wiki, API, and error output.

The evaluator must not use:

- source-file reads, `grep`, `rg`, filesystem search, database/SQLite inspection, browser search, or external documentation;
- any old evaluation report, closure report, roadmap, answer key, screenshot, conversation, or remembered ID;
- any Git command, including read-only `git status`, `git log`, or `git diff`;
- `penguin index`, rebuild, repair, watch, repository registration/removal, note/memory/link/API writes, ontology changes, or suggestion acceptance;
- Tauri build, app installation, MCP reconfiguration, signing, release, deletion, or configuration edits.

The only permitted write is the new Round 18 evaluation report requested in Section 8.

If MCP is unavailable, use the installed stable CLI only. Do not construct a path from an old report. Record how the CLI path was discovered and mark MCP-only scenarios `N/A: MCP unavailable` with the exact evidence.

## 2. Evidence contract

Every Q and B scenario must contain this record:

```text
scenario:
surface: MCP | CLI | GUI
exact command/tool and exact inputs:
bounded raw evidence:
elapsed time:
exit/status/error code:
repo/branch/snapshot/revision:
freshness:
coverage:
candidateCount/returnedCount/totalIsExact:
cursor/hasMore/truncated:
evidence origin/method/confidence:
dynamic IDs and the result that emitted them:
workaround count:
verdict: PASS | PARTIAL | FAIL | N/A
confidence: high | medium | low
```

Global rules:

1. IDs and cursors must be emitted during this Round 18 session.
2. A repository claim must preserve the FPMS-NT repo scope through every follow-up.
3. Empty results, `no_match`, candidates, dead-code findings, inferred edges, external edges, and unresolved references do not prove absence.
4. `totalIsExact:false`, truncation, unexhausted cursors, excluded files, stale data, unresolved references, dynamic dispatch, DI, or reflection require a lower-bound or `not proven` conclusion.
5. A semantic/vector hit can find a candidate but cannot prove a call edge, request flow, unusedness, or absence.
6. “Configured”, “MCP Ready”, “app installed”, and “DMG exists” do not prove that this fresh process loaded the same runtime generation.
7. A capability listed in a manifest is not considered usable until a real call succeeds or returns a truthful structured unavailable status.
8. Never repair a failed scenario during this evaluation. Record the failure and continue.

## 3. Dynamic target-selection rule

Round 18 must not hard-code a known endpoint or symbol from an older report.

After preflight, take the last hexadecimal character of the current capability hash. Convert it to an integer from 0 to 15:

```text
endpointSelectionIndex = value mod 5
symbolSelectionIndex = value mod 3
```

Use zero-based indexing.

- For endpoint scenarios, request endpoint page 2 with `limit=5`, then select `endpointSelectionIndex` from that page.
- For symbol scenarios, run the scoped discovery query required by the question and select `symbolSelectionIndex` from the first three actionable FPMS-NT results.
- If there are too few results, use the last available result and record `DYNAMIC_SELECTION_FALLBACK`.
- Do not replace a failing selected target with an easier one unless the question explicitly permits it. A replacement counts as one workaround.

This rule ensures the evaluator cannot reuse a previous answer or node ID.

## 4. Preflight

Start from an empty prompt and discover exact commands/tool names from current Penguin help and MCP tools. Do not assume Round 17 command spelling.

At minimum execute the current equivalents of:

```text
help
capabilities
status
doctor
coverage for FPMS-NT
onboarding for FPMS-NT
MCP initialize
MCP tools/list
MCP health
MCP knowledge capabilities
```

Record all non-zero exits, protocol errors, timeouts, warnings, runtime generations, and duplicate tool/capability IDs before answering Q1.

## 5. New independent questions — Q1–Q20

### Q1 — zero-memory discovery test

Without relying on command names from this brief, use only the current help/capability surfaces to answer:

> What is the safest first sequence for investigating an unfamiliar FPMS-NT production symptom, and at which points must the agent stop before claiming causality or absence?

The sequence must include repository selection, freshness/coverage checks, a positive discovery step, dynamic-ID continuation, a negative-result rule, and an MCP-unavailable fallback. Execute every proposed command once.

Pass condition: all commands are current and copyable; advertised, callable, unavailable, and mutating capabilities are clearly distinguished.

### Q2 — capability honesty, including semantic/vector search

Inspect CLI and MCP capabilities for lexical, graph, semantic, vector, hybrid, blend, fallback, embedding, model, or vector-health fields.

For every semantic/vector-related claim:

1. record whether it is absent, experimental, unavailable, degraded, or ready;
2. record active model/space, dimensions, ready chunk/vector counts, provider, and degraded reason if returned;
3. attempt one permitted read-only semantic or blend query only if the current contract advertises such a mode;
4. compare it with explicit graph/lexical-only search;
5. verify the result identifies the retrieval lane instead of pretending all hits are proven graph facts.

If semantic search is unavailable and Penguin says so clearly, mark capability honesty `PASS` but semantic power `NOT IMPLEMENTED/UNAVAILABLE`. If Penguin claims ready while no read call works, or silently performs an unrelated fallback, mark `FAIL`.

Do not inspect the database or model files to fill missing evidence.

### Q3 — installed runtime self-containment

Using only exposed runtime/health/capability information and real calls, determine whether the installed CLI and MCP work without importing code or native modules from `/Users/shieng/Desktop/Pengvi`.

Check:

- launcher/runtime identity;
- build ID and generation;
- native dependency health reported by Penguin;
- whether a real CLI search and MCP search succeed;
- whether semantic/vector native-extension readiness is separately reported;
- whether output exposes a workspace path as an execution dependency.

Do not rename directories, disconnect files, inspect bundles, or modify the machine. If self-containment is not observable, conclude `not proven`; do not infer it from a successful app build.

### Q4 — canonical CLI/MCP contract parity

Choose one read-only capability from each class: discovery, search, graph, pagination, Wiki/API, and structured error. Compare CLI and MCP field-by-field:

- canonical capability ID and tool/command name;
- input schema and required fields;
- read-only/mutating annotation;
- build/hash/schema/contract;
- output envelope;
- error code, retryability, and remediation;
- scope, revision, freshness, coverage, and completeness.

A matching capability hash alone is insufficient. Report duplicate IDs, aliases that dispatch differently, or a tool that is listed but not callable.

### Q5 — concept query versus exact query

Ask Penguin this business-intent question without using a known filename or symbol:

> Where does FPMS-NT decide whether a withdrawal or payout operation may proceed, and which returned evidence is only a candidate?

Then derive an exact identifier from the current result and run a second exact/path-qualified query.

Compare:

- retrieval lanes;
- result ordering;
- repository precision;
- locator and node ID quality;
- proven, inferred, unresolved, and external evidence;
- whether semantic mode, if available, adds useful candidates;
- whether the exact result remains ahead of weaker semantic candidates.

Do not claim the business rule is correct without source review.

### Q6 — metamorphic search stability

Using the target selected in Q5, issue three equivalent queries:

1. exact identifier;
2. path-qualified identifier;
3. a short natural-language paraphrase based only on Penguin-returned terminology.

Run each twice in fresh CLI processes and, when available, once through MCP. Compare top results, node IDs, scope/revision, retrieval lane, and timing.

Pass condition: exact and path-qualified forms resolve deterministically; natural-language ranking may differ but must not cross repository scope or manufacture stronger proof.

### Q7 — dynamic endpoint selection and identity

Enumerate FPMS-NT endpoints with `limit=5`, continue to page 2 using the returned cursor, and select the endpoint using Section 3.

Test every identity form actually emitted or documented by Penguin:

- rendered title;
- canonical protocol identity;
- `node:<id>`;
- route form, if exposed;
- one intentionally corrupted identity.

Use endpoint identity, context, and flow. Record whether valid forms converge on the same node/revision and whether invalid input returns a structured, actionable error.

### Q8 — endpoint handler truth versus inventory decoration

For the Q7 endpoint, determine whether its reported handler is a real current-revision graph relation or only inventory metadata.

Carry the freshly emitted endpoint and handler IDs through context, flow, callers, and callees. Preserve edge type, origin, method, confidence, locator, scope, and revision.

Pass condition: the first hop agrees across CLI/MCP and across context/flow. Missing deeper hops must be presented as an evidence frontier, not a fabricated chain.

### Q9 — bounded request-flow reconstruction

Starting from the Q7 endpoint, attempt:

```text
endpoint -> handler -> service/use case -> external or data candidate -> tests
```

Produce a linear table with one row per hop. For every row, classify `proven`, `inferred`, `external`, `unresolved`, or `not proven`.

Stop at the first unsupported hop. The output must say what source/runtime evidence would be needed to continue.

### Q10 — duplicate service labels and cross-repository identity

Inspect the service map/list for repeated display labels, with particular attention to labels like `FPMS-NT-Auth-Player` if they are currently present.

For each repeated label:

- record its stable ID, repository ID/path if returned, service kind, revision, and edge counts;
- determine whether they are true duplicates, separate repo registrations, separate service nodes, aliases, or unresolvable display collisions;
- select one node and ensure context/path/services follow-ups do not silently switch to another node with the same title;
- compare GUI-visible label evidence with CLI/MCP identity evidence when GUI is available.

Do not conclude duplicate data from the label alone. If stable differentiating identity is missing, mark usability/identity `FAIL`.

### Q11 — file-target versus node-target affected parity

Use the dynamically selected symbol from Q5 or Q6. Run affected/impact once with its defining file and once with its emitted node ID.

Compare changed nodes, impacted nodes, tests, routes, scope, revision, proof status, truncation, and ordering through CLI and MCP.

File and node targets need not return identical sets if their semantics differ, but the difference must be documented and must not cross repositories. An empty set is not proof of safety.

### Q12 — coverage debt as actionable evidence

Using only Penguin status/coverage/doctor/read-only inventory surfaces, explain the current FPMS-NT coverage debt:

- discovered/admitted/excluded/failed/stale files;
- unresolved-reference count;
- reason, path, type, and pagination for exclusions/unresolved entries when exposed;
- which query classes remain useful despite the debt;
- which negative or completeness claims are blocked.

Attempt to retrieve at least one concrete excluded/stale/unresolved item through a documented read-only surface. If only aggregate counts exist, mark the debt “visible but not actionable.”

### Q13 — adversarial negative tri-state

For the Q5 symbol and Q7 endpoint, evaluate:

1. no production caller exists;
2. no test covers the target;
3. the endpoint never reaches an external/data boundary;
4. the service-label duplicate in Q10 has no effect on query routing.

Each conclusion must be exactly one of `proven`, `contradicted`, or `not proven`, with coverage, completeness, unresolved/dynamic caveats, and the extra evidence needed.

### Q14 — cursor portability without hidden process state

Test endpoint, file-symbol, and dead-code pagination independently:

1. request page 1 with a small limit;
2. preserve only the raw page-1 envelope and cursor;
3. continue page 2 in a new CLI process or new MCP session;
4. test malformed, exhausted, and wrong-repository cursors;
5. check stable ordering and duplicate IDs.

Any continuation that requires manually reconstructing an offset or title is a failure.

### Q15 — typed-error discrimination

Trigger all of these without mutation:

- missing target;
- empty query;
- unknown repository;
- ambiguous target;
- invalid node ID;
- wrong-repository node ID;
- malformed cursor;
- wrong-scope cursor;
- invalid endpoint identity;
- unsupported semantic mode, if semantic is unavailable.

Build a table of human message, JSON/MCP error, exit/status, retryable, category, and copyable remediation. `no_match` must not hide invalid, ambiguous, scope, stale, or unavailable cases.

### Q16 — Wiki/API knowledge freshness boundary

List current API documents/previews, notes, memories, tags, links/backlinks, evidence targets, and saved queries using only capabilities that are actually exposed.

Read one real API/Wiki object selected from current output. Check source, author/type, scope, revision, freshness, generated/manual state, sensitive/redaction metadata, backlinks, and whether a stale note is clearly separated from current code truth.

Do not create, update, export, sync, bind, delete, or repair anything. Missing provenance must reduce the score.

### Q17 — runtime-generation two-session replay

Agent A must record initialize output, MCP health, tools/list, capability hash, generation, one search node ID, and one structured error. Completely close Agent A's MCP session.

Agent B starts a new MCP session and repeats initialize, health, tools/list, and the same follow-ups using only Agent A's packet.

Compare server process/generation, build ID, capability hash, schemas, tool annotations, revision, node continuity, and error shape. Configuration presence alone is not reload proof.

### Q18 — timeout and latency honesty

Measure at least these cold and warm operations through fresh processes where possible:

- capabilities;
- scoped search;
- endpoint page;
- context;
- flow;
- affected;
- doctor;
- semantic/blend query if advertised.

Record p50-like median from at least three runs and the maximum observed time. A timeout must preserve `timedOut`, exit/status, partial evidence, and a safe retry path; it must not be projected as an empty successful graph result.

### Q19 — agent-to-agent investigation packet

Agent A creates a packet containing only current Penguin output:

- repo/branch/revision/coverage;
- Q5 symbol ID;
- Q7 endpoint and handler IDs;
- one cursor;
- one proven edge;
- one inferred/unresolved boundary;
- one typed error and remediation;
- exact next commands/tools.

Agent B receives only this packet in a completely new session and must replay context, flow, affected, cursor continuation, negative audit, and error remediation. Count every manual repair or substituted identifier.

### Q20 — installed, configured, loaded, and useful are four different claims

Using the complete Round 18 evidence, give four separate verdicts:

1. **Installed:** current app/runtime artifacts are visible to Penguin clients;
2. **Configured:** Claude/Codex configuration points to a Penguin launcher/server;
3. **Loaded:** this exact fresh process initialized the current build/generation;
4. **Useful:** the system answered scoped engineering questions with actionable evidence and honest limits.

Each verdict must cite a current-session observation. Never use one verdict as proof of another.

## 6. End-to-end workflows — B1–B8

### B1 — cold production-symptom triage

Start with only this prompt:

> A withdrawal or payout-related operation is not progressing in FPMS-NT. Use Penguin to identify likely code entry points and prepare a source/log investigation checklist without claiming an unproven root cause.

Use discovery, scoped search, context/flow, and coverage. Output an evidence frontier and next actions.

### B2 — dynamic gRPC request investigation

Use Section 3 to choose a page-two endpoint, continue endpoint -> handler -> service boundary, and produce a request-trace memo. Include stable IDs, revision, edge origins, incompleteness, and source-review requirements.

### B3 — safe-change decision

Use the selected symbol to build callers/callees/affected/tests/routes evidence. Give `GO`, `CONDITIONAL`, or `NO-GO`. Any missing critical edge, partial coverage, stale revision, or unresolved boundary must prevent unconditional GO.

### B4 — semantic recall honesty

Ask one exact and one conceptual business question. If semantic/vector retrieval is available, compare off versus blend/semantic and verify provenance. If it is unavailable, verify the product says so and continues with graph/lexical fallback without pretending semantic results exist.

### B5 — service-map collision investigation

Investigate one repeated service display label. Determine whether the nodes represent different repos/services or accidental duplicates. Carry one stable ID through a follow-up and document whether UI labels are sufficiently disambiguated.

### B6 — three-surface continuity

Continue one endpoint cursor, one filesymbol cursor, and one deadcode cursor in new processes/sessions. Then replay one emitted node ID through both CLI and MCP. Report hidden-state dependence, mismatch, or successful continuity.

### B7 — degraded-environment recovery

Simulate only through naturally occurring failures; do not break configuration. If MCP is unavailable or stale, use the documented CLI fallback. If semantic is unavailable, use graph/lexical. Record what remains usable, what is environmental, what is a product gap, and what remains unproven.

### B8 — final one-page decision packet

Output exactly this summary after all evidence sections:

```text
ROUND: 18
PRODUCT TRUST: GO | CONDITIONAL | NO-GO
ENVIRONMENT: READY | DEGRADED | NOT READY
GRAPH/LEXICAL: score and verdict
SEMANTIC/VECTOR: READY | EXPERIMENTAL | UNAVAILABLE | MISLEADING
CLI/MCP PARITY: score and verdict
FRESH SESSION: PROVEN | NOT PROVEN
SAFE WITHOUT SOURCE:
REQUIRES SOURCE/LOG/DB/HUMAN:
TOP 5 PRODUCT GAPS:
TOP 3 ENVIRONMENT GAPS:
EXACT RETEST COMMANDS/TOOLS:
```

## 7. Scoring

Give two independent percentages. Do not average them into one score.

### 7.1 Product capability — 100 points

| Dimension | Points | Required evidence |
| --- | ---: | --- |
| Discoverability/onboarding | 8 | safe cold start and copyable commands |
| Scoped search quality | 10 | exact, path-qualified, concept, collision safety |
| Context and source-pack usefulness | 10 | actionable locator, evidence, omissions |
| Graph/flow/affected quality | 14 | consistent proven first hops and honest frontier |
| Endpoint investigation | 10 | dynamic page-two target, identity, handler truth |
| Cross-repo/service identity | 8 | duplicate-label disambiguation and no scope leaks |
| Pagination and handoff | 10 | portable cursors/IDs across fresh processes |
| Accuracy and revision integrity | 8 | stable locator/scope/revision |
| Completeness and honesty | 10 | coverage debt, negatives, inference, not-proven rules |
| Semantic/vector usefulness | 7 | availability honesty plus real persisted retrieval if ready |
| Wiki/API provenance | 3 | freshness, source, revision and sensitive boundary |
| Recovery and speed | 2 | actionable errors and measured responsiveness |

Semantic/vector scoring guidance:

- `0–1/7`: misleading readiness, silent fallback, or unusable advertised mode;
- `2–3/7`: honestly unavailable with working graph/lexical fallback;
- `4–5/7`: experimental semantic retrieval works but lifecycle/quality is incomplete;
- `6–7/7`: persisted, scoped, reproducible retrieval with model/provenance and benchmark evidence.

### 7.2 Environment readiness — 100 points

| Dimension | Points | Required evidence |
| --- | ---: | --- |
| Installed stable launcher/runtime | 20 | current build and runtime identity |
| MCP initialize/tools/health | 20 | fresh successful protocol calls |
| CLI/MCP build/schema parity | 20 | same contract and real-call behavior |
| Fresh two-session generation proof | 20 | new sessions load and replay current generation |
| Installed-runtime self-containment | 10 | no observable workspace dependency; native health honest |
| Error/timeout observability | 5 | failures preserve transport evidence |
| Release/signing evidence | 5 | report only what current surfaces prove |

### 7.3 Hard caps

Apply these caps after dimension scoring:

| Failure | Maximum score |
| --- | ---: |
| Repository scope silently crosses to another repo | Product 69 |
| Emitted node ID cannot round-trip without title/path reconstruction | Product 79 |
| Empty/partial result is presented as proven absence | Product 69 |
| Semantic/vector is claimed ready but real read is unavailable or silently falls back | Product 79 |
| CLI and MCP return different build/hash/schema with no stale warning | Environment 59 |
| Fresh-session boundary is not proven | Environment 69 |
| MCP unavailable | Environment 59; product still scored from available surfaces |
| Evaluation uses source, DB, Git, old reports, or mutation | Run is non-compliant; no 95+ verdict allowed |

Round 18 is a broader capability benchmark than Round 17. A lower Round 18 score does not retroactively invalidate the frozen Round 17 95/100 trust result; it identifies the next capability gaps, especially semantic retrieval and service identity UX.

## 8. Required report

Create a new report without overwriting this brief or any previous report:

```text
docs/quality/index-evaluation-<model>-round18.md
```

Required section order:

1. Compliance statement and fresh-session evidence.
2. Client/runtime/MCP/CLI preflight table.
3. Product score /100 and environment score /100, including hard caps.
4. Q1–Q20 in order with the full evidence contract.
5. B1–B8 in order with end-to-end evidence.
6. Graph/lexical capability verdict.
7. Semantic/vector capability verdict.
8. Cross-repo/service-label identity verdict.
9. Operations safe without source reading.
10. Operations requiring source, logs, DB, runtime evidence, or human review.
11. Product defects versus environment failures versus unproven claims.
12. Ordered improvements with impact, cost, and a directly executable acceptance test.
13. The exact B8 one-page decision packet.

The report must include these three tables:

| Dynamic ID/cursor | Emitted by | Follow-up | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |

| Claim | Evidence lane | Completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |

| Capability | Advertised | Real call | CLI/MCP parity | Runtime status | Verdict |
| --- | --- | --- | --- | --- | --- |

## 9. Completion gate

Round 18 is complete only when:

- Q1–Q20 and B1–B8 are executed or individually marked with evidenced `N/A`;
- all IDs/cursors are fresh and their emitting results are recorded;
- dynamic endpoint selection follows Section 3;
- graph/lexical and semantic/vector are scored separately;
- service-label duplicates are investigated by stable identity, not visual title alone;
- endpoints, filesymbols, and deadcode cursor portability are tested;
- positive, negative, ambiguous, cross-scope, stale/revision, inferred, external, unresolved, unavailable, timeout, and structured-error cases are represented;
- CLI and MCP are compared through real calls when MCP is available;
- two genuinely new MCP sessions perform the runtime-generation replay;
- every negative claim contains coverage/completeness and uses `not proven` when needed;
- no source, DB, Git, old report, browser, configuration edit, build, re-index, repair, or knowledge write occurs;
- the new report uses the Round 18 filename and does not overwrite history.

<!-- Fresh-session question packet only. No answers or hidden expected IDs are included. -->
