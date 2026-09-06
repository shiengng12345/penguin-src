# Penguin Wiki / Knowledge Layer — Codex GPT-5 Round 14 Evaluation

Date: 2026-08-30
Agent: Codex, GPT-5 based
Session start: 2026-08-30T13:21:40+08:00 (Asia/Kuala_Lumpur)
Repository under test: `FPMS-NT`, `/Users/shieng/Desktop/Projects/fpmsnt`
Requested branch: `brazil-v2`

This is a read-only evaluation. I used the local Penguin CLI bundle and did not
run a Tauri build, release, packaging, signing, indexing, or source/database
inspection. The CLI fallback was:

```sh
VN=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
B=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs
export PENGUIN_WASM_DIR=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm
```

The orchestrator performed one read-only `git status` before the evaluation to
protect the already-dirty worktree. It was not used as product evidence. The
evaluation itself used Penguin surfaces only; therefore the strict brief gate
“no git commands” was not completely satisfied.

## 1. Environment and fresh-session setup

MCP was unavailable in this session: no Penguin MCP tool or server name was
exposed to the agent, so there was no MCP initialize/session error to replay.
The fallback CLI and runtime paths above both existed and ran with Node.js
22.23.1. Every CLI query below was a new CLI process. No previous report or
answer key was read.

Setup commands and bounded raw results:

```text
penguin help --json
=> commands include search, filesymbols, context, explore, flow, callers,
   callees, affected, endpoints, deadcode, graph-query, coverage, onboarding,
   doctor, and capabilities; cursor ordering is filePath,startLine,nodeId;
   exhausted cursor is nextCursor:null; invalid cursor exit code is 2.

penguin capabilities --json
=> schemaVersion=14, contractVersion=2, buildId=local,
   capabilityHash=40ae9528330e4...e4487d0; 99 capabilities, 61 read-only,
   61 cursor-capable; selected operations have input/output schema IDs v2.

penguin status --compact --json
=> totalRepos=26, fresh=19, stale=6, unknown=1, errors=31.

penguin doctor --json
=> {"ledgerSeq":12348,"materializedSeq":12348,"status":"ok",
    "ledgerTruncatedAtLine":null,"nodes":1004663,"edges":4430749,
    "pendingSuggestions":1,"verify":false}

penguin coverage --repo FPMS-NT --json
=> {"discovered":3340,"admitted":3333,"excluded":7,"failed":0,"stale":0}

penguin onboarding FPMS-NT --json
=> repoId=repo_c58d58a2...; revisionHash=b071f365...; capabilityHash=
   40ae9528...; indexed files=3333; fresh symbols=13710.
```

The explicit FPMS-NT status record was:

```json
{
  "repoId":"repo_c58d58a2-bb7f-4696-bd45-2c0c29634c67",
  "name":"FPMS-NT", "rootPath":"/Users/shieng/Desktop/Projects/fpmsnt",
  "defaultBranch":"brazil-v2", "branchStatus":"live",
  "branchId":"branch_10012ad4-067a-4749-aafb-7a9c4f5c133d",
  "indexedAt":"2026-08-30T04:23:32.546Z",
  "indexedCommit":"3f0f1984b9e4337668529a13bad5264501729908",
  "headCommit":"3f0f1984b9e4337668529a13bad5264501729908",
  "worktreeState":"clean", "dirtyFiles":[], "changedFiles":0,
  "stale":false, "staleReason":null, "staleSymbols":725,
  "parserVersion":"tree-sitter-wasm-v8-wrapper-allowlist",
  "schemaVersion":14, "snapshotId":"snapshot_804a4c86-b397-447a-9066-a51d36f2511a",
  "cacheState":"ready", "coverageGaps":[]
}
```

Common evidence envelope for resolved FPMS-NT queries: repo ID above, branch
`brazil-v2`, commit and HEAD aligned at
`3f0f1984b9e4337668529a13bad5264501729908`, clean indexed worktree, parser
`tree-sitter-wasm-v8-wrapper-allowlist`, schema 14, coverage 3340/3333/7/0.
Most graph results additionally reported `unresolvedReferenceCount=103925`,
`completeness=partial` or `lower_bound`, and `totalIsExact=false` where the
result was not a closed set. Workaround counts below count manual retries,
raw-node normalization, or explicit scope recovery.

## 2. Capability/readiness split and scores /100

| Dimension | Score | Basis |
|---|---:|---|
| Agent discoverability | 72 | Help, onboarding, and 99 advertised capabilities are available; onboarding does not expose copyable full commands. |
| Context usefulness | 82 | Context/explore provide locators, source packs, callers/callees, routes, tests, provenance, and proof limits. |
| Accuracy | 75 | Fresh node graph evidence is useful, but endpoint inventory omits revision metadata and `node:` is rejected by endpoint-identity. |
| Completeness | 46 | Seven excluded files, 725 stale symbols, 103,925 unresolved references, and lower-bound call lists block closure claims. |
| Honesty | 84 | Negative results say `not_proven`; deadcode warns about DI/reflection/framework false positives; coverage warnings are visible. |
| MCP/CLI parity | N/A | MCP was unavailable in the evaluation environment; not scored as a product mismatch. |
| Continuity | 72 | Fresh node IDs and cursors survive new CLI processes; form normalization and bare filesymbols output reduce handoff reliability. |
| Usability | 72 | Main flow is copyable after discovering positional/flag syntax; endpoint identity requires an undocumented three-form call. |
| Speed | 80 | Typical local queries completed in under five seconds; status is large unless filtered externally. |
| Product overall | 71 | CLI-only, excluding the unavailable MCP dimension; good investigation aid, not a complete proof system. |
| Environment readiness | 35 | CLI bundle/doctor are healthy, but MCP is not exposed and the stable-runtime/reload boundary is not proven. |

## 3. Q1–Q17 answers

### Q1 — contract boot and capability truthfulness

Commands: `help --json`, `capabilities --json`, `doctor --json`, plus the
individual CLI commands listed in the brief. The CLI has real dispatch for the
required read-only operations: `search`, `filesymbols`, `context`, `explore`,
`flow`, `callers`, `callees`, `affected`, `endpoints`, and `deadcode`; it also
has graph operations `graph-query`, `graph`, and `architecture`. Pagination is
advertised for the selected read-only operations, and negative-result behavior
is observable through `search`/`context`/`deadcode` with `proofStatus` and
coverage diagnostics.

Raw contract evidence: selected operations all advertised `requiredOn` CLI and
MCP, `mutating=false`, `supportsCursor=true`, and schema IDs such as
`knowledge.callees.input.v2` / `knowledge.callees.output.v2`. `callees` and
`affected` executed successfully with current IDs. MCP runtime registration
could not be checked because no MCP server/tool was exposed. Confidence: high
for CLI registration, unavailable for MCP. Scope: CLI local bundle. Freshness:
doctor ledger/materialized sequence both 12348. Workarounds: 0.

### Q2 — source-pack usefulness without source reading

Commands:

```sh
penguin search "getActiveEventConfigByObjId" --repo FPMS-NT --json
penguin filesymbols --repo FPMS-NT --path apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts --json
penguin context node:node_af26e1f8-17f5-473b-b76c-e33a150abfac --repo FPMS-NT --json
penguin explore node:node_af26e1f8-17f5-473b-b76c-e33a150abfac --repo FPMS-NT --json
```

`filesymbols` emitted the focus node with locator
`.../color-land-event-config.service.ts:135-156`, kind `method`, title and
signature. `context` emitted three callers, one callee, a source block, exact
revision, clean freshness, coverage, tests/routes fields, and a lower-bound
call note. `explore` emitted the same focus, source blocks for focus/callee/
callers, a route path beginning at
`gRPC promotion.v1.FrontendColorLandService.RollColorLandDice`, provenance, and
`sourcesOmitted=[]`. It is enough to prepare a source-review checklist; it is
not enough to declare semantic correctness. `context` reported
`completeness=lower_bound`, `candidateCount=17`, `totalIsExact=false`, and
`unresolvedReferenceCount=103925`; therefore source-pack content is useful but
not a substitute for source review. Confidence: high. Workarounds: 1
(search by symbol name after the exact path-qualified search returned
`NO_MATCH_INCOMPLETE`).

### Q3 — dynamic identifier handoff matrix

Fresh IDs from this session:

| Emission | ID | Follow-ups | Result |
|---|---|---|---|
| filesymbols | `node_8c82a67a-76e0-4319-8199-3a3f7e5c9853` | context, flow, callers, callees, affected | All five commands exited 0; callers/callees resolved; other graph envelopes returned normally. |
| search | `node_af26e1f8-17f5-473b-b76c-e33a150abfac` | context, flow, callers, callees, affected | All five exited 0 and preserved FPMS-NT/brazil-v2 revision. |
| ambiguous context candidate | `node_7c2d4657-cd74-4a3e-ac9a-004767fa3749` | context, flow, callers, callees, affected | All five exited 0; context identified external calls and no callers. |
| endpoint page two | `node_74499273-c2a9-45d5-98eb-db01b536b1cf` | context, flow, callers, callees, affected | All five exited 0; flow preserved the endpoint and `proto` service. |

Each follow-up used `node:<id> --repo FPMS-NT --json`, except
`endpoint-identity`, whose accepted node form is the bare ID. Revision remained
commit `3f0f1984...`, branch ID `branch_10012ad4...`; graph completeness was
lower-bound/partial, not closed. No silent scope fallback was observed for
these explicit node follow-ups. The bare-vs-prefixed identity difference is a
contract footgun. Confidence: high. Workarounds: 1.

### Q4 — scoped search and collision containment

Commands were `search constructor --json`, `search execute --json`,
`search update --json`, followed by the same queries with `--repo FPMS-NT`, and
path-qualified context for the emitted constructor candidate.

The unscoped CLI query resolved to the current working repository
`penguin-src`, not a clearly labelled all-repository result. It did not warn
that it had selected the current repo. Scoped counts were constructor 1325,
execute 373, update 4169; each returned 50 with `truncated=true`,
`completeness=partial`, `totalIsExact=false`, coverage 3340/3333/7/0, and the
same indexed commit. Every scoped hit carried `repoName=FPMS-NT` and a path.
`context constructor --repo FPMS-NT` returned a structured ambiguous result
with 20 candidates and `TARGET_NOT_RESOLVED`; the path-qualified
`apps/admin/inteceptor/payment-external.service.ts#constructor` resolved the
fresh method node. Explicit node follow-ups did not cross repositories.

Conclusion: explicit repository scope contains collisions; unscoped behavior
is not safe enough to call “global search” and is insufficiently explicit.
Confidence: high. Workarounds: 2 (always add `--repo`; use path-qualified
target after ambiguity).

### Q5 — endpoint inventory as a paged work queue

Command: `penguin endpoints FPMS-NT --protocol grpc --limit 3 --json`, then
the returned `nextCursor` in two fresh CLI processes.

Page one IDs/titles: `node_c84137ec...` AccountActivityService, `node_baf87103...`
AccumulativeBetRewardFrontendService, `node_bf3d2b4d...`
AccumulativeEventConfigAdminService.Create. Page two IDs/titles:
`node_ec762949...` GetAccumulativeEventConfigs,
`node_74499273...` UpdateAccumulativeEventConfig,
`node_4cb67701...` AdminGrowthTaskService.CreateTaskConfig. Page three IDs/titles:
`node_d54ed2c1...`, `node_83ed1c2a...`, `node_be1ac4a2...`.

Page one had `candidateCount=1535`, `returnedCount=3`,
`totalIsExact=false`, `truncated=true`. Page two had 1532/3/false/true;
page three 1529/3/false/true. Observed ordering was title,nodeId and there
were no duplicate IDs across these pages. The selected page-two endpoint had:

```json
{"nodeId":"node_74499273-c2a9-45d5-98eb-db01b536b1cf",
 "identityKey":"grpc::AccumulativeEventConfigAdminService.updateaccumulativeeventconfig",
 "handlers":[{"title":"proto","repoId":"repo_e3c88b3d-1f5c-43d4-9420-e1f685ae7a56"}],
 "handlerStatus":"handled","missingHandlerReason":null}
```

Inventory itself omitted revision, freshness, coverage, and locator metadata;
those were recovered from context/flow. `context` had no handler field, while
`flow` emitted the service handler node `node_0fb2fbd0-1160-4b5c-b60a-28a62dc57463`.
The first incomplete boundary was the `proto` service. Confidence: high for
pagination, medium for handler interoperability. Workarounds: 2.

### Q6 — five-form endpoint identity equivalence

The accepted call was:

```sh
penguin endpoint-identity \
  "AccumulativeEventConfigAdminService.UpdateAccumulativeEventConfig" \
  "grpc::AccumulativeEventConfigAdminService.updateaccumulativeeventconfig" \
  node_74499273-c2a9-45d5-98eb-db01b536b1cf --repo FPMS-NT --json
```

It returned `equal=true`, `rootNodeId=node_74499273...`,
`completeness=complete`; rendered title, canonical identity, and bare node ID
all resolved to the same node. Replacing the second form with
`/AccumulativeEventConfigAdminService/UpdateAccumulativeEventConfig` also
returned `equal=true`. An invalid canonical form returned a structured JSON
result with `status=no_match`, `equal=false`, `completeness=unknown`, exit 1,
but no retry/remediation suggestion. Supplying `node:node_744...` was rejected
as `no_match`; only the bare node ID was accepted. `context` and `flow` accepted
the public `node:<id>` form. Confidence: high. Workarounds: 1.

### Q7 — request path with an explicit evidence frontier

Using the Q5 endpoint:

```sh
penguin flow node:node_74499273-c2a9-45d5-98eb-db01b536b1cf --repo FPMS-NT --json
```

The only emitted chain was endpoint
`AccumulativeEventConfigAdminService.UpdateAccumulativeEventConfig` → service
`proto`, with edge `handles`. It had aligned commit evidence, clean freshness,
coverage 3340/3333/7/0, `candidateCount=2`, `returnedCount=2`,
`completeness=partial`, `proofStatus=proven`. No repository or data candidate
was emitted. The first evidence frontier is the proto service; database/data
reachability is `not proven`. The graph does not provide an edge-level
origin/confidence record on this endpoint flow, unlike `explore` provenance.
Confidence: high for the bounded result, low for any deeper request claim.
Workarounds: 0.

### Q8 — simulated change-preparation packet

Target: `node_af26e1f8-17f5-473b-b76c-e33a150abfac`,
`apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts:135-156`.
Direct callers: `verifyPlayerColorLand`, `playDice`, `buildContext`; direct
callee: `getColorLandEventConfigByIdFromCache`. `affected` returned 9 impacted
nodes, six test files, and routes
`gRPC promotion.v1.RecaptchaColorLandService.VerifyPlayerColorLand` and
`gRPC promotion.v1.FrontendColorLandService.RollColorLandDice`.
`explore` provenance showed parser `calls` and `defines` edges with confidence
1; no inferred edge was present in this target’s provenance. Context warned
that calls are lower-bound and `unresolvedReferenceCount=103925`.

Source-review checklist: verify cache/database lifecycle; verify active/status
and date predicate semantics; inspect both gRPC controller paths; inspect the
three callers and six tests; verify dynamic/interface dispatch, DI wiring,
external calls, and unresolved references; rerun tests after any change.
Decision: `NO-GO` from Penguin alone. The aligned revision is good, but
coverage is incomplete and graph closure is not proven. Confidence: high.
Workarounds: 0.

### Q9 — four adversarial negatives

| Claim | Query/evidence | Conclusion |
|---|---|---|
| “This function has no callers.” | `callers node:node_af26...` returned 3 exact candidates, `totalIsExact=true`, but completeness lower-bound and unresolved refs present. | False for the three confirmed callers; no global absence claim is proven. |
| “This endpoint has no handler.” | Q5 inventory reported `handlerStatus=handled`, handler `proto`; Q5 flow emitted service node `node_0fb2...`. | The claim is contradicted for the indexed handler; handler-to-runtime semantics remain not proven. |
| “This symbol is unused.” | `deadcode --repo FPMS-NT --limit 5 --json` returned candidates with note “verify DI, reflection, framework magic, dynamic import, and public entry points”; target was not itself established unused. | `not proven`; deadcode is a candidate queue, not proof. |
| “This request never reaches a data boundary.” | Q5 endpoint flow stopped at `proto`, `completeness=partial`, `totalIsExact` not supplied. | `not proven`; the flow is only a lower bound. |

The empty query `search "" --repo FPMS-NT --json` returned
`NO_MATCH_INCOMPLETE`, `proofStatus=not_proven`, `candidateCount=0`,
`totalIsExact=false`, coverage 3340/3333/7/0, and an explicit warning that an
empty result is not proof. Confidence: high. Workarounds: 0.

### Q10 — revision drift and stale evidence

`status --json` selected FPMS-NT’s live/default `brazil-v2`; explicit context
with `--branch brazil-v2` returned `alignment=explicit`, while the same query
without it returned `alignment=aligned`. Both had commit
`3f0f1984b9e4337668529a13bad5264501729908`, clean worktree, zero dirty files,
and snapshot `snapshot_804a4c86...`. `files FPMS-NT --limit 3 --json` returned
3333 entries, including indexed/skipped status; filesymbols returned the target
symbols with status `fresh` and cursor metadata.

The repository is clean and aligned according to Penguin, so a real stale case
was not available without modifying the repository or indexing state, both
forbidden. However status still reports `staleSymbols=725`, and search results
reported `freshness.status=stale` while context/explore reported fresh. This is
an unresolved freshness-field inconsistency. A current-session symbol from
`penguin-src` (`node_116a43a4...`) passed to FPMS-NT returned
`NODE_NOT_FOUND`, not a distinct wrong-revision/stale error. Confidence: high.
Workarounds: 1.

### Q11 — evidence provenance cross-check

Confirmed parser edge: `explore node_af26...` emitted provenance
`edgeType=calls`, `origin=parser`, `method=EXTRACTED`, `confidence=1`.
External call: `context node:node_7c2d...` emitted `@nestjs/common.Inject`,
`@nestjs/microservices.ClientGrpc`, completeness partial and
`externalCallCount=2`. Unresolved evidence: context diagnostics for
`node_af26...` reported `unresolvedReferenceCount=103925` and coverage gap
`unresolved_references_present`, but no per-reference locator/reason was
available. Agent suggestion: `suggestions FPMS-NT --json` returned one pending
edge suggestion, `mentions`, confidence 0.7, from “MCP Wiki Test Page 测试页”
to `materialize`; search negative results suggested `penguin index <repo-path>`.

No inferred edge was emitted for the selected target, so inferred-edge
availability is `not proven`, not “none exist”. Across context/explore/graph
surfaces, scope, commit, freshness and proof status survived; endpoint flow
did not retain the richer edge origin/confidence fields, and unresolved
references were counts rather than actionable records. Confidence: medium-high.
Workarounds: 1.

### Q12 — cursor recovery after context compaction

Endpoints: page 1→2→3 succeeded in new processes with copied cursors; counts
were 1535/3, 1532/3, 1529/3, all `totalIsExact=false`, `truncated=true`, and
ordered by title,nodeId. Malformed cursor returned exit 2,
`{"code":"CURSOR_INVALID","message":"invalid or mismatched endpoint cursor"}`.
A cursor under FPMS-CCMS returned exit 2,
`CURSOR_SCOPE_MISMATCH`. A limit-2000 request was capped at 500, proving the
endpoint corpus was not exhausted in this run.

Filesymbols on the target file: page 1→2→3→4 succeeded with 3,3,3,1 items;
page 4 returned `candidateCount=1`, `returnedCount=1`, `totalIsExact=true`,
`nextCursor=null`, `truncated=false`. Malformed cursor returned exit 2,
`CURSOR_INVALID`; a cursor under FPMS-CCMS returned the same generic invalid
error rather than a scope-specific error.

Deadcode: page 1→2 succeeded with 5 items each, `candidateCount=5647`,
`totalIsExact=true`, `truncated=true`; a limit-6000 request returned all 5647,
`nextCursor=null`, `truncated=false`. Malformed cursor returned exit 2,
`CURSOR_INVALID`; a cursor under FPMS-CCMS returned
`CURSOR_SCOPE_MISMATCH`. No duplicate IDs were seen in the continued pages.
Filesymbols and deadcode continuation are reproducible without hidden state.
Endpoint exhaustion remains unproven because the hard 500-page cap was not
fully traversed. Confidence: high for tested behavior. Workarounds: 2.

### Q13 — onboarding as a first-day decision aid

The onboarding output gives the repo path, 3333 indexed files, 13710 fresh
symbols, six key entry routes, `flow`/coverage warnings, `status`, and the
Search → Context → Graph → Evidence reading order. A copyable memo for a new
engineer is:

```sh
penguin status --json
penguin coverage --repo FPMS-NT --json
penguin endpoints FPMS-NT --protocol grpc --limit 3 --json
penguin context node:<ID_FROM_CURRENT_RESULT> --repo FPMS-NT --json
penguin flow node:<ID_FROM_CURRENT_RESULT> --repo FPMS-NT --json
penguin search "term" --repo FPMS-NT --json
penguin filesymbols --repo FPMS-NT --path <path> --json
```

Use only IDs emitted by the current result; preserve commit, freshness,
coverage, completeness, `totalIsExact`, cursor, and proof status. Treat every
empty/no-match/deadcode/partial flow as `not proven` when coverage or dynamic
wiring is incomplete. If MCP is unavailable, use the exact CLI bundle/runtime
fallback in section 1. This memo works, but onboarding itself does not include
the full copyable command sequence or the endpoint identity three-argument
contract. Confidence: high. Workarounds: 1.

### Q14 — MCP/CLI contract and behavior comparison

CLI sequence executed with fresh processes: `search` → `filesymbols` →
`context` → `flow` → `endpoints` → malformed cursor. CLI preserved IDs and
revision on graph surfaces; filesymbols/endpoints inventory surfaces omitted
some evidence metadata; malformed endpoint cursor returned structured exit-2
JSON.

MCP result: `N/A: environment unavailable`. No server name, tools/list, tool
schema, initialize response, or protocol error was available. This is an
environment readiness failure, not evidence of a product parity failure.
Confidence: high. Workarounds: 1 (CLI fallback).

### Q15 — agent-to-agent handoff

Agent-A packet contained: repo `FPMS-NT`, branch `brazil-v2`, commit
`3f0f1984...`, symbol `node_af26e1f8...`, endpoint
`node_74499273...`, flow endpoint→`proto`, affected candidate count 9, and
the negative-result rule “Q5 flow is partial; data boundary not proven”.
Next commands were:

```sh
penguin context node:node_af26e1f8-17f5-473b-b76c-e33a150abfac --repo FPMS-NT --json
penguin flow node:node_74499273-c2a9-45d5-98eb-db01b536b1cf --repo FPMS-NT --json
penguin callers node:node_af26e1f8-17f5-473b-b76c-e33a150abfac --repo FPMS-NT --json
```

Agent-B replayed these as new CLI processes and preserved IDs, scope, commit,
freshness, and terminology. Cursor replay also worked when the full cursor
string was copied; endpoint identity required manual normalization from
`node:<id>` to bare `<id>`. Confidence: high. Workarounds: 1.

### Q16 — recovery-oriented error exercise

| Input | Exit/status | Raw error/result | Retryability/remediation |
|---|---:|---|---|
| Missing target | 1 | `TARGET_NOT_RESOLVED`, empty target, ambiguous noise candidates | Non-retryable; supply a target. Not copy-safe because the output suggests no exact target. |
| Unknown repo | 2 | `unknown repo: DOES-NOT-EXIST` | Non-retryable; use `status` to copy an indexed name. |
| Ambiguous symbol | 1 | `TARGET_NOT_RESOLVED`; 20 `constructor` candidates | Non-retryable until path or emitted candidate ID is selected; actionable. |
| Invalid node | 1 | `NODE_NOT_FOUND`, `proofStatus=not_proven` | Non-retryable; re-run search/filesymbols. |
| Wrong-revision/cross-repo node | 1 | current `penguin-src` ID under FPMS-NT also became `NODE_NOT_FOUND` | Not distinguishable from absent ID; remediation not specific. |
| Malformed cursor | 2 | `CURSOR_INVALID`, `retryable=false` | Copy the cursor from the immediately preceding same-scope page. |
| Wrong-scope cursor | 2 | `CURSOR_SCOPE_MISMATCH` for endpoint/deadcode; generic invalid for filesymbols | Scope-safe retry is clear for endpoint/deadcode, not for filesymbols. |
| Invalid endpoint identity | 1 | three forms all `status=no_match`, `equal=false`, completeness unknown | Non-retryable; no safe retry suggestion. |
| Empty negative query | 0 | `NO_MATCH_INCOMPLETE`, `proofStatus=not_proven`, coverage warning | Exit 0 is potentially misleading, but diagnostics explicitly forbid absence claims. |

All results carried the FPMS-NT revision envelope when the target was scoped;
invalid cursor results were the exception and carried only structured cursor
error fields. Confidence: high. Workarounds: 3.

### Q17 — repaired runtime and long-lived client handoff

`help --json` and `capabilities --json` both exposed `callees`; current
`callees node:node_af26...` and `affected node:node_af26...` exited 0 and were
not interpreted as unknown commands or filenames. CLI capability hash was
`40ae9528330e4...e4487d0`; contract/schema were 2/14.

MCP fresh-session comparison was unavailable because MCP was not exposed.
The client used the app-bundle runtime path from section 1, not a proven stable
user runtime. `doctor` was healthy, but no initialize/hello health check or
update/restart notice was exposed by the allowed surface. Therefore “new
runtime installed” is supported by the executable path and doctor status;
“already-running MCP process reloaded it” is `not proven`. Confidence: high.
Workarounds: 1.

## 4. B1–B6 workflows with the full handoff evidence

### B1 — cold-start gRPC investigation

Starting from onboarding/status, endpoint page one and page two were fetched.
Page-two endpoint `node_74499273...` was carried through context and flow. The
bounded memo is: FPMS-NT/brazil-v2, aligned commit `3f0f1984...`, endpoint title
`AccumulativeEventConfigAdminService.UpdateAccumulativeEventConfig`, handler
status handled by `proto`, flow reaches only the proto service, and data-layer
reachability is `not proven`. Source review is required at the first evidence
frontier. The workflow is reliable for bounded discovery, not full tracing.

### B2 — safe change planning

Target `node_af26e1f8...` produced three confirmed callers, one confirmed
callee, nine impact candidates, six tests, and two related gRPC routes. Two
fresh caller IDs were followed successfully: `node_79307c9d...` and
`node_60f4c2d2...`; both retained the same scope/revision. Because graph calls
are lower-bound and unresolved references are present, the decision is
`NO-GO` without source review. The packet is actionable and honest about its
closure limit.

### B3 — negative-result audit

The four Q9 claims were replayed against the current symbol and endpoint. One
claim was contradicted by three callers, one by an explicit handled status, and
the unused/data-boundary claims remained `not proven`. Deadcode’s own note
requires DI/reflection/framework verification. No negative claim was promoted
from an empty array alone.

### B4 — two-agent continuity replay

Agent A’s packet contained only Penguin output: repo/revision, symbol and
endpoint IDs, flow, impact count, negative-result caveat, and next commands.
Agent B used fresh CLI processes and reproduced context, flow, callers, and the
negative boundary. No ID or cursor was reconstructed. The only manual value was
normalizing the endpoint identity node form; filesymbol and endpoint inventory
metadata still require context recovery.

### B5 — MCP/CLI degraded-mode report

Product capability score: 71/100 on the CLI-only evidence above. Environment
readiness score: 35/100 because the CLI bundle and doctor are healthy but MCP
is unavailable and stable-runtime/reload behavior is unproven. These are kept
separate; MCP unavailability is not counted as a product parity defect.

### B6 — runtime continuity and repaired command replay

Agent A recorded capability hash, fresh symbol/endpoint IDs, a deadcode cursor,
and the invalid-cursor response. Agent B replayed `callees`, `affected`, cursor
continuation, and the same negative query in new processes. CLI IDs, revision,
cursor semantics, and structured error codes survived. Endpoint `node:` identity
normalization did not, and MCP long-lived process reload could not be tested.

## 5. Reliable operations without source reading

- Discover a repository and branch with `status`, then gate all claims with
  `coverage` and explicit `--repo`.
- Search by symbol or path, select a fresh emitted ID, and carry it through
  `context`, `callers`, `callees`, `flow`, and `affected`.
- Prepare a source-review checklist from context/explore source packs without
  opening source files.
- Traverse endpoint, filesymbols, and deadcode cursors across fresh processes
  when the complete cursor string is copied.
- Distinguish `proven`, `not_proven`, `partial`, `lower_bound`, external calls,
  and candidate queues well enough to avoid the tested negative-claim traps.
- Produce a bounded request memo and a `NO-GO` change packet.

## 6. Operations that still require source reading or human intervention

- Prove semantic correctness, database reachability, runtime dispatch, DI,
  reflection, dynamic imports, interface dispatch, and framework magic.
- Close graph coverage when seven files are excluded and unresolved-reference
  counts are present.
- Explain the 725 stale-symbol status versus clean/fresh per-node results and
  search’s contradictory `freshness.status=stale` field.
- Map endpoint inventory handler repo IDs to the selected FPMS-NT repository.
- Compare MCP tools/list, input/output schemas, and long-lived session reload.
- Resolve ambiguous raw names safely without relying on unadvertised positional
  identity rules.
- Exhaust the 1535 endpoint queue under the hard 500-item limit and prove final
  endpoint cursor semantics.

## 7. Misleading, ambiguous, failed, unavailable, or non-actionable outputs

- Unscoped search silently used the current `penguin-src` scope instead of
  clearly presenting an all-repository search boundary.
- `endpoint-identity` accepted bare node IDs but rejected the public
  `node:<id>` form; the brief’s public continuation notation is therefore not
  universal.
- Endpoint inventory and filesymbols inventory surfaces omitted revision,
  freshness, coverage, and locator envelopes that graph surfaces provided.
- Search reported `freshness.status=stale` for an aligned clean FPMS-NT query;
  context/explore reported fresh.
- Missing-target output included irrelevant ambiguous topic candidates.
- Wrong-revision/cross-repository IDs collapse to `NODE_NOT_FOUND` rather than
  distinguishing absent, stale, and scope mismatch.
- Filesymbols wrong-scope cursors collapse to generic `CURSOR_INVALID`.
- Empty search exits 0 even though the result is `NO_MATCH_INCOMPLETE`; the
  structured diagnostics mitigate but do not eliminate agent misuse risk.
- MCP was unavailable, so MCP contract/parity and reload evidence are absent.

## 8. Product failures versus evaluation-environment failures

Product-level failures observed in the CLI contract/behavior:

1. Inconsistent node continuation syntax between graph queries and
   `endpoint-identity`.
2. Missing evidence envelopes on endpoint/filesymbol inventory outputs.
3. Silent current-repository fallback for unscoped search.
4. Freshness field inconsistency and stale-symbol ambiguity.
5. Incomplete error taxonomy for stale/wrong-revision/absent IDs and
   filesymbol cursor scope mismatch.
6. Endpoint pagination has a hard 500 limit and no demonstrated final-page
   path in this evaluation.

Environment-level failures:

1. No Penguin MCP server/tool was exposed, so MCP parity and long-lived MCP
   reload were not testable.
2. The current runtime is app-bundle based; stable installation and restart
   signaling are not exposed by the allowed surface.
3. The repository worktree was already dirty before this evaluation, although
   Penguin’s FPMS-NT indexed target itself reported clean/aligned.

## 9. Ordered improvements with impact, cost, and directly testable acceptance criteria

1. **Unify target normalization and evidence envelopes** — impact high, cost
   medium. Acceptance: the same emitted `node:<id>`, bare ID, title, canonical
   identity, and slash route either resolve consistently or return a typed
   remediation; every inventory response includes repo, revision, freshness,
   coverage, completeness, proof, and locator fields.
2. **Make scope mandatory or explicit** — impact high, cost low-medium.
   Acceptance: unscoped search either rejects with a copyable scope command or
   returns an explicit multi-repo scope; no query silently selects cwd repo.
3. **Repair freshness/revision diagnostics** — impact high, cost medium.
   Acceptance: clean aligned FPMS-NT queries report one consistent freshness
   status; a cross-repo and stale ID produce distinct typed errors with
   retryability and remediation.
4. **Expose unresolved-reference closure data** — impact high, cost high.
   Acceptance: every unresolved count can be paged by locator/reason/type, and
   completeness cannot be `proven` for a negative claim while unresolved
   references remain relevant.
5. **Finish cursor contract tests** — impact medium-high, cost medium.
   Acceptance: endpoints, filesymbols, and deadcode each demonstrate page one,
   continuation, final page, exhausted continuation, malformed cursor, and
   wrong-scope cursor with stable typed errors and no duplicates.
6. **Provide MCP health and reload observability** — impact high for clients,
   cost medium. Acceptance: `tools/list` exposes the same capability hash as
   CLI; initialize/hello reports runtime build; a second fresh session proves
   repaired tools and emits an update/restart notice when needed.
7. **Improve onboarding** — impact medium, cost low. Acceptance: onboarding
   emits a copyable cold-start command sequence with freshness gate, page-two
   endpoint selection, ID handoff, negative-claim rules, and CLI fallback.

## 10. Final recommendation for Claude/Codex-only internal use

Recommend Penguin for internal Claude/Codex use as a scoped investigation and
source-review preparation layer, with mandatory explicit repository scope and
mandatory human/source review at every partial, lower-bound, unresolved,
external, stale, or negative-result boundary. It is effective for discovery,
ID-based navigation, bounded flows, impact candidates, and honest `NO-GO`
packets. Do not treat it as proof of absence, complete request tracing, or a
replacement for source/runtime review. MCP remains an environment readiness
gap in this run, and endpoint identity/freshness/evidence-envelope issues
should be fixed before broad internal reliance.

No release recommendation is made.
