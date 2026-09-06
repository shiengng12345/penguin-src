# Penguin Knowledge Evaluation Brief — Round 23

## 1. Purpose

Run a completely fresh, black-box evaluation of the currently installed Penguin Knowledge runtime. This round verifies that a new Claude Code or Codex session can use Penguin as a dependable engineering knowledge system without reading the repository directly.

This is a new question set. Do not reuse answers, IDs, cursors, timings, scores, or conclusions from any earlier round.

## 2. Mandatory isolation boundary

The evaluator must:

- start in a genuinely new AI session after the Penguin MCP client has been restarted;
- use only the Penguin MCP server and information returned by Penguin MCP tools;
- not read source files, the SQLite database, Git, local CLI output, generated bundles, plans, snapshots, or older evaluation reports;
- not call shell, filesystem, browser, or another code-index product as fallback;
- not mutate the index, repository, MCP configuration, semantic queue, notes, or application state;
- use freshly returned repository, branch, node, endpoint, service, cursor, generation, and session identities;
- label every unsupported conclusion as `UNPROVEN`, `PARTIAL`, `N/A`, or `BLOCKED`, with the exact reason.

The evaluator may read only this brief before using Penguin MCP. The evaluator must not inspect another evaluator's report.

## 3. Deployment boundary

Penguin Wiki/Knowledge is currently private and owner-local. Other users are fresh MCP consumers only. Therefore:

- MCP-only engineering usefulness is the scored product surface;
- owner-observed Tauri checks belong only in Section 8 and do not add MCP-only points;
- unavailable public release signing, distribution, or multi-user Wiki hosting is not an MCP product defect;
- Graph and lexical search must remain useful even when semantic indexing is unavailable, paused, or incomplete.

## 4. Required bootstrap evidence

Before answering Q1, obtain through Penguin MCP:

1. initialize/session identity evidence;
2. health and running-versus-available runtime identity;
3. capability inventory and tool annotations;
4. architecture and repository/service discovery;
5. aggregate semantic status;
6. freshness and coverage status for the dynamically selected repository.

Record:

- session ID and client-connected timestamp;
- contract version, schema version, capability hash and build IDs;
- configured, launcher, initialize, loaded and useful states separately;
- semantic backend, model revision/hash, dimensions and chunker version;
- active/staging/superseded generations and ready/expected/running/pending/failed totals;
- whether the response is complete or truncated and any continuation cursor.

Do not assume that “configured” means “loaded” or that “sqlite-vec present” means semantic retrieval is ready.

## 5. Dynamic target selection

Choose all targets from current MCP output:

- `Repo A`: the largest currently admitted repository with useful graph coverage;
- `Repo B`: a different repository or service boundary;
- `Concept A`: a business concept whose wording differs from likely code identifiers;
- `Symbol A`: a real symbol returned from a search in Repo A;
- `Endpoint A`: a real endpoint returned from endpoint inventory;
- `File A`: a real source path connected to Symbol A;
- `Service A` and `Service B`: two currently discovered services with a relationship if one exists.

Record how each target was discovered. Never paste an ID from this brief or an old report.

## 6. Questions Q1–Q20

### Q1 — Fresh-process identity chain

Correlate initialize, health, capabilities and one real query. Are session identity, running build, available build, schema, contract and capability hash mutually consistent? State whether a client restart is required and cite the MCP field that proves it.

### Q2 — Discoverability and annotation audit

From capability/tool discovery, identify the correct MCP-native operations for search, context, flow, affected analysis, coverage, semantic status/control, endpoints, services and onboarding. Verify read-only versus destructive annotations and flag duplicate or ambiguous tool IDs.

### Q3 — Architecture count reconciliation

Request architecture and service/repository summaries. Reconcile headline repository, service, endpoint and relationship counts with returned items and truncation metadata. Do not treat a page count as a database total.

### Q4 — Exact and lexical target recovery

Find Symbol A using an exact identifier or path, then a lexical description. Record returned counts, total semantics, provenance, rank and stable identity. Explain any difference without inventing missing results.

### Q5 — Paraphrased semantic consistency

Search Concept A semantically with three materially different natural-language phrasings. Keep scope and limit constant. For each run record root hit count, evidence count, query status, semantic-applied state, generation ID, top stable identities, warnings and timing. Counts and status must be internally consistent.

### Q6 — Hybrid ranking honesty

Run one hybrid query for Concept A. Separate graph/lexical evidence from vector similarity. Explain why similarity can widen recall but cannot prove execution, ownership, or runtime wiring.

### Q7 — Semantic readiness and failure truth

Use semantic status to decide whether semantic answers are ready. If ready, prove the active generation is complete and model-compatible. If unavailable or incomplete, require a typed reason and verify that Graph/Lexical still work; do not award semantic-answer credit.

### Q8 — Stable node round-trip

Take Symbol A's freshly emitted `nodeId` or canonical identity through search → get-node → context → affected. Compare repository, branch/revision, path, symbol kind and stable identity at each hop. Record any identity drift.

### Q9 — Endpoint inventory pagination

Request a bounded endpoint page, continue once with the returned cursor, and check for overlap, omission, repeated cursor or mixed scope. Distinguish `returnedCount`, page length and total count. Verify endpoint identities survive continuation.

### Q10 — Endpoint-to-boundary flow

Trace Endpoint A from declaration/transport through handler and service to a persistence or outbound boundary. Mark each hop as direct, inferred, missing or truncated. A declaration-only endpoint must not be presented as a complete implementation chain.

### Q11 — Affected file/node parity

Run affected analysis once with File A and once with Symbol A's stable node identity. Compare impacted nodes, endpoints, services, confidence, evidence and limits. Explain legitimate differences; flag unstable node-ID handling.

### Q12 — Context usefulness and counters

Request compact context for Symbol A. Reconcile definitions, callers, callees, tests, endpoints, first-hop relations, inferred edges and evidence counters. Check that omitted compact mirrors do not cause false zeroes or contradictory totals.

### Q13 — Coverage debt actionability

Request coverage for Repo A. Record admitted/indexed/excluded/failed/stale/unresolved values and concrete examples. Determine whether the response gives an MCP-native next action. Do not claim completeness when excluded, stale, failed or unresolved debt remains.

### Q14 — Freshness and revision truth

Correlate index status, coverage and query warnings for Repo A. Distinguish aligned, behind, dirty, stale and unknown states. If revision differs from the indexed commit, require a stable reason rather than a generic stale label.

### Q15 — Semantic lifecycle integrity

Read semantic status twice at least five seconds apart. Reconcile active, staging and superseded rows; expected/ready/running/pending/retryable/terminal counters; lease, heartbeat, rate, ETA and worker identity. Historical replaced generations must be superseded, not falsely active or stalled.

### Q16 — Graph-first responsiveness

Immediately run bounded search → context → flow → affected → service graph while also checking semantic status. Record each MCP timing and any partial/truncated warning. Graph/Lexical must remain available regardless of semantic lifecycle state.

### Q17 — Three-family continuation handoff

Create fresh continuation state for three different families: search, endpoint/service inventory, and one context/affected traversal. Record the exact cursor plus scope and stable identity, then continue each once later in the session. Verify cursor family isolation and deterministic continuation.

### Q18 — Typed negative matrix

Without mutating anything, exercise independently generated invalid values for: unknown repository, unavailable branch, unknown node, wrong cursor family and tampered/expired cursor. Require distinct typed error codes, truthful messages and MCP-native remediation. Do not accept a branch error when the repository itself is unknown.

### Q19 — Compactness and duplication

Compare compact and normal responses for endpoints and dead-code inventory. Confirm canonical items remain available, redundant root mirrors are omitted in compact mode, and raw/sent-byte statistics are honest. Compact output must not silently change semantic meaning.

### Q20 — New-user onboarding

Request onboarding help as a fresh MCP-only consumer. Verify examples use current capability IDs, canonical nested scope/options/page fields, fresh identity flow and real cursor continuation. Flag any CLI-only flag or stale command that an MCP client cannot execute.

## 7. Bonus engineering scenarios B1–B8

### B1 — Cross-service ownership decision

Use only current service and graph evidence to explain whether Service A calls, depends on, owns or merely references Service B. Preserve uncertainty when coverage is incomplete.

### B2 — Safe-change proposal

For File A, produce a minimal safe-change plan using affected, callers/callees, tests, endpoint and service evidence. Separate proven blast radius from lower-bound or inferred risk.

### B3 — Conflicting retrieval signals

Find one case where exact/graph evidence and semantic ranking emphasize different candidates. Prefer exact runtime/identity evidence for factual claims and explain how semantic recall still helps discovery.

### B4 — Endpoint completeness audit

Choose one implemented endpoint and, if available, one declaration-only endpoint. Compare handler status, first-hop relations, flow completeness and negative-proof limits.

### B5 — Repository isolation

Repeat one search or architecture query for Repo A and Repo B. Verify notes, services, endpoints, counts and identities do not leak across scope.

### B6 — Lower-bound negative conclusion

Choose a missing relationship or test claim. State whether the result proves absence, only proves absence in indexed coverage, or is unprovable due to truncation/unresolved references.

### B7 — Agent-A/Agent-B transfer simulation

Write a compact handoff containing only MCP-emitted stable identities, cursors, scope and caveats. Resume it as Agent B without rediscovery. Score continuity separately from answer quality.

### B8 — Product readiness verdict

Give separate verdicts for exact/graph engineering investigation, semantic discovery, MCP runtime reliability, coverage completeness and owner-only Tauri UX. State the strongest safe use case and the strongest unsafe claim.

## 8. Owner-only Tauri evidence lane

These checks are performed by the owner in the installed Penguin app and reported separately. The MCP-only evaluator must not perform or score them unless owner evidence is supplied in the current session:

1. Wiki opens on `Graph` by default.
2. The unused `Focus` tab is absent.
3. Semantic background state is visible without opening Terminal.
4. Ready/embedding/paused/stalled/unavailable states and counters match backend truth.
5. Pause, Resume, Retry and Cancel are shown only when valid.
6. One Pause/Resume cycle is tested only when real nonterminal work naturally exists; otherwise record `N/A_NO_ACTIVE_WORK` and do not create work.
7. Closing the Tauri window does not falsely claim semantic work was cancelled.
8. Storage and Graph remain responsive while status polling occurs.

## 9. Required evidence tables

Include these tables in the report:

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |

| Semantic run | Root hits | Evidence count | Query status | Semantic applied/generation | Top stable identities | Warnings | Timing |
| --- | ---: | ---: | --- | --- | --- | --- | ---: |

| Cursor family | Initial scope/identity | Cursor emitted | Continuation result | Overlap/drift | Verdict |
| --- | --- | --- | --- | --- | --- |

| Negative case | Expected boundary | Actual error code | MCP-native remediation | Verdict |
| --- | --- | --- | --- | --- |

| Coverage dimension | Count/status | Concrete evidence | Limitation | Safe conclusion |
| --- | --- | --- | --- | --- |

| Owner Tauri check | Owner evidence | Result | Included in MCP score? |
| --- | --- | --- | --- |

## 10. Scoring rubric — 100 points

- Runtime identity, fresh-session load and MCP reliability: 10
- Capability discovery, schemas, annotations and onboarding: 10
- Exact/lexical/graph retrieval and execution tracing: 20
- Semantic readiness, consistency, ranking honesty and lifecycle: 20
- Stable identities, pagination and multi-family continuation: 15
- Scope isolation, freshness, coverage and negative-proof honesty: 15
- Compactness, responsiveness and engineering usability: 10

Score 95–100 only if all hard gates below pass. A high subscore cannot hide a failed hard gate.

## 11. Hard gates

A report cannot score 95 or above if any of these occur:

- Penguin MCP is unavailable in the genuinely fresh session;
- running/available runtime identity is stale or contradictory;
- schema, contract or capability hash conflicts across MCP surfaces;
- semantic output claims readiness without one compatible complete active generation;
- repeated semantic responses contain contradictory counts, status or warnings;
- stable node or endpoint identity cannot survive its required round-trip;
- pagination repeats, skips or crosses scope without an explicit typed limitation;
- unknown repository, branch, node and cursor failures collapse into misleading errors;
- Graph/Lexical becomes unavailable because semantic work is paused, incomplete or unavailable;
- negative conclusions ignore exclusions, stale symbols, unresolved references or truncation;
- remediation tells an MCP-only user to run unavailable local CLI commands;
- the evaluator uses forbidden source/DB/Git/CLI/old-report fallback.

## 12. Required report

Create exactly one new report:

```text
docs/quality/index-evaluation-<model>-round23.md
```

The report must contain:

- evaluator/model and fresh-session statement;
- every Q1–Q20 and B1–B8 answer or an individual justified N/A;
- all required evidence tables;
- observed facts separated from inference;
- limitations and unproven claims;
- category scores and total score from 1–100;
- explicit hard-gate results;
- top remaining defects ordered by user impact;
- a final `GO`, `CONDITIONAL GO`, or `NO-GO` verdict.

Do not modify source, index, configuration, this brief, the active pointer, or any older report.

## 13. Program completion rule

Round 23 program closure requires two independent reports:

- one from a genuinely fresh Claude Code session;
- one from a genuinely fresh Codex session.

Each report must score 95–100, pass every hard gate, remain MCP-only, and must not read the other report. Anything less means the implementation is not yet complete.
