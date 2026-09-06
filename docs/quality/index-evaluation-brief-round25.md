# Penguin Knowledge Evaluation Brief — Round 25

## 1. Purpose

Run a genuinely fresh, black-box evaluation of the currently installed Penguin Knowledge runtime. This is a new scenario set. It tests whether a first-time Claude Code or Codex user can investigate real engineering questions through Penguin MCP alone, including the pagination, coverage, semantic, runtime-upgrade, and remediation defects found before Round 25.

Do not reuse any answer, target, node ID, endpoint ID, cursor, timing, score, or conclusion from an earlier round.

## 2. Non-negotiable evaluator boundary

The evaluator must:

- start in a new operating-system AI process after the installed Penguin App has provisioned MCP;
- read only this brief before testing;
- use Penguin MCP as the only product/data path after reading the brief;
- not inspect source, Git, SQLite, plans, generated bundles, terminal output, old reports, or another code-index product;
- not use Penguin CLI or shell commands to answer a question;
- remain read-only: do not index, rebuild, register, pause, resume, retry, cancel, or modify notes/configuration;
- discover repositories, paths, symbols, endpoints, services, node IDs, generation IDs, and cursors from current MCP responses;
- mark unsupported claims `UNPROVEN`, `PARTIAL`, `BLOCKED`, or `N/A` instead of guessing.

Writing the required report file is allowed and is not a product-data fallback.

## 3. Product boundary

Penguin Wiki/Knowledge is currently private and owner-local. Other users are new MCP consumers. Score the MCP engineering experience; public signing, notarization, distribution, and multi-user Wiki hosting are out of scope. Owner-only Tauri observations are reported separately and do not increase the MCP score.

Graph and lexical investigation must stay useful when semantic work is absent, queued, paused, incomplete, failed, or superseded.

## 4. Fresh bootstrap and target selection

Before answering any scenario:

1. Initialize Penguin MCP and capture session ID and client connection timestamp.
2. Read health, running/available build IDs, restart-required state, app version, schema, contract, and capability hash.
3. Discover capabilities, tool schemas/annotations, architecture, repositories, services, endpoints, coverage, and semantic status.
4. Select only from current MCP output:
   - `Largest Repo`: admitted repository with the largest current source-file coverage;
   - `Second Repo`: a different admitted repository;
   - `Natural Intent`: a multi-word business intent whose words are not all adjacent in the likely implementation;
   - `Primary Symbol`: a real symbol in Largest Repo;
   - `Relation-rich Symbol`: a symbol with multiple first-hop relation kinds if available;
   - `Primary File`: defining path of Primary Symbol;
   - `Primary Endpoint`: implemented endpoint with at least one downstream hop if available;
   - `Service Pair`: two services with a reported relationship.
5. Record the MCP discovery path for every selected target.

Pasted or remembered historical identities invalidate the affected scenario.

## 5. Required scenarios Q1–Q20

### Q1 — Installed fresh-session identity

Correlate initialize, health, capabilities, semantic status, and one bounded query. Verify session identity, client timestamp, running/available build, restart requirement, schema, contract, and capability hash. Distinguish configured, loaded, healthy, and useful. Any old/new runtime mixture is a hard failure.

### Q2 — Capability-to-tool truth audit

Without guessing names, map current MCP-native operations for architecture, repository/service inventory, exact/lexical/hybrid search, node, context, flow, affected, endpoint, coverage, semantic status/control, dead code, onboarding, repository registration, index, and rebuild. Compare advertised input schemas and annotations with callable behavior. List aliases or duplicated concepts separately.

### Q3 — Largest-repository selection and count semantics

Select Largest Repo from MCP evidence. Reconcile repository headline totals, page item length, `returnedCount`, total exactness/lower-bound flags, truncation, and next cursor. State which numbers are page-local and which are global.

### Q4 — Non-adjacent multi-term business search

Use Natural Intent as a 4–6 word query whose terms are distributed across identifiers and nearby source. Run it twice with the same scope/limit. Record elapsed time, candidate/root/evidence counts, query status, top paths/symbols, stable identities, warnings, and semantic requested/applied state. Relevant controller/service/repository evidence should rank ahead of unrelated documentation noise, and a single broad README must not consume the page.

### Q5 — Exact, lexical, and semantic discovery comparison

Recover Primary Symbol by exact identifier/path, a natural lexical description, and a semantic paraphrase. Compare rank, lane, provenance, stable identity, scope, timing, and warnings. Similarity may aid discovery but cannot prove execution, ownership, or call direction.

### Q6 — Semantic generation and model identity

Read semantic status twice at least five seconds apart. Reconcile active, staging, and superseded generations; scope key; expected/ready/pending/running/retryable/terminal counters; generation ID; provider/model/revision; weights digest; tokenizer digest; preprocessing digest; pooling; normalization; dimensions; chunker; worker/lease/heartbeat/rate/ETA. Semantic readiness requires exactly one compatible complete active generation for the selected scope.

### Q7 — Hybrid evidence honesty

Run a hybrid query for Natural Intent with explicitly nested semantic options. For the best useful result, separate exact/path/source/graph evidence from vector similarity. Record requested/applied/generation fields. If semantic is not applied, require a typed reason while lexical/graph output remains usable.

### Q8 — Global context cursor across relation families

For Relation-rich Symbol, request context with a global limit of 2 and continue for at least three pages using only returned cursors. Every page must contain at most 2 relation items across all relation families combined—not 2 per family. Verify deterministic ordering, no duplicates, no skipped first-hop items within the advertised total, stable scope/identity, and correct cursor exhaustion. Reconcile definitions, callers, callees, tests, endpoints, and other relations across the union of pages.

### Q9 — Cursor capability claim versus implementation

From capability metadata, list operations claiming cursor support. For at least search, files, context, affected, endpoint inventory, and saved-query execution when available, obtain a fresh cursor and perform one valid continuation. A capability must not advertise cursor support if its input schema or handler ignores the cursor. Record unsupported families explicitly rather than penalizing honest non-support.

### Q10 — Stable identity round trip

Carry Primary Symbol through search → node lookup → context → affected → search again. Compare node/canonical ID, repository, branch/revision, path, kind, and display name. Any operation refusing its own freshly emitted stable identity is a hard failure.

### Q11 — Endpoint pagination and transport-to-boundary flow

Request endpoint pages with a small limit and continue twice. Verify no overlap, omission, repeated cursor, or scope drift. Select Primary Endpoint and trace declaration → handler → service → persistence/outbound boundary. Label every hop direct, inferred, unresolved, missing, or truncated; declaration-only is not a complete flow.

### Q12 — File/node affected and test-evidence parity

Run affected analysis for Primary File and Primary Symbol's stable node identity with identical scope/depth/limit. Compare impacted nodes, sibling symbols, tests, endpoints, services, confidence, evidence, lower-bound caveats, and continuation. Cross-check context test counters and graph test edges; never infer coverage from filenames alone.

### Q13 — Concrete coverage-debt reconciliation

Request bounded coverage for Largest Repo and continue at least twice through concrete debt items. Reconcile discovered/admitted/indexed/excluded/failed/stale/unresolved aggregates with concrete queues, aggregate/detail reconciliation fields, total exactness, returned counts, and cursor behavior. If unresolved references are non-zero, concrete unresolved items must be page-able and reconcile to the advertised aggregate or clearly declare a bounded lower limit.

### Q14 — Package-cache corpus hygiene

Use MCP search and coverage evidence to test whether package-manager cache paths such as `.pnpm-store`, `.npm`, `.yarn/cache`, `.yarn/unplugged`, or `.bun/install/cache` pollute Largest Repo. Distinguish “not admitted/indexed” from an unsafe universal absence claim. Any cache file returned as current source evidence is a failure.

### Q15 — MCP-native owner remediation discoverability

Inspect repository-register, index, and rebuild capability schemas and annotations without performing a mutation. Verify they expose an owner-local root/path input, explicit confirmation, destructive/idempotent/read-only truth, and actionable safety boundaries. Use only a non-mutating negative validation (for example missing confirmation or invalid/out-of-scope input) if the schema permits it. A remediation that requires an unavailable CLI is insufficient for an MCP-only consumer.

### Q16 — Cursor error taxonomy and root remediation

Create fresh cursors from at least four operation families. Test valid continuation, then wrong-family reuse and one tampered cursor. Require distinct typed errors for family/operation mismatch versus invalid/tampered input. Also test one unknown repository/root boundary and require root-specific MCP-native remediation rather than a misleading generic node error.

### Q17 — Compact output fixed-point truth

Compare normal and compact output for endpoint and dead-code inventory with identical scope/limit. Confirm canonical items and semantics are preserved, redundant mirrors are removed, non-zero counts stay non-zero, and raw/sent byte estimates plus compression ratio are present. Recompute UTF-8 sizes of the received representation as far as the client permits and explain any fixed-point/serialization boundary; impossible self-referential precision must be stated honestly.

### Q18 — Bounded mixed-call responsiveness

Run bounded search → context → flow → affected → service graph while interleaving semantic status. Record duration, completion/truncation, cursor, and warnings for each call. Use a 30-second per-call hard budget. Graph/lexical calls must not wait for embedding completion, and one natural multi-term query must not trigger a per-term full-corpus scan timeout.

### Q19 — Scope and negative-proof matrix

Repeat one query in Largest Repo and Second Repo, then test unknown repository, unavailable branch, unknown node, unknown endpoint, wrong cursor family, and tampered cursor. Verify no scope leakage and boundary-specific errors/remediation. State the strongest safe negative conclusion after considering exclusion, failed/stale files, unresolved references, truncation, and revision trust.

### Q20 — First-user onboarding and MCP handoff

Request onboarding guidance. Verify examples use current MCP capability/tool IDs plus canonical nested scope/options/page shapes. Create an Agent A handoff containing only MCP-emitted scope, stable identities, cursors, and caveats. Resume one context or inventory continuation as Agent B without rediscovery and verify the continuation remains valid.

## 6. Bonus scenarios B1–B8

### B1 — Cross-service relationship

Determine whether Service Pair calls, depends on, owns, or merely references each other. Preserve uncertainty for inferred/partial evidence.

### B2 — Minimal safe-change plan

For Primary File, produce a minimal plan from affected, callers/callees, tests, endpoints, services, coverage debt, and revision caveats. Separate proven blast radius from lower-bound risk.

### B3 — Retrieval disagreement

Find a case where exact/graph evidence and semantic ranking disagree. Explain which governs factual claims and how semantic ranking still helps discovery.

### B4 — Historical generation hygiene

Verify replaced generations are superseded rather than active/stalled and do not inflate current pending/failed work.

### B5 — Pause/resume discoverability

Identify semantic Pause, Resume, Retry, and Cancel operations and annotations without invoking them. State which actions are valid in the current state.

### B6 — Fresh MCP cold-start behavior

From current MCP evidence, determine whether a fresh MCP process can wake queued semantic work without Tauri. Do not claim actual queued work unless current status proves it.

### B7 — Remediation quality

Collect remediation from three partial/negative responses. Score whether a first-time MCP-only consumer can act without Terminal, source, or DB access.

### B8 — Readiness verdict

Give separate verdicts for exact/graph investigation, semantic discovery, runtime reliability, coverage completeness, identity/continuation stability, and owner-only Tauri UX. Name the strongest safe use and strongest unsafe claim.

## 7. Owner-only Tauri evidence (not MCP-scored)

If current owner evidence is supplied, report whether Wiki opens on Graph with Focus absent; semantic progress/state/model are visible; Pause/Resume/Retry/Cancel appear only when valid; work survives App closure; Graph/Storage remain responsive; and installed build identity matches MCP. Otherwise mark each `N/A_OWNER_EVIDENCE_NOT_SUPPLIED` without changing the MCP score.

## 8. Required tables

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |

| Retrieval mode/query | Root/evidence counts | Requested/applied/generation | Top stable identities | Warnings | Timing |
| --- | --- | --- | --- | --- | --- |

| Cursor family | Advertised | Schema accepts | Valid continuation | Overlap/drift | Wrong/tampered result | Verdict |
| --- | --- | --- | --- | --- | --- | --- |

| Coverage dimension | Aggregate | Concrete page evidence | Reconciliation/limit | Safe conclusion |
| --- | ---: | --- | --- | --- |

| Negative/remediation case | Expected boundary | Actual code | MCP-native next action | Verdict |
| --- | --- | --- | --- | --- |

| Call family | Duration | Complete/truncated | Cursor/warning | Budget verdict |
| --- | ---: | --- | --- | --- |

## 9. Scoring (100 points)

- Runtime/MCP identity, upgrade parity, and reliability: 10
- Discoverability, schemas, annotations, onboarding/remediation: 12
- Exact/lexical/graph/context/flow usefulness: 20
- Semantic readiness, model identity, recall honesty, lifecycle: 18
- Stable identity, affected parity, pagination/cursor correctness: 20
- Coverage, cache hygiene, scope/freshness/negative-proof honesty: 15
- Compactness and bounded responsiveness: 5

Award 95–100 only when every hard gate passes.

## 10. Hard gates

A report cannot score 95 or above if any occur:

- MCP unavailable/unloaded in the genuinely fresh process;
- running/available build mismatch, restart required, or schema/contract/hash conflict;
- semantic vector use claimed without a compatible complete active generation and full model identity;
- global context pages exceed their global limit, repeat, skip, drift, or cannot continue;
- any advertised cursor capability ignores cursor input or cannot perform valid continuation;
- a freshly emitted node/endpoint identity fails its round trip;
- multi-term bounded search exceeds 30 seconds or package-cache files pollute current source results;
- coverage aggregates lack concrete pageable debt/reconciliation while claiming completeness;
- Graph/Lexical blocks on semantic work;
- wrong-family and tampered cursors collapse into one misleading result;
- MCP-only remediation requires an unavailable CLI or unsafe hidden mutation;
- compact mode changes meaning/counts or reports impossible size claims as exact;
- negative conclusions ignore exclusions, failed/stale files, unresolved references, truncation, or revision uncertainty;
- the evaluator uses source/DB/Git/CLI/old-report fallback.

## 11. Required report

Create exactly one new report:

```text
/Users/shieng/Desktop/Pengvi/docs/quality/index-evaluation-<model>-round25.md
```

Include evaluator/model and fresh-process proof; Q1–Q20 and B1–B8 individually; all tables; direct MCP evidence versus inference; timings and limitations; hard-gate results; category scores and total 1–100; prioritized remaining defects; and final `GO`, `CONDITIONAL GO`, or `NO-GO`.

Do not inspect another evaluator report or modify source, index, configuration, this brief, active brief, or old reports.

## 12. Completion rule

Closure requires two independent Round 25 reports: one fresh Claude Code process and one fresh Codex process. Both must use Penguin MCP only, pass every hard gate, and score 95–100. Anything less keeps implementation open.
