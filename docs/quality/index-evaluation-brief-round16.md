# Penguin Wiki / Knowledge Evaluation Brief — Fresh Round 16

> **Purpose:** independently test the newly installed Penguin build as a high-trust knowledge layer for Claude Code and Codex. This round focuses on the boundary that caused repeated failures before: stable launcher resolution, MCP generation identity, fresh client sessions, CLI/MCP parity, dynamic ID handoff, pagination, and honest evidence limits.
>
> **Release scope:** evaluation only. Do not modify source code, repositories, notes, the knowledge database, client configuration, or generated reports. Do not run indexing, rebuilding, mutation, release packaging, or signing commands.

## 1. Fresh-session rule

Run this entire brief in a completely new Claude Code or Codex session after installing the latest Penguin application.

The evaluator must not use:

- previous conversations, previous node IDs, previous reports, answer keys, or screenshots;
- source files, database files, `git`, `grep`, browser search, or manual database queries;
- guessed IDs, reconstructed hidden state, or a title substituted after an ID failure.

Use only Penguin CLI, Penguin MCP, and Wiki/Knowledge surfaces exposed by the installed application. If a surface is unavailable, record the exact failure and use the documented fallback. Never convert an unavailable environment into a product failure without evidence.

Before testing, record:

1. model, agent, session start time, and whether this is Claude Code or Codex;
2. Penguin app version and installation path, if exposed by the UI;
3. MCP availability, server name, initialize result, exact `tools/list` count, and any transport error;
4. CLI entry path and runtime path used for fallback;
5. whether this session was started after completely quitting and reopening the client.

## 2. Allowed CLI setup

Prefer the installed stable CLI launcher if it is on `PATH`:

```bash
penguin help --json
```

If it is not on `PATH`, use the newest runtime supplied by the installed app and record the exact paths. A local development fallback is allowed only when the installed app path is unavailable:

```bash
PENGUIN_NODE=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
PENGUIN_BUNDLE=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/penguin.mjs
PENGUIN_WASM=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/wasm
"$PENGUIN_NODE" "$PENGUIN_BUNDLE" help --json
```

For every CLI command below, replace `<penguin>` with the working launcher invocation and do not silently mix development and installed runtimes.

Primary test repository:

```text
repo: FPMS-NT
path: /Users/shieng/Desktop/Projects/fpmsnt
preferred branch: brazil-v2, when available
```

## 3. Evidence contract for every answer

For every question, record the exact CLI command or MCP tool call, exit code/status, a bounded raw JSON excerpt, and:

- repository and branch scope;
- node/endpoint identity and locator;
- snapshot/revision ID and indexed commit;
- freshness, worktree state, changed-file count, parser/schema/resolver versions;
- discovered/admitted/excluded/failed/stale/unresolved counts;
- completeness, `proofStatus`, `totalIsExact`, candidate count, returned count;
- cursor, exhausted/truncated state, and whether any item was repeated;
- warnings, remediation, retryability, and workaround count.

Use `not proven` whenever evidence is partial, inferred, unresolved, externally dispatched, dynamically wired, stale, lower-bound, or non-exact. An empty array is not proof of absence unless the result explicitly proves a closed set.

Every positive claim must have a locator and aligned revision. Separate parser-confirmed edges, inferred edges, external calls, unresolved references, and suggestions.

## 4. Bootstrap questions

### Q1 — capability truth and first move

From an empty prompt, answer: “What can Penguin reliably do for an engineer investigating FPMS-NT, and what can it not prove?”

Run:

```text
<penguin> help --json
<penguin> capabilities --json
<penguin> status --compact --json
<penguin> doctor --json
<penguin> coverage --repo FPMS-NT --json
<penguin> onboarding FPMS-NT
```

If MCP is available, also run `initialize`, `tools/list`, `mcp_health`, and `knowledge_capabilities` in a new MCP session.

Compare advertised commands, canonical capabilities, implemented status, and actual runtime results. Identify the recommended first investigation command, at least three read-only operations, two graph operations, one paged operation, and one negative-result operation. List every unavailable or not-proven capability instead of filling the gap from memory.

### Q2 — generation and launcher identity

In one fresh CLI process and one fresh MCP session, compare:

```text
capabilities --json
mcp_health
knowledge_capabilities
```

Record build ID, capability hash, schema/contract version, running generation, available generation, launcher/runtime status, and restart action. Then completely close the MCP client process, open a second fresh MCP session, and repeat the same calls.

Pass only if the two fresh sessions agree on generation and capability hash, or if a difference is explicitly explained by an update/outdated-runtime response. “Configuration present” and “local initialize passed” are not proof that a long-lived Claude/Codex process reloaded.

### Q3 — MCP listing integrity

Call MCP `tools/list` and `knowledge_capabilities`.

Check:

1. `knowledge_explore` is the first discovery tool;
2. core search, file-symbol, context, graph, endpoint, and status tools are discoverable;
3. the listing is bounded enough to scan;
4. no tool names are duplicated;
5. no capability IDs are duplicated;
6. compatibility aliases remain callable without creating a second advertised capability;
7. the full capability manifest is still available through `knowledge_capabilities`.

Record any mismatch between listed tools, callable tools, and the canonical manifest.

## 5. Dynamic investigation questions

### Q4 — path-qualified source-pack usefulness

Without opening the source file, investigate:

```text
apps/promotion/src/modules/color-land/services/color-land-event-config.service.ts#getActiveEventConfigByObjId
```

Run `search`, `filesymbols`, `context`, and `explore` with `repo: FPMS-NT`. Use source-pack controls only if the surface exposes them.

Report whether the returned pack contains a usable focus node, file/line locator, kind/signature, callers, callees, tests, routes, external calls, source blocks, omitted-source reasons, revision, freshness, coverage, completeness, and next commands. Decide whether it is sufficient to prepare a source-review checklist. Do not decide semantic correctness without source review.

### Q5 — collision containment

For each query below, run one global search and one `--repo FPMS-NT` search:

```text
constructor
execute
update
```

Select one current result from the scoped search using only its emitted node ID and locator. Run `context`, `callers`, and `flow` with `node:<id>` and the same repository scope.

Report whether global results disclose multi-repository scope, whether the scoped result preserves repo identity, and whether a path-qualified follow-up can resolve a different repository. Unknown totals must remain unknown.

### Q6 — dynamic ID matrix

Obtain fresh IDs from the current session:

1. one symbol from `filesymbols`;
2. one symbol from `search`;
3. one candidate from an ambiguous result;
4. one endpoint from `endpoints`.

For every applicable ID, run:

```text
context node:<id>
flow node:<id>
callers node:<id>
callees node:<id>
affected node:<id>
```

Create a matrix of emitted ID, accepted follow-ups, status, repo, branch, revision, locator, and error/remediation. If a follow-up fails, preserve the exact emitted ID and record the failure; do not substitute a title or path.

### Q7 — endpoint queue and page-two handoff

Run:

```text
<penguin> endpoints FPMS-NT --protocol grpc --limit 3 --json
```

Copy the returned cursor exactly into page two, then page three if available. Verify ordering, duplicate IDs, `candidateCount`, `returnedCount`, `totalIsExact`, `truncated`, and exhausted-cursor behavior.

Select an endpoint from page two, not page one. Carry its emitted ID through `context` and `flow`. Record handler status, handler IDs, root/parent relationships, edge origin, confidence, and the first incomplete evidence boundary.

### Q8 — five-form endpoint identity

For the page-two endpoint, compare these forms when available:

1. rendered inventory title;
2. canonical `grpc::Service.method` identity;
3. bare emitted node ID;
4. `node:<id>`;
5. slash route `/Service/Method`.

Use `endpoint-identity`, `context`, and `flow`. Also test one intentionally invalid service or method. Report which forms resolve to the same node, which are rejected, and whether invalid input returns a typed, retryable, copyable remediation.

### Q9 — bounded request-trace chain

Using only current-session IDs, attempt:

```text
endpoint → handler → service → repository/data candidate → related test
```

Use only `context`, `flow`, `explore`, `callers`, `callees`, `affected`, and graph queries exposed by Penguin. For every hop record edge type, origin, method, confidence, locator, revision, and status: confirmed, inferred, external, unresolved, or suggestion.

Identify the first evidence frontier. A short flow is a lower bound unless the result explicitly proves completeness. Never claim data-layer reachability merely because a repository-like title appears.

## 6. Negative and error questions

### Q10 — four adversarial negative claims

Evaluate all four claims against current-session targets:

1. “This function has no callers.”
2. “This endpoint has no handler.”
3. “This symbol is unused.”
4. “This request never reaches a data boundary.”

Use the relevant graph operation and inspect coverage, freshness, `totalIsExact`, unresolved references, DI/reflection warnings, dynamic-dispatch caveats, and result status. Each conclusion must be either directly proven or `not proven`; an empty result alone fails this question.

### Q11 — error taxonomy and remediation

Test each of the following independently in CLI and MCP when available:

- missing target;
- unknown repository;
- ambiguous symbol;
- invalid node ID;
- wrong-revision or stale ID if available;
- malformed cursor;
- cursor from another repo/scope;
- invalid endpoint identity;
- empty query.

For each, record structured error code, message, `retryable`, details, remediation, exit/status, protocol `isError`, and whether the next action is copyable. Distinguish invalid, absent, ambiguous, stale, scope mismatch, and unavailable runtime. Do not call a generic error “handled” if it hides the recovery step.

### Q12 — cursor continuity and scope safety

Exercise pagination for:

```text
endpoints
filesymbols
deadcode
```

For each surface, test normal continuation in a new process, exhausted cursor, malformed cursor, and wrong repository/scope cursor. Confirm stable ordering, no repeated items, exactness flags, and structured error codes. The continuation must work from page-one JSON alone; it must not require hidden session state.

## 7. Cross-session and handoff questions

### Q13 — fresh-session replay

Session A records only Penguin output:

- capability hash and build ID;
- one symbol ID;
- one endpoint ID;
- one valid cursor;
- one invalid-cursor error;
- exact next commands.

Completely quit the client and start Session B. Session B must execute every next command using only the packet. Record whether IDs, scope, revision, cursor, error shape, and terminology survive. Count every manually reconstructed value and every workaround.

### Q14 — Claude/Codex client continuity

For each available client, verify separately:

1. client was fully quit before the new session;
2. MCP initialize succeeded;
3. `tools/list` is non-empty and duplicate-free;
4. `mcp_health` reports the same generation as CLI;
5. one `knowledge_search` call succeeds;
6. a second completely fresh session sees the same generation and capability hash.

If a client cannot be controlled or its reload state is not exposed, mark that item `not proven`. Do not infer successful reload from a green Settings badge.

## 8. Safe change-preparation question

### Q15 — GO / NO-GO engineering packet

Choose a current-session symbol with at least three callers or impact candidates. Prepare a bounded change packet containing:

- target node, defining locator, and selected revision;
- direct callers and callees with evidence status;
- affected files/nodes and related tests;
- routes/endpoints that may be related;
- external and unresolved edges;
- coverage, pagination, truncation, and lower-bound limits;
- exact source-review checklist;
- decision: `GO` only when aligned revision and sufficient evidence are proven; otherwise `NO-GO`.

The evaluator must not edit code. Score whether Penguin prevents an agent from treating a candidate list as a complete closure.

## 9. Required scoring

Score each dimension from 0–100 and justify every score with evidence:

| Dimension | What to score |
|---|---|
| Agent discoverability | Can a new agent find the right first tool and understand aliases? |
| Context usefulness | Are returned packs actionable without opening source? |
| Accuracy | Are scope, IDs, revisions, and evidence statuses correct? |
| Completeness | Are meaningful edges, handlers, tests, and limits exposed? |
| Honesty | Are negative, partial, inferred, external, and unresolved results labeled? |
| MCP/CLI parity | Do inputs, outputs, IDs, schemas, errors, and hashes agree? |
| Continuity | Do fresh processes and fresh sessions preserve the contract? |
| Usability | Are commands, errors, cursors, and remediation copyable? |
| Speed | Are bounded queries responsive and predictable? |
| Product overall | Weighted engineering usefulness, not environment health. |
| Environment readiness | Installed runtime, launcher, MCP initialize, and client reload evidence. |

Keep `Product overall` and `Environment readiness` separate. An MCP outage lowers environment readiness; it does not automatically lower product capability if the same operation is proven through the allowed CLI fallback.

## 10. Required report

Create a new report without overwriting this brief or any earlier report:

```text
docs/quality/index-evaluation-<model>-round16.md
```

Use this section order:

1. Fresh-session environment and exact runtime/client paths.
2. Capability/readiness split and all scores /100.
3. Q1–Q15 answers with exact commands/tools and bounded raw evidence.
4. Session A → Session B handoff packet and replay results.
5. Reliable operations without source reading.
6. Operations requiring source reading or human intervention.
7. Misleading, ambiguous, failed, unavailable, or non-actionable outputs.
8. Product failures versus environment failures.
9. Ordered improvements with impact, cost, and directly testable acceptance criteria.
10. Final recommendation for Claude/Codex internal use only.

## 11. Completion gate

- Q1–Q15 are executed in a truly new client session.
- At least two fresh MCP sessions are tested when MCP is available.
- Every follow-up node ID was emitted by the current session.
- Endpoint page two is selected and carried through context/flow.
- All three cursor surfaces test normal, exhausted, malformed, and wrong-scope behavior.
- Positive, negative, stale/revision, ambiguous, inferred, external, unresolved, and unavailable cases are represented.
- CLI and MCP are compared, or MCP is explicitly marked `N/A: environment unavailable` with evidence.
- Every negative conclusion includes coverage/completeness evidence and uses `not proven` when required.
- No source, database, git, previous report, browser, release, signing, mutation, or indexing operation is used.
