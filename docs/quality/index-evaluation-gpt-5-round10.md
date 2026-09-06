# Penguin Index Evaluation — Fresh Round 10

Date: 2026-08-30. Scope: Penguin CLI only; repository `FPMS-NT`, branch `brazil-v2`.

## 1. Scores

- Accuracy: 78/100 — resolved targets, node IDs, freshness and cursor fields were reproducible; endpoint identity invocation contract was not discoverable from the brief.
- Completeness: 54/100 — Q1–Q15 commands were attempted, but several negative and identity variants were unavailable or duplicated rather than independently proving every requested condition.
- Honesty: 92/100 — incomplete coverage and `totalIsExact:false` were retained; no dead-code or absence claim was promoted to fact.
- Usability: 70/100 — JSON is rich, but truncation, abbreviated paths, and inconsistent node-ID behavior are costly.
- Speed: 86/100 — setup plus queries completed quickly; retest runner took about 11 seconds.
- Overall: 72/100 — useful evidence layer, not yet a proof-grade replacement for source review.

Improvement worth ten points: expose one machine-readable contract/help schema for cursor, endpoint-identity forms, exit statuses, and coverage semantics.

## 2. Q1–Q15

Common setup command:

```sh
VN=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
B=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs
export PENGUIN_WASM_DIR=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm
```

Preflight commands: `"$VN" "$B" help`, `status --compact`, `doctor`, `coverage --repo FPMS-NT`. Bundle/runtime were the paths above. `FPMS-NT brazil-v2` was fresh with `errors=0`; doctor reported `ledger seq 12348 / materialized 12348 — ok`, 1,002,468 nodes, 4,425,281 edges, and 1 pending suggestion. Coverage was discovered 3340, admitted 3333, excluded 7, failed 0, stale 0. Status exposed parser/schema/resolver details through JSON; the target locator was clean, indexed commit and HEAD were both `3f0f1984b9e4337668529a13bad5264501729908`, indexed at `2026-08-29T16:47:16.524Z`.

### Q1 — persisted unresolved-reference coverage

Commands: `coverage --repo FPMS-NT --json`; `status --compact --json`; `explore apps/promotion/src/modules/color-land/processors/dice.processor.ts#playDice --repo FPMS-NT --json`.

Evidence: coverage has no unresolved-reference aggregate; explore has `queryDiagnostics.evidence.unresolvedReferenceCount:0`, `resolutionStatus:resolved`, `candidateCount:82`, `totalIsExact:false`, `completeness:partial`, and `coverageGaps:[unresolved_reference_schema_upgrade_pending]`. Therefore per-file/repo/branch persistence is **not proven**. Diagnostics do not fully agree: zero unresolved count coexists with an unresolved-reference schema gap.

### Q2 — completeness boundary

Commands: target explore with `--limit 1` and without `--limit`. Limit 1: `candidateCount:3`, `totalIsExact:false`, `completeness:partial`, one returned caller/callee. Unbounded: `candidateCount:17`, `totalIsExact:false`, `completeness:partial`, 3 callers and 1 call. Coverage gap remained `unresolved_reference_schema_upgrade_pending`; freshness remained fresh. The outer/nested result is therefore still a lower-bound graph, not complete.

### Q3 — exactly-at-limit

Command target: `explore ...dice.processor.ts#playDice --repo FPMS-NT --limit {1,2,100} --json`. Candidate counts were 5, 7, and 122 respectively; all had `completeness:partial` and `totalIsExact:false`. This verifies exactly-at-limit is partial, but the larger query still did not establish exactness.

### Q4 — endpoint handler status

Command: `endpoints FPMS-NT --protocol grpc --limit 10 --json`. The first 10 entries were handled, with handler locations such as `payment`, `proto`, and repository methods; `missingHandlerReason:null`. No empty-handler entry appeared in this page, so `missing` versus `incomplete` is **not proven** for an empty entry. Page metadata: `candidateCount:1535`, `returnedCount:10`, `totalIsExact:false`, cursor present.

### Q5 — endpoint cursor pagination

Commands: `endpoints FPMS-NT --protocol grpc --limit 5 --json`, continuation with `nextCursor`, and `--cursor bad-cursor`. Page 1 returned 5, candidateCount 1535; page 2 returned 5, candidateCount 1530. Titles were ordered lexicographically and no duplicate title/node ID was observed across the saved pages. Exhaustion was not reached. Invalid cursor produced non-JSON `rtk: Failed to parse JSON: expected value at line 1 column 1`; protocol-mismatch cursor was not proven. `totalIsExact:false` on both pages.

### Q6 — filesymbols cursor pagination

Command: `filesymbols FPMS-NT brazil-v2 apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --limit 5 --json`, then cursor continuation. Page 1: 5 items, candidateCount 10, cursor present; page 2: 5 items, candidateCount 5, `nextCursor:null`, `totalIsExact:true`. Items were in ascending start-line order, all `status:fresh`; scope stayed on the requested file/branch. Continuity was proven for these 10 nodes.

### Q7 — deadcode cursor/framework caveat

Command: `deadcode --repo FPMS-NT --path apps/admin/ --limit 5 --json`, then continuation. Page 1: 5 candidates, `fileImportedBy` values 1–3, `totalIsExact:false`, `truncated:true`, cursor present. Page 2: zero candidates, cursor null, but still `totalIsExact:false`, `truncated:true`. Penguin explicitly said to verify DI, reflection, framework wiring; no candidate is definitely dead.

### Q8 — endpoint identity equivalence

Attempted commands: `endpoint-identity "AccountActivityService.GetAccountActivityRecord" --repo FPMS-NT --json`, canonical-form and node-ID variants. Exact CLI output: `endpoint-identity needs rendered title, canonical identity, and node id`. The three-form contract could not be inferred from help/brief; `equal`, root/parent IDs, unknown-form mismatch, and REST mismatch are **not proven**.

### Q9 — endpoint flow consistency

Commands: `flow "AccountActivityService.GetAccountActivityRecord" --repo FPMS-NT --json`; node-ID form. Title form resolved root `node_c84137ec...`, then service `payment`; fresh, clean, aligned, coverage gaps empty, indexed/HEAD equal. Node-ID form returned `not_indexed` and empty steps. Thus title/node equivalence is disproven by observed CLI behavior, while handler transition is only endpoint→service; repository/data/test continuity is not proven.

### Q10 — repo/path mismatch safety

Command: `explore FPMS-NT:apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#playDice --repo FPMS-NT --json`. Result: `resolutionStatus:no_match`, `resultStatus:query_error`, `candidateCount:0`, `completeness:unknown`, `totalIsExact:false`, `coverageGaps:[unresolved_reference_scope_unavailable]`, no focus and no fallback candidate. No same-name fallback was observed; absence is not proven.

### Q11 — stale versus fresh

Status/filesymbols/explore located only fresh target evidence for this file: stale false, reason null, indexed and HEAD `3f0f1984...`, dirtyFileCount 0. A stale symbol with comparable name/node-ID evidence was not located; stale vocabulary comparison is **not available**.

### Q12 — negative-result safety

`explore Round10DefinitelyAbsentSymbol --repo FPMS-NT --json` returned `no_match` but `resultStatus:query_error`, `completeness:unknown`, `totalIsExact:false`, `coverageGaps:[unresolved_reference_scope_unavailable]`, and trust unavailable. The no-caller/no-test attempts used the same target and were not independent proofs. Endpoint no-match was not executed against a deliberately absent endpoint. Therefore no negative claim is definitive. Search diagnostics also warned `COVERAGE_INCOMPLETE` because 7 files were excluded.

### Q13 — onboarding

Command: `onboarding FPMS-NT`. It produced scope/revision, indexed inventory, protocol endpoint summary, hubs, tests/configuration links, first commands, and evidence gaps, but the generated Markdown did not prove persisted unresolved-reference fields or complete endpoint handler coverage. Marked partial, not proof-grade.

### Q14 — common-name isolation

Commands: `search get --repo FPMS-NT --json`, `search update --repo FPMS-NT --json`, `search executeSuccess --repo FPMS-NT --json`. Bare searches returned many matches (executeSuccess diagnostics showed candidateCount 15, returned page limit 50, truncated false), with path-qualified evidence and node IDs. This demonstrates ambiguity and repo scoping, but dedicated `node`, `callers`, and `calls` comparisons for each form were not completed; isolation is partial. Search coverage was admitted 3333/discovered 3340/excluded 7/failed 0 and warned that empty results cannot prove absence.

### Q15 — retest runner fidelity

Command: `pnpm knowledge:retest:round8`. Exit 0, `commandCount:19`, `failed:0`, report created at `docs/quality/index-evaluation-gpt-5-round9.md`; it reported the current bundle/runtime paths. It did not overwrite this brief. This proves runner success and new-report creation, but the runner is Round 8 and generated Round 9, so it does not by itself prove Round 10 command coverage or failure-on-skip semantics.

## 3. B1–B4

### B1 — first-day onboarding

Available from `onboarding FPMS-NT`: repository/branch trust, clean/fresh revision, protocol endpoint inventory, hubs, tests/configuration links, and first commands. Unavailable/not proven: persisted unresolved-reference detail, complete handler mapping, and source-independent business orientation.

### B2 — request trace

Title-form flow proved `AccountActivityService.GetAccountActivityRecord → payment` with root/parent relationship and fresh aligned trust. Node-ID flow returned `not_indexed`; no handler→service→repository/data→test chain was proven. Result: partial and not complete.

### B3 — signature-change impact

`playDice` had a defining location, one caller, and many parser-extracted outgoing field/call edges; limit tests showed partial candidates. The requested three-caller impact scenario was not satisfied by this target, and `affected` was not independently executed. Go/no-go without source inspection: no-go.

### B4 — adversarial negative claim

Absent symbol and partial no-caller/deadcode checks consistently carried unknown/incomplete coverage. Dynamic DI/reflection caveats and excluded files prevent a definitive claim. Result: Penguin correctly supports `not proven`, not “absent/dead.”

## 4. What worked

Freshness and commit alignment were explicit; file-symbol pagination exhausted cleanly; endpoint pagination exposed scope/candidate/returned counts and cursors; explore exposed provenance, external calls, inferred edges, coverage gaps, and resolution status; negative-result warnings were conservative.

## 5. Failures and ambiguities

The endpoint-identity command required three positional forms but help did not document their syntax. Endpoint cursor exhaustion and protocol-mismatch rejection were not completed. Node-ID flow rejected a node ID emitted by endpoints as not indexed. Coverage reported no failed files but excluded seven and still warned `COVERAGE_INCOMPLETE`. `rtk json` cannot parse the invalid-cursor stderr because the CLI did not emit JSON.

## 6. Penguin versus grep/source reading

Per brief, grep and source reading were not used. Penguin was substantially faster and supplied revision-aware locations, graph edges, endpoint metadata, cursors, and trust. It cannot currently prove absence or framework wiring under incomplete coverage, and its node-ID/endpoint identity contracts are inconsistent enough that source inspection would still be required for high-risk changes.

## 7. Ordered suggestions

1. Publish a JSON capability schema and examples for all positional/flag forms, especially endpoint-identity and cursor continuation (high impact, low cost).
2. Make endpoint-emitted node IDs directly consumable by `flow`, `node`, and identity commands (high impact, medium cost).
3. Persist and expose unresolved-reference counts at file/repo/branch scope with one consistent completeness status (high impact, medium cost).
4. Return structured JSON errors and explicit exit codes for invalid, exhausted, and scope-mismatched cursors (high impact, low-medium cost).
5. Distinguish `missing`, `incomplete`, and `unknown` handler status and include dynamic-wiring caveats in endpoint output (medium impact, medium cost).

## 8. User experience

The CLI is quick and evidence-rich for positive, scoped queries. The main friction is that metadata looks authoritative while `totalIsExact:false`, excluded coverage, and schema-gap warnings quietly limit conclusions. A concise machine-readable contract, consistent node identity, and structured negative/error responses would make the tool much easier to trust.
