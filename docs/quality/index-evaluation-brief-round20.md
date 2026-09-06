# Penguin Wiki / Knowledge Evaluation Brief — Fresh Round 20

> Created: 2026-08-31  
> Purpose: independent black-box retest of the installed Penguin Knowledge runtime after the vector-index, runtime-parity, WAL, and resume fixes.  
> Audience: a completely new Claude Code, Codex, or other MCP-capable AI session.  
> Boundary: Penguin Wiki/Knowledge is private on the owner's Mac. Every non-owner consumer is a new MCP-only user. Local CLI, source, database, index administration, and GUI access belong only to the owner and must not be used to compensate for a weak MCP experience.

## 0. Mandatory fresh-session setup

1. Fully quit every previous Claude Code, Codex, Claude Desktop, Cursor, and Penguin MCP process used for an earlier evaluation.
2. Start a new client process and a new conversation.
3. Give the evaluator only this file. Do not provide old reports, scores, commands, IDs, cursors, screenshots, capability hashes, or conclusions.
4. Do not open any earlier `index-evaluation-*` report.
5. The owner may confirm that the current Penguin app was installed, but installation is not proof that this session loaded its runtime.
6. Record client/model/version, session start time and timezone, client PID/session ID when exposed, MCP initialize result, Penguin server generation/build ID, capability hash, schema version, contract version, and repository revision.

If a genuinely new process cannot be evidenced, record `FRESH_SESSION_NOT_PROVEN`; continue the run, but cap Environment Readiness at 69/100.

## 1. Strict black-box and mutation boundary

The evaluator may use only:

- Penguin MCP tools exposed to this fresh session;
- MCP protocol initialize, tools/list, and health/capability calls;
- bounded information returned by those calls.

The evaluator must not use:

- local CLI or terminal as a substitute for MCP;
- source-file reads, `grep`, `rg`, filesystem search, SQLite/database inspection, Git, browser search, or external documentation;
- Penguin GUI, unless a scenario explicitly asks for an optional visual comparison; GUI evidence never replaces MCP evidence;
- old evaluation reports, plans, closure documents, screenshots, remembered IDs, or answer keys;
- index/re-index/watch, repository registration/removal, repair, migration, configuration, MCP reconfiguration, note/memory/API writes, export, delete, build, install, or release commands.

The only permitted write is the new report required by Section 9. If MCP is unavailable, record the exact connection/protocol evidence and continue only with environment analysis. Do not use CLI to award missing MCP points.

## 2. Required evidence record

For every Q and B scenario record:

```text
scenario:
MCP tool and exact inputs:
bounded raw result or exact error:
elapsed time:
build/generation/capability hash:
repo/branch/revision/snapshot:
freshness and coverage:
candidateCount/returnedCount/totalIsExact:
cursor/hasMore/truncated:
retrieval lane:
evidence origin/method/confidence:
dynamic IDs and the result that emitted them:
workaround count:
verdict: PASS | PARTIAL | FAIL | N/A
confidence: high | medium | low
```

Rules:

1. Every ID and cursor must be emitted in this Round 20 session.
2. Keep FPMS-NT scope through every follow-up; never repair a scope leak manually without counting a workaround.
3. A vector/semantic hit is a candidate, not proof of a call edge, flow, unusedness, runtime behavior, or absence.
4. Empty, truncated, partial, stale, excluded, unresolved, inferred, external, or unexhausted results cannot prove absence.
5. A listed capability is usable only after a real call succeeds or returns a truthful structured unavailable/degraded state.
6. `configured`, `installed`, `MCP Ready`, and `loaded by this session` are four separate claims.
7. If vector backfill is incomplete, record `ready/total/failed`, generation ID, and whether graph/lexical operations remain usable. Partial backfill is an environment/lifecycle state; hiding it or claiming complete readiness is a product failure.
8. Do not alter a failing target or retry with guessed IDs unless the scenario permits it. Count every manual repair.

## 3. Dynamic target selection

After preflight, take the final hexadecimal character of the current capability hash:

```text
endpointIndex = hexValue mod 5
symbolIndex = hexValue mod 3
```

- Enumerate FPMS-NT endpoints with `limit=5`, continue using the returned cursor to page 2, and select `endpointIndex` from page 2.
- Run the concept query in Q5 and select `symbolIndex` from the first three actionable FPMS-NT symbol results.
- If fewer results exist, select the last available result and record `DYNAMIC_SELECTION_FALLBACK`.
- Do not replace a difficult selected target with a convenient one.

## 4. Preflight

Starting from an empty prompt, discover Penguin through MCP rather than assuming tool names. Execute the current equivalents of:

- MCP initialize and tools/list;
- health/status;
- knowledge capabilities;
- onboarding/discovery for FPMS-NT;
- freshness/coverage for FPMS-NT;
- vector/semantic health and lifecycle status, if advertised.

Record duplicate tool IDs, missing annotations, protocol errors, timeouts, stale generations, unavailable tools, and whether all tools share one build ID/capability hash.

## 5. Independent questions — Q1–Q20

### Q1 — Zero-memory discoverability

Without using command names copied from this brief, ask Penguin how a new MCP-only user should investigate an unfamiliar FPMS-NT symptom safely. Execute the discovered read-only sequence once. It must cover repository selection, freshness/coverage, broad discovery, exact-ID continuation, negative-result limits, and source/log escalation.

### Q2 — Loaded runtime identity

Prove whether this exact session loaded the current Penguin runtime. Correlate initialize, health, tools/list, capabilities, build ID, generation, schema, contract, and capability hash. Configuration presence alone is insufficient. Report any mixed generation or schema.

### Q3 — MCP surface integrity

Classify every knowledge-related MCP tool as read-only, mutating, unavailable, experimental, or deprecated using exposed metadata. Select one tool from discovery, search, graph, pagination, affected, Wiki/API, semantic/vector, and typed-error classes and make a real bounded call. A listed-but-uncallable tool fails this scenario unless it returns a truthful structured unavailable status.

### Q4 — Repository precision and collision safety

Search for a common term globally and then scoped to FPMS-NT. Verify scoped results do not silently include another repository. Check result identity, locator, revision, retrieval lane, ordering, and collision metadata. Similar display titles must retain stable repository-qualified identity.

### Q5 — Concept-to-exact investigation

Ask only this business question:

> Where does FPMS-NT decide whether a withdrawal or payout-related operation may proceed, and which returned items are only candidates?

Select the dynamic symbol, then query its exact ID and path-qualified identity. Compare ranking, lane, node ID, locator, repository scope, revision, confidence, and evidence. Do not claim the business rule is correct without source/runtime evidence.

### Q6 — Metamorphic search stability

Run the selected Q5 target as exact ID, path-qualified name, and one natural-language paraphrase based only on returned terminology. Repeat each twice. Exact forms should be deterministic; conceptual ranking may vary but must not cross scope or strengthen evidence incorrectly.

### Q7 — Vector/semantic capability truth

Inspect vector/semantic/hybrid capability and health. Record provider, model, revision/hash, dimensions, backend, active vector space/generation, chunker version when exposed, ready, total, failed, lifecycle status, degraded reason, and runtime-download policy.

Run one exact query with graph/lexical-only behavior and one conceptual query using the advertised semantic/hybrid mode. Verify:

- the result states its retrieval lane;
- exact symbol/path results are not displaced by weak semantic candidates;
- semantic candidates preserve repo/revision/provenance;
- partial vector coverage is disclosed;
- unavailable semantic search never silently falls back while claiming semantic success.

### Q8 — Graph availability during vector backfill

If vector `ready < total`, immediately run scoped search, context, endpoint pagination, flow, and affected. These graph/lexical operations must remain usable and bounded. If all vectors are ready, record that condition and still run the same operations. A vector lifecycle job must not block graph publication or make MCP unusable.

### Q9 — Dynamic endpoint identity round-trip

Enumerate endpoint page 1 and page 2 using the emitted cursor, select the dynamic page-2 endpoint, and test every identity form Penguin emits: stable node ID, canonical protocol identity, rendered title/route when documented, plus one intentionally corrupted identity. Valid forms must converge on the same repo/revision/node. Invalid input must produce a typed actionable error.

### Q10 — Endpoint handler truth

For Q9, determine whether the handler link is a current graph relation or only display metadata. Carry endpoint and handler IDs through context, callers/callees, and flow. Preserve edge type, origin, confidence, locator, scope, and revision. Missing deeper edges define an evidence frontier, not an invented chain.

### Q11 — Bounded request flow

Attempt:

```text
endpoint -> handler -> service/use case -> external/data candidate -> tests
```

Create one row per hop and classify it `proven`, `inferred`, `external`, `unresolved`, or `not proven`. Stop at the first unsupported hop and state what source/log/runtime/DB evidence would be needed.

### Q12 — Affected file/node parity

Run affected/impact for both the Q5 defining file and Q5 node ID. Compare changed/impacted nodes, tests, routes, revision, proof state, completeness, truncation, and ordering. Different semantics are acceptable only when documented. Empty output never proves safe change by itself.

### Q13 — Service-label duplicates

Inspect service inventory/map for repeated display labels, including `FPMS-NT-Auth-Player` if present. For each repeated label record stable ID, repo ID/path when exposed, service kind, revision, and edge counts. Carry one stable ID into a follow-up and verify no silent switch. Distinguish true duplicate data, separate repository registration, separate service nodes, alias, and unresolved display collision.

### Q14 — Coverage debt and actionable inventory

Record discovered, admitted/indexed, excluded, failed, stale, unresolved, and vector-ready counts. Retrieve at least one concrete excluded/stale/unresolved item through a documented MCP read surface when counts are non-zero. If only aggregates exist, say `visible but not actionable`. Explain exactly which positive and negative claims remain possible.

### Q15 — Cursor portability

Test endpoint, file-symbol, and dead-code pagination independently. Obtain page 1 with a small limit, preserve only the envelope/cursor, then continue in a new MCP session. Test malformed, exhausted, and wrong-repository cursors. Record duplicate IDs and ordering. Reconstructing offsets/titles manually is a failure.

### Q16 — Typed error discrimination

Trigger read-only failures for missing target, empty query, unknown repository, ambiguous target, invalid node ID, wrong-repository node ID, malformed cursor, wrong-scope cursor, invalid endpoint identity, and unsupported semantic mode when applicable. Compare error code, message, category, retryable, remediation, transport status, and whether `no_match` is incorrectly used.

### Q17 — Adversarial negative tri-state

For Q5 and Q9, judge these claims only as `proven`, `contradicted`, or `not proven`:

1. no production caller exists;
2. no test covers the target;
3. the endpoint never reaches an external/data boundary;
4. a duplicate service label cannot affect routing;
5. no better semantic candidate exists outside current ready-vector coverage.

Every row must include completeness/coverage and missing evidence.

### Q18 — Wiki/API provenance boundary

List exposed API documents/previews, notes, memories, tags, links/backlinks, evidence targets, and saved queries. Read one object selected from current output. Check source/type/author, scope, revision, freshness, generated/manual state, sensitive/redaction metadata, and backlinks. Do not mutate. Separate remembered knowledge from current code evidence.

### Q19 — Two-session generation and ID replay

Agent A records initialize, health, tools/list, capabilities, build/generation/hash, one node ID, one endpoint ID, one cursor, one proven relation, and one typed error. Fully close Agent A's MCP session. Agent B receives only this packet, opens a new MCP session, and replays all follow-ups. Record generation continuity, schema/tool parity, cursor portability, and workaround count.

### Q20 — Installed/configured/loaded/useful separation

Give four separately evidenced verdicts:

1. Installed — an artifact exists or is reported;
2. Configured — the client points to Penguin;
3. Loaded — this process initialized the expected build/generation;
4. Useful — an MCP-only user completed scoped engineering investigations with honest limits.

Never use one verdict as proof of another.

## 6. End-to-end workflows — B1–B8

### B1 — Cold incident triage

Start only with: `A withdrawal or payout-related operation is not progressing in FPMS-NT.` Use MCP discovery, coverage, search, context, and flow to produce candidate entry points, an evidence frontier, and a source/log checklist without claiming a root cause.

### B2 — Dynamic gRPC investigation

Use the Q9 page-2 endpoint to produce an endpoint-to-handler-to-service trace memo with stable IDs, provenance, revision, completeness, unresolved boundaries, and exact next source/log checks.

### B3 — Safe-change decision

Use Q5 callers/callees/affected/tests/routes evidence. Return `GO`, `CONDITIONAL`, or `NO-GO`. Missing critical evidence, stale scope, partial coverage, dynamic dispatch, or unresolved boundaries must prevent unconditional GO.

### B4 — Hybrid recall honesty

Compare exact, graph/lexical, and conceptual semantic/hybrid queries. State what semantic retrieval improves and what it cannot prove. Include ready/total vector coverage and ensure partial coverage prevents global absence claims.

### B5 — Graph remains useful while semantics progress

If semantic backfill is incomplete, complete one real search -> context -> flow -> affected chain while recording vector progress before and after. The graph result must not depend on waiting for vector completion. If complete, run the chain and mark the incomplete-state branch `N/A: vectors already ready`.

### B6 — Service collision continuity

Investigate one repeated service label using stable identity and continue into a related endpoint or edge. Report whether display names are sufficient for a new MCP-only user and whether identity prevents cross-repo switching.

### B7 — Agent handoff

Agent A creates a packet containing only current Penguin output. Agent B replays context, flow, affected, cursor continuation, negative audit, semantic candidate retrieval, and one error remediation without old reports/source/CLI. Count all repairs.

### B8 — Final decision packet

Output exactly:

```text
ROUND: 20
PRODUCT CAPABILITY: <0-100>/100
MCP-ONLY USER EXPERIENCE: <0-100>/100
ENVIRONMENT READINESS: <0-100>/100
PRODUCT TRUST: GO | CONDITIONAL | NO-GO
ENVIRONMENT: READY | DEGRADED | NOT READY
GRAPH/LEXICAL: score and verdict
SEMANTIC/VECTOR: READY | PARTIAL | DEGRADED | UNAVAILABLE | MISLEADING
VECTOR PROGRESS: ready/total/failed and generation
MCP CONTRACT/PARITY: score and verdict
FRESH TWO-SESSION REPLAY: PROVEN | NOT PROVEN
SAFE WITHOUT SOURCE:
REQUIRES SOURCE/LOG/DB/HUMAN:
TOP 5 PRODUCT GAPS:
TOP 3 ENVIRONMENT GAPS:
EXACT MCP RETEST TOOLS/INPUTS:
```

## 7. Scoring

Give three separate scores. Do not average them.

### 7.1 Product capability — 100

| Dimension | Points |
| --- | ---: |
| Discoverability and onboarding | 7 |
| Scoped exact/concept search | 10 |
| Context/source-pack usefulness | 9 |
| Graph/flow/affected quality | 14 |
| Endpoint identity/investigation | 10 |
| Cross-repo/service identity | 7 |
| Pagination and handoff | 8 |
| Revision/provenance integrity | 8 |
| Completeness and negative honesty | 10 |
| Semantic/vector retrieval and lifecycle | 12 |
| Wiki/API provenance | 3 |
| Recovery, errors, and latency | 2 |

Semantic/vector receives 10–12 only when real scoped retrieval works, model/provenance/lane are visible, lifecycle state is truthful, graph remains usable during backfill, and partial coverage is not overstated. A fully ready local corpus is not required to prove lifecycle design, but incomplete vectors must reduce current environment/usefulness scores.

### 7.2 MCP-only user experience — 100

| Dimension | Points |
| --- | ---: |
| Fresh discovery without CLI/source/UI | 20 |
| Callable MCP surface and annotations | 20 |
| Stable IDs/cursors across sessions | 20 |
| Actionable engineering evidence | 20 |
| Honest degradation/errors/remediation | 10 |
| Speed and bounded output | 10 |

### 7.3 Environment readiness — 100

| Dimension | Points |
| --- | ---: |
| Current MCP initialize/tools/health | 25 |
| Loaded build/generation/schema identity | 20 |
| Fresh two-session replay | 20 |
| Repository freshness/coverage | 15 |
| Vector lifecycle health/progress | 15 |
| Timeout/error observability | 5 |

## 8. Hard caps

| Failure | Cap |
| --- | ---: |
| MCP unavailable after a real probe | MCP UX 20; Environment 39 |
| Fresh session not proven | Environment 69 |
| Scope silently crosses repository | Product 69; MCP UX 69 |
| Emitted node ID cannot round-trip | Product 79; MCP UX 79 |
| Empty/partial result presented as absence | Product 69 |
| Semantic claimed ready but unavailable/silent fallback | Product 79 |
| Vector partial state hidden or graph blocked by backfill | Product 79 |
| Two sessions load mixed build/schema without warning | Environment 59 |
| Source, DB, Git, CLI fallback, old reports, or mutation used | Non-compliant; no 95+ score |

Target acceptance is **95–100** for Product Capability and MCP-only User Experience. Environment may score lower only for clearly evidenced machine/session state that the product reports honestly; such a result is not permission to hide a product defect.

## 9. Required report

Create a new file without overwriting any brief or prior report:

```text
docs/quality/index-evaluation-<model>-round20.md
```

Required order:

1. Compliance and fresh-session proof.
2. MCP initialize/runtime/repository/vector preflight.
3. Three scores and hard caps.
4. Q1–Q20 with full evidence records.
5. B1–B8.
6. Graph/lexical verdict.
7. Semantic/vector quality and lifecycle verdict.
8. MCP-only consumer verdict.
9. Cross-repo/service-label identity verdict.
10. Safe-without-source versus source/log/DB/human boundary.
11. Product defects, environment failures, and unproven claims separated.
12. Ordered improvements with executable MCP acceptance tests.
13. Exact B8 packet.

Include these tables:

| Dynamic ID/cursor | Emitted by | Agent-B follow-up | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |

| Claim | Evidence lane | Coverage/completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |

| Capability | Advertised | Real MCP call | Build/generation | Runtime status | Verdict |
| --- | --- | --- | --- | --- | --- |

| Vector state | Model/revision | Ready/total/failed | Lane/provenance | Graph available | Verdict |
| --- | --- | --- | --- | --- | --- |

## 10. Completion gate

Round 20 is complete only when Q1–Q20 and B1–B8 are executed or individually evidenced as N/A; all IDs/cursors are fresh; MCP is the primary and only consumer surface; endpoint page 2 and three cursor families are tested; graph use during semantic progress is tested; semantic retrieval is real or truthfully unavailable; duplicate labels are checked by stable identity; two genuinely new MCP sessions replay the packet; every negative uses tri-state logic and coverage; no source/DB/Git/CLI/old-report/mutation is used; and the report is written to a new Round 20 filename.

<!-- Fresh-session question packet only. No answer key or hidden expected IDs. -->
