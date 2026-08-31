# Penguin Wiki / Knowledge Evaluation Brief — Round 19 Full Closure

> **Created:** 2026-08-31  
> **Purpose:** immutable baseline for 95-100% knowledge closure acceptance; deterministic contract testing with frozen targets and no evaluator-specific refinements.  
> **Release scope:** none. This is a deterministic, machine-readable test runner, not a production release gate.

## Immutability

This brief is frozen. Round 19 reports must reference this exact file by SHA-256 hash. Do not modify scenarios, targets, or acceptance criteria. If a scenario requires adjustment, create Round 20.

## Required report filename

```text
.superpowers/sdd/2026-08-31-penguin-knowledge-95-100-full-closure/round19-<evaluator>-<timestamp>.md
```

## Scope and setup

Primary repository:

```text
repo: FPMS-NT
path: /Users/shieng/Desktop/Projects/fpmsnt
branch: brazil-v2, when available
```

CLI fallback when MCP is unavailable:

```sh
VN=/Applications/Penguin.app/Contents/Resources/_up_/packages/knowledge-cli/bundle/node
B=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/penguin.mjs
export PENGUIN_WASM_DIR=/Users/shieng/Desktop/Pengvi/packages/knowledge-cli/bundle/wasm
"$VN" "$B" <command> [options] [--json]
```

Before G0, record Round19RunHeader:

```typescript
{
  briefVersion: "Round19",
  briefSha256: "<computed from this file>",
  buildId: "<from capabilities>",
  capabilityHash: "<from capabilities>",
  schemaVersion: "<from capabilities>",
  contractVersion: "<from capabilities>",
  runtimePath: "<actual runtime path>",
  clientSessionId: "<process/session ID>",
  startedAt: "<ISO timestamp>"
}
```

## Evidence rules

- Record every command input, tool call, exit code, timing, scope, revision, counts, cursor, lanes, evidence, and workaround.
- Never read an old report as an answer key.
- Never invent node IDs; use only IDs emitted by the current session.
- Deterministic target fallback: after a concept query returns zero symbol-lane hits, select only `(score desc, identityKey, nodeId)` sorted hits; if none exist, fail the discovery scenario. No evaluator-specific refinements allowed.

## Gate G0 — Contract Identity

Run `capabilities --json` and verify:

1. `buildId` is non-empty string
2. `capabilityHash` is non-empty string
3. `schemaVersion` is numeric
4. `contractVersion` is string "2"

Record exact values. Exit if any missing.

## Gate G1 — Basic Operations

### G1.1 Search with results

```text
search constructor --repo FPMS-NT --json
```

Assert: `results` array non-empty, each has `nodeId`, `title`, `kind`, first result has `locator.filePath`.

### G1.2 File symbols

```text
filesymbols FPMS-NT brazil-v2 <path-from-G1.1> --json
```

Assert: `items` array non-empty, `candidateCount` >= 1, `totalIsExact` is boolean.

### G1.3 Context from node

```text
context node:<id-from-G1.1> --repo FPMS-NT --json
```

Assert: `node` object has `nodeId`, `title`, `kind`, `firstHopRelations` is array.

## Gate G2 — Pagination Cursors

### G2.1 Endpoints page 1

```text
endpoints FPMS-NT --protocol grpc --limit 1 --json
```

Assert: `items` length 1, `nextCursor` is string, `candidateCount` >= 1.

### G2.2 Endpoints page 2

```text
endpoints FPMS-NT --protocol grpc --limit 1 --cursor <cursor-from-G2.1> --json
```

Assert: `items[0].nodeId` != G2.1's nodeId, `candidateCount` matches G2.1.

### G2.3 Cursor exhaustion

Continue until `nextCursor` is null. Assert: `truncated` is false on last page.

## Gate G3 — Scope Errors

### G3.1 Missing repository

```text
search test --repo NONEXISTENT-REPO --json
```

Assert: `error.code` is "REPOSITORY_NOT_FOUND", exit code != 0.

### G3.2 Invalid node ID

```text
context node:invalid-node-id --repo FPMS-NT --json
```

Assert: `error.code` is "INVALID_TARGET", exit code != 0.

### G3.3 Malformed cursor

```text
endpoints FPMS-NT --cursor malformed --json
```

Assert: `error.code` is "CURSOR_INVALID", exit code != 0.

## Gate G4 — Freshness and Coverage

Run:

```text
status --compact --json --repo FPMS-NT
coverage --repo FPMS-NT --json
```

Assert: `freshness.status` is one of ["fresh", "stale", "partial"], `coverage.indexed` >= 0.

## Gate G5 — Affected Analysis

```text
affected <file-from-G1.2> --repo FPMS-NT --json
```

Assert: `changed` array exists, `impacted` array exists, `revision` object has `revisionId`.

## Gate G6 — Endpoint Identity

Select endpoint from G2.1. Test forms:

1. `node:<endpointId>`
2. `grpc::Service.Method` (from endpoint title)

Both via:

```text
context <form> --repo FPMS-NT --json
```

Assert: Both return same `nodeId`, both succeed with exit code 0.

## Gate G7 — Flow Tracing

```text
flow node:<endpoint-from-G2.1> --repo FPMS-NT --json
```

Assert: `steps` array non-empty, root step has `depth` 0, `via` is string or null.

## Gate G8 — Callers and Callees

```text
callers node:<symbol-from-G1.1> --repo FPMS-NT --json
callees node:<symbol-from-G1.1> --repo FPMS-NT --json
```

Assert: Both return arrays, `revision` present in both.

## Gate G9 — Deadcode Listing

```text
deadcode --repo FPMS-NT --limit 5 --json
```

Assert: `items` is array, `proofStatus` is "candidate" or "not_proven" (never "proven").

## Gate G10 — MCP/CLI Parity

If MCP available, compare:

1. `knowledge_capabilities` vs `capabilities --json`
2. `knowledge_search` vs `search --json`
3. `knowledge_context` vs `context --json`

Assert: `buildId`, `capabilityHash`, node IDs match across surfaces.

If MCP unavailable, record "N/A: MCP server not connected" and skip comparisons.

## Gate G11 — Evidence Provenance

From G1.3 context, find one `firstHopRelations` item. Assert it has:

- `edgeType` (string)
- `evidenceState` (string, one of: "proven", "candidate", "not_proven")
- `source.repoId` (string or null)

## Gate G12 — Deterministic Target Selection

Run conceptual query:

```text
search "payment external service" --repo FPMS-NT --json
```

If zero symbol-lane results:
- Sort all hits by `(score desc, identityKey, nodeId)`
- Select first result
- If no results at all, FAIL scenario with "zero hits after deterministic sort"

Assert: Selection is reproducible across evaluators.

## Completion gate

- G0–G12 all pass
- Every dynamic ID from current session only
- No answer keys, no source reading, no git operations
- Deterministic target selection enforced
- MCP marked N/A if unavailable, not failed

## Required Round19RunHeader fields

Final report must include complete `Round19RunHeader` with all timing, revision, build, and session metadata.
