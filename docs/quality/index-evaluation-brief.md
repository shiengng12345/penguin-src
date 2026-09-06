# Penguin Knowledge Evaluation Brief — Round 27 (Active Full Copy)

Canonical immutable copy: `docs/quality/index-evaluation-brief-round27-frozen.md`.

Rubric contract hash (SHA-256): `91014055cdb03d3a8f78f4dbeabb9711e2f2b4fff0d0715f01fda41048f1e8a8`

## 1. Mission

Run a genuinely fresh, black-box acceptance evaluation of the currently installed Penguin Knowledge runtime. Round 27 preserves the complete Round 26 engineering-investigation surface and adds an explicit closure matrix for every defect reproduced during Round 26. Category weights remain unchanged.

Do not reuse any target, answer, repository ranking, path, symbol, endpoint, node ID, cursor, timing, score, or conclusion from any earlier round.

## 2. Strict evaluator boundary

The evaluator must:

- start in a new operating-system Claude Code or Codex process after Penguin App provisioning;
- read only this brief before product testing;
- must not read any previous evaluation report, including another evaluator's Round 27 report;
- use Penguin MCP as the only product and data path after reading the brief;
- Do not inspect source, Git, SQLite, plans, bundles, terminal output, old reports, or Penguin CLI; do not use another code-index product;
- remain read-only and never modify the knowledge index, semantic lifecycle, notes, configuration, or repository state;
- NEVER call `knowledge_repository_register`, `knowledge_index`, or `knowledge_rebuild`, even with `confirmed:false`;
- never call Pause, Resume, Retry, Cancel, note-write, memory-write, or any other mutating operation;
- discover all repositories, roots, symbols, files, endpoints, services, node IDs, generation IDs, and cursors from current MCP responses;
- label unsupported claims `UNPROVEN`, `PARTIAL`, `BLOCKED`, or `N/A` rather than guessing.

Writing exactly one required evaluation report is allowed and is not a product-data fallback.

## 3. Product and scoring boundary

Penguin Wiki/Knowledge is private owner-local infrastructure on this Mac. Other users are fresh MCP-only consumers. Score the first-user MCP engineering experience. Public signing, notarization, distribution, cloud hosting, and multi-user Wiki access are out of scope.

Graph and lexical lanes are factual retrieval paths and must remain usable when semantic work is unavailable, queued, paused, incomplete, retrying, stalled, cancelled, or superseded. Vector similarity can improve discovery but cannot independently prove execution, ownership, direction, or completeness.

Owner-only Tauri evidence is recorded separately and does not add MCP score.

## 4. Fresh bootstrap and dynamic selection

Before Q1:

1. Initialize Penguin MCP and capture the fresh session ID and client connection timestamp.
2. Read health, runtime identity, capability manifest, semantic status, architecture, repository inventory, service inventory, endpoint inventory, and coverage.
3. Select from current MCP output only:
   - `Largest Repo`: admitted repository with the largest current source-file coverage;
   - `Second Repo`: a different admitted repository with enough source evidence to search;
   - `Natural Intent`: a new 4–6 word business intent whose terms are not all adjacent in likely source;
   - `Primary Symbol`: a currently returned symbol in Largest Repo;
   - `Relation-rich Symbol`: a currently returned symbol with multiple first-hop relation kinds when available;
   - `Primary File`: the defining path of Primary Symbol;
   - `Primary Endpoint`: a currently implemented endpoint with at least one downstream hop when available;
   - `Service Pair`: two currently reported related services.
4. Record the MCP discovery chain for every target.
5. Do not select a target copied from this brief or an old report; there is no fixed answer key.

<!-- BEGIN ROUND27 IMMUTABLE RUBRIC -->
## Required scenarios Q1–Q20

### Q1 — Fresh runtime identity chain

Correlate initialize, health, capability manifest, semantic status, and one bounded query. Record session ID, connection time, server version, app version, running and available build IDs, restart-required state, schema version, contract version, and capability hash. Distinguish `configured`, `loaded`, `healthy`, and `useful`. Any old/new runtime mixture is a hard failure.

### Q2 — Capability schema and annotation audit

Discover the canonical MCP operation for architecture, repositories, services, exact/lexical/hybrid search, node lookup, context, flow, affected analysis, files, endpoints, coverage, semantic status/control, dead code, onboarding, doctor, repository registration, index, and rebuild. For every advertised tool sampled, verify `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` agree with `mutating` and observed behavior. List aliases and duplicate concepts separately.

### Q3 — Repository ranking and source/graph file reconciliation

Select Largest Repo from current evidence. Page its file inventory with a small limit. Reconcile:

- admitted source files;
- graph-parsed files;
- source-and-graph files;
- `source-only` files;
- graph-only files;
- candidate/global total;
- page item count and `returnedCount`;
- total exactness/lower-bound flags, truncation, and cursor.

Verify the supplied equations reconcile. Sample at least three `source-only` entries when available and explain why searchable admitted files need not contain graph symbols. A mismatch hidden behind one headline total fails this scenario.

### Q4 — Same multi-term query across two repositories

Run the same 4–6 word query (`Natural Intent`) in Largest Repo and Second Repo, then repeat each call once with identical scope/options/limit. Record all four durations, query status, candidate/root/evidence counts, requested/applied semantic state, top paths/symbols/stable identities, warnings, and cursor. Use a 30-second hard budget per call.

The query terms must not all be an adjacent phrase. Relevant source/controller/service/repository evidence should rank ahead of broad documentation noise. One README must not consume the result page. Compare deterministic stability between each pair of repeated calls.

### Q5 — Exact occurrence continuation

Choose a currently discovered identifier or phrase that occurs more times than a deliberately small page limit. Run exact or phrase search and continue using only returned cursors until at least three pages or exhaustion. Verify every occurrence has file/line/snippet provenance, pages do not overlap, repeated occurrences in one file are not collapsed, totals/limits are truthful, and cursor exhaustion is deterministic.

### Q6 — Exact, lexical, semantic retrieval triangle

Recover Primary Symbol using an exact identifier/path, a natural lexical description, and a semantic paraphrase. Compare rank, lane, provenance, scope, stable identity, timing, warnings, and requested/applied/generation fields. If semantic is unavailable or not applied, require a typed reason while exact/lexical results remain useful.

### Q7 — Semantic generation fixed point

Read semantic status twice at least five seconds apart. Reconcile active, staging, and superseded generations; canonical scope; expected/ready/pending/running/retryable/terminal counts; provider/model/revision; dimensions; weights/tokenizer/preprocessing digests; pooling; normalization; chunker version; worker lease/heartbeat/rate/ETA. `active` is valid only for one compatible, complete, atomically selected generation. Do not infer progress from elapsed time alone.

### Q8 — Hybrid evidence decomposition

Run one hybrid query with explicitly nested semantic options. For the highest useful results, separate source text, exact/path, graph relation, and vector-similarity evidence. State what each lane can and cannot prove. Record semantic requested/applied/generation status and any fallback reason.

### Q9 — Global context cursor budget

For Relation-rich Symbol, request context with one global relation limit of 2. Continue at least three pages using only returned cursors. Each page may contain at most two relation items across all relation families combined, not two per family. Verify stable ordering, no overlap, no scope drift, no skipped first-hop item within the advertised total, and deterministic exhaustion.

### Q10 — Cursor support truth table

From capability metadata, list operations that advertise cursor support. Obtain and continue fresh cursors for search, files, context, affected, endpoints, and saved-query execution when honestly supported. Mark unsupported families explicitly. A capability must not claim cursor support if its schema lacks the input or its handler ignores it.

### Q11 — Stable identity round trip

Carry Primary Symbol through search → node lookup → context → affected → search. Compare canonical/node identity, repository, revision/snapshot, path, kind, display name, and provenance. Then carry Primary Endpoint from inventory → continuation page → flow. A tool refusing its own freshly emitted stable identity is a hard failure.

### Q12 — Endpoint continuation and boundary flow

Page endpoint inventory at least three pages with a small limit. Verify no overlap, omission within advertised order, repeated cursor, or scope drift. Trace Primary Endpoint from declaration through handler and service to persistence or outbound boundary. Mark every hop `direct`, `inferred`, `unresolved`, `missing`, or `truncated`; declaration-only is not a complete flow.

### Q13 — Affected parity and test evidence

Run affected analysis for Primary File and Primary Symbol identity with the same scope/depth/limit. Compare impacted nodes, sibling symbols, tests, endpoints, services, confidence, evidence, lower-bound caveats, and continuation. Cross-check context and graph test edges. A filename containing `test` is not by itself proof of executable coverage.

### Q14 — Concrete coverage and cache hygiene

Page at least two concrete coverage-debt families for Largest Repo, including unresolved or stale items when non-zero. Reconcile aggregates with concrete returned items, exactness/lower bounds, page counts, and cursor. Then search for `.pnpm-store`, `.npm`, `.yarn/cache`, `.yarn/unplugged`, and `.bun/install/cache` pollution. Conclude only “not admitted/indexed in current evidence” unless coverage proves more. Any cache file returned as current source evidence is a failure.

### Q15 — Read-only owner mutation preflight

Inspect repository-register, index, and rebuild schemas and annotations, but NEVER invoke those mutating tools. Verify each exposes an owner-local `root_path` or compatible `path`, explicit `confirmed`, and truthful safety annotations.

Use only `knowledge_doctor` with `mutation_preflight`:

1. choose one owner root emitted by current MCP and preflight one action;
2. verify `readOnly:true`, `mutationPerformed:false`, canonical root, confirmation requirement, and canonical next action;
3. preflight an existing out-of-scope system root and require `ROOT_PATH_OUT_OF_SCOPE` plus preserved MCP-native `remediation`;
4. if the transport schema permits a malformed action/object, require `MUTATION_PREFLIGHT_INVALID`; if schema validation blocks it before handler execution, record schema enforcement instead of bypassing it;
5. verify repository/index/semantic status did not change before versus after.

No permission prompt or mutation should occur in this scenario.

### Q16 — Cursor and root error taxonomy

Create fresh cursors from at least four operation families. Perform valid continuation, wrong-family reuse, and one single-character tamper. Require distinct typed outcomes for operation/family mismatch and invalid/tampered encoding. Test unknown repository, unavailable branch, unknown node, and unknown endpoint boundaries. Every error must preserve specific remediation instead of collapsing into a generic not-found response.

### Q17 — Compact representation honesty

Compare normal and compact endpoint/dead-code output using identical scope and limits. Canonical items, non-zero counts, meaning, continuation, and caveats must survive. Redundant mirrors may disappear. Record raw/sent byte estimates and compression ratio, and explain the serialization boundary; impossible self-referential byte precision must not be claimed as exact.

### Q18 — Mixed-call latency isolation

Run bounded search → context → flow → affected → service graph, interleaving semantic-status calls. Record duration, completion/truncation, cursor, warnings, and semantic state for every call. Apply a 30-second hard budget per call. Graph/lexical work must not wait for embedding completion, and the same multi-term query from Q4 must remain bounded.

### Q19 — Scope and negative-proof matrix

Repeat one query across Largest Repo, Second Repo, unknown repository, unavailable branch, unknown node, unknown endpoint, wrong cursor family, and tampered cursor. Verify no cross-scope leakage and boundary-specific errors/remediation. State the strongest safe negative conclusion after considering exclusions, failed/stale files, unresolved references, truncation, source-only files, and revision trust.

### Q20 — First-user onboarding and Agent handoff

Request onboarding guidance and verify examples use current canonical MCP tool IDs and nested scope/options/page shapes. Construct an Agent A handoff containing only MCP-emitted scope, identities, one unused cursor, and caveats. Resume it as Agent B without rediscovery. Verify the cursor and identities remain valid in the same revision/session boundary, or explain a typed invalidation.

## Bonus scenarios B1–B8

### B1 — Cross-service relation proof

Determine whether Service Pair calls, depends on, owns, or only references one another. Preserve uncertainty for inferred or partial edges.

### B2 — Minimal safe-change envelope

For Primary File, produce a minimal change plan from affected, context, flow, tests, endpoint/service evidence, coverage debt, and revision caveats. Separate proven blast radius from lower-bound risk.

### B3 — Retrieval disagreement

Find one case where exact/graph evidence and semantic ranking disagree. Explain why factual claims follow direct evidence while vector similarity still assists discovery.

### B4 — Historical generation hygiene

Verify replaced generations are superseded rather than simultaneously active or permanently counted as current work.

### B5 — Semantic control discoverability

Identify Pause, Resume, Retry, and Cancel schemas/annotations without invoking them. State which actions are valid in the current state and why.

### B6 — Fresh MCP worker wake contract

From current MCP evidence, determine whether a fresh MCP process can wake queued semantic work without Tauri. Do not claim a real wake occurred unless current state proves queued work existed and progressed.

### B7 — Remediation usability

Collect remediation from at least three partial/negative results, including mutation preflight and one cursor/root failure. Judge whether a first-time MCP-only consumer can act without source, DB, or CLI access.

### B8 — Readiness verdict by lane

Give separate verdicts for exact/graph investigation, semantic discovery, runtime reliability, file/coverage completeness, identity/continuation stability, and owner-only Tauri UX. Name the strongest safe use and strongest unsafe claim.

## 7. Mandatory reproduced-edge closure matrix E1–E19

Every edge gate below is required and must be scored inside its owning Q scenario as well as listed in one consolidated pass/fail table. These gates add no points and do not change category weights. Any failed or untested edge gate is a hard-gate failure.

- E1: Report schema skew as a typed first-class state across health, query, CLI/MCP identity, and remediation; never claim readiness from equal version numbers when required schema objects are absent.
- E2: Keep filtered endpoint inventory bounded, preserve exact filters and typed timeout remediation, and continue with a non-overlapping cursor on a large endpoint corpus.
- E3: Represent a registered repository with no semantic generation as canonical `not_queued`, with zero work and no fabricated active generation.
- E4: Prove exact/lexical/graph calls with no active semantic generation do not initialize, health-check, or invoke the embedding model.
- E5: Apply `scope.kinds` before bounded candidate loss so an existing symbol is not excluded by earlier candidates of another kind.
- E6: Apply requested repository scope to explain/context resolution and reject unknown repositories without cross-repository fallback.
- E7: Reject relative, nonexistent, non-directory, non-repository, escaped-symlink, and TOCTOU-changed mutation roots with typed read-only preflight results.
- E8: Preserve symbol-level granularity in affected analysis; distinct changed symbols in one file must not collapse into one file-only result.
- E9: Return concrete impact edges, endpoint/service links, executable-test evidence, confidence, and lower-bound caveats when affected evidence exists.
- E10: Emit a stable endpoint locator that round-trips inventory → continuation → flow without rediscovery.
- E11: When flow is truncated, emit a valid continuation cursor and preserve ordered non-overlapping hops to deterministic exhaustion.
- E12: Keep candidate/global totals stable across endpoint pages and distinguish exact totals from lower bounds.
- E13: Keep context continuation globally bounded and deduplicated across all relation families, with no repeated payload or scope drift.
- E14: Use only canonical current MCP wire tool IDs in onboarding examples; aliases must be labelled and nonexistent names must not be advertised.
- E15: Every timeout or budget-partial response must preserve operation-specific remediation and any safe continuation path.
- E16: Reconcile admitted source, graph-parsed, source-only, graph-only, endpoint-discovered, and endpoint-queryable counts without hiding loss behind one total.
- E17: Resolve same-name repositories and roots deterministically or return typed ambiguity; never silently select a different repository.
- E18: Classify unresolved references into concrete pageable families with exact/lower-bound semantics and safe negative-proof limits.
- E19: Keep repeated identical bounded queries deterministic in identity, candidate count, ordering, cursor, and semantic requested/applied state.

## 8. Owner-only Tauri evidence — not MCP-scored

If the owner supplies current screenshots or observations, report separately whether Wiki opens on Graph with Focus absent; semantic state/progress/model are visible; Pause/Resume/Retry/Cancel appear only when valid; background work survives App closure; Graph/Storage stay responsive; and installed build identity matches MCP. Otherwise mark every item `N/A_OWNER_EVIDENCE_NOT_SUPPLIED`. Do not change the MCP score.

## 9. Required evidence tables

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Healthy | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |

| Repository/file measure | Aggregate | Page evidence | Reconciliation equation or bound | Safe conclusion |
| --- | ---: | --- | --- | --- |

| Query/retrieval lane | Repo | Duration | Candidate/root/evidence | Requested/applied/generation | Top identities | Warning |
| --- | --- | ---: | --- | --- | --- | --- |

| Cursor family | Advertised | Schema accepts | Valid continuation | Overlap/drift | Wrong-family | Tampered | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |

| Preflight/error case | Read-only proof | Typed code | Preserved remediation | State unchanged | Verdict |
| --- | --- | --- | --- | --- | --- |

| Coverage family | Aggregate | Concrete page evidence | Exact/lower bound | Cursor | Safe conclusion |
| --- | ---: | --- | --- | --- | --- |

| Mixed call | Duration | Complete/truncated | Cursor/warning | 30-second budget |
| --- | ---: | --- | --- | --- |

| Edge gate | Owning scenario | Direct MCP evidence | Pass/fail | Failure/remediation |
| --- | --- | --- | --- | --- |

## 10. Scoring — 100 points

- Runtime identity, installed MCP parity, and reliability: 10
- Discoverability, schemas, annotations, onboarding, remediation: 14
- Exact/lexical/graph/context/flow usefulness and latency: 20
- Semantic readiness, identity, hybrid honesty, lifecycle: 16
- Stable identities, pagination, cursor correctness, affected parity: 20
- File reconciliation, coverage debt, cache hygiene, negative-proof honesty: 15
- Compactness and handoff usability: 5

Award 95–100 only when every hard gate passes. Do not round a lower raw score upward.

## 11. Hard gates

A report cannot score 95 or above if any condition occurs:

- MCP is unavailable or unloaded in the fresh OS process;
- running/available build mismatch, restart required, or schema/contract/hash conflict;
- semantic use is claimed without a compatible complete active generation and full model identity;
- any of the four Q4 calls exceeds the 30-second hard budget;
- exact occurrence pages collapse distinct occurrences or overlap/drift;
- context pages exceed the global limit, repeat, skip, drift, or cannot continue;
- advertised cursor support ignores input or cannot produce valid continuation;
- a freshly emitted node/endpoint identity fails round trip;
- admitted-source, graph-parsed, and source-only counts do not reconcile honestly;
- concrete non-zero coverage debt cannot be paged or bounded;
- package-cache files pollute current source evidence;
- mutation discovery requires calling a mutating tool, triggers permission, or changes state;
- mutation schemas/annotations omit root, confirmation, or truthful safety hints;
- wrong-family and tampered cursors collapse into the same misleading result;
- typed root/cursor errors lose actionable `remediation`;
- Graph/Lexical blocks on semantic work;
- compact output changes meaning/counts or presents impossible byte claims as exact;
- negative conclusions ignore exclusion/failure/staleness/unresolved/truncation/source-only/revision limits;
- any required scenario or any E1–E19 reproduced-edge gate is untested, omitted, or failed;
- the recorded rubric contract hash differs from the embedded Round 27 hash;
- the evaluator uses source, DB, Git, terminal, CLI, old-report, or another-index fallback.

## 12. Required report output

Create exactly one report matching the evaluator:

- Codex: `/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-codex-round27.md`
- Claude Code: `/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-claude-opus-5-round27.md`

Do not read or modify the other evaluator report. Include:

- evaluator/model and fresh-process proof;
- the exact embedded rubric contract hash before any product call;
- Q1–Q20 and B1–B8 separately;
- every required scenario and E1–E19 in a consolidated pass/fail table;
- every required table;
- direct MCP evidence separated from inference;
- durations, limitations, and all hard-gate outcomes;
- category scores and total 1–100;
- prioritized remaining defects;
- final `GO`, `CONDITIONAL GO`, or `NO-GO`.

Do not modify source, index, configuration, this brief, the active brief, or any older report.

## 13. Closure rule

Both independent reports must record the exact embedded rubric contract hash and score 95–100. One must come from a genuinely fresh Claude Code OS process and one from a genuinely fresh Codex OS process. Both must use Penguin MCP only, must score every required scenario, and must pass every hard gate and E1–E19. Anything less keeps the implementation open.
<!-- END ROUND27 IMMUTABLE RUBRIC -->
