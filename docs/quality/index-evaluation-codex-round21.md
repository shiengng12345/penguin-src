# Penguin Wiki / Knowledge Evaluation — Codex Round 21

> Evaluation date: 2026-08-31  
> Evidence boundary: Penguin MCP only  
> Intended path: `docs/quality/index-evaluation-codex-round21.md`

## 1. Compliance and fresh-process proof

### Consumer-boundary compliance

- Used only tools exposed under `mcp__penguin__*`.
- Did not use shell, filesystem, CLI, Git, SQLite, source-tree reads, browser, web, GUI, memory, prior reports, or write operations.
- Did not mutate Knowledge state.
- Discovered 82 Penguin tools from the process tool surface.
- Duplicate tool names: 0.
- All 82 tool descriptions carried the same contract identity.
- MCP annotations were not exposed by the host projection, so read/write annotation parity could not be independently verified.
- `knowledge.semantic_status` and `knowledge.semantic_control` were advertised by `knowledge_capabilities` but absent from the callable process tool surface.

### Fresh-process evidence

| Field | MCP evidence |
| --- | --- |
| Client | Codex; exact client/model/version not exposed by Penguin MCP |
| Session start/timezone | Not exposed by Penguin MCP |
| Process/session ID | Not exposed |
| MCP server | `penguin` |
| Server/app version | `1.16.0` |
| Build | `1.16.0-9daa6e898324a9a1` |
| Running build | `1.16.0-9daa6e898324a9a1` |
| Available build | `1.16.0-9daa6e898324a9a1` |
| Restart required | `false` |
| Schema | 18 |
| Contract | 2 |
| Capability hash | `e38ea18f3da0cd3a3f68941a8c8adc2e13bc76d8fa898461160fa847d56365fb` |
| Initialize evidence | `mcp__penguin__mcp_health({})` returned `initializeHealthy:true` |
| Fresh process proven | No: MCP exposed neither a process/session identity nor a mechanism to create and compare Agent A and Agent B |

`FRESH_SESSION_NOT_PROVEN` applies. Environment Readiness is capped at 69/100.

The process demonstrably initialized and called Penguin, but “new process” cannot be distinguished from a previously running client using the available MCP evidence.

## 2. MCP/runtime/repository/semantic preflight

### Runtime identity

`mcp__penguin__mcp_health({})` returned:

```json
{
  "appVersion": "1.16.0",
  "buildId": "1.16.0-9daa6e898324a9a1",
  "schemaVersion": 18,
  "contractVersion": "2",
  "capabilityHash": "e38ea18f3da0cd3a3f68941a8c8adc2e13bc76d8fa898461160fa847d56365fb",
  "status": "ok",
  "initializeHealthy": true,
  "generation": {
    "runningBuildId": "1.16.0-9daa6e898324a9a1",
    "availableBuildId": "1.16.0-9daa6e898324a9a1",
    "outdated": false,
    "restartRequired": false
  },
  "queryRuntime": {
    "workers": 2,
    "hardTimeoutMs": 30000
  }
}
```

Health, capabilities, tool descriptions, and Knowledge search diagnostics agreed on contract 2 and capability hash. No mixed build identity was observed.

### FPMS-NT revision

| Field | Value |
| --- | --- |
| Repository | FPMS-NT |
| Repo ID | `repo_a48ec7fb-5987-47df-9198-06969359cb50` |
| Branch | `brazil-v2` |
| Branch ID | `branch_1d21f868-3252-4b74-8289-8f7c4735247f` |
| Commit | `3f0f1984b9e4337668529a13bad5264501729908` |
| Snapshot | `snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55` |
| Worktree fingerprint | `073264f852ac84af18fb68cb22b56c5bdb3801e578c69510f638e13a0b0544c5` |
| Freshness | fresh, clean, exact commit/worktree |
| Indexed at | `2026-08-31T11:21:16.695Z` |
| Discovered/admitted/excluded/failed/stale | 3340/3333/7/0/0 |
| Unresolved references | Aggregate 84,447; itemized 84,024 |
| Reconciliation | mismatch, delta -423 |
| Completeness | partial/lower bound |

### Dynamic derivation

Capability hash ends in `fb`:

- Penultimate hex = `f` = 15
- Final hex = `b` = 11
- `endpointPage = 2 + (15 mod 2) = 3`
- `endpointIndex = 11 mod 5 = 1`
- `conceptIndex = 15 mod 3 = 0`

Page 3, item 1:

```text
gRPC CMS.BackendService.DeleteConfigArticle
node_230694fb-950e-4a7d-b735-6d9d4ba99e43
grpc::CMS.BackendService.deleteconfigarticle
handler: node_44322d8a-1afd-4518-a916-63266c2b4ef0
path: apps/cms/src/article/article.controller.ts
```

The mandatory concept question was executed exactly once. It returned:

```json
{
  "error": {
    "code": "QUERY_TIMEOUT",
    "message": "query exceeded the hard timeout",
    "retryable": false
  }
}
```

No actionable semantic result existed from which to select `conceptIndex=0`. `DYNAMIC_SELECTION_FALLBACK` was therefore applied to the final actionable symbol emitted on dynamic endpoint page 3:

```text
GetConfigArticleById
node_6eb94c01-6c1a-4ab8-a369-baf0e7915142
repo_a48ec7fb-5987-47df-9198-06969359cb50::apps/cms/src/article/article.controller.ts::ArticleController.GetConfigArticleById
```

### Capability calls

| Capability | Advertised | Real MCP call | Build/generation | Runtime state | Verdict |
| --- | --- | --- | --- | --- | --- |
| Health | Yes | `mcp_health({})` succeeded | current/current | ok | PASS |
| Capabilities | Yes | `knowledge_capabilities({compact:true,contract_version:"2"})` succeeded | current | 101 registered | PASS |
| Onboarding | Yes | `knowledge_onboarding_generate({repo:"FPMS-NT",branch:"brazil-v2"})` succeeded | current | read-only | PARTIAL: recommends CLI |
| Search | Yes | Exact/path/lexical succeeded | current | graph/lexical available | PASS |
| Context | Yes | Endpoint and symbol calls succeeded | current | lower-bound | PASS |
| Flow | Yes | Endpoint-to-service graph succeeded | current | partial | PASS |
| Affected | Yes | Node succeeded; path timed out | current | lower-bound | PARTIAL |
| Endpoints | Yes | Cursor pagination succeeded | current | 608 exact candidates | PASS |
| File symbols | Yes | Cursor continuation succeeded | current | 15 exact candidates | PASS |
| Dead-code audit | Yes | Returned `truncated:true`, `nextCursor:null` | current | 5,650 candidates | FAIL |
| Service graph | Yes | Timed out at 30 seconds | current | unavailable for use | FAIL |
| Semantic status | Yes, required on MCP | Not exposed as callable tool | unknown | not observable | FAIL |
| Semantic search | Yes | Every bounded semantic request timed out | unknown | not usable | FAIL |
| Notes | Yes | Returned a global candidate despite FPMS-NT input | current | revision unknown | FAIL scope safety |
| Source pack | Yes | Returned verified locator with empty snippet | current | incomplete | PARTIAL |

### Semantic lifecycle

| Semantic state | Model/space | Ready/total/failed | Active/staging | Graph available | Verdict |
| --- | --- | --- | --- | --- | --- |
| Status unavailable | Bundled manifest identifies `nomic-embed-text-v1.5`; model hash `b4342336…` | Not exposed | Not exposed | Yes | UNAVAILABLE |
| Mandatory concept query | Requested FPMS-NT semantic blend | Timed out | Not exposed | Yes afterward | FAIL |
| Three code-language variants | FPMS-NT symbol space | All timed out | Not exposed | Yes | FAIL |
| Invalid workspace selection | `workspace_missing_round21` | Timed out instead of typed selection error | Not exposed | Yes afterward | FAIL |

No claim that vectors are active, ready, paused, complete, or progressing is supportable.

## 3. Scores and hard caps

### Product Capability: 46/100

| Dimension | Score |
| --- | ---: |
| Fresh discovery and scope safety | 3/8 |
| Exact/path/concept retrieval | 5/12 |
| Context/source-pack usefulness | 4/8 |
| Graph/flow/affected quality | 9/14 |
| Endpoint identity and pagination | 7/10 |
| Coverage/completeness honesty | 7/9 |
| Service/cross-repo identity | 1/7 |
| Semantic recall and provenance | 0/12 |
| Background lifecycle/recovery truth | 1/10 |
| Runtime identity, errors and parity | 6/7 |
| Wiki/API provenance boundary | 3/3 |
| **Total** | **46/100** |

### MCP-only User Experience: 43/100

| Dimension | Score |
| --- | ---: |
| New-session discoverability | 9/18 |
| Callable annotated surface | 8/15 |
| Bounded output and speed | 5/12 |
| Stable IDs and three cursor families | 7/15 |
| Engineering evidence/actionability | 12/18 |
| Semantic status and degradation clarity | 2/12 |
| Restart/handoff without manual reconfiguration | 0/10 |
| **Total** | **43/100** |

### Environment Readiness: 56/100

| Dimension | Score |
| --- | ---: |
| MCP initialize/tools/health | 20/20 |
| Running/available build-generation identity | 20/20 |
| Fresh Agent-A/Agent-B replay | 0/15 |
| FPMS-NT freshness/coverage | 12/15 |
| Active semantic generation integrity | 0/15 |
| Worker progress/wake/restart observability | 0/10 |
| Timeout/error observability | 4/5 |
| **Total before cap** | **56/100** |

### Applied hard caps

| Condition | Evidence | Applied |
| --- | --- | --- |
| Fresh process not proven | No PID/session ID or Agent-B process surface | Environment cap 69; score already 56 |
| Silent repository scope crossing | `get_architecture({repo:"FPMS-NT",...})` returned all 20 repositories; `note_list({repo:"FPMS-NT"})` returned repo-null global note | Product/MCP UX cap 69; scores already below |
| Source/CLI fallback | None used | No non-compliance cap |
| Semantic claimed ready falsely | No ready claim was made | Not applied |
| Graph blocked by semantic backfill | Graph remained callable; semantic state itself unobservable | Not applied |

## 4. Q1–Q20 evidence records

All records share runtime identity `1.16.0-9daa6e898324a9a1`, contract 2, schema 18, capability hash `e38e…65fb`, and FPMS-NT snapshot `snapshot_5225…ee55` unless stated otherwise.

### Q1 — Zero-memory MCP onboarding

- scenario: New AI investigates an unfamiliar FPMS-NT symptom safely.
- MCP tool and exact bounded inputs: `knowledge_onboarding_generate({repo:"FPMS-NT",branch:"brazil-v2"})`; then `index_status({mode:"detailed"})`, `knowledge_coverage({repo:"FPMS-NT",branch:"brazil-v2",kind:"excluded",limit:3})`, bounded search/context/affected calls.
- raw result or exact typed error: onboarding established Status → Coverage → Scoped Search → Explore → Affected → Source Review and warned that negative/partial/lower-bound/stale results require coverage checks. It nevertheless rendered local CLI commands, not MCP calls. Path affected call returned `QUERY_TIMEOUT`.
- elapsed time: onboarding 4,651 ms; index 306 ms; excluded coverage 1,414 ms.
- running/available build and generation: current/current; restart false.
- capability/schema/contract identity: `e38e…65fb`/18/2.
- repo/branch/revision/snapshot: FPMS-NT/`brazil-v2`/`3f0f…9908`/`snapshot_5225…ee55`.
- coverage and freshness: fresh; partial; 3340/3333/7/0/0; 84,447 unresolved.
- candidateCount/returnedCount/totalIsExact: excluded 7/3/true.
- cursor/hasMore/truncated: excluded cursor emitted; truncated true.
- retrieval lanes: status, coverage, lexical/path, graph.
- evidence origin/method/confidence: MCP metadata and extracted graph; high for sequence, medium for usability.
- dynamic IDs and result that emitted them: repo/snapshot emitted by status; endpoint/handler emitted by endpoints.
- workarounds: mapped onboarding’s CLI-oriented guidance to MCP tools manually.
- verdict: PARTIAL
- confidence: high

### Q2 — Exact process/runtime identity

- scenario: Correlate runtime identity across health, capabilities, tools, and Knowledge.
- MCP tool and exact bounded inputs: `mcp_health({})`; `knowledge_capabilities({compact:true,contract_version:"2"})`; bounded path search.
- raw result or exact typed error: running and available build IDs matched; `outdated:false`, `restartRequired:false`; search diagnostics repeated contract 2 and capability hash.
- elapsed time: health samples 3,104 ms and 2,621 ms; capabilities 269 ms; path search 578 ms.
- running/available build and generation: identical.
- capability/schema/contract identity: identical.
- repo/branch/revision/snapshot: exact FPMS-NT revision.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: path 1/1; exactness represented by exact path ranking.
- cursor/hasMore/truncated: false.
- retrieval lanes: health/capabilities/path.
- evidence origin/method/confidence: direct MCP; high.
- dynamic IDs and result that emitted them: status and path search.
- workarounds: none.
- verdict: PASS
- confidence: high

### Q3 — Graph-first availability

- scenario: Repository discovery, exact/path search, context, and endpoints without semantic dependency.
- MCP tool and exact bounded inputs: `status_panel({})`; endpoints pages with `limit:5`; exact/path searches with `semantic:"off"`; context calls with `allow_fallback:false`.
- raw result or exact typed error: endpoints and context worked. Exact node-ID search and exact symbol-name search returned zero, while path search and ID context succeeded.
- elapsed time: endpoint pages 730/732/756 ms; path search 320 ms; endpoint context 4,783 ms.
- running/available build and generation: current/current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: exact FPMS-NT revision.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: endpoints 608/5/true; path 1/1; exact ID search 0/0.
- cursor/hasMore/truncated: endpoint cursors emitted.
- retrieval lanes: repository, path, graph.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: endpoint pagination.
- workarounds: exact node search required context instead.
- verdict: PARTIAL — endpoint pagination preceded semantic, but exact/path search was executed after the first semantic attempt, so the required order was not fully met.
- confidence: high

### Q4 — Semantic lifecycle truth

- scenario: Read semantic status twice at least five seconds apart.
- MCP tool and exact bounded inputs: capability inspection advertised `knowledge_semantic_status({scopeKey?:string})`.
- raw result or exact typed error: no `mcp__penguin__knowledge_semantic_status` callable tool existed in this process. No first or second status read was possible.
- elapsed time: N/A.
- running/available build and generation: current/current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: FPMS-NT exact revision.
- coverage and freshness: graph coverage available; vector coverage unavailable.
- candidateCount/returnedCount/totalIsExact: N/A.
- cursor/hasMore/truncated: N/A.
- retrieval lanes: capability registry only.
- evidence origin/method/confidence: advertised contract versus actual tool surface; high.
- dynamic IDs and result that emitted them: none.
- workarounds: none permitted.
- verdict: FAIL
- confidence: high

### Q5 — Exact versus conceptual retrieval

- scenario: Compare exact forms and a semantic paraphrase for the fallback concept target.
- MCP tool and exact bounded inputs:
  - `knowledge_context({repo:"FPMS-NT",branch:"brazil-v2",target:"node_6eb94c01-...",depth:1,limit:5,allow_fallback:false})`
  - same call with full path-qualified identity
  - exact search for `GetConfigArticleById`
  - semantic search for `lookup a CMS article configuration by identifier`, `limit:5`
- raw result or exact typed error: stable ID and full identity converged; exact symbol-name search returned 0; path search returned verified path; paraphrase returned `QUERY_TIMEOUT`.
- elapsed time: ID context 2,482 ms; identity 8,447 ms; exact name 1,565 ms; semantic 30,012 ms.
- running/available build and generation: current; vector generation unknown.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: unchanged.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: context 1/1; name 0/0; semantic unavailable.
- cursor/hasMore/truncated: none.
- retrieval lanes: identity graph, path, exact lexical, semantic.
- evidence origin/method/confidence: exact extracted graph takes precedence; high for identity, none for semantic.
- dynamic IDs and result that emitted them: fallback symbol emitted by endpoint page 3.
- workarounds: `DYNAMIC_SELECTION_FALLBACK`.
- verdict: PARTIAL
- confidence: high

### Q6 — Semantic recall with code-language variation

- scenario: Three code-language conceptual pairs.
- MCP tool and exact bounded inputs:
  - semantic `DeleteConfigArticle code path compared with deleteConfigArticle implementation`
  - semantic `gRPC CMS backend method that deletes an article configuration`
  - semantic `delete article configs before persistence`
  - all scoped to FPMS-NT/`brazil-v2`, symbols, `limit:5`, `semantic:"blend"`.
- raw result or exact typed error: all three returned `QUERY_TIMEOUT`, `retryable:false`.
- elapsed time: 30,007/30,008/30,024 ms.
- running/available build and generation: vector generation unknown.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: requested FPMS-NT exact revision; timeout result omitted resolved scope.
- coverage and freshness: unavailable in timeout result.
- candidateCount/returnedCount/totalIsExact: unavailable.
- cursor/hasMore/truncated: unavailable.
- retrieval lanes: semantic requested.
- evidence origin/method/confidence: timeout only; high.
- dynamic IDs and result that emitted them: names came from endpoints/flow.
- workarounds: none.
- verdict: FAIL
- confidence: high

### Q7 — Semantic unavailable honesty

- scenario: Invalid/unavailable semantic workspace selection.
- MCP tool and exact bounded inputs: semantic search with `workspaceId:"workspace_missing_round21"`, FPMS-NT revision, `limit:1`.
- raw result or exact typed error: `QUERY_TIMEOUT`; no typed invalid-space reason. Immediate path search with semantic off succeeded in 578 ms.
- elapsed time: 30,013 ms then 578 ms.
- running/available build and generation: current; semantic generation unknown.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: graph call preserved FPMS-NT scope.
- coverage and freshness: graph fresh/partial.
- candidateCount/returnedCount/totalIsExact: graph 1/1.
- cursor/hasMore/truncated: false.
- retrieval lanes: semantic then path.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: snapshot from graph read.
- workarounds: none.
- verdict: FAIL — graph survived, but semantic selection was not truthfully classified.
- confidence: high

### Q8 — Endpoint page and stable identity

- scenario: Replay endpoint identity forms and one corruption.
- MCP tool and exact bounded inputs: `knowledge_context` with stable ID, canonical identity, display title, and corrupted canonical identity; FPMS-NT/`brazil-v2`, `depth:1`, `limit:5`, `allow_fallback:false`.
- raw result or exact typed error: all valid forms converged to `node_230694fb…`, `snapshot_5225…`; corrupted form returned `INVALID_TARGET`.
- elapsed time: 3,851/1,743/1,723/2,401 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: unchanged.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: valid calls 1/1.
- cursor/hasMore/truncated: endpoint page had a next cursor.
- retrieval lanes: endpoint identity graph.
- evidence origin/method/confidence: extracted identity; high.
- dynamic IDs and result that emitted them: endpoint page 3.
- workarounds: none.
- verdict: PASS
- confidence: high

### Q9 — Endpoint-to-boundary flow

- scenario: Trace dynamic endpoint to boundary and tests.
- MCP tool and exact bounded inputs: `knowledge_flow({repo:"FPMS-NT",branch:"brazil-v2",target:"node_230694fb-...",allow_fallback:false})`.
- raw result or exact typed error:
  - endpoint → handler: proven `handles`
  - handler → `deleteConfigArticle`: proven `calls`
  - next results: DTO reference and validator call
  - external/persistence hop: not proven
  - tests: none returned under partial coverage
- elapsed time: 7,813 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: unchanged.
- coverage and freshness: fresh/partial; 84,447 unresolved.
- candidateCount/returnedCount/totalIsExact: 5/5; completeness partial.
- cursor/hasMore/truncated: no.
- retrieval lanes: graph flow.
- evidence origin/method/confidence: `EXTRACTED`, confidence 1, revision scope.
- dynamic IDs and result that emitted them: endpoint/handler from endpoints.
- workarounds: none.
- verdict: PARTIAL — stopped at the first unsupported boundary hop.
- confidence: high

### Q10 — Context continuity

- scenario: Carry endpoint and handler IDs across context, callers, callees, flow, and source retrieval.
- MCP tool and exact bounded inputs: endpoint/handler context; callers/callees with `depth:2,limit:10`; flow; `knowledge_get_hit` for controller lines 20–35.
- raw result or exact typed error: all graph calls retained the same repo/snapshot. Handler callers returned 0 under `lower_bound`; callees returned 1. Source retrieval returned a verified locator but `snippet:""`.
- elapsed time: context 4,783/3,801 ms; callers/callees 7,579/8,698 ms; source 111 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: stable.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: context 1/1; callers 0; callees 1.
- cursor/hasMore/truncated: none.
- retrieval lanes: graph and source pack.
- evidence origin/method/confidence: graph high; display/source content unusable.
- dynamic IDs and result that emitted them: endpoints/flow.
- workarounds: none.
- verdict: PARTIAL
- confidence: high

### Q11 — Affected path/node parity

- scenario: Compare affected results for path and stable node.
- MCP tool and exact bounded inputs:
  - path `apps/cms/src/article/article.controller.ts`
  - fallback concept node `node_6eb94c01-...`
  - both FPMS-NT/`brazil-v2`, `allow_fallback:false`
- raw result or exact typed error: path returned `QUERY_TIMEOUT`; node returned 0 impacted, route `gRPC CMS.BackendService.GetConfigArticleById`, tests empty, completeness `lower_bound`.
- elapsed time: 30,006 ms and 9,961 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: node call exact.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: node 0/0; not proof of safety.
- cursor/hasMore/truncated: none.
- retrieval lanes: impact graph.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: fallback target from endpoint page.
- workarounds: none.
- verdict: FAIL
- confidence: high

### Q12 — Coverage debt is actionable

- scenario: Retrieve concrete excluded and unresolved items.
- MCP tool and exact bounded inputs: `knowledge_coverage` for excluded `limit:3`, unresolved/failed/stale `limit:1`.
- raw result or exact typed error: excluded items included `.env.example` (`secret_policy`) and binary fonts. Unresolved item: `apps/admin/inteceptor/external.module.ts:9`, raw target `Module`, reason `no_enclosing_symbol`.
- elapsed time: 1,414 ms; unresolved 765 ms; failed/stale 477/509 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: exact.
- coverage and freshness: aggregate unresolved 84,447 versus itemized 84,024; reconciliation mismatch -423.
- candidateCount/returnedCount/totalIsExact: excluded 7/3/true; unresolved 84,024/1/true; failed 0; stale 0.
- cursor/hasMore/truncated: excluded and unresolved cursors emitted.
- retrieval lanes: coverage.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: none.
- workarounds: none.
- verdict: PARTIAL — actionable, but aggregate reconciliation is inconsistent.
- confidence: high

### Q13 — Service-label collision continuity

- scenario: Inspect repeated service labels and carry a stable service ID.
- MCP tool and exact bounded inputs: `knowledge_service_graph({repo:"FPMS-NT",branch:"brazil-v2",include_direct_neighbours:true,layout:"hierarchical"})`.
- raw result or exact typed error: `QUERY_TIMEOUT`. `get_architecture({repo:"FPMS-NT",branch:"brazil-v2",limit:20})` returned all 20 repositories without a scope/revision envelope.
- elapsed time: 30,402 ms and 5,676 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: service result unavailable; architecture silently broadened scope.
- coverage and freshness: not reported by architecture.
- candidateCount/returnedCount/totalIsExact: unavailable.
- cursor/hasMore/truncated: unavailable.
- retrieval lanes: service graph/architecture.
- evidence origin/method/confidence: direct failure and scope leak; high.
- dynamic IDs and result that emitted them: none.
- workarounds: architecture attempt did not repair the failure.
- verdict: FAIL
- confidence: high

### Q14 — Background progress does not block engineering

- scenario: Immediate bounded search → context → flow → affected chain.
- MCP tool and exact bounded inputs: path search `limit:1`; handler context `depth:1,limit:5`; endpoint flow; handler affected.
- raw result or exact typed error: all calls completed successfully.
- elapsed time: 668 + 7,161 + 12,556 + 2,848 ms; chain about 23.2 seconds, 29 seconds including two health reads.
- running/available build and generation: health remained current/current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: stable.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: search 1/1; context 1/1; flow 5/5; affected 0/0 lower-bound.
- cursor/hasMore/truncated: none.
- retrieval lanes: path and graph.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: prior endpoint pagination.
- workarounds: semantic before/after state unavailable.
- verdict: PARTIAL
- confidence: high

### Q15 — MCP-only worker wake

- scenario: New MCP process with UI closed, status read, then conceptual request.
- MCP tool and exact bounded inputs: semantic status was not callable; conceptual requests timed out.
- raw result or exact typed error: no queued-work, wake, worker, lease, or transition evidence.
- elapsed time: semantic requests each reached 30-second limit.
- running/available build and generation: current build; semantic generation unknown.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: requested FPMS-NT.
- coverage and freshness: semantic result unavailable.
- candidateCount/returnedCount/totalIsExact: unavailable.
- cursor/hasMore/truncated: unavailable.
- retrieval lanes: semantic requested.
- evidence origin/method/confidence: absence of callable lifecycle surface; high.
- dynamic IDs and result that emitted them: none.
- workarounds: none permitted.
- verdict: FAIL
- confidence: high

### Q16 — Restart and stale-session recovery

- scenario: Agent A/Agent B close-and-replay.
- MCP tool and exact bounded inputs: no Penguin MCP tool can create or identify a second process.
- raw result or exact typed error: `restartRequired:false`; no Agent-B evidence.
- elapsed time: N/A.
- running/available build and generation: same current build.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: Agent-A packet available only.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: N/A.
- cursor/hasMore/truncated: N/A.
- retrieval lanes: health only.
- evidence origin/method/confidence: direct limitation; high.
- dynamic IDs and result that emitted them: Agent-A packet in table below.
- workarounds: none.
- verdict: FAIL
- confidence: high

### Q17 — Three cursor families

- scenario: Endpoint, file-symbol, and dead-code pagination plus error cases.
- MCP tool and exact bounded inputs:
  - endpoints `limit:2`, emitted cursor, immediate continuation
  - file symbols for article service `limit:2`, emitted cursor, continuation
  - dead code FPMS-NT `limit:2`
  - malformed and wrong-scope cursors
- raw result or exact typed error: endpoint and file-symbol continuations preserved order and scope. Wrong repo/path returned `CURSOR_SCOPE_MISMATCH`. Malformed cursor returned `CURSOR_INVALID`. A previously emitted expired endpoint cursor was misclassified as malformed. Dead code returned `truncated:true`, 5,650 candidates, and `nextCursor:null`.
- elapsed time: endpoint continuation 2,243 ms; wrong repo 14 ms; file continuation 339 ms; dead code 531 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: same-process continuations exact.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: endpoints 608/2/true; file 15/2/true; dead code 5650/2/true.
- cursor/hasMore/truncated: endpoint/file good; audit broken.
- retrieval lanes: endpoint/file/audit.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: cursor table below.
- workarounds: Agent-B unavailable; no offset reconstruction performed.
- verdict: FAIL
- confidence: high

### Q18 — Error taxonomy

- scenario: Ten bounded read-only failures.
- MCP tool and exact bounded inputs: empty search; empty context target; unknown repo; ambiguous `healthcheck`; invalid node; wrong-repo node; malformed/wrong-scope cursor; corrupted endpoint; invalid semantic workspace.
- raw result or exact typed error:
  - `INVALID_QUERY`
  - `TARGET_REQUIRED`
  - `SCOPE_NOT_FOUND`
  - `TARGET_AMBIGUOUS`
  - `INVALID_TARGET`
  - `SCOPE_MISMATCH`
  - `CURSOR_INVALID`
  - `CURSOR_SCOPE_MISMATCH`
  - corrupted identity: `INVALID_TARGET`
  - semantic selection: `QUERY_TIMEOUT`
- elapsed time: 7–4,128 ms except semantic 30,013 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: correct scope retained for graph errors.
- coverage and freshness: available on successful/no-match reads.
- candidateCount/returnedCount/totalIsExact: ambiguity emitted six candidates.
- cursor/hasMore/truncated: error-specific.
- retrieval lanes: validation, resolution, cursor, semantic.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: wrong-repo node came from FPMS-NT endpoint context.
- workarounds: several remediations say “run penguin search” or use CLI flags rather than naming MCP tools.
- verdict: PARTIAL
- confidence: high

### Q19 — Adversarial negative tri-state

- scenario: Six negative claims.
- MCP tool and exact bounded inputs: context, flow, affected, service graph, semantic search, lifecycle inspection.
- raw result or exact typed error: table below.
- elapsed time: represented by source calls above.
- running/available build and generation: current; semantic unknown.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: FPMS-NT exact where available.
- coverage and freshness: partial, unresolved, and semantic coverage unknown.
- candidateCount/returnedCount/totalIsExact: varies; no empty lower-bound was treated as absence.
- cursor/hasMore/truncated: no negative depends on unexhausted cursor.
- retrieval lanes: graph, coverage, semantic/lifecycle.
- evidence origin/method/confidence: direct; high.
- dynamic IDs and result that emitted them: endpoint/fallback symbol.
- workarounds: none.
- verdict: PASS for truth handling; all six are `not proven`.
- confidence: high

### Q20 — Installed/configured/loaded/useful and provenance boundary

- scenario: Separate lifecycle verdicts and read one note object.
- MCP tool and exact bounded inputs: `mcp_health({})`; capabilities; graph calls; `knowledge_note_list({repo:"FPMS-NT",limit:1})`.
- raw result or exact typed error:
  - Installed: proven by callable 1.16.0 runtime and ready native dependencies.
  - Configured: not proven; health returned `configured:null`.
  - Loaded: proven for build/contract, not for semantic generation.
  - Useful: conditional for exact graph engineering; not useful for semantic/lifecycle/service-collision acceptance.
  - Note: `Redis ClusterAllFailedError`, path `redis-clusterallfailederror.md`, timestamp `2026-07-12T03:59:08.553Z`, repo scope null, revision null, sensitivity normal, candidate only.
- elapsed time: note 424 ms.
- running/available build and generation: current/current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: code graph exact; note unscoped/unrevisioned.
- coverage and freshness: note freshness unknown; global lower-bound coverage.
- candidateCount/returnedCount/totalIsExact: note 1/1/true.
- cursor/hasMore/truncated: none.
- retrieval lanes: runtime, graph, note.
- evidence origin/method/confidence: code graph extracted/current; note manual/remembered candidate with provenance gaps.
- dynamic IDs and result that emitted them: note had no node ID.
- workarounds: none.
- verdict: PARTIAL
- confidence: high

## 5. End-to-end workflows B1–B8

### B1 — Cold player/account incident

- scenario: “An FPMS-NT player/account operation is not progressing.”
- MCP tool and exact bounded inputs: lexical search for `player account operation not progressing`, FPMS-NT/`brazil-v2`, semantic off, `limit:5`.
- raw result or exact typed error: 11,189 candidates; top five were source occurrences in `apps/livechat_scheduler/src/livechat_scheduler.service.ts`, including `LivechatSchedulerService`. These are retrieval candidates, not a root cause.
- elapsed time: 7,531 ms; MCP internal total 7,081.138 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: exact FPMS-NT revision.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: 11,189/5; truncated.
- cursor/hasMore/truncated: cursor emitted; true.
- retrieval lanes: source and symbol.
- evidence origin/method/confidence: source candidates, medium-low relevance.
- dynamic IDs and result that emitted them: `node_8c84d909…` emitted by search.
- workarounds: none.
- verdict: PARTIAL
- confidence: high

Evidence frontier: candidate entry points only. Required next evidence is an operation/player/proposal/trace identifier, exact method or route, timestamps, runtime logs, downstream RPC response, and DB/persistence state. No root cause is claimed.

### B2 — Graph while semantics is busy or unavailable

- scenario: Scoped search → context → flow → affected with semantic unavailable.
- MCP tool and exact bounded inputs: Q14 chain.
- raw result or exact typed error: graph chain completed; semantic status itself was unavailable.
- elapsed time: about 23.2 seconds for chain.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: stable.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: 1/1, 1/1, 5/5, 0/0 lower-bound.
- cursor/hasMore/truncated: no.
- retrieval lanes: path/graph.
- evidence origin/method/confidence: direct.
- dynamic IDs and result that emitted them: dynamic endpoint.
- workarounds: lifecycle state unavailable.
- verdict: PARTIAL
- confidence: high

### B3 — Hybrid recall audit

- scenario: Exact ID/path, lexical/graph, and semantic comparison.
- MCP tool and exact bounded inputs: Q5 calls plus dynamic concept semantic request.
- raw result or exact typed error: ID/identity/path worked; exact symbol-name search did not; conceptual queries timed out.
- elapsed time: exact 0.3–8.4 seconds; semantic 30 seconds.
- running/available build and generation: current/unknown semantic.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: exact for graph.
- coverage and freshness: graph fresh/partial; vector unknown.
- candidateCount/returnedCount/totalIsExact: graph documented; semantic unavailable.
- cursor/hasMore/truncated: none.
- retrieval lanes: identity/path/exact/semantic.
- evidence origin/method/confidence: exact graph wins.
- dynamic IDs and result that emitted them: endpoint page 3.
- workarounds: fallback concept target.
- verdict: PARTIAL
- confidence: high

Semantic retrieval added no usable evidence, and no code-token reranking evidence was returned.

### B4 — Safe-change decision

- scenario: Decide change safety for fallback concept target.
- MCP tool and exact bounded inputs: context, flow, callers/callees, affected path/node, tests/routes.
- raw result or exact typed error: flow proved endpoint → handler → service → repository/Redis/S3-related calls for `GetConfigArticleById`; affected path timed out; node impact was lower-bound; tests were empty under partial coverage.
- elapsed time: flow 21,448 ms; affected path 30,006 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: exact.
- coverage and freshness: fresh but partial, 84,447 unresolved.
- candidateCount/returnedCount/totalIsExact: flow 23/23; affected incomplete.
- cursor/hasMore/truncated: no.
- retrieval lanes: graph/impact.
- evidence origin/method/confidence: extracted graph, high for returned edges.
- dynamic IDs and result that emitted them: fallback target from endpoint page.
- workarounds: none.
- verdict: NO-GO
- confidence: high

Missing complete affected parity, tests, source body, dynamic dispatch, and runtime/persistence proof prevent unconditional change safety.

### B5 — Fresh-process handoff

- scenario: Agent A packet to Agent B.
- MCP tool and exact bounded inputs: no process-control or second-client Penguin MCP tool exists.
- raw result or exact typed error: same-process ID/cursor replay succeeded, but Agent-B replay did not occur.
- elapsed time: N/A.
- running/available build and generation: Agent A current/current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: packet below.
- coverage and freshness: fresh/partial.
- candidateCount/returnedCount/totalIsExact: N/A.
- cursor/hasMore/truncated: current-process only.
- retrieval lanes: N/A.
- evidence origin/method/confidence: direct limitation.
- dynamic IDs and result that emitted them: table below.
- workarounds: none.
- verdict: FAIL
- confidence: high

### B6 — Collision-safe service investigation

- scenario: Repeated service label to endpoint via stable service identity.
- MCP tool and exact bounded inputs: scoped `knowledge_service_graph`.
- raw result or exact typed error: `QUERY_TIMEOUT`; fallback architecture silently broadened scope.
- elapsed time: 30,402 ms.
- running/available build and generation: current.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: not safely established.
- coverage and freshness: unavailable.
- candidateCount/returnedCount/totalIsExact: unavailable.
- cursor/hasMore/truncated: unavailable.
- retrieval lanes: service graph.
- evidence origin/method/confidence: failure evidence high.
- dynamic IDs and result that emitted them: none.
- workarounds: unscoped fallback rejected as evidence.
- verdict: FAIL
- confidence: high

### B7 — Failure and recovery honesty

- scenario: Semantic invalid/degraded case followed by graph success.
- MCP tool and exact bounded inputs: invalid workspace semantic search followed by exact path search.
- raw result or exact typed error: semantic returned generic timeout; graph returned a verified path hit.
- elapsed time: 30,013 ms then 578 ms.
- running/available build and generation: current; semantic unknown.
- capability/schema/contract identity: E0.
- repo/branch/revision/snapshot: graph exact.
- coverage and freshness: graph fresh/partial.
- candidateCount/returnedCount/totalIsExact: graph 1/1.
- cursor/hasMore/truncated: no.
- retrieval lanes: semantic/path.
- evidence origin/method/confidence: direct.
- dynamic IDs and result that emitted them: path hit `hit_789680…`.
- workarounds: none.
- verdict: PARTIAL — graph recovery is honest; semantic remediation is not specific.
- confidence: high

### B8 — Decision packet

See the exact packet at the end of this report.

## 6. Graph-first and semantic lifecycle verdicts

Graph-first is materially useful but incomplete:

- Stable endpoint ID, canonical identity, and title round-trip correctly.
- Revision-scoped paths and flow edges carry origin, method, confidence, and provenance.
- The dynamic endpoint proved endpoint → handler → service.
- The fallback concept flow proved repository, Redis, and S3-related downstream calls.
- Affected-path timeout, empty source snippets, lower-bound callers/tests, 84,447 unresolved references, and service-graph timeout prevent source-free safety claims.

Semantic lifecycle is unavailable:

- The lifecycle status capability is advertised but not callable.
- Provider runtime files exist, but installed model files do not prove an active generation.
- Every semantic query hit the 30-second hard timeout.
- No active/staging generation, progress, rate, ETA, lease, retry, pause, failure, or ready count was observable.

## 7. Background worker, wake, and restart verdicts

| Background event | Before | Action/trigger | After | Persisted across restart | Verdict |
| --- | --- | --- | --- | --- | --- |
| Semantic status read | Unknown | Attempt to discover callable status | Tool absent | Not tested | FAIL |
| Conceptual query | Unknown | FPMS-NT semantic blend | 30-second timeout | Not tested | FAIL |
| Graph after semantic failure | Semantic timed out | Exact path search | Success in 578 ms | N/A | PASS |
| MCP-only wake | Unknown | Conceptual request | No worker transition data | Not tested | NOT PROVEN |
| Client restart | Current build | No process-control surface | Agent B not created | Not tested | NOT PROVEN |

- Background worker: NOT PROVEN.
- MCP-only wake: NOT PROVEN.
- Restart required: health says no for Agent A.
- Restart handling across Agent B: NOT PROVEN.

## 8. Stable identity, cursor, and collision verdicts

### Dynamic identity and cursor table

| Dynamic ID/cursor | Emitted by | Agent-B replay | Scope/revision | Result | Workaround |
| --- | --- | --- | --- | --- | --- |
| `repo_a48ec7fb-...` | `status_panel`, `index_status` | Not proven | FPMS-NT/`3f0f…9908` | Same-process calls resolve | None |
| `snapshot_5225df3e-...` | `index_status`, endpoints | Not proven | FPMS-NT `brazil-v2` | Stable across graph calls | None |
| `node_230694fb-...` | Dynamic endpoint page 3 | Not proven | exact snapshot | ID/identity/title converge | None |
| `node_44322d8a-...` | Endpoint handler | Not proven | exact snapshot | Context/flow round-trip | None |
| `node_6eb94c01-...` | Page-3 final fallback item | Not proven | exact snapshot | ID/full identity converge | Dynamic-selection fallback |
| Endpoint cursor, `limit:2` | `knowledge_endpoints` | Not proven | exact FPMS-NT snapshot | Immediate continuation succeeded | None |
| Expired endpoint cursor | `knowledge_endpoints` | Not proven | originally FPMS-NT | Returned `CURSOR_INVALID: malformed cursor` | None |
| File-symbol cursor | `knowledge_file_symbols` | Not proven | article service/exact branch | Continuation succeeded | None |
| Dead-code cursor | `find_dead_code` | Not proven | FPMS-NT | `truncated:true`, cursor null | Cannot continue |
| Search hit `hit_789680…` | Path search | Not proven | exact snapshot | `get_hit` returned empty snippet | None |

Stable endpoint identity: PASS.  
Three cursor families: FAIL.  
Service collision safety: FAIL.  
Fresh-process replay: NOT PROVEN.

## 9. Owner-only Tauri evidence

No owner screenshots, timestamps, pause/resume observations, or restart observations were provided through the permitted evidence lane.

- Graph-default tab: NOT TESTED
- Focus absence: NOT TESTED
- Semantic status display: NOT TESTED
- Pause/resume: NOT TESTED
- Pause persistence: NOT TESTED
- Retry/cancel: NOT TESTED
- `OWNER_UI_EVIDENCE`: none

Owner UI evidence contributes no MCP-only points.

## 10. Safe-without-source versus escalation boundary

### Safe without source

- Resolve FPMS-NT repository, branch, commit, and snapshot.
- Confirm running/available runtime identity.
- Enumerate endpoints with stable cursors.
- Round-trip endpoint stable ID, canonical identity, and title.
- Prove returned `handles` and `calls` edges at the indexed revision.
- Identify exact file/line candidates.
- Retrieve concrete coverage exclusions and unresolved references.
- Reject absence and safety claims when completeness is partial/lower-bound.
- Produce investigation candidates and an evidence frontier.

### Requires source/log/DB/runtime/human evidence

- Root cause of a player/account operation that is “not progressing.”
- Runtime dispatch, reflection, interface/DI resolution, callback execution, and configuration.
- Whether a returned repository/Redis/S3 call actually executed.
- Downstream service response, timeout, retry, queue, or transaction state.
- Database mutation/absence and persistence consistency.
- Complete test coverage or production-caller absence.
- Safe-change approval while affected-path queries time out.
- Semantic generation lifecycle, active pointer integrity, wake, lease, progress, and restart recovery.
- Tauri pause/resume and UI persistence.

## 11. Tri-state claims

| Claim | Evidence lane | Coverage/completeness | Proven/contradicted/not proven | Missing evidence |
| --- | --- | --- | --- | --- |
| No production caller exists for fallback concept target | Graph callers | lower-bound; partial | not proven | Exhaustive callers, dynamic dispatch, source/runtime |
| No test covers dynamic endpoint | Context/flow tests empty | partial; unresolved references | not proven | Exhaustive test graph/source |
| Dynamic endpoint never reaches external/persistence boundary | Delete flow stops at service/DTO | partial | not proven | Service source/runtime, complete callees |
| Duplicate service labels cannot affect selection | Service graph timed out | unknown | not proven | Bounded collision inventory and stable service replay |
| No better conceptual match exists outside active-vector coverage | Semantic timeout/status absent | unknown | not proven | Active generation and complete vector coverage |
| Closing Penguin UI stops all MCP semantic work | No UI/new-process evidence | unknown | not proven | Owner UI and independent MCP worker observation |

## 12. Defects, environment failures, and unproven claims

### Product defects

1. `knowledge.semantic_status` is advertised as required on MCP but missing from the actual callable tool surface.
2. Every bounded semantic query reaches the 30-second hard timeout without lifecycle or remediation details.
3. Scoped architecture silently returns all repositories.
4. Scoped note listing returns an unscoped repo-null note.
5. Dead-code audit reports 5,650 candidates and `truncated:true` but provides no cursor.
6. Affected-by-path times out.
7. Service graph times out.
8. `knowledge_get_hit` returns a verified locator with an empty snippet.
9. Exact symbol-name search returns no result for a symbol that context resolves by stable ID/full identity.
10. Expired endpoint cursor is classified as malformed rather than expired.
11. Coverage aggregate/itemized unresolved counts differ by 423.
12. Error remediations frequently describe CLI commands/flags rather than executable MCP tools.

### Environment failures

1. Fresh client/process identity is not observable.
2. Agent-B process cannot be created or proven through Penguin MCP.
3. Semantic active/staging generation is not observable.
4. Worker lifecycle and MCP-only wake are not observable.
5. Owner UI controls were not tested.

### Unproven claims

- Semantic generation is ready, partial, paused, failed, or progressing.
- Graph latency is independent of background embedding rather than simply operating while no active worker is known.
- Stable IDs and cursors survive a real process restart.
- Service-label collisions are safe.
- Dynamic endpoint has no tests or persistence boundary.
- Closing the Tauri UI affects or does not affect semantic work.

## 13. Ordered improvements and executable MCP-only retests

1. Expose the advertised status tool.

   ```json
   mcp__penguin__knowledge_semantic_status({"scopeKey":"repo_a48ec7fb-5987-47df-9198-06969359cb50"})
   ```

   Retest twice at least five seconds apart and require provider, model revision/hash, dimensions, backend, chunker, active/staging generations, ready/total/failed, rate, ETA, control state, lease, and reason.

2. Make semantic failure fast and typed.

   ```json
   mcp__penguin__knowledge_search({
     "query":"lookup a CMS article configuration by identifier",
     "mode":"semantic",
     "options":{"semantic":"blend","compact":true,"explain":true},
     "page":{"limit":5},
     "scope":{"revisions":[{"repoName":"FPMS-NT","branch":"brazil-v2"}],"kinds":["symbol"]}
   })
   ```

3. Reject or honor architecture scope.

   ```json
   mcp__penguin__get_architecture({"repo":"FPMS-NT","branch":"brazil-v2","limit":20})
   ```

   The response must contain only FPMS-NT and an explicit revision envelope.

4. Bound and paginate service inventory.

   ```json
   mcp__penguin__knowledge_service_graph({
     "repo":"FPMS-NT",
     "branch":"brazil-v2",
     "include_direct_neighbours":true,
     "layout":"hierarchical"
   })
   ```

5. Repair dead-code pagination by accepting and emitting cursors.

   ```json
   mcp__penguin__find_dead_code({"repo":"FPMS-NT","branch":"brazil-v2","limit":2})
   ```

6. Repair affected path performance and parity.

   ```json
   mcp__penguin__knowledge_affected({
     "repo":"FPMS-NT",
     "branch":"brazil-v2",
     "path":"apps/cms/src/article/article.controller.ts",
     "allow_fallback":false
   })
   ```

7. Return source text or a typed exclusion reason.

   ```json
   mcp__penguin__knowledge_get_hit({
     "snapshot_id":"snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55",
     "original_revision_id":"snapshot_5225df3e-18e3-44ab-9cc2-dc0dae37ee55",
     "file_path":"apps/cms/src/article/article.controller.ts",
     "start_line":20,
     "end_line":35,
     "context_lines":0
   })
   ```

8. Make onboarding MCP-native: name `mcp__penguin__*` calls and JSON inputs rather than local CLI commands.

9. Reconcile unresolved-reference aggregates.

   ```json
   mcp__penguin__knowledge_coverage({
     "repo":"FPMS-NT",
     "branch":"brazil-v2",
     "kind":"unresolved",
     "limit":1
   })
   ```

10. Add explicit `CURSOR_EXPIRED` classification and restart-safe Agent-B replay evidence.

```text
ROUND: 21
PRODUCT CAPABILITY: 46/100
MCP-ONLY USER EXPERIENCE: 43/100
ENVIRONMENT READINESS: 56/100
PRODUCT TRUST: NO-GO
ENVIRONMENT: DEGRADED
GRAPH/LEXICAL: 68/100 — CONDITIONAL; stable endpoint identity and revision-scoped flow work, but affected/service/source and scope safety fail
SEMANTIC/VECTOR: UNAVAILABLE
VECTOR PROGRESS: unknown/unknown/unknown and active/staging generation not exposed
BACKGROUND WORKER: NOT PROVEN
MCP-ONLY WAKE: NOT PROVEN
RESTART REQUIRED/HANDLED: NO-CURRENT
MCP CONTRACT/PARITY: 48/100 — FAIL; semantic status is advertised but absent, audit pagination is incomplete, and scoped calls can broaden silently
FRESH PROCESS HANDOFF: NOT PROVEN
OWNER UI CONTROL: NOT TESTED
SAFE WITHOUT SOURCE: Runtime/build identity; FPMS-NT revision and coverage; endpoint pagination and identity round-trip; returned revision-scoped graph edges; candidate paths and evidence frontiers.
REQUIRES SOURCE/LOG/DB/HUMAN: Root cause; runtime dispatch; actual external/persistence execution; DB state; complete test/caller absence; semantic lifecycle/wake/restart; Tauri controls.
TOP 5 PRODUCT GAPS:
1. Advertised knowledge_semantic_status is not callable.
2. All bounded semantic queries time out at 30 seconds without typed lifecycle remediation.
3. Scoped architecture/note calls can return cross-repository or unscoped data.
4. Dead-code pagination is truncated with no cursor; affected-path and service-graph calls time out.
5. Source retrieval returns an empty verified snippet and coverage unresolved counts do not reconcile.
TOP 3 ENVIRONMENT GAPS:
1. Fresh process and Agent-B identity cannot be evidenced.
2. Active/staging semantic generation and worker state are not observable.
3. Owner UI pause/resume/restart evidence was not provided.
EXACT MCP RETEST TOOLS/INPUTS:
1. mcp__penguin__knowledge_semantic_status({"scopeKey":"repo_a48ec7fb-5987-47df-9198-06969359cb50"})
2. mcp__penguin__knowledge_search({"query":"lookup a CMS article configuration by identifier","mode":"semantic","options":{"semantic":"blend","compact":true,"explain":true},"page":{"limit":5},"scope":{"revisions":[{"repoName":"FPMS-NT","branch":"brazil-v2"}],"kinds":["symbol"]}})
3. mcp__penguin__knowledge_service_graph({"repo":"FPMS-NT","branch":"brazil-v2","include_direct_neighbours":true,"layout":"hierarchical"})
4. mcp__penguin__knowledge_affected({"repo":"FPMS-NT","branch":"brazil-v2","path":"apps/cms/src/article/article.controller.ts","allow_fallback":false})
5. mcp__penguin__find_dead_code({"repo":"FPMS-NT","branch":"brazil-v2","limit":2})
```

