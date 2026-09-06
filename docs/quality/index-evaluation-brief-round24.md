# Penguin Knowledge Evaluation Brief — Round 24

## 1. Objective

Perform a completely fresh black-box evaluation of the currently installed Penguin Knowledge runtime. Round 24 is a new scenario set intended to determine whether a first-time Claude Code or Codex user can rely on Penguin MCP for engineering investigation without reading source code or using the local CLI.

Do not reuse answers, targets, IDs, cursors, timings, scores, or conclusions from any previous round.

## 2. Strict evaluator boundary

The evaluator must:

- start in a genuinely new operating-system AI process after MCP configuration has been installed;
- read only this brief before beginning the evaluation;
- use Penguin MCP as the only product/data path after reading this brief;
- not read source, Git, SQLite, generated bundles, plans, snapshots, old reports, terminal output, or another code-index product;
- not use Penguin CLI or shell commands to answer any question;
- not modify repositories, index state, MCP configuration, notes, semantic jobs, or Tauri state;
- discover every repository, branch, path, symbol, endpoint, service, node ID, generation ID, and cursor from fresh MCP responses;
- record `UNPROVEN`, `PARTIAL`, `BLOCKED`, or `N/A` whenever the returned evidence cannot support a claim.

The report itself may be written to the required absolute path. Writing the report is not a product-data fallback.

## 3. Product boundary

Penguin Wiki/Knowledge is private and owner-local. Other users are new MCP consumers. Score the MCP engineering experience. Public signing/distribution and multi-user Wiki hosting are out of scope. Owner-only Tauri observations are reported separately and do not raise the MCP score.

Graph and lexical capabilities must remain usable even when semantic work is unavailable, paused, incomplete, or superseded.

## 4. Fresh bootstrap protocol

Before selecting targets:

1. initialize Penguin MCP and record the new session identity and connection timestamp;
2. obtain health, running/available build identity, contract/schema versions, and capability hash;
3. discover capability IDs, input schemas, annotations, architecture, repositories, services, endpoints, coverage, and semantic status;
4. distinguish configured, loaded, healthy, useful, and restart-required states;
5. state whether any response is truncated and preserve its emitted continuation cursor.

Do not infer that configuration proves loading, or that sqlite-vec/model files prove an active compatible generation.

## 5. Dynamic target selection

Choose only from current MCP output:

- `Primary Repo`: the admitted repository with the largest useful source/graph coverage;
- `Secondary Repo`: a different admitted repository;
- `Natural Concept`: a business or infrastructure concept expressed differently from its likely identifier;
- `Primary Symbol`: a real symbol in Primary Repo returned by current search;
- `Sibling Symbol`: another symbol defined in the same source file if one exists;
- `Primary File`: the defining path of Primary Symbol;
- `Primary Endpoint`: a current implemented endpoint, preferably with at least one downstream hop;
- `Service Pair`: two services with a current reported relationship if available.

Record the MCP discovery path for every target. Pasted historical identities invalidate the affected question.

## 6. Required questions Q1–Q20

### Q1 — New-session runtime proof

Correlate initialize, health, capability inventory, semantic status, and one bounded real query. Are session ID, client timestamp, running build, available build, restart-required state, schema, contract, and capability hash consistent? Cite exact MCP fields.

### Q2 — First-time tool selection

Without guessing tool names, identify the current MCP-native operations for architecture, repositories/services, exact/lexical/hybrid search, node lookup, context, flow, affected analysis, endpoints, coverage, semantic status/control, dead-code inventory, and onboarding. Audit read-only/destructive/idempotent annotations and flag duplicates or ambiguous aliases.

### Q3 — Count and page semantics

Use architecture plus one bounded repository/service inventory. Reconcile headline totals, `returnedCount`, item-array length, exact-total flags, truncation, and next cursor. State which values describe the page and which describe the complete result set.

### Q4 — Identifier-to-node recovery

Recover Primary Symbol first by exact identifier/path and then by a lexical description. Compare ranking, provenance, stable node identity, repository/branch/path, total semantics, warnings, and elapsed time. Carry the freshly returned stable identity forward.

### Q5 — Semantic paraphrase robustness

Run three materially different natural-language descriptions of Natural Concept with identical scope and limit. For each call record root hit count, evidence count, query status, semantic requested/applied state, generation ID, model identity, top stable identities, warnings, and timing. Explain ranking variation without turning similarity into proof of ownership or execution.

### Q6 — Hybrid evidence separation

Run a hybrid query for Natural Concept. For the top useful candidate, separate exact/path/graph evidence from vector similarity. Verify nested semantic options are accepted. If semantic is not applied, require a typed reason and prove lexical/graph output remains useful.

### Q7 — Semantic generation integrity

Read aggregate semantic status twice at least five seconds apart. Reconcile active, staging, and superseded generations; expected/ready/pending/running/retryable/terminal/failed counters; model revision/digests; tokenizer; dimensions; chunker; worker/lease/heartbeat/rate/ETA. A ready verdict requires one complete compatible active generation.

### Q8 — Three-page context continuation

Request a deliberately small context page for Primary Symbol and continue twice using only the returned context cursor. Verify deterministic ordering, no overlap, no skipped first-hop item within the advertised total, stable scope/identity, and a new cursor when more data remains. Reconcile definitions, callers, callees, tests, endpoints, relations, inferred edges, and evidence counters across pages.

### Q9 — Stable identity round-trip

Carry Primary Symbol through search → node lookup → context → affected. Compare node ID/canonical identity, repository, branch/revision, path, kind, and display name. Record any identity drift or operation that refuses its own freshly emitted identity.

### Q10 — File/node affected parity

Run affected analysis for Primary File and separately for Primary Symbol's stable node identity using the same scope/depth/limit. Compare impacted nodes, tests, endpoints, services, confidence, evidence, lower-bound caveats, and continuation. If Sibling Symbol exists, explain why file atomicity should or should not include it.

### Q11 — Test evidence consistency

Using the same Primary File, compare context test counters, affected test items, and graph edges. Determine whether file-level test evidence remains visible when the selected node is not itself the directly tested symbol. Do not infer test coverage from filenames alone.

### Q12 — Endpoint pagination and identity

Request a small endpoint page and continue at least twice. Check overlap, omission, repeated cursor, scope drift, handler/declaration status, returned/page/total counts, and endpoint identity persistence. Preserve one implemented Primary Endpoint for Q13.

### Q13 — Endpoint-to-boundary flow

Trace Primary Endpoint from transport declaration through handler/service to persistence or an outbound boundary. Label each hop direct, inferred, unresolved, missing, or truncated. Do not present a declaration-only route as a complete execution flow.

### Q14 — Coverage reconciliation and actionable debt

Request bounded coverage for Primary Repo and continue once. Reconcile discovered/admitted/indexed/excluded/failed/stale/unresolved values with concrete returned items and aggregate/detail reconciliation fields. Distinguish deliberate binary/secret exclusion from parser failure. Require MCP-native remediation; a local CLI-only instruction is insufficient for a new MCP consumer.

### Q15 — Revision and freshness truth

Correlate repository inventory, index/freshness status, coverage, and query warnings for Primary Repo. Distinguish exact commit, dirty worktree, behind, stale, and unknown. State the strongest safe negative conclusion permitted by exclusions, unresolved references, truncation, and revision trust.

### Q16 — Cursor error taxonomy

Create fresh cursors from search, context, affected, and endpoint/service inventory. Test one valid continuation for each. Then use a valid cursor with the wrong operation family and separately tamper with one cursor. Require distinct typed errors (family/operation mismatch versus invalid/tampered), truthful messages, and MCP-native remediation.

### Q17 — Compact response truthfulness

Compare normal and compact output for endpoint inventory and dead-code inventory with the same scope/limit. Confirm canonical items and meaning are preserved, redundant mirrors are removed, and raw/sent byte estimates plus compression ratio are present and arithmetically plausible. Compact mode must not turn a non-zero count into a false zero.

### Q18 — Bounded responsiveness under mixed calls

Run bounded search → context → flow → affected → service graph, interleaving semantic status checks. Record MCP timing, completion/truncation, and warnings for every call. Identify any timeout or call exceeding the evaluator's bounded per-call budget. Graph/lexical must not wait for embedding completion.

### Q19 — Scope and negative-boundary matrix

Repeat one query in Primary Repo and Secondary Repo, then independently test an unknown repository, unavailable branch in a known repository, unknown node, wrong cursor family, and tampered cursor. Verify no repository leakage and require boundary-specific error codes/remediation rather than one misleading generic failure.

### Q20 — Fresh-user onboarding and handoff

Request onboarding help. Verify examples use current MCP capability IDs and canonical nested scope/options/page shapes, not unavailable CLI flags. Produce a compact Agent A handoff containing only MCP-emitted scope, stable identities, cursors, and caveats; resume at least one continuation as Agent B without rediscovery.

## 7. Bonus scenarios B1–B8

### B1 — Cross-service relationship

Use only service and graph evidence to determine whether one Service Pair member calls, depends on, owns, or merely references the other. Preserve uncertainty when evidence is inferred or partial.

### B2 — Minimal safe-change plan

For Primary File, provide a small change plan based on affected, callers/callees, tests, endpoints, service evidence, and coverage caveats. Separate proven blast radius from lower-bound risk.

### B3 — Retrieval disagreement

Find one case where exact/graph evidence and semantic ranking prioritize different candidates. Explain which evidence governs a factual claim and how semantic ranking still helps discovery.

### B4 — Implemented versus declaration-only endpoint

If both exist, compare flow completeness, first-hop evidence, handler status, and negative-proof limits. Otherwise record `N/A_NO_DECLARATION_ONLY_ENDPOINT_RETURNED`.

### B5 — Historical generation hygiene

Verify replaced generations are superseded rather than active/stalled. Check whether totals distinguish current work from historical rows without counting old expected chunks as pending work.

### B6 — Pause/resume discoverability without mutation

Identify the semantic control capabilities and annotations but do not invoke them. State when Pause, Resume, Retry, or Cancel would be valid according to current status.

### B7 — MCP-only remediation quality

Collect remediation returned by at least three negative/partial results. Score whether a first-time MCP-only user can act without Terminal, source, or DB access.

### B8 — Readiness verdict

Give separate verdicts for exact/graph investigation, semantic discovery, runtime reliability, coverage completeness, continuation/identity stability, and owner-only Tauri UX. Name the strongest safe use and strongest unsafe claim.

## 8. Owner-only Tauri evidence (not MCP-scored)

The owner may separately provide current-session evidence for:

1. Wiki opens on Graph and the old Focus tab is absent.
2. Semantic state and counters are visible without Terminal.
3. Pause/Resume/Retry/Cancel appear only when valid.
4. Closing/reopening Tauri does not falsely cancel durable work.
5. Storage and Graph remain responsive while status polling runs.
6. Installed app/runtime build identity matches MCP health.

If no current owner evidence is supplied, mark each item `N/A_OWNER_EVIDENCE_NOT_SUPPLIED`; do not reduce or increase the MCP score.

## 9. Required tables

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |

| Semantic query | Root/evidence counts | Status | Requested/applied/generation | Top stable identities | Warnings | Timing |
| --- | --- | --- | --- | --- | --- | --- |

| Cursor family | Scope/identity | Initial cursor | Continuation(s) | Overlap/drift | Negative test | Verdict |
| --- | --- | --- | --- | --- | --- | --- |

| Negative case | Expected boundary | Actual code | MCP-native remediation | Verdict |
| --- | --- | --- | --- | --- |

| Coverage dimension | Aggregate | Concrete evidence | Reconciliation/limit | Safe conclusion |
| --- | ---: | --- | --- | --- |

| Call family | Duration | Complete/truncated | Cursor/warning | Responsiveness verdict |
| --- | ---: | --- | --- | --- |

| Owner Tauri item | Current owner evidence | Result | Included in MCP score? |
| --- | --- | --- | --- |

## 10. Scoring (100 points)

- Fresh runtime/MCP identity and reliability: 10
- Discoverability, schemas, annotations, onboarding: 10
- Exact/lexical/graph/context/flow usefulness: 20
- Semantic readiness, recall honesty, lifecycle: 20
- Stable identity, affected parity, pagination/cursors: 20
- Scope, freshness, coverage, negative-proof honesty: 15
- Compactness and responsiveness: 5

Score 95–100 only when every hard gate passes.

## 11. Hard gates

A report cannot score 95 or above if any of these occur:

- Penguin MCP is unavailable or not loaded in the genuinely new process;
- runtime identity is contradictory or restart-required remains true;
- schema/contract/capability hash conflicts across MCP surfaces;
- semantic answers claim vector application without a compatible complete active generation;
- semantic counts/status contradict across repeated calls;
- a freshly emitted node/endpoint identity cannot complete its required round-trip;
- valid context/endpoint/search/affected continuation repeats, skips, crosses scope, or cannot continue;
- wrong-family and tampered cursors collapse into the same misleading boundary;
- node/file affected results violate the documented file-atomic lower-bound contract;
- Graph/Lexical becomes unavailable or times out because semantic work is incomplete;
- coverage aggregates lack concrete items or reconciliation while still claiming completeness;
- negative conclusions ignore exclusions, stale/failed files, unresolved references, truncation, or revision uncertainty;
- remediation requires an unavailable local CLI for the MCP-only consumer;
- the evaluator uses forbidden source/DB/Git/CLI/old-report fallback.

## 12. Required report

Create exactly one new report:

```text
/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-<model>-round24.md
```

The report must include:

- evaluator/model and proof of a genuinely new process;
- Q1–Q20 and B1–B8 individually answered or individually justified as N/A/BLOCKED;
- all required tables;
- direct MCP observations separated from inference;
- timings, limitations, unproven claims, and hard-gate results;
- category scores and total score from 1–100;
- top remaining defects ordered by user impact;
- final `GO`, `CONDITIONAL GO`, or `NO-GO`.

Do not inspect another evaluator's report and do not modify product source, index, configuration, this brief, active brief, or old reports.

## 13. Completion rule

Program closure requires two independent Round 24 reports: one genuinely fresh Claude Code process and one genuinely fresh Codex process. Each must use Penguin MCP only, pass all hard gates, and score 95–100. Anything less keeps implementation open.
