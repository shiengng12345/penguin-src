# Penguin Knowledge Evaluation — Codex Round 23

## Evaluation identity and isolation statement

- Evaluator: Codex (the exact underlying model build was not emitted by Penguin MCP).
- Session: fresh Codex evaluation session for Round 23; no earlier IDs, cursors, timings, scores, or conclusions were reused.
- MCP session identity: `BLOCKED`. No registered initialize operation was exposed, and no successful response emitted a session ID or client-connected timestamp. Freshness is therefore procedural, not independently MCP-verifiable.
- Evidence boundary: exactly the Round 23 brief was read locally. All product observations below came from fresh Penguin MCP calls or the active Penguin MCP tool registration. No source, Git, SQLite, CLI, browser, snapshot, bundle, plan, old report, Claude report, or other index product was inspected.
- Mutation boundary: no Penguin mutation operation was called. The only file created is this report.

## Executive verdict

**NO-GO — 6/100.**

The lightweight MCP health surface is alive and reports the same running and available build (`12765c69a2ed6a33`, `outdated:false`). However, the active MCP registration advertises schema version 14 while the knowledge database reports schema version 18. Every tested database-backed operation fails before repository discovery with non-retryable `QUERY_WORKER_CRASH`: `knowledge.db schema_version 18 is newer than this build supports (14); upgrade Penguin before opening it.`

Consequently, Round 23 cannot select dynamic targets, execute successful engineering queries, obtain semantic lifecycle state, perform stable-identity round-trips, emit or continue cursors, or distinguish typed negative boundaries. No unsupported capability receives points.

## Bootstrap and dynamic target selection

Observed facts:

- `mcp_health.status`: `ok`.
- `serverGeneration.runningBuildId`: `12765c69a2ed6a33`.
- `serverGeneration.availableBuildId`: `12765c69a2ed6a33`.
- `serverGeneration.outdated`: `false`.
- MCP registration metadata consistently advertises contract `2`, schema `14`, and capability hash `40ae9528330e4e97d68072d3c40c1be3db9e40f8f52478b44c8de026be4487d0`.
- The database-backed capability, architecture, service, index-status, search, context, flow, affected, endpoint, coverage, dead-code, repository-graph, doctor, and node operations all fail at database open because the database schema is 18 and the running build supports only 14.
- The active registration exposes 75 uniquely named Penguin tools; no duplicate tool ID was visible. It exposes search, context, flow, affected, coverage, endpoint, and service-graph tools, but no tool name for initialize, onboarding, or semantic status/control.
- `knowledge_capabilities` fails despite its registration description saying it does not require an initialized knowledge database.

Inference:

- The launcher/server process is running, but the knowledge database is not loadable by this build. This prevents the MCP engineering surface from being useful.
- A client restart is not indicated merely to load the already available build because `serverGeneration.outdated:false`. A Penguin upgrade is required by the typed database-open message. Whether an additional client restart is needed after that upgrade is `UNPROVEN` in this session.

Dynamic targets:

| Target | Result | Reason |
| --- | --- | --- |
| Repo A | `BLOCKED` | Architecture, repository, service, index-status, and coverage calls fail before emitting repositories. |
| Repo B | `BLOCKED` | No second repository/service boundary was emitted. |
| Concept A | `BLOCKED` | No current business-domain evidence was returned from which to select a paraphrasable concept. |
| Symbol A | `BLOCKED` | Exact and lexical searches fail before returning hits. |
| Endpoint A | `BLOCKED` | Endpoint inventory fails before returning items. |
| File A | `BLOCKED` | No symbol/path identity was emitted. |
| Service A / Service B | `BLOCKED` | Service graph fails before returning services or relationships. |

## Required evidence tables

### Runtime surfaces

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| MCP health / launcher | Session ID and connected time not emitted; build `12765c69a2ed6a33`; contract/schema/hash not present in health | Yes: config path and cwd emitted | Health process loaded | Health only | No for current available build: `outdated:false` | `PARTIAL` |
| Active MCP registration | No session ID; contract `2`; schema `14`; hash `40ae9528…487d0` | Yes: 75 uniquely named tools visible | Registration loaded | Discovery only | `UNPROVEN` | `PARTIAL` |
| Knowledge database | DB schema `18`; running build supports `14` | Present | No | No | Upgrade required; post-upgrade restart `UNPROVEN` | `FAIL` |
| Capability manifest | Registration advertises contract `2`, schema `14`, hash above | Tool registered | No: database-open error | No | Same upgrade blocker | `FAIL` |
| Semantic runtime | Backend/model/dimensions/chunker/generations not emitted | `UNPROVEN` | `UNPROVEN` | No | `UNPROVEN` | `BLOCKED` |

Configured, launcher, initialize, loaded, and useful states are deliberately separate: configuration and liveness do not establish database load or engineering usefulness.

### Semantic searches

Concept A could not be selected. One neutral MCP-only operational probe was issued to exact, lexical, and semantic modes solely to test availability; it is not scored as a business-concept answer.

| Semantic run | Root hits | Evidence count | Query status | Semantic applied/generation | Top stable identities | Warnings | Timing |
| --- | ---: | ---: | --- | --- | --- | --- | ---: |
| Concept phrasing 1 | `BLOCKED` | `BLOCKED` | `QUERY_WORKER_CRASH`, non-retryable | Not emitted | None | Schema 18 is newer than supported 14 | Not emitted |
| Concept phrasing 2 | `BLOCKED` | `BLOCKED` | Not run: Concept A unavailable | Not emitted | None | Dynamic target selection blocked | N/A |
| Concept phrasing 3 | `BLOCKED` | `BLOCKED` | Not run: Concept A unavailable | Not emitted | None | Dynamic target selection blocked | N/A |
| Neutral semantic availability probe | `BLOCKED` | `BLOCKED` | `QUERY_WORKER_CRASH`, non-retryable | Not emitted | None | Schema mismatch | Not emitted |
| Neutral hybrid availability probe | `BLOCKED` | `BLOCKED` | Semantic blend could not pass database open | Not emitted | None | Schema mismatch | Not emitted |

No semantic-answer credit is awarded.

### Continuation cursors

| Cursor family | Initial scope/identity | Cursor emitted | Continuation result | Overlap/drift | Verdict |
| --- | --- | --- | --- | --- | --- |
| Search | Dynamic repo/symbol unavailable | No | Cannot continue | Uncheckable | `BLOCKED` |
| Endpoint/service inventory | Dynamic repo/service unavailable | No | Cannot continue | Uncheckable | `BLOCKED` |
| Context/affected traversal | Symbol A/File A unavailable | No | Cannot continue | Uncheckable | `BLOCKED` |

No cursor was fabricated. The wrong-family probe used an independently generated invalid input and is scored only in the negative matrix, not as valid continuation evidence.

### Typed negative matrix

| Negative case | Expected boundary | Actual error code | MCP-native remediation | Verdict |
| --- | --- | --- | --- | --- |
| Independently generated unknown repository | Repository-not-found typed error | `QUERY_WORKER_CRASH` | Upgrade Penguin; no in-session MCP repair action | `FAIL` |
| Independently generated unavailable branch | Branch-not-found for a valid emitted repository | `QUERY_WORKER_CRASH`; a valid repository could not first be emitted | Upgrade Penguin; then retry discovery | `BLOCKED/FAIL` |
| Independently generated unknown node | Node-not-found typed error | `QUERY_WORKER_CRASH` | Upgrade Penguin; no node-level remediation emitted | `FAIL` |
| Wrong cursor family | Cursor-family mismatch | `QUERY_WORKER_CRASH` | Upgrade Penguin; no cursor remediation emitted | `FAIL` |
| Tampered/expired cursor | Tampered/expired cursor typed error | `QUERY_WORKER_CRASH` | Upgrade Penguin; no cursor remediation emitted | `FAIL` |

The five boundaries collapse to the same database-open crash, so the negative matrix is not truthful at the requested domain level.

### Coverage

| Coverage dimension | Count/status | Concrete evidence | Limitation | Safe conclusion |
| --- | --- | --- | --- | --- |
| Admitted/indexed | `BLOCKED` | `knowledge_coverage` returns `QUERY_WORKER_CRASH` | No repository can be selected | Completeness is unproven |
| Excluded | `BLOCKED` | No coverage payload | Excluded examples unavailable | Absence cannot be claimed |
| Failed | At least one runtime load failure; source-file failure count unavailable | Non-retryable schema mismatch | Not a repository coverage count | Engineering coverage is unusable in this session |
| Stale/freshness | `BLOCKED` | Detailed `index_status` fails | No revision or branch rows | Alignment/behind/dirty/stale/unknown cannot be classified per repo |
| Unresolved references | `BLOCKED` | No coverage payload | No examples or counters | Negative graph conclusions are unsafe |
| MCP-native next action | Upgrade Penguin | Error message explicitly says the build is too old | No callable update/reload action was exposed | External owner repair is required before reevaluation |

### Owner-only Tauri lane

No owner evidence was supplied in this fresh session. All owner checks are N/A and contribute zero MCP points.

| Owner Tauri check | Owner evidence | Result | Included in MCP score? |
| --- | --- | --- | --- |
| Graph opens by default | None | `N/A` | No |
| Focus tab absent | None | `N/A` | No |
| Background semantic state visible | None | `N/A` | No |
| State/counters match backend | None | `N/A` | No |
| Pause/Resume/Retry/Cancel validity | None | `N/A` | No |
| Natural-work Pause/Resume cycle | None | `N/A_NO_OWNER_EVIDENCE` | No |
| Closing window cancellation truth | None | `N/A` | No |
| Storage/Graph responsiveness during polling | None | `N/A` | No |

## Q1–Q20

### Q1 — Fresh-process identity chain

`FAIL`. Health reports matching running and available build IDs and `outdated:false`, but no session ID or connected timestamp is emitted. The registration advertises schema 14 while database open reports schema 18. Contract `2` and capability hash are visible only in registration metadata because capability discovery fails. A real query was attempted and failed with non-retryable `QUERY_WORKER_CRASH`. No restart is required merely to move from running to available build (`serverGeneration.outdated:false`), but an upgrade is required; post-upgrade restart behavior is `UNPROVEN`.

### Q2 — Discoverability and annotation audit

`PARTIAL/FAIL`. Visible MCP-native operations include `knowledge_search`, `knowledge_context`, `knowledge_flow`, `knowledge_affected`, `knowledge_coverage`, `knowledge_endpoints`, `knowledge_service_graph`, and `knowledge_explore`. The active registration has 75 unique names and no visible duplicate IDs. Registration descriptions distinguish several read-only/specialized tools from explicit mutations such as suggestion acceptance, package installation, branch selection, and note writing. However, the canonical capability manifest and its annotations fail to load, no raw read-only/destructive annotation object was emitted, and no initialize, onboarding, or semantic status/control tool is visibly registered. Full verification is blocked.

### Q3 — Architecture count reconciliation

`BLOCKED`. Architecture and service/repository summaries fail before returning headline counts, items, totals, or truncation metadata. No page count was treated as a database total.

### Q4 — Exact and lexical target recovery

`BLOCKED`. Exact and lexical availability probes both return the schema-mismatch worker crash. Symbol A, counts, provenance, rank, and stable identity were not emitted.

### Q5 — Paraphrased semantic consistency

`BLOCKED`. Concept A cannot be selected from current MCP evidence, and semantic search cannot open the database. Three business phrasings were therefore not fabricated. Root/evidence counts, query state, generation, identities, warnings, and timing are unavailable.

### Q6 — Hybrid ranking honesty

`BLOCKED`. A semantic-blend availability attempt does not pass database open. No lexical/graph versus vector ranking can be separated. General ranking claims receive no credit.

### Q7 — Semantic readiness and failure truth

`BLOCKED`, zero semantic credit. No semantic status/control operation is visible in the active registration, and capability discovery fails. Backend, model revision/hash, dimensions, chunker version, active generation completeness, compatibility, and counters are all unproven. Exact and lexical queries also fail, so graceful graph/lexical degradation is not demonstrated.

### Q8 — Stable node round-trip

`BLOCKED`. Search emits no node; therefore search → get-node → context → affected cannot be executed with a fresh stable identity. An independently generated unknown-node probe also fails at database open.

### Q9 — Endpoint inventory pagination

`BLOCKED`. Both normal and compact bounded endpoint requests fail before returning page length, `returnedCount`, total count, endpoint identity, or cursor. Continuation cannot be tested.

### Q10 — Endpoint-to-boundary flow

`BLOCKED`. Endpoint A is unavailable, and flow fails before any declaration, handler, service, persistence, or outbound hop is emitted. No declaration-only endpoint is represented as complete.

### Q11 — Affected file/node parity

`BLOCKED`. Neither File A nor Symbol A/node identity exists in current MCP output. Affected analysis fails at database open; parity, confidence, evidence, and limits are unavailable.

### Q12 — Context usefulness and counters

`BLOCKED`. Context fails before definitions, callers, callees, tests, endpoints, relations, inferred edges, mirrors, or evidence counters are emitted.

### Q13 — Coverage debt actionability

`FAIL`. Coverage returns no admitted/indexed/excluded/failed/stale/unresolved counts or examples. The only action is the runtime error's request to upgrade Penguin; no MCP-native repair action was supplied. Completeness is explicitly unproven.

### Q14 — Freshness and revision truth

`BLOCKED`. Detailed index status, coverage, and query warnings cannot emit a repository revision. Aligned, behind, dirty, stale, and unknown states cannot be distinguished. No generic stale label is substituted.

### Q15 — Semantic lifecycle integrity

`BLOCKED`. There is no visible semantic status tool. Two fresh `knowledge_doctor` attempts were made 5.1 seconds apart, but both fail at database open and are not misrepresented as semantic status. Active/staging/superseded generations, expected/ready/running/pending/retryable/terminal counters, leases, heartbeat, rate, ETA, and worker identity remain unproven.

### Q16 — Graph-first responsiveness

`FAIL`. Sequential bounded probes returned quickly but unsuccessfully: search 39 ms, context 37 ms, flow 39 ms, affected 46 ms, service graph 31 ms (client-observed elapsed time). Each returned the same non-retryable worker crash, with no result/truncation metadata. Semantic state could not be checked. Fast failure is not graph/lexical availability.

### Q17 — Three-family continuation handoff

`BLOCKED`. Search, endpoint/service inventory, and context/affected operations emit no valid initial cursor or stable identity. No continuation or family-isolation claim is possible.

### Q18 — Typed negative matrix

`FAIL`. Independently generated unknown repository, unavailable branch, unknown node, wrong-family cursor, and tampered/expired cursor probes all collapse to `QUERY_WORKER_CRASH`. A proper unavailable-branch test against a valid emitted repository is additionally blocked because no repository is emitted. Domain-specific remediation is absent.

### Q19 — Compactness and duplication

`BLOCKED`. Normal and compact endpoint calls both fail before canonical items or byte statistics. Dead-code inventory also fails; its visible registration schema does not expose a compact option. Meaning preservation and raw/sent-byte honesty cannot be checked.

### Q20 — New-user onboarding

`FAIL`. No onboarding-named tool is visible, and capability discovery cannot provide current examples. Canonical scope/options/page fields are visible on the registered search schema, but no successful fresh-identity or cursor example can be verified. No CLI-only remediation was followed.

## Bonus engineering scenarios B1–B8

### B1 — Cross-service ownership decision

`BLOCKED`. No services or relationships were emitted. Calls, dependency, ownership, and reference claims are all unproven.

### B2 — Safe-change proposal

`BLOCKED`. File A, affected nodes, callers/callees, tests, endpoints, and service evidence are unavailable. A safe-change plan would be speculative and is not fabricated.

### B3 — Conflicting retrieval signals

`BLOCKED`. Neither exact/graph candidates nor semantic rankings were returned, so no conflict case exists in current evidence.

### B4 — Endpoint completeness audit

`BLOCKED`. No implemented or declaration-only endpoint was emitted. Handler status, first-hop relations, flow completeness, and negative-proof limits cannot be compared.

### B5 — Repository isolation

`BLOCKED`. Repo A and Repo B cannot be selected. Cross-scope leakage cannot be evaluated.

### B6 — Lower-bound negative conclusion

`BLOCKED`, with the required safe conclusion: no missing relationship or missing test result can prove absence because indexed coverage, exclusions, stale state, unresolved references, and truncation are all unknown.

### B7 — Agent-A/Agent-B transfer simulation

`BLOCKED`. Penguin emitted no stable repository/node/endpoint/service identity or valid cursor. An Agent-A handoff cannot be formed without fabrication, so Agent-B continuation and continuity scoring are zero.

### B8 — Product readiness verdict

| Product dimension | Verdict | Strongest safe statement |
| --- | --- | --- |
| Exact/graph engineering investigation | `NO-GO` | The operations are registered but unusable against the current database. |
| Semantic discovery | `NO-GO` | Readiness and lifecycle are unproven; no semantic points awarded. |
| MCP runtime reliability | `NO-GO` | Lightweight health works, but all tested knowledge operations fail consistently. |
| Coverage completeness | `NO-GO` | No coverage or freshness payload is available. |
| Owner-only Tauri UX | `N/A` | No owner evidence was supplied; contributes zero points. |

Strongest safe use case: lightweight liveness/build alignment check only.

Strongest unsafe claim: that Penguin can currently answer any code, graph, endpoint, service, semantic, coverage, freshness, pagination, or negative-proof engineering question from this MCP session.

## Hard-gate outcomes

| Hard gate | Outcome | Evidence |
| --- | --- | --- |
| Penguin MCP available in fresh session | `FAIL` for scored knowledge surface | Health is alive, but every tested database-backed product call crashes before evidence. |
| Running/available identity not stale or contradictory | `PASS` | Same build ID; `outdated:false`. |
| Schema/contract/capability hash consistent | `FAIL` | Registration schema 14 conflicts with database schema 18; manifest cannot load. |
| Semantic readiness requires compatible complete active generation | `BLOCKED` | No semantic status/generation payload. No readiness claim or credit. |
| Repeated semantic responses internally consistent | `BLOCKED` | No semantic responses exist. |
| Stable node/endpoint identity round-trip | `BLOCKED` | No identities emitted. |
| Pagination avoids repeat/skip/cross-scope | `BLOCKED` | No valid cursor emitted. |
| Typed unknown repo/branch/node/cursor failures | `FAIL` | All negative probes collapse to `QUERY_WORKER_CRASH`. |
| Graph/Lexical remains available independent of semantic lifecycle | `FAIL` | Both exact and lexical calls are unavailable; immediate cause is schema incompatibility. |
| Negative conclusions account for debt/truncation | `PASS` for evaluator honesty | All absence conclusions are marked blocked/unproven. |
| Remediation avoids unavailable local CLI commands | `PASS` narrowly | Error requests a Penguin upgrade; no CLI command was prescribed. MCP-native repair remains absent. |
| No forbidden fallback used | `PASS` | Evaluation remained within brief + Penguin MCP + report write. |

Not all hard gates pass; a score of 95 or above is impossible.

## Scores

| Category | Score | Maximum | Rationale |
| --- | ---: | ---: | --- |
| Runtime identity, fresh-session load and MCP reliability | 3 | 10 | Health and build alignment work; no session identity and database cannot load. |
| Capability discovery, schemas, annotations and onboarding | 2 | 10 | Registration is visible and uniquely named; canonical manifest/onboarding/semantic operations are unavailable. |
| Exact/lexical/graph retrieval and execution tracing | 0 | 20 | All tested operations fail before evidence. |
| Semantic readiness, consistency, ranking honesty and lifecycle | 0 | 20 | No status, compatible generation, or successful semantic result. |
| Stable identities, pagination and multi-family continuation | 0 | 15 | No identities or cursors emitted. |
| Scope isolation, freshness, coverage and negative-proof honesty | 0 | 15 | Product evidence unavailable; negative boundaries collapse. |
| Compactness, responsiveness and engineering usability | 1 | 10 | Failures are fast and consistent, but no engineering result or compactness evidence exists. |
| **Total** | **6** | **100** | **NO-GO** |

## Limitations and unproven claims

- No MCP-emitted session ID or connected timestamp exists in the observed responses.
- No repository, branch, revision, snapshot, workspace, node, endpoint, service, semantic generation, or continuation cursor was emitted.
- Semantic backend, model revision/hash, dimensions, chunker version, generation rows, worker state, and readiness counters are unproven.
- Repository coverage, exclusions, failures, stale symbols, unresolved references, revision alignment, truncation, and total counts are unproven.
- Client-observed operation timings establish only rapid failure, not successful responsiveness.
- Owner Tauri behavior is N/A without current-session owner evidence and adds no points.
- The evaluation does not infer source-level causes beyond the explicit MCP schema-mismatch message.

## Top remaining defects by user impact

1. **Critical — runtime/database incompatibility:** the installed MCP build supports schema 14 but the database is schema 18, making the entire knowledge surface unusable.
2. **Critical — stale capability contract:** registered metadata advertises schema 14 while the live database requires 18; `knowledge_capabilities` cannot load and cannot reconcile the mismatch.
3. **High — domain errors masked by infrastructure failure:** repository, branch, node, and cursor negatives all collapse to `QUERY_WORKER_CRASH`.
4. **High — no semantic observability surface:** no initialize, semantic status/control, generation, model, or readiness operation is visible in the active registration.
5. **High — no stable identity or continuation path:** repository discovery fails before any MCP-native identity or cursor can be handed off.
6. **Medium — capability manifest violates its advertised bootstrap property:** the tool described as not requiring an initialized database still fails on database schema open.
7. **Medium — onboarding cannot be verified:** no onboarding-named operation or successful current-schema example is available to a fresh MCP-only user.

## Final decision

**NO-GO.** Repair the installed runtime/database schema compatibility first, restart/reconnect the MCP client if the upgraded runtime requires it, and rerun Round 23 in another genuinely fresh session. Program closure is not achieved because this independent report scores **6/100** and multiple hard gates fail or remain blocked.
