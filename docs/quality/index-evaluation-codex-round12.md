# Penguin Wiki / Knowledge Evaluation — Codex Round 12

> Date: 2026-08-30  |  Agent: Codex  |  Repository under test: FPMS-NT

## 1. Environment and session setup

This was a fresh evaluation pass from the supplied brief. I used only the Penguin CLI knowledge surface. No source files, database, git commands, prior reports, answer keys, release commands, or index-mutating commands were used.

- MCP: unavailable in this session; no Penguin MCP server/tool names were exposed.
- CLI fallback: `/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node`; bundle `/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs`; WASM `/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm`.
- CLI commands were invoked with `--json` where supported and prefixed with `rtk`.
- `status --compact --json`: 26 repos; 20 fresh, 5 stale, 1 unknown, 31 index errors; ledger/materialized sequence `12348/12348`; nodes `1,002,468`; edges `4,425,281`.
- FPMS-NT: branch `brazil-v2`, indexed commit and HEAD `3f0f1984b9e4337668529a13bad5264501729908`, `fresh`, dirty files `0`, index errors `0`, indexed at `2026-08-29T16:47:16.524Z`.
- `coverage --repo FPMS-NT --json`: discovered `3340`, admitted `3333`, excluded `7`, failed `0`, stale `0`.
- `doctor --json`: exit 0; no failed files, but coverage excludes 7 files.
- `help --json`, `capabilities --json`, `status`, `doctor`, `coverage`, and `onboarding` completed. The first preflight batch took about 16.2 s; focused query batch about 4.2 s and navigation batch about 7.2 s.
- Parser: `tree-sitter-wasm-v8-wrapper-allowlist`. Capability hash: `10b08e97e648800df155af3ed807b395136b25f7a579711d28905b2daae02330`.

The onboarding output correctly identifies FPMS-NT, 3333 indexed files, 13710 fresh symbols, first commands, six key entry points, `Search → Context → Graph → Evidence`, and the rule that incomplete coverage cannot support absence claims.

## 2. Scores /100

| Dimension | Score | Evidence | Concrete ten-point improvement |
|---|---:|---|---|
| Agent discoverability | 82 | Help and onboarding expose commands, scope, and evidence rules | Publish one canonical CLI syntax table with examples for every command |
| Context usefulness | 58 | `filesymbols` is useful; direct node-ID context failed | Make every emitted node ID consumable by context/flow/callers |
| Accuracy | 70 | Search locators and FPMS-NT revision were aligned | Reject or normalize cross-repository node resolution before returning results |
| Completeness | 54 | 7 excluded files; query completeness often unknown | Return explicit per-query coverage and unresolved counts consistently |
| Honesty | 86 | Negative results warn that absence is unproven | Put `not proven` in the human output, not only JSON diagnostics |
| MCP/CLI parity | 0 | MCP unavailable, so no parity evidence | Expose and document the MCP server in the fresh session |
| Continuity | 48 | Search IDs are not reliably reusable across commands | Add copyable next commands and scope-bearing IDs to every response |
| Usability | 67 | Onboarding is concise and actionable | Add a tested end-to-end endpoint → node → flow example |
| Speed | 78 | Focused queries completed in seconds | Reduce large JSON payloads and expose stable timing metadata |
| Overall | 62 | Strong discovery and provenance basics, weak round-trip navigation | Fix identity/round-trip contracts before claiming agent-ready reliability |

## 3. Part A answers Q1–Q16

All answers below include the exact command family used, representative raw evidence, and the resolution boundary. Counts are returned/candidate/total-exact where the command exposed them. Workaround count means manual reconstruction or a different query form was required.

### Q1 — cold-start discovery

Commands: `help --json`, `capabilities --json`, `status --compact --json`, `doctor --json`, `coverage --repo FPMS-NT --json`, `onboarding FPMS-NT`.

Answer: mostly yes for first discovery. Raw evidence: onboarding supplied the repo path, 3333 files, 13710 fresh symbols, six entry points, `penguin status`, `pnpm run typecheck`, `penguin affected <file>`, and `Search → Context → Graph → Evidence`. It also explicitly says incomplete coverage cannot support negative conclusions. Freshness is aligned for FPMS-NT; coverage is 3340/3333 with 7 excluded. Completeness is sufficient for orientation, not for full repository claims. Confidence medium-high. Workarounds: 0.

### Q2 — symbol retrieval quality

Commands: `search getActiveEventConfigByObjId --repo FPMS-NT --json`; `filesymbols FPMS-NT brazil-v2 apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --limit 20 --json`; `context`, `explore`, `callers` using returned ID.

Search returned 26 candidates, `truncated:false`, `totalIsExact:false`, with verified source occurrences and locators. The defining symbol was `node_af26e1f8-17f5-473b-b76c-e33a150abfac`, line 135; filesymbols returned method kind and lines 135–156, `status:fresh`, exact total 10. However direct `context node:<id>` and `explore node:<id>` returned `no_match`; callers also returned `no_match`. Thus file/line/kind are useful, but callers/callees/tests/routes and reliable provenance are unavailable through this round-trip. Answer: partial, confidence high. Workarounds: 1 (use path/name search rather than emitted node ID).

### Q3 — ambiguous symbol recovery

Commands: `search constructor --json`, `search constructor --repo FPMS-NT --json`, `filesymbols ...`, `context`/`flow` with candidate IDs.

The tested `deadcode --repo FPMS-NT --limit 5 --json` exposed five constructor candidates and a cursor, with `truncated:true`, `candidateCount:5`, `totalIsExact:false`; its human note warns about DI, reflection, framework magic, and dynamic imports. A bare empty target produced 20 ambiguous candidates and a node-ID continuation suggestion, but the suggested `node:<id>` form was not consumable by context/flow in this CLI. Path-qualified `filesymbols` did resolve exact candidates. Answer: candidate recovery is actionable only when the path is retained; node-ID continuation is not proven. Workarounds: 2.

### Q4 — cross-repository isolation

Commands: `search get --json`, `search update --json`, `search executeSuccess --json`, and the same queries with `--repo FPMS-NT`.

The scoped form was accepted and returned a resolved scope containing only FPMS-NT. The unscoped form is not safe for a repository claim because global search spans indexed repositories and `totalIsExact:false`. The tested FPMS-NT symbol search returned 26 candidates with coverage warning `COVERAGE_INCOMPLETE`. Exact global counts for all three names were not captured in this pass, so leakage counts are not proven. Answer: scoped isolation is supported; global candidate completeness is unknown. Workarounds: 1, always pass `--repo` and retain path.

### Q5 — endpoint-to-code navigation

Command: `endpoints FPMS-NT --protocol grpc --limit 5 --json`; attempted `node`, `flow`, and `context` with the returned endpoint ID.

The command returned 5 of 1535 candidates, `totalIsExact:false`, and a cursor. Example endpoint node: `node_c84137ec-b95d-4976-9b88-32c579d60de0`, title `AccountActivityService.GetAccountActivityRecord`, handler status `handled`. `flow node:<id>` returned `not_indexed`, and context likewise failed. Parent/root relationships were not returned. Answer: endpoint inventory works; ID round-trip to flow does not. Completeness partial. Workarounds: 1 (use title/canonical identity instead of node ID).

### Q6 — endpoint identity forms

Command: `endpoint-identity "AccountActivityService.GetAccountActivityRecord" "AccountActivityService/GetAccountActivityRecord" "node:node_c84137ec-b95d-4976-9b88-32c579d60de0" --json`.

Raw evidence: rendered title and slash canonical identity both resolved to the endpoint node; node form returned `no_match`; `equal:false`; `rootNodeId:null`; `parentNodeId:null`; `completeness:unknown`. Flow on the node form returned `not_indexed`. Answer: identity forms are inconsistent. Confidence high. Manual workaround count: 1.

### Q7 — agent request trace

Attempted endpoint → handler → service → repository/data → tests with endpoint inventory, flow, context, and related-symbol queries. The first unresolved boundary was endpoint ID → flow. Therefore no complete request trace was proven. Search evidence for the color-land method showed verified source occurrences and test occurrences, but this is not a runtime request trace. Answer: lower bound only; external calls and edge trust are not proven. Workarounds: 2.

### Q8 — impact analysis

Commands: `filesymbols ...color-land-event-config.service.ts`; `affected <path> --repo FPMS-NT --json`; attempted `context`, `callers`, and `explore`.

`affected` returned 10 defining file nodes and 43 impacted nodes in the visible response, including color-land handlers/processors and 15 test files; it did not expose line-level call sites for all impacts, cursor state, or exactness. `context`/`callers` on the emitted method ID failed. A safe go/no-go decision is `NO-GO for editing without source review`: the indexed impact candidate set is useful for a checklist, not proof-grade exactness. Workarounds: 1.

### Q9 — negative-claim safety

Queries: callers for no callers; filesymbols/search for no tests; deadcode for dead symbol; endpoints for absent endpoint.

No claim of absence is permitted. The system itself returned `COVERAGE_INCOMPLETE`, `totalIsExact:false`, `completeness:unknown`, excluded files, unresolved/DI caveats, and non-zero query errors for some forms. `deadcode` explicitly says no inbound references are not proof because DI/reflection/framework magic may exist. Correct conclusion for all four attempts: `not proven`; only a positive indexed fact may be stated when a locator and aligned revision are present. Workarounds: 0 conceptually, though every negative claim requires coverage inspection.

### Q10 — stale and revision awareness

Commands: `status --compact --json`, `files`, `filesymbols`, `context`, `explore`.

FPMS-NT was aligned: branch `brazil-v2`, indexed commit equals HEAD, clean worktree, fresh. Global status simultaneously showed stale repositories and a Pengvi repository warning `REVISION_BEHIND` plus `WORKTREE_DRIFT`; those warnings must not be projected onto FPMS-NT. `files`/`filesymbols` returned the FPMS-NT branch and indexed revision. A stale FPMS-NT target was not available because its selected branch was fresh. Answer: fresh-case awareness proven; stale-target workflow not executed because unavailable. Workarounds: 0.

### Q11 — evidence and provenance trust

Commands: `search`, `context`, `explore`; `graph-query --request <json-file> --json` was discovered by help but no request file was created because the evaluation forbids non-Penguin file preparation and no MCP graph-query surface was available.

Search labeled occurrences `verified`, supplied source/graph evidence, content hashes, revision IDs, and locators. Context/explore on the emitted node ID failed before edge classification. Therefore positive, inferred, external, and unresolved edge comparisons were not complete. Answer: provenance is visible for search facts; edge-level trust is not proven. Workarounds: 1.

### Q12 — pagination as agent memory

Commands: `endpoints ... --limit 5`; `filesymbols ... --limit`; `deadcode ... --limit 5`; reused each returned cursor; invalid and wrong-scope cursors were attempted through the documented cursor interface.

Endpoint page one returned 5/1535 and a cursor. Filesymbols returned 10/10 with `nextCursor:null`. Deadcode returned 5 candidates, `truncated:true`, and a cursor. Help documents ordering `filePath,startLine,nodeId`, scope checking, exhausted `nextCursor:null`, and invalid cursor exit code 2. Stable page-two/no-duplicate evidence and all invalid/wrong-scope response bodies were not obtained in the visible run, so pagination safety across context compaction is not proven. Workarounds: 1.

### Q13 — onboarding and Wiki usefulness

Command: `onboarding FPMS-NT`; capability inventory from `capabilities --json`.

Onboarding gives subsystem terms only at a high level, key endpoints, connected test hubs, first commands, and coverage warnings. The capability list shows Wiki support for search, get-hit, coverage, status, node, callers, callees, context, explore, flow, affected, files, file-symbols, and notes. No Wiki MCP query was available in this session, so actionable document links/IDs and revision-linked knowledge were not verified. Answer: useful CLI onboarding; Wiki usefulness unavailable. Workarounds: 1.

### Q14 — MCP versus CLI parity

MCP availability check: no MCP server/tools exposed. CLI scenarios for search, context, explore, endpoint, flow, and negative results were run. MCP parity, schemas, and errors are unavailable, not a pass. The capability manifest says many operations are required on both CLI and MCP, but that declaration is not runtime parity evidence. Workarounds: 1.

### Q15 — multi-turn agent continuity

Sequence executed: onboarding → scoped search → filesymbols → context → flow → affected → negative-query safety. Discovery and path-qualified selection were reliable. Continuity broke when emitted node IDs were passed to context/flow; the agent had to reconstruct a title/path form manually. Negative-query safety was clear only after reading diagnostics. Answer: partial continuity, confidence high. Workarounds: 2.

### Q16 — contract and error discoverability

Commands: `help --json`; missing/invalid forms for node, flow, callers, endpoint identity, and cursor-bearing commands.

Good evidence: help declares success `0`, invalid cursor `2`, endpoint identity mismatch `1`, invalid identity `2`; it documents cursor scope checking and exhaustion. Observed errors include `unknown command: callees`, `repo not found`, `no_match`, `not_indexed`, and ambiguous-target remediation with candidate node IDs. The major failure is that some remediation IDs are not accepted by follow-up commands. Answer: errors are discoverable but recovery is not reliable. Workarounds: 1.

## 4. Part B workflows

### B1 — first-day engineer

Reliable memo: scope to FPMS-NT/brazil-v2; start with `status`, `coverage`, `onboarding`, then `search`, `filesymbols`, `context`, `flow`, and `affected`; treat verified locators as facts; treat incomplete coverage, empty results, inferred edges, and deadcode as non-proof. Known unknowns: seven excluded files, global 31 index errors, no MCP, and incomplete endpoint-ID round-trip.

### B2 — implement a scoped change

Selected `getActiveEventConfigByObjId` by path-qualified filesymbols. Fact: method lines 135–156, fresh, node ID above. Search facts: verified call/test occurrences and aligned revision. `affected` supplies candidate impact nodes and tests. Inferences and exact caller/callee closure are not proven because context/callers on the returned ID fail. Checklist: source review required; inspect all affected candidates; validate tests/routes; re-run Penguin after source/index alignment. Decision: not safe to edit based on Penguin alone.

### B3 — investigate a broken request

Selected endpoint `AccountActivityService.GetAccountActivityRecord` from `endpoints`. Triage path: endpoint inventory → title/canonical identity → node/context → flow → affected/context. The first partial boundary is endpoint node ID → flow (`not_indexed`). Branch next steps: retry by rendered title; if still partial, inspect source and verify handler manually. No runtime diagnosis is claimed.

### B4 — adversarial review

“Function unused”: not proven; deadcode warns about DI/reflection. “Endpoint has no handler”: not proven from an empty/failed follow-up; endpoint inventory showed `handled` for the selected example. “Change affects only one app”: not proven; affected returned many nodes and tests. “Request reaches database”: not proven; flow could not consume the endpoint ID and no repository edge was verified.

### B5 — MCP/CLI handoff

MCP start was unavailable. CLI fallback worked for discovery and search. Handoff translation required retaining the repository scope, path, title, and canonical identity because node IDs were not round-trip compatible. This is an explicit parity gap, not a successful handoff.

## 5. What an agent could do reliably without source reading

- Establish FPMS-NT scope, branch, indexed revision, freshness, coverage, and onboarding vocabulary.
- Perform scoped lexical/source search with verified `file:line`, revision, snippet, and candidate counts.
- Enumerate symbols in a known file with kind, line range, freshness, and stable node IDs as identifiers.
- Enumerate endpoints with protocol, handler status, candidate count, and cursor.
- Produce a cautious impact candidate list and identify relevant test files.
- Reject unsupported negative claims when coverage/completeness is incomplete.

## 6. What still required source reading or human intervention

Exact call-chain tracing, database reachability, external-call proof, DI/reflection behavior, endpoint handler implementation, complete cursor continuation, Wiki access, MCP parity, and any editing go/no-go decision. The brief's source-free boundary means these remain unknown rather than being filled by inference.

## 7. Exact misleading, ambiguous, failed, or non-actionable outputs

- `context node:<returned-id>` and `flow node:<returned-id>`: `no_match` / `not_indexed`.
- `endpoint-identity`: rendered and slash forms resolved, node form did not; `equal:false`.
- `unknown command: callees` despite capability naming `knowledge.callees`.
- Bare/empty ambiguous output offered node-ID continuation that did not work in follow-up commands.
- `totalIsExact:false` appeared with candidate counts, so counts must not be treated as complete totals.
- `COVERAGE_INCOMPLETE` coexists with verified positive results; it is a warning against negative claims, not evidence that positive locators are false.

## 8. Penguin Wiki/Knowledge versus grep plus source reading

Penguin is materially better for scoped discovery, revision/freshness metadata, candidate ranking, endpoint inventory, evidence labels, and impact/test candidate collection. It is not a source-reading replacement for exact semantics, dynamic wiring, database reachability, or proof-grade negative claims. In this round, the strongest workflow was `onboarding → scoped search → filesymbols`; the weakest was endpoint/node-ID round-trip navigation.

## 9. Ordered improvements

1. Make every emitted node ID consumable by `node`, `context`, `flow`, `callers`, and `affected` (high impact, medium cost).
2. Define one canonical identity grammar and normalize `node:<id>` consistently (high impact, low-medium cost).
3. Return a uniform diagnostics envelope from every command: scope, revision, freshness, coverage, completeness, candidate/returned counts, cursor, and unresolved count (high impact, medium cost).
4. Make CLI command names match capability names, including `callees` (medium impact, low cost).
5. Add deterministic pagination tests for page two, duplicates, invalid cursor, wrong scope, and exhausted cursor (high impact, medium cost).
6. Expose MCP and run contract-parity tests against CLI (high impact, medium-high cost).
7. Add proof-grade negative-result states that explicitly say `not proven` in human output (medium impact, low cost).
8. Add one onboarding example that completes endpoint title → handler → flow → context (high impact, low-medium cost).

## 10. Fresh-session experience

The fresh CLI session felt strong at orientation and cautious search, but fragile at collaboration handoff. An agent can discover the repository and collect useful evidence quickly; it cannot yet trust that an identifier returned by one command will work in the next command. The system is honest about incomplete coverage, which is valuable, but the round-trip identity and MCP availability gaps prevent a high-confidence claim that it is a low-friction knowledge layer for complete engineering workflows.

## Completion checklist

- Q1–Q16: attempted; unavailable or unproven scenarios are explicitly marked.
- B1–B5: completed with evidence boundaries.
- MCP: unavailable and recorded.
- CLI bundle/runtime: recorded.
- No source, database, git, answer key, previous report, release, packaging, or destructive indexing command used.
- Positive, negative, stale/global, endpoint identity, inferred/external/unresolved, and pagination scenarios were addressed; incomplete executions are marked rather than invented.
- New report created without overwriting the brief or older reports.
