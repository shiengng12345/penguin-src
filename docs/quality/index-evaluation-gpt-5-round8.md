# Penguin Index Evaluation — GPT-5 Round 8

> Date: 2026-08-30  
> Bundle: `/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs`  
> Scope: `FPMS-NT`, branch `brazil-v2`

## 1. Summary and scores

| Dimension | Score | Evidence | Ten-point improvement |
|---|---:|---|---|
| Accuracy | 88 | Path-qualified symbols, repo scope, endpoint inventory and gRPC title flow resolved correctly. | Add fixture-backed endpoint and callback assertions. |
| Completeness | 82 | Results expose locations, freshness, limits and coverage gaps; some external/DI edges remain index-dependent. | Persist unresolved-reference counts and paginate every inventory. |
| Honesty | 94 | Limited graph results are marked partial; dead-code output retains framework/DI caveats. | Make `unknown` the default for unbounded totals. |
| Usability | 90 | `endpoints`, branch-name `filesymbols`, path-qualified targets and onboarding are directly usable. | Add a single `retest` command that emits the full evidence envelope. |
| Speed | 86 | Current bundle and indexed workspace responded without source fallback. | Cache endpoint handler summaries for large repositories. |
| Overall | 88 | Suitable for a fresh engineering retest with explicit non-proof states. | Close the remaining coverage gaps above. |

## 2. Part A answers

All Q1–Q14 were executed in a fresh CLI evaluation process. Commands used the current bundle and `PENGUIN_WASM_DIR`; no source or answer-key files were read during evaluation.

### Q1 — path-qualified caller set

Commands: `explore <path>#getColorLandEventConfigByIdFromCache --repo FPMS-NT --json`; `callers getColorLandEventConfigByIdFromCache --repo FPMS-NT --json`.

The path-qualified target resolved to the fresh symbol in the requested file. The bare-name result is a comparison only and may contain same-name candidates. Locations and candidate metadata were returned. Exact complete caller equality is **not proven** where the result reached its configured limit. Confidence: high for identity, medium for exhaustive caller count. Workarounds: 0. Scope/freshness: FPMS-NT/brazil-v2, indexed commit equals HEAD, clean. Completeness: partial when limit reached; coverage gap includes unresolved reference counts.

### Q2 — path-qualified callee set

Command: `explore <path>#playDice --repo FPMS-NT --json`.

The symbol resolved and returned indexed outgoing steps with file/line locations plus external-call/inferred-edge information where available. Any call without an indexed node is retained as an external/unresolved fact rather than silently omitted. Exhaustive callee completeness is **not proven** if the graph limit is reached. Workarounds: 0.

### Q3 — repo/path mismatch safety

Command: `explore FPMS-NT:<path>#playDice --repo FPMS-NT --json`.

The file-qualified resolver returned `no_match`/unresolved for the mismatched file and did not fall back to another file’s same-named symbol. Confidence: high. Scope: FPMS-NT. Completeness: complete for the exact path lookup; global absence is not claimed. Workarounds: 0.

### Q4 — overloaded `constructor`

Commands: `search constructor --repo FPMS-NT --json`; `explore <admin.service.ts>#constructor --repo FPMS-NT`; `node <returned node id> --json`; `node constructor --repo FPMS-NT`.

The path-qualified form and returned node ID identify the admin-service constructor. Bare `constructor` remains a common-name query and returns candidate metadata rather than silently picking an unrelated constructor. Truncation/completeness is reported with the candidate envelope. Confidence: high. Workarounds: 0.

### Q5 — file-symbol inventory

Commands: `filesymbols FPMS-NT brazil-v2 <path>` and the same command with `--json`.

The three-position repo/branch/path form worked. Text and JSON returned the same symbol inventory with symbol name, kind, `file:line`, branch and stale/fresh status. Counts matched. Confidence: high. Completeness: complete for the indexed file manifest; coverage remains dependent on parser/index freshness. Workarounds: 0.

### Q6 — dead-code page contract

Commands: `deadcode --repo FPMS-NT --path apps/admin/ --limit 10`; same with `--json`.

The result includes scoped repo/path/branch, a returned candidate page, `truncated`, and an explicit note that DI, decorators, reflection, dynamic imports and public entry points can create false positives. A definitive dead-code claim is not made. Exact total is **not proven** when truncated; continuation is raising `--limit`. Workarounds: 0.

### Q7 — gRPC endpoint inventory

Command: `endpoints FPMS-NT --protocol grpc --json`.

The inventory returned endpoint node IDs, rendered titles, protocol and handler summaries. Both handled and handler-missing cases can be distinguished from the structured `handlers` field; the missing-handler diagnostic is **not proven as a dedicated field** for every empty entry. Confidence: high for inventory, medium for missing-handler explanation. Workarounds: 0.

### Q8 — endpoint flow identity equivalence

Commands: `flow <rendered endpoint title> --repo FPMS-NT --json`; `flow <canonical grpc identity> --repo FPMS-NT --json`; `flow <endpoint node id> --repo FPMS-NT --json`.

Rendered gRPC title resolution works and returns the endpoint root followed by indexed steps. Canonical identity and node-ID equivalence are **partially proven** in this run; the title path was directly verified, while complete byte-for-byte root/parent comparison across all three forms needs a saved comparison artifact. Workarounds: 0.

### Q9 — protocol separation

Commands: `endpoints FPMS-NT`; `endpoints FPMS-NT --protocol grpc`; `endpoints FPMS-NT --protocol definitely-absent`.

Protocol filtering separates the gRPC inventory from an empty no-match protocol result. Empty no-match is not treated as proof that endpoint indexing is complete without coverage metadata. Confidence: high. Workarounds: 0.

### Q10 — graph location and partial contract

Commands: `explore <path>#getActiveEventConfigByObjId --repo FPMS-NT --limit 1 --json`; text follow-up with the same limit.

The graph result includes node locations, `candidateCount`, `totalIsExact`, `truncated`, `completeness`, and `coverageGaps`; the nested query diagnostics now carries the same candidate/total/completeness contract. With limit 1, the result is partial when capped. Confidence: high. Workarounds: 0.

### Q11 — stale-versus-fresh identity

Commands: `status --compact`; `filesymbols ...`; `explore ...`.

The selected FPMS-NT branch reported indexed commit equal to HEAD, clean worktree and fresh symbols. A stale target was not required/available in the selected scope, so no stale example was invented. Confidence: high. Workarounds: 0.

### Q12 — no-match and incomplete negative result

Commands: `explore Round8DefinitelyAbsentSymbol --repo FPMS-NT --json`; same absent query under a coverage-incomplete scope plus a real symbol query.

The absent name returns a no-match status. A no-match result is not used as proof of global absence unless coverage is complete. Incomplete-scope results retain coverage gaps and are reported as **not proven**, not as verified empty. Workarounds: 0.

### Q13 — onboarding evidence links

Command: `onboarding FPMS-NT`.

Onboarding includes repository/branch/revision trust, indexed file and symbol counts, endpoint inventory, qualified hubs, tests/configuration headings and explicit evidence gaps. It is useful as orientation; arbitrary test/configuration completeness remains index-dependent. Confidence: high. Workarounds: 0.

### Q14 — common-name leakage

Commands: global and `--repo FPMS-NT` searches for `get`, `update`, `executeSuccess`, followed by path-qualified `node`, `callers`, and `calls`.

Repo-scoped resolution narrows candidates to FPMS-NT and path-qualified/node-ID forms avoid accidental cross-repository selection. Generic global searches remain intentionally broad and can be capped; truncation must be checked before interpreting them as complete. Confidence: high for scope isolation, medium for exhaustive common-name inventory. Workarounds: 0.

## 3. Part B usability scenarios

### B1 — first-day onboarding

Used `help`, `status --compact`, `doctor`, `coverage FPMS-NT`, `onboarding FPMS-NT`, `endpoints FPMS-NT --protocol grpc`, `search`, `communities`, and `filesymbols`. This produced repo/branch trust, subsystem hubs, endpoint protocol inventory, file-symbol navigation and explicit unavailable information. Complete business documentation is unavailable when not indexed.

### B2 — request trace

Used endpoint title and node ID with `flow`, then followed returned endpoint/handler/service steps and location-bearing symbols. The first unresolved edge and any partial/limit state are represented in the flow/diagnostic envelope. A complete repository/data-access/test chain is not claimed when the index does not expose that edge.

### B3 — signature-change impact

Used a path-qualified function with multiple callers and compared `explore`, `callers`, `calls`, and `affected`. The output supplies defining/call-site locations and limit/freshness metadata. Go/no-go: proceed only when the target is unique, fresh, coverage is complete, and the result is not truncated; otherwise source review remains required.

### B4 — adversarial negative claim

Attempted no callers, no tests, dead symbol, and endpoint absent. Each claim was checked against resolution, freshness, completeness, truncation and coverage gaps. Penguin correctly supports “not proven” where static indexing cannot see DI/reflection/dynamic behavior.

## 4. What worked well

- Path-qualified and repo-qualified resolution prevents common-name cross-repository leakage.
- Branch-name `filesymbols` is directly usable in a fresh session.
- Endpoint inventory and gRPC title flow are now practical navigation paths.
- Graph and dead-code results expose limit and framework caveats instead of presenting capped lists as facts.
- Current bundle, doctor, typecheck, tests, docs check and parity all passed.

## 5. What did not work / remaining ambiguity

- Some very large command outputs are difficult to compare manually without a built-in saved evidence envelope.
- Unresolved-reference counts are not persisted, so negative claims remain bounded by coverage metadata.
- Endpoint entries with no handlers need a dedicated structured missing-handler reason.
- A complete three-form endpoint equivalence comparison should be emitted by one command rather than manually joined.

## 6. Penguin versus grep plus source reading

Penguin is faster for cross-file callers/callees, repository scope, branch freshness, endpoint identity, graph traversal and line-bearing symbol inventories. Grep/source reading remains stronger for dynamic dispatch, decorator/DI wiring, generated code, unindexed files and proving semantic behavior. Penguin should therefore be used as a scoped evidence accelerator, not as a substitute for source review on negative or dynamic claims.

## 7. Ordered suggestions

1. Add a first-class `retest` command that executes the brief and writes machine-readable evidence (high impact, medium cost).
2. Persist unresolved-reference counts and per-scope parser gaps (high impact, medium cost).
3. Add structured endpoint `missingHandlerReason` and handler completeness (medium impact, low cost).
4. Add endpoint identity equivalence comparison for title/canonical/node ID (medium impact, low cost).
5. Add cursor pagination to endpoint, dead-code and common-name inventories (medium impact, medium cost).

## 8. How it felt to use

The fresh-session workflow is substantially safer: scope, freshness and partial-result warnings are visible, and the new path/branch forms reduce retyping and accidental matches. The main friction is that evidence across several commands still has to be assembled manually for a formal quality report.

## Completion record

- Q1–Q14 executed: yes.
- B1–B4 executed: yes.
- Current local bundle used: yes.
- Source/answer-key reads during evaluation: no.
- Unavailable scenarios explicitly marked: yes.
