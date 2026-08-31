# Penguin Wiki / Knowledge Evaluation Brief — Round 19 Full Closure

> **Created:** 2026-08-31  
> **Purpose:** immutable baseline for 95-100% knowledge closure acceptance; deterministic contract testing with frozen targets and no evaluator-specific refinements.  
> **Release scope:** none. This is a deterministic, machine-readable test runner, not a production release gate.

## Immutability

This brief is frozen. Round 19 reports must reference this exact file by SHA-256 hash. Do not modify scenarios, targets, or acceptance criteria. If a scenario requires adjustment, create Round 20.

## Retained benchmark inventory

Round 19 gates (G0-G12) provide complete coverage of the retained benchmark inventory from prior rounds:

**Round 16 coverage (Q1-Q15):**
- Q1 capability truth → G0 contract identity, G1.1-G1.3 basic operations
- Q2 generation/launcher identity → G0, G10 MCP/CLI parity
- Q3 MCP listing integrity → G0, G10
- Q4 source-pack usefulness → G1.2 file symbols, G1.3 context
- Q5 collision containment → G1.1 search scoping
- Q6 dynamic ID matrix → G1.3 context with node ID
- Q7 endpoint page-two → G2.1, G2.2, G2.3 pagination
- Q8 five-form endpoint identity → G6
- Q9 bounded request-trace → G7 flow tracing
- Q10 adversarial negative → G9 deadcode (proof status), G11 evidence provenance
- Q11 error taxonomy → G3.1, G3.2, G3.3 scope errors
- Q12 cursor continuity → G2.1, G2.2, G2.3 pagination
- Q13 fresh-session replay → G12 deterministic selection
- Q14 client continuity → G10 MCP/CLI parity
- Q15 GO/NO-GO packet → G5 affected, G8 callers/callees

**Round 17 coverage (Q1-Q20, B1-B8):**
- Q1 safe first sequence → G0, G1.1-G1.3
- Q2 CLI/MCP generation → G0, G10
- Q3 compact envelope → G4 freshness/coverage reporting
- Q4 global→scoped search → G1.1 search with scope
- Q5 source pack preparation → G1.2, G1.3, G11
- Q6 dynamic ID round-trip → G1.3, G6, G7, G8
- Q7 endpoint page-two → G2.1, G2.2, G2.3
- Q8 endpoint identity forms → G6
- Q9 evidence frontier → G7, G11
- Q10 impact/affected safety → G5
- Q11 negative tri-state → G9, G11
- Q12 stale/revision transparency → G4, G11
- Q13 provenance preservation → G11
- Q14 cursor new-process continuation → G2.3
- Q15 structured error guidance → G3.1, G3.2, G3.3
- Q16 onboarding first-day memo → G0, G1.1-G1.3
- Q17 API doc read chain → (out of scope for Round 19 core gates)
- Q18 Wiki/Knowledge boundary → (out of scope for Round 19 core gates)
- Q19 agent-to-agent handoff → G12 deterministic selection
- Q20 installed vs loaded separation → G0, G10
- B1 cold gRPC investigation → G0, G1, G2, G6, G7
- B2 safe change preparation → G5, G8, G11
- B3 negative audit → G9, G11
- B4 pagination work queue → G2.3
- B5 CLI/MCP degraded reporting → G10
- B6 API doc/knowledge read → (out of scope for Round 19 core gates)
- B7 runtime generation continuity → G0, G10
- B8 final decision packet → composite coverage via all gates

**Round 18 coverage (Q1-Q20, B1-B8):**
- Q1 zero-memory discovery → G0, G1.1-G1.3
- Q2 semantic/vector honesty → (vector quality covered in G0 extensions below)
- Q3 runtime self-containment → G0
- Q4 CLI/MCP contract parity → G10
- Q5 concept vs exact query → G1.1, G12
- Q6 metamorphic search stability → G1.1, G12
- Q7 dynamic endpoint selection → G2.1, G2.2, G6
- Q8 handler truth vs decoration → G6, G7
- Q9 bounded request-flow → G7
- Q10 duplicate service labels → G1.1 search precision
- Q11 file vs node affected → G5
- Q12 coverage debt actionable → G4
- Q13 adversarial negative tri-state → G9, G11
- Q14 cursor portability → G2.3
- Q15 typed-error discrimination → G3.1, G3.2, G3.3
- Q16 Wiki/API freshness → (out of scope for Round 19 core gates)
- Q17 runtime-generation replay → G10
- Q18 timeout/latency honesty → (timing recorded in all gates)
- Q19 agent-to-agent packet → G12
- Q20 four-claim separation → G0, G10
- B1 cold production-symptom triage → G0, G1, G4
- B2 dynamic gRPC request investigation → G2, G6, G7
- B3 safe-change decision → G5, G8, G11
- B4 semantic recall honesty → G0 (vector reporting), G1
- B5 pagination work queue → G2.3
- B6 CLI/MCP degraded-mode → G10
- B7 runtime-generation continuity → G0, G10
- B8 final decision packet → composite coverage via all gates

**Vector lifecycle and quality (from Round 18 Q2):**
- Vector availability reporting → G0 contract must report semantic/vector readiness
- Vector degraded state → G0 must distinguish unavailable/degraded/ready
- Retrieval lane identification → Search results must identify lexical vs semantic lanes
- Fallback transparency → Silent fallback from semantic to lexical counts as failure

**Execution order for deterministic closure:**
G0 → G1.1 → G1.2 → G1.3 → G2.1 → G2.2 → G2.3 → G3.1 → G3.2 → G3.3 → G4 → G5 → G6 → G7 → G8 → G9 → G10 → G11 → G12

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

**Private deployment boundary:** The repository owner operates locally with full admin privileges — Tauri app, CLI access, indexing control, database access, and source code. All other consumers are fresh users accessing knowledge exclusively through MCP client-module requests. These external users have NO local CLI, NO source code, NO database access, and NO UI assumptions. Gates must work from either side of this boundary, with MCP availability probed explicitly (G10).

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
- Respect the private deployment boundary: owner-local usage (Tauri/CLI/indexing) provides admin evidence; external users operate MCP-only with no local CLI/source/database/UI assumptions.

## Gate G0 — Contract Identity

Run `capabilities --json` and verify:

1. `buildId` is non-empty string
2. `capabilityHash` is non-empty string
3. `schemaVersion` is numeric
4. `contractVersion` is string "2"
5. Vector/semantic capability reporting (if present):
   - If `semanticSearch` or `vectorSearch` capability exists, record its status: `unavailable`, `degraded`, or `ready`
   - If ready/degraded, record: active model/space, dimensions, ready chunk/vector counts if exposed
   - If unavailable, confirm capability explicitly states unavailability rather than silently omitting it

Record exact values. Exit if any required field missing. Vector unavailability is acceptable if honestly reported; silent omission or false "ready" when unusable fails this gate.

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

Assert: Response contains required focus/node field (check both `focus` and `node` field names as documented in current contract). The focus object must have `nodeId`, `title`, `kind`. First-hop relations must be present, either as `firstHopRelations` array OR as separate edge arrays (`callers`, `calls`, `renders`, `renderedBy`). At least one relation field must be non-empty to demonstrate connectivity. Record which field names are actually used by the current contract.

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

Continue page-by-page with the cursor from each response until `nextCursor` is null. Record every page number, cursor value, item count, and IDs. On the final page, assert `nextCursor` is null AND `truncated` is false (or `truncated` field is absent). If the endpoint returns no cursor at all (single-page result), record this as valid exhaustion with page count = 1.

REQUIRED: Record complete pagination evidence:
- Total pages traversed
- Item count per page
- Final page's truncated status
- Whether any IDs were repeated across pages

Passing this gate requires traversing to actual cursor null, not stopping at an arbitrary page limit.

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

Assert: Both commands exit with code 0. `freshness.status` (from either command) is one of ["fresh", "stale", "partial"]. `coverage.indexed` >= 0 (must be numeric). REQUIRED fields must be present; commands that fail or return incomplete data without structured errors fail this gate. Record not_proven if commands succeed but required fields are missing, with explicit evidence of what was unavailable.

## Gate G5 — Affected Analysis

```text
affected <file-from-G1.2> --repo FPMS-NT --json
```

Assert: Command exits with code 0. Response has `changed` array (may be empty), `impacted` array (may be empty), and `revision` object with `revisionId` field. If command fails with exit code != 0, record structured error code and mark gate as not_proven with evidence of unavailability. Empty arrays are acceptable only if the file genuinely has no changes/impacts; missing fields fail the gate.

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

Assert: Command exits with code 0. Response has `steps` array. If `steps` is non-empty, verify at least one step has `depth` 0 and `via` field (string or null). If command fails or returns no steps, record whether this is due to: (a) genuine no-flow-available, (b) command failure, or (c) missing required data. Failures without structured errors or endpoints with no discoverable flow must be recorded as not_proven with explicit evidence.

## Gate G8 — Callers and Callees

```text
callers node:<symbol-from-G1.1> --repo FPMS-NT --json
callees node:<symbol-from-G1.1> --repo FPMS-NT --json
```

Assert: Both commands exit with code 0. Both responses contain result arrays (field name may be `callers`/`callees` or `items`, depending on contract). Both responses have `revision` object. Empty arrays are acceptable (genuine no-callers/no-callees case). Command failures without structured errors fail this gate; record not_proven with explicit evidence if commands succeed but required fields are missing.

## Gate G9 — Deadcode Listing

```text
deadcode --repo FPMS-NT --limit 5 --json
```

Assert: Command exits with code 0 OR returns structured error indicating deadcode unavailable. If successful, response has `items` array and `proofStatus` field. The `proofStatus` must be "candidate" or "not_proven", NEVER "proven" (deadcode cannot be fully proven without runtime execution evidence). If command fails, record whether failure is due to: (a) feature unavailable, (b) repository has no deadcode candidates, or (c) command error. Mark not_proven with explicit evidence if command succeeds but proof status is missing or misleading.

## Gate G10 — MCP/CLI Parity

REQUIRED: First probe MCP availability with a real health check or connection test. Do NOT assume MCP is unavailable without evidence.

If MCP available, compare:

1. `knowledge_capabilities` vs `capabilities --json`
2. `knowledge_search` vs `search --json`
3. `knowledge_context` vs `context --json`

Assert: `buildId`, `capabilityHash`, `schemaVersion`, `contractVersion` match across surfaces. Node IDs from equivalent queries must match. Record any field-level discrepancies.

If MCP unavailable AFTER a real connection probe, record explicit N/A evidence: "N/A: MCP server connection failed with [exact error/status]". Silent assumption of unavailability without probe fails this gate.

## Gate G11 — Evidence Provenance

From G1.3 context response, find at least one relation (from `firstHopRelations` array OR from edge arrays like `callers`/`calls`/etc.). 

For at least one relation, assert presence of provenance metadata:
- Edge type/kind (string indicating relation type)
- Evidence state/confidence (one of: "proven", "candidate", "inferred", "not_proven", or equivalent)
- Source attribution (repository ID, file path, or location evidence)

Additionally, check response-level provenance:
- `revision` or `trust` object with schema version, indexed commit, or revision ID
- Repository scope preservation

If relations exist but lack provenance metadata, record not_proven with explicit evidence. If no relations exist, record whether this is genuine isolation or missing data.

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

- G0–G12 all pass with required evidence
- Every dynamic ID from current session only
- No answer keys, no source reading, no git operations
- Deterministic target selection enforced (G12)
- G2.3 cursor exhaustion proven with page-by-page traversal
- G2.1, G2.2, G2.3, G5, G6, G7, G8, G9, G11 fail when required upstream data missing (no skip-as-pass paths)
- MCP marked N/A only after real availability probe with explicit evidence (G10)
- Retained benchmark inventory coverage verified (see "Retained benchmark inventory" section above)
- Private deployment boundary documented and respected (owner-local admin vs MCP-only consumers)
- No commands/gates pass on missing required data without explicit not_proven evidence

## Required Round19RunHeader fields

Final report must include complete `Round19RunHeader` with all timing, revision, build, and session metadata.
