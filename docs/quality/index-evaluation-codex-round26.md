# Penguin Knowledge Round 26 — Codex Independent Evaluation

## Final verdict

**CONDITIONAL GO — Raw weighted score: 75.78/100. Hard-gate-adjusted final score: 75.78/100.**

Penguin is useful for revision-scoped exact/lexical investigation, stable symbol lookup, bounded context/flow exploration, typed cursor failures, read-only mutation preflight, and compact handoff. It is not ready for semantic/vector-assisted discovery in this session, and its coverage remains substantially partial. A scoped handled-endpoint inventory also exceeded the 30-second runtime budget, although global endpoint pagination and endpoint flow succeeded.

No hard gate failed on the evidence actually exercised. The final score remains below 95 because semantic readiness is absent, affected analysis is only a lower bound, coverage debt is large, and one scoped endpoint query timed out. Under the Round 26 closure rule, implementation remains open.

## Evaluator and fresh-process proof

- Evaluator/model: Codex, GPT-5 family. The exact deployment sub-version is not exposed by Penguin MCP and is therefore `UNPROVEN`.
- Evaluation began from the supplied new-session instruction and active Round 26 brief. After the brief was read, all product/data discovery and testing used Penguin MCP only.
- No Penguin CLI, source, Git, SQLite, old evaluation report, another index, semantic control, repository registration, index, rebuild, note write, or other mutating product operation was invoked.
- The only non-MCP write is this required report.
- Fresh MCP session: `ca977c6f-edc9-4071-a0fa-c8b801deb350`; client connected `2026-09-02T07:32:45.350Z`. Final health readback at `2026-09-02T07:45:14.252Z` retained the same session and identity.

## Runtime identity and dynamic targets

| Item | MCP-discovered value | Discovery chain |
| --- | --- | --- |
| Runtime | app `1.16.0`; build `1.16.0-f5de64b02a83a582`; schema `18`; contract `2` | `mcp_health` → `knowledge_capabilities` → final `mcp_health` |
| Capability identity | `f99fca378bb72ee30313ccc9da98ce4eb353c9b41eff230726186fd16446b67f` | initialize metadata and both health reads |
| Model bundle identity | `4193e4f88c3f16239a6853400ae2765b4b0903e97c80fcbfd814af24dd2a01e5` | health; semantic generation status was empty |
| Largest Repo | `FPMS-NT`, `repo_a48ec7fb-5987-47df-9198-06969359cb50`, branch `brazil-v2`, snapshot `snapshot_c7bf7942-2ca8-46c5-9064-db607bd598f7`, commit `3f0f1984b9e4337668529a13bad5264501729908` | architecture inventory → `knowledge_files(limit=1)` across MCP-discovered repositories; largest admitted count observed was 3,333 |
| Second Repo | `FPMS`, `repo_52c3c449-1317-49b1-aff0-2540ea7a28e5`, branch `brazil-v2`, snapshot `snapshot_91c7701f-bf18-4f8c-a21b-cd979893af4c`, commit `cfd23f4c356bf4441adf5830d5a002d1caaa0fc3` | repository scan → current indexed branch candidate → `knowledge_files`; 3,141 admitted files |
| Natural Intent | `preview segment audience task count` | newly chosen after endpoint/file discovery; terms are not an adjacent phrase |
| Primary Symbol | `TaskConfig`, node `node_70d941a1-cef3-434b-9648-9048e5745b4a` | Natural Intent search → exact `TaskConfig` search |
| Relation-rich Symbol | same `TaskConfig` node | exact search → context reported 43 first-hop relation candidates |
| Primary File | `apps/promotion/src/modules/growth-task/repositories/task-config.schema.ts` | Primary Symbol locator, lines 260–397 |
| Primary Endpoint | `gRPC AdminGrowthTaskController.CreateTaskConfig`, node `node_be66b8aa-6061-466a-a96d-a426d9b2e8d4`, identity `grpc::AdminGrowthTaskController.createtaskconfig` | endpoint page 1 → handler at `apps/promotion/src/modules/growth-task/controllers/admin-growth-task.controller.ts:86` |
| Service Pair | `FPMS-NT` → `FPMS-NT-Payment` | scoped service graph → proven `invokes` edge at `apps/admin/inteceptor/payment-external.service.ts:32` |

## Required evidence tables

### Runtime surface

| Runtime surface | Session/build/schema/contract/hash | Configured | Loaded | Healthy | Useful | Restart required | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| MCP/runtime | session `ca977…`; build `1.16.0-f5de64b02a83a582`; schema 18; contract 2; capability `f99f…b67f` | yes | yes; initialize healthy | yes; status `ok`, launcher healthy | yes for bounded exact/graph calls | no | PASS |
| Semantic/vector | model hash `4193…a01e5`; no generation IDs | bundle configured by health | native model/runtime files reported ready | generation health `UNPROVEN`; status returned `[]` | no semantic query applied | N/A | PARTIAL |

`configured`, `loaded`, `healthy`, and `useful` are separate claims: the model bundle is configured/installed, but an empty semantic-generation status does not prove an active, compatible, useful vector space.

### Repository/file reconciliation

| Repository/file measure | Aggregate | Page evidence | Reconciliation equation or bound | Safe conclusion |
| --- | ---: | --- | --- | --- |
| Discovered files | 3,340 | `knowledge_files(limit=10)` | admitted 3,333 + excluded 7 = 3,340 | exact for selected snapshot |
| Admitted source files | 3,333 | 10 returned; `returnedCount=10`, remaining 3,323, cursor present | 3,298 source-and-graph + 35 source-only = 3,333 | reconciles |
| Graph-parsed files | 3,298 | status values exposed per item | 3,298 source-and-graph + 0 graph-only = 3,298 | reconciles |
| Candidate/global total | 3,333 | `candidateCount=3333`, `totalIsExact=true` | 3,333 admitted + 0 graph-only = 3,333 | exact |
| Source-only samples | 35 total | `.dockerignore`, `.github/actions/setup-node/action.yml`, `.github/codex/prompts/review.md` | admitted/searchable text need not define parseable symbols | direct status evidence, not absence of content |
| Coverage debt | excluded 7; failed 0; stale 0; unresolved 95,718 | excluded and unresolved each paged twice | unresolved concrete item total = aggregate 95,718, delta 0 | exact debt count, investigation completeness remains partial |

### Query/retrieval lanes

| Query/retrieval lane | Repo | Duration | Candidate/root/evidence | Requested/applied/generation | Top identities | Warning |
| --- | --- | ---: | --- | --- | --- | --- |
| Q4 lexical call 1 | FPMS-NT | 6.706 s | 929 candidates / 10 returned | semantic off/off/none | controller line 11; DTO node `node_f1b…`; validator spec line 109 | coverage incomplete |
| Q4 lexical repeat | FPMS-NT | 5.282 s | 929 / 10 | off/off/none | identical top hits and hit IDs | coverage incomplete |
| Q4 lexical call 3 | FPMS | 6.098 s | 967 / 10 | off/off/none | `Client/public/languages/en_US.json:3717`; `ph_PH.json:541` | broader localization noise |
| Q4 lexical repeat | FPMS | 5.741 s | 967 / 10 | off/off/none | identical top hits and hit IDs | coverage incomplete |
| Exact Primary Symbol | FPMS-NT | 3.465 s | 616 / 5 | off/off/none | `TaskConfig`, stable node `node_70d…`, line 260 | partial coverage |
| Natural lexical description | FPMS-NT | 3.578 s | 984 / 5 | off/off/none | scheduler/module/service results; Primary Symbol absent from top 5 | recall gap |
| Semantic paraphrase | FPMS-NT | 4.409 s | 0 / 0 | requested yes; applied no; `no_active_space` | none | typed `MODE_UNAVAILABLE` |
| Hybrid | FPMS-NT | 15.322 s | 929 / 5 | requested yes; applied no; `no_active_space` | same deterministic source evidence as Natural Intent | semantic skipped honestly |

### Cursor truth table

| Cursor family | Advertised | Schema accepts | Valid continuation | Overlap/drift | Wrong-family | Tampered | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Search | yes | `page.cursor` | yes; `taskConfig` pages 1–3 returned six distinct hit IDs | none observed | cross-family tested at endpoint boundary | tamper tested at endpoint boundary | PASS |
| Files | yes | `cursor` | yes; page 1 `.cursor/cli.json`, `.dockerignore`; page 2 `.eslintrc.js`, setup action | none | file cursor → endpoints produced `CURSOR_OPERATION_MISMATCH` | N/T separately | PASS |
| Context | yes | `cursor` | yes; three pages × exactly 2 global relations | none; relation IDs distinct | N/T separately | N/T separately | PASS |
| Coverage | yes | `cursor` | yes; excluded and unresolved page 2 continued correctly | none observed | N/T separately | N/T separately | PASS |
| Endpoints | yes | `cursor` | yes; three global pages, six distinct endpoint IDs | none observed | `CURSOR_OPERATION_MISMATCH` | `CURSOR_INVALID` | PASS |
| File symbols | yes | `cursor` | schema/capability only; unexecuted | UNPROVEN | UNPROVEN | UNPROVEN | PARTIAL |
| Dead code | yes | `cursor` | fresh cursor emitted; normal/compact identity parity | page 2 unexecuted | UNPROVEN | UNPROVEN | PARTIAL |
| Note list | yes | `cursor` | unexecuted; unrelated to required code path | UNPROVEN | UNPROVEN | UNPROVEN | PARTIAL |
| Saved-query run | yes | `cursor` | `knowledge_saved_query_list` returned no saved queries | N/A_NO_DATA | N/A | N/A | N/A |
| Affected | no | no cursor/limit/depth in schema | complete returned lower-bound set only | N/A | N/A | N/A | honestly unsupported |

### Preflight/error taxonomy

| Preflight/error case | Read-only proof | Typed code | Preserved remediation | State unchanged | Verdict |
| --- | --- | --- | --- | --- | --- |
| Index preflight, owner root | `readOnly:true`, `mutationPerformed:false` | status `valid` | canonical `knowledge_index`, root, `confirmed:true`, owner approval | yes | PASS |
| Rebuild preflight, owner root | same | status `valid` | canonical `knowledge_rebuild` | snapshot/commit/index time/fingerprint identical before/after | PASS |
| Existing out-of-scope `/System` | no mutation or prompt | `ROOT_PATH_OUT_OF_SCOPE` | choose root within configured roots or update owner config | yes | PASS |
| Malformed action `bogus` | handler rejected read-only preflight | `MUTATION_PREFLIGHT_INVALID` | choose register/index/rebuild | yes | PASS |
| Wrong cursor family | read-only request | `CURSOR_OPERATION_MISMATCH` | restart endpoint paging with same scope/options/limit | yes | PASS |
| One-character cursor tamper | read-only request | `CURSOR_INVALID` | restart endpoint paging with same scope/options/limit | yes | PASS |
| Unknown repository | read-only files query | `SCOPE_NOT_FOUND` | specify a registered repository | yes | PASS |
| Unavailable branch | read-only files query | `SCOPE_NOT_FOUND` | specify branch, commit, or snapshot; candidate listed | yes | PASS |
| Unknown node | read-only node query | `NODE_NOT_FOUND` | call `knowledge_search` for current stable node ID | yes | PASS |
| Unknown endpoint | read-only flow query | `ENDPOINT_NOT_FOUND` | call `knowledge_endpoints` in same scope for fresh endpoint ID | yes | PASS |

### Coverage families

| Coverage family | Aggregate | Concrete page evidence | Exact/lower bound | Cursor | Safe conclusion |
| --- | ---: | --- | --- | --- | --- |
| Excluded | 7 | two pages of 3: `.env.example` secret-policy plus binary fonts/image | exact aggregate | yes | seven files excluded in selected snapshot; not searchable source |
| Unresolved | 95,718 | two pages of 3 with path, line, raw target, and reason codes | exact concrete/aggregate reconciliation; graph conclusions remain lower bound | yes | 95,718 unresolved references materially limit recall and negative proof |
| Cache paths | 0 pollution hits | `.pnpm-store`, `.yarn/cache`, `.yarn/unplugged`, `.bun/install/cache` returned `NO_MATCH_INCOMPLETE`; `.npm` matched only admitted `.npmrc` | negative is incomplete | search cursors N/A for zero | no package-cache pollution admitted/indexed in current evidence; filesystem absence is not proven |

### Mixed calls

| Mixed call | Duration | Complete/truncated | Cursor/warning | 30-second budget |
| --- | ---: | --- | --- | --- |
| lexical search | 4.381 s | 5/929, truncated | cursor; coverage warning | PASS |
| semantic status 1 | 0.188 s | `statuses=[]` | none | PASS |
| context | 5.068 s | 2/43, truncated families | cursor | PASS |
| semantic status 2 | 0.182 s | `statuses=[]` | none | PASS |
| flow | 5.168 s | 8 returned, truncated | direct hop evidence retained | PASS |
| semantic status 3 | 0.160 s | `statuses=[]` | none | PASS |
| affected | 7.318 s | 8/8, not truncated but lower bound | no cursor; completeness lower bound | PASS |
| semantic status 4 | 0.168 s | `statuses=[]` | none | PASS |
| service graph | 3.592 s | 84 edges, not truncated; aggregated | no cursor | PASS |

Graph and lexical calls did not wait for embeddings. All mixed calls completed under 30 seconds. Separately, `knowledge_endpoints(repo=FPMS-NT, handled_only=true, limit=2)` returned `QUERY_TIMEOUT` at the 30-second hard timeout; this is recorded under Q12 and reliability scoring.

## Q1–Q20 scenario scoring

| Scenario | Score /100 | Verdict | Direct MCP evidence | Limitation/failure | Remediation |
| --- | ---: | --- | --- | --- | --- |
| Q1 | 95 | PASS | Same session/build/schema/contract/hash across initialize metadata and health; bounded query completed 4.381 s | exact Codex deployment sub-version not MCP-exposed | expose evaluator client/model label if required for audit |
| Q2 | 96 | PASS | 101 capabilities = 101 implemented registrations; zero annotation/mutating mismatches; 26 aliases listed; 0.2 s manifest calls | aliases increase discoverability surface | keep one canonical ID in onboarding and label aliases compatibility-only |
| Q3 | 94 | PASS | FPMS-NT 3,333 admitted; 3,298 graph; 35 source-only; 0 graph-only; equations reconcile; 3.577 s | coverage partial with 7 exclusions and 95,718 unresolved refs | reduce unresolved debt; keep separate totals |
| Q4 | 91 | PASS | Four calls 6.706/5.282/6.098/5.741 s; identical repeated hit IDs and ranking within each repo | FPMS ranking led with localization/UI noise and only 2/5 term coverage | improve multi-term intent ranking and de-duplicate localization families |
| Q5 | 92 | PASS | Exact `taskConfig`, three pages ×2; six distinct occurrence hit IDs and file/line/byte locators; 0.544/0.544/0.283 s | total reported as lower bound (`totalIsExact=false`) and exhaustion not reached | retain cursors to deterministic exhaustion in regression suite |
| Q6 | 62 | PARTIAL | exact recovered `TaskConfig` at rank 1; semantic returned typed `MODE_UNAVAILABLE/no_active_space` in 4.409 s | lexical description did not recover Primary Symbol in top 5; semantic unavailable | build compatible active generation and improve lexical synonym ranking |
| Q7 | 35 | UNPROVEN | aggregate and scoped semantic status twice 5.205 s apart returned `statuses=[]` | no active/staging/superseded generation, counts, provider/model revision, worker lease, heartbeat, or ETA to reconcile | expose a complete generation record and lifecycle state |
| Q8 | 65 | PARTIAL | hybrid request in 15.322 s explicitly reported source/symbol lanes and skipped semantic with `no_active_space` | no vector lane, so four-way evidence decomposition impossible | activate semantics; retain current honest fallback diagnostics |
| Q9 | 93 | PASS | context total 43 exact; three pages each returned globally bounded 2 distinct `referencedBy` relations; 5.313/5.670/5.521 s | exhaustion not reached; other relation families occur later | add regression proving complete exhaustion across family boundaries |
| Q10 | 88 | PASS/PARTIAL | search/files/context/coverage/endpoints valid continuations; capability truth table matches schemas | saved-query has no data; file-symbol/note/dead-code continuation not fully exercised | ship seeded read-only saved query or make no-data test fixture available |
| Q11 | 88 | PASS | symbol search→node→context→affected→search retained node, repo, snapshot, path and lines; endpoint inventory→node→flow accepted fresh ID | endpoint `get_node` has `repoId:null`, no versions/source, and null target locator although scoped revision exists | hydrate endpoint node with canonical repository and declaration/handler locator |
| Q12 | 68 | PARTIAL | global pages: 1–3 returned six ordered distinct IDs; endpoint flow reached handler→service and deeper calls in 5.327 s | required scoped handled inventory timed out at 30 s; flow truncated before a single clearly labelled persistence/outbound terminal | optimize scoped endpoint query; label terminal boundary/hop status explicitly |
| Q13 | 60 | PARTIAL | file/symbol affected parity exact: same eight changed nodes, three dependencies, no tests/routes; 5.708/5.415 s | schema offers no requested depth/limit/cursor; result is lower bound and suggested commands are not execution proof | support bounded depth/limit; expose proven impacted/test edges with evidence |
| Q14 | 88 | PASS | excluded and unresolved each paged twice; unresolved count reconciled exactly; cache searches bounded 0.263–3.826 s | 95,718 unresolved refs; negative cache claims remain incomplete | prioritize resolver debt and retain safe negative wording |
| Q15 | 98 | PASS | mutation schemas require root/path + confirmed; annotations truthful; doctor preflights 0.9–6.1 ms, typed errors, unchanged snapshot | none material | retain contract tests; never require mutator invocation for discovery |
| Q16 | 96 | PASS | four fresh cursor families continued; mismatch and tamper are distinct typed codes; scope/node/endpoint errors have remediation; slowest error 21.230 s | unknown-node boundary is slow | index node lookup or short-circuit invalid stable-ID shape |
| Q17 | 95 | PASS | endpoints IDs/counts/cursor equal normal/compact; 18,171→11,391 bytes ratio .627. Dead code equal; 4,527→2,984 ratio .659 | estimates correctly labelled, but method of estimate not externally verified | document serialization boundary in capability/onboarding |
| Q18 | 92 | PASS | all nine mixed calls under 7.318 s; semantic calls interleaved; lexical/graph remained responsive | separate scoped endpoints timeout shows uneven operation isolation | profile endpoint handler and preserve 30 s cancellation |
| Q19 | 92 | PASS | Largest/Second query scopes stayed separate; unknown repo/branch/node/endpoint and cursor failures specific; no cross-repo hits | coverage/exclusions/unresolved/source-only prevent proof of global absence | keep structured negative-proof checklist in responses |
| Q20 | 91 | PASS | onboarding 20.206 s; canonical nested search example; Agent B resumed MCP-only handoff cursor and same snapshot, 3 hits in 4.622 s | onboarding includes optional owner CLI and one legacy alias `index_status`; duration is high | lead with canonical MCP-only section and move owner CLI to separate owner doc |

## Bonus scenario scoring

Bonus scenarios do not add points; they can reduce relevant categories.

| Scenario | Score /100 | Verdict | Direct MCP evidence | Limitation/failure | Remediation |
| --- | ---: | --- | --- | --- | --- |
| B1 | 93 | PASS | Service graph in 3.607 s proves FPMS-NT `invokes` FPMS-NT-Payment at `apps/admin/inteceptor/payment-external.service.ts:32`, parser extracted, confidence 1 | environment-level aggregation does not prove a live request occurred | preserve “static invokes edge,” not runtime execution wording |
| B2 | 68 | PARTIAL | Primary File affected/context/flow/coverage evidence identifies sibling types, TaskConfig references, CreateTaskConfig flow, exact snapshot | affected exposes no impacted nodes/tests/routes and is lower-bound | plan: edit only schema; inspect 43 context relations; verify handler/service/DTO/validator; run suggested tests/typecheck; do not claim complete blast radius |
| B3 | 40 | BLOCKED | exact/graph recovered Primary Symbol while semantic returned no active space | no semantic ranking exists, so an actual ranking disagreement cannot be found | create compatible active generation, then compare stable identities across lanes |
| B4 | 40 | UNPROVEN | two scoped status reads returned empty arrays | no historical generation records to prove superseded hygiene | expose active/staging/superseded history with terminal/current accounting |
| B5 | 68 | PARTIAL | schema exposes pause/resume/retry/cancel; truthful mutating/destructive annotations; generation required for retry/cancel | current valid actions cannot be determined from empty status | return explicit no-generation action eligibility in semantic status |
| B6 | 40 | UNPROVEN | fresh MCP session saw no queued semantic work and no progress | wake contract cannot be demonstrated; no mutation invoked | expose read-only worker capability/heartbeat and test with real queued work |
| B7 | 94 | PASS | actionable remediation on preflight root error, malformed action, cursor mismatch/tamper, unknown repo/branch/node/endpoint | some messages reference owner configuration without an MCP-readable owner guide | link remediation to canonical onboarding/capability IDs |
| B8 | 92 | PASS | lane verdicts below derive from exact scenario evidence | owner-only Tauri UX has no supplied evidence | supply current owner screenshots/observations separately |

## Q2 operation discovery and safety audit

Canonical operations discovered through the capability manifest and registrations:

- architecture `knowledge_architecture` (alias `get_architecture`); repositories `knowledge_index_status`; services `knowledge_service_graph`; files `knowledge_files`; endpoints `knowledge_endpoints`; coverage `knowledge_coverage`;
- exact/phrase/substring/lexical/semantic/hybrid retrieval through `knowledge_search` modes plus nested `options.semantic`;
- node `knowledge_get_node` (alias `get_node`); context `knowledge_context`; flow `knowledge_flow`; affected `knowledge_affected`; dead code `knowledge_dead_code` (alias `find_dead_code`);
- semantic state/control `knowledge_semantic_status` / `knowledge_semantic_control`;
- onboarding `knowledge_onboarding_generate`; doctor `knowledge_doctor`;
- owner mutation surfaces `knowledge_repository_register`, `knowledge_index`, `knowledge_rebuild`.

Across all 101 capability entries, no annotation mismatch was found: read-only operations advertised `readOnlyHint:true`, `destructiveHint:false`, `idempotentHint:true`, `openWorldHint:false`; mutators advertised the inverse safety posture and required confirmation. This is manifest/schema evidence. Observed behavior was sampled on read-only operations only; mutators were deliberately never invoked.

## Q8 hybrid evidence decomposition

For the highest Natural Intent hits:

- Source text directly proves the queried terms occur at a particular snapshot/path/line and provides a content hash. It does not prove execution or ownership.
- Exact/path evidence, when used, proves name/path equality and occurrence provenance. It does not prove call direction.
- Graph relations with extracted provenance can prove a static edge such as endpoint `handles` handler or symbol `calls` another symbol. They remain incomplete when unresolved references or dynamic dispatch exist.
- Vector similarity was not applied (`no_active_space`) and proved nothing. The response correctly fell back to source/symbol evidence rather than presenting semantic usefulness.

## Q11 stable identity round trip

The Primary Symbol retained:

`node_70d941a1-cef3-434b-9648-9048e5745b4a` → identity `repo_a48ec7fb-5987-47df-9198-06969359cb50::apps/promotion/src/modules/growth-task/repositories/task-config.schema.ts::TaskConfig` → FPMS-NT/brazil-v2/snapshot `snapshot_c7bf…` → path lines 260–397. The post-affected exact search returned the same node at line 260.

The Primary Endpoint retained node `node_be66…`, identity `grpc::AdminGrowthTaskController.createtaskconfig`, and flowed to handler `node_09a…` at controller lines 86–106, then service method `node_cadb…` at `task-config.service.ts:73–183`. The endpoint node itself has null repository/source fields; the scoped target/revision and flow supply the usable provenance, so identity quality is PARTIAL rather than perfect.

## Q12 endpoint flow classification

| Hop | Classification | Evidence |
| --- | --- | --- |
| gRPC endpoint → `createTaskConfig` | direct | `handles`, extracted at controller line 84; handler lines 86–106 |
| handler → `TaskConfigService.create` | direct | `calls`, controller line 93; service lines 73–183 |
| handler → decoder/DTO/user/error types | direct static graph evidence | extracted `calls`/`references`/`throws`; not execution proof |
| service → `fetchBiCohort`, `validateForCreate`, uploaded-list population, reward provisioning | direct static calls | file/line provenance returned |
| persistence/outbound terminal | unresolved/truncated | flow limit reached; `truncated:true`; no single terminal was labelled as persistence/outbound |

## Q13 affected parity and minimal safe-change envelope

File input and stable-symbol input produced the same lower-bound result: eight changed sibling symbols from the schema file, three dependencies, zero impacted nodes, zero tests, zero routes, and suggestions `pnpm test` / `pnpm typecheck`. This proves input parity for this target; it does not prove that no impact or tests exist. Filenames and suggested commands were not treated as test-execution proof.

Minimal safe-change plan from current MCP evidence:

1. Keep edits limited to the Primary File and named `TaskConfig` field/type contract.
2. Review all 43 paged context relations, especially references from service/cache/campaign snapshot symbols.
3. Re-run the CreateTaskConfig endpoint flow to confirm handler, decoder, validation, service, and downstream boundary.
4. Inspect unresolved-reference coverage near the touched module before claiming complete impact.
5. Run targeted tests and typecheck outside this read-only evaluation. Current evidence proves no test execution.

## Q19 scope and negative-proof matrix

| Boundary | Direct result | Safe interpretation |
| --- | --- | --- |
| Largest Repo | 929 Natural Intent candidates; FPMS-NT-only repo/snapshot IDs | scoped positive evidence only |
| Second Repo | 967 candidates; FPMS-only repo/snapshot IDs | deterministic but noisier ranking; no leakage from FPMS-NT |
| Unknown repo | `SCOPE_NOT_FOUND` | repository is not registered under that exact name in current MCP inventory |
| Unavailable branch | `SCOPE_NOT_FOUND` with valid branch candidate | requested branch unavailable; does not mean repository content lacks the query |
| Unknown node | `NODE_NOT_FOUND` | exact stable node ID not present in selected current scope |
| Unknown endpoint | `ENDPOINT_NOT_FOUND` | exact endpoint target not found in selected current scope |
| Wrong cursor family | `CURSOR_OPERATION_MISMATCH` | cursor cannot be used for endpoint continuation |
| Tampered cursor | `CURSOR_INVALID` | cursor integrity failed |

Strongest safe negative conclusion: **No verified match was returned in the selected admitted source/index scope and options.** Because the selected repository has excluded files, 35 source-only files, 95,718 unresolved references, truncation on several operations, and other repositories/branches with stale or unavailable checkout alignment, current MCP evidence cannot prove global filesystem absence, safe deletion, runtime non-execution, or complete blast radius.

## Q20 MCP-only handoff

Agent A handoff contained only MCP-emitted data: FPMS-NT repo ID, branch, commit, snapshot, Primary Symbol node, Primary Endpoint node, an unused Natural Intent search cursor, and the coverage-incomplete warning. Agent B submitted the same query/mode/options/scope plus that cursor and received the next three distinct hits on the same snapshot in 4.622 seconds. No rediscovery was needed.

## Semantic lifecycle and control

- Repeated aggregate and scoped `knowledge_semantic_status` calls returned `statuses: []`.
- A semantic-only query returned `MODE_UNAVAILABLE` with reason `no_active_space`.
- A hybrid query set `requested:true`, `applied:false`, `activeGenerationIds:[]`, and `skippedLanes:[semantic/no_active_space]` while exact/lexical lanes remained useful.
- The semantic-control schema exposes `pause`, `resume`, `retry`, `cancel`; all are mutating, destructive, non-idempotent, confirmation-required operations. `scopeKey` and `operationToken` are required; retry/cancel also require `generationId`.
- Current action eligibility, worker wake behavior, historical supersession, provider/model revision, dimensions, digests, pooling, normalization, chunker version, lease/heartbeat/rate/ETA are `UNPROVEN` because no status record exists.

## Readiness verdict by lane

| Lane | Verdict | Strongest safe use | Strongest unsafe claim |
| --- | --- | --- | --- |
| Exact/graph | GO with caveats | revision-scoped occurrence lookup, direct static edge investigation, endpoint handler tracing | complete runtime execution or safe deletion |
| Semantic discovery | NO-GO | none in this session; only typed fallback diagnostics | similarity, hybrid boost, model readiness, generation completeness |
| Runtime reliability | CONDITIONAL GO | bounded health/search/context/flow/affected/service calls | uniformly fast scoped queries; scoped endpoint query timed out |
| File/coverage completeness | CONDITIONAL GO | exact admitted/graph/source-only reconciliation and concrete debt paging | absence across excluded/unresolved/unindexed content |
| Identity/continuation | GO with caveats | stable symbol and endpoint round trip, signed typed cursors | perfect endpoint hydration or all-family exhaustion |
| Owner-only Tauri UX | N/A | no owner evidence supplied | any UX/install parity assertion beyond MCP runtime identity |

## Category scoring and exact arithmetic

| Category | Weight | Category score /100 | Weighted contribution | Evidence summary | Remaining gap |
| --- | ---: | ---: | ---: | --- | --- |
| Runtime identity, installed MCP parity, reliability | 10% | 88 | 8.80 | consistent build/session/schema/hash; most calls bounded | scoped endpoint timeout; occasional queue saturation during broad parallel scan |
| Discoverability, schemas, annotations, onboarding, remediation | 14% | 92 | 12.88 | 101/101 registrations, zero annotation mismatches, actionable typed remediation | onboarding latency and optional CLI/alias clutter |
| Exact, lexical, graph, context, flow usefulness and latency | 20% | 88 | 17.60 | deterministic search; paged context; evidence-bearing flow/service graph | lexical miss for Primary Symbol; flow terminal truncated |
| Semantic readiness, model identity, hybrid honesty, lifecycle | 16% | 25 | 4.00 | honest typed fallback and bundle model hash | no active/history/status/model-generation details |
| Stable identity, pagination, cursor correctness, affected parity | 20% | 86 | 17.20 | strong signed cursor behavior, typed mismatch/tamper, symbol parity | endpoint hydration partial; affected lower bound/no depth-limit |
| File reconciliation, coverage debt, cache hygiene, negative-proof honesty | 15% | 72 | 10.80 | equations reconcile; debt pages exact; safe cache conclusion | 95,718 unresolved refs and 7 exclusions |
| Compactness and Agent handoff usability | 5% | 90 | 4.50 | identity/count/cursor parity; .627/.659 ratios; handoff resumed | estimates not independently serialized; onboarding slow |

Arithmetic:

`88×0.10 + 92×0.14 + 88×0.20 + 25×0.16 + 86×0.20 + 72×0.15 + 90×0.05`

`= 8.80 + 12.88 + 17.60 + 4.00 + 17.20 + 10.80 + 4.50 = 75.78/100`

- **Raw weighted score: 75.78/100**
- **Hard-gate-adjusted final score: 75.78/100** (no hard-gate cap was triggered; score was not rounded upward)

## Hard gates

| Hard gate | PASS/FAIL | Direct evidence | Score impact |
| --- | --- | --- | --- |
| Fresh MCP available/loaded | PASS | health `ok`, configured, initialize/launcher healthy | none |
| Runtime/build/schema/contract/hash parity | PASS | running=available `1.16.0-f5de…`; restart false; schema 18/contract 2/hash stable | none |
| No unsupported semantic claim | PASS | semantic explicitly unavailable/not applied | semantic category reduced |
| Four Q4 calls under 30 s | PASS | 6.706, 5.282, 6.098, 5.741 s | none |
| Exact occurrence pagination correctness | PASS | three pages, six distinct hits/locators, limit 2 | none |
| Global context limit/cursor correctness | PASS | exactly two relations on each of three pages; distinct IDs/same scope | none |
| Advertised required cursor support works | PASS | search/files/context/coverage/endpoints continued; no-data families labelled | partial family coverage lowers category |
| Fresh node/endpoint identities round trip | PASS | symbol accepted by node/context/affected/search; endpoint accepted by node/flow | endpoint hydration lowers score |
| File totals reconcile | PASS | 3,333=3,298+35; 3,298=3,298+0; 3,333=3,333+0 | none |
| Non-zero debt pageable/bounded | PASS | excluded 7 and unresolved 95,718 returned concrete pages/cursors | completeness category reduced |
| No package-cache pollution in current evidence | PASS | only `.npmrc` matched; four cache directory patterns no-match-incomplete | none; not filesystem absence proof |
| Mutation discovery read-only | PASS | manifest schemas + doctor only; no prompt/mutation; state stable | none |
| Mutation root/confirmation/annotations truthful | PASS | all three schemas require root/path and confirmed; destructive annotations | none |
| Cursor mismatch vs tamper distinct | PASS | `CURSOR_OPERATION_MISMATCH` vs `CURSOR_INVALID` | none |
| Root/cursor remediation preserved | PASS | structured remediation returned for all tested boundaries | none |
| Graph/lexical independent of semantics | PASS | mixed calls bounded while semantic status empty | none |
| Compact meaning/count honesty | PASS | identical IDs/counts/cursors; estimates labelled | none |
| Negative-proof honesty | PASS | all negative claims retain coverage/source-only/unresolved/truncation/revision caveats | none |
| Evaluation boundary | PASS | MCP-only product/data testing; no mutator invoked | report valid |

The scoped handled-endpoint timeout is a serious reliability defect but is not one of the brief’s explicit automatic hard-gate conditions once global endpoint cursor support and fresh endpoint identity/flow were independently proven. It materially reduced Q12 and category 1/3 scores.

## Accuracy, recall, evidence quality, completeness, reliability, latency, semantic readiness, first-user usability

- Accuracy: **GO with caveats.** Exact source occurrence, stable symbol, static relation, cursor, and error claims are strongly evidence-bearing.
- Recall: **CONDITIONAL GO.** 95,718 unresolved references, source-only files, exclusions, truncation, and lexical miss prevent strong completeness claims.
- Evidence quality: **GO with caveats.** Snapshot, path, line, node, content hash, and edge provenance are generally present; endpoint node hydration and affected evidence are weaker.
- Completeness: **NO-GO for proof of absence/complete blast radius.** Coverage is explicitly partial.
- Reliability: **CONDITIONAL GO.** Most calls were responsive, but scoped endpoint inventory timed out and broad parallel scanning briefly produced query-busy responses.
- Latency: **CONDITIONAL GO.** Q4 and Q18 met 30 seconds; onboarding took 20.206 seconds; unknown-node lookup took 21.230 seconds; scoped endpoint inventory timed out.
- Semantic/vector readiness: **NO-GO.** No active generation or generation metadata was available.
- First-user MCP usability: **CONDITIONAL GO.** Schemas, annotations, typed remediation, and handoff are good; semantic absence, coverage debt, and endpoint performance require expert caution.

## Five highest-priority remaining defects

1. **No active semantic generation or inspectable lifecycle.** Reproduction: scoped `knowledge_semantic_status` twice → `statuses=[]`; semantic search → `MODE_UNAVAILABLE/no_active_space`.
2. **Very large unresolved-reference debt.** Reproduction: `knowledge_coverage` for FPMS-NT snapshot, kind `unresolved`, limit 3 → exact 95,718 with concrete pages.
3. **Scoped endpoint inventory can hit the hard timeout.** Reproduction: `knowledge_endpoints(repo=FPMS-NT, branch=brazil-v2, snapshot_id=snapshot_c7bf…, handled_only=true, limit=2)` → `QUERY_TIMEOUT` at 30 seconds.
4. **Affected analysis is structurally under-bounded and low-recall.** Reproduction: file and stable-symbol calls both return eight changed siblings, zero impacted/tests/routes, lower-bound completeness; registration schema exposes no depth, limit, or cursor.
5. **Endpoint stable-node hydration is incomplete.** Reproduction: `knowledge_get_node(id=node_be66…)` accepts the identity but returns `repoId:null`, empty versions, `source:null`, and null target locator; flow must restore provenance.

## Owner-only Tauri evidence (not MCP-scored)

No current owner screenshots or observations were supplied. Therefore all requested owner-only checks are `N/A_OWNER_EVIDENCE_NOT_SUPPLIED`: Graph opens/focus state, visible semantic model/progress, valid control visibility, background work after App closure, Graph/Storage responsiveness, and App/MCP installed-build visual parity. No score adjustment was made.

## Closure

Round 26 Codex result is **75.78/100, CONDITIONAL GO**. It does not satisfy the 95–100 closure threshold. Exact/graph investigation is usable with explicit lower-bound caveats; semantic discovery and complete negative proof are not ready.
