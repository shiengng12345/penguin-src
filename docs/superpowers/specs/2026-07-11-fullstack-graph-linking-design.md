# Full-Stack Graph Linking — Design (Spec A)

Date: 2026-07-11
Status: Approved (brainstorm) — pending implementation plan
Branch: feature/knowledge-core
Relation: foundation for [WHY Layer spec, 2026-07-11]; the WHY layer consumes the
edges this spec produces.

## Problem

The knowledge graph stitches BACKEND cross-service gRPC edges: a consumer stub
`--invokes-->` a GLOBAL endpoint node (identity `grpc::Service.Method`,
`repo_id NULL`, `branch_id NULL`) `<--handles--` a server `@GrpcMethod` handler.
Backend client calls are detected from AST as `this.xService.method(...)`.

But the two FRONTEND repos that consume the SAME endpoints are invisible in the
graph. So "who actually consumes this endpoint" stops at the backend boundary —
the full-stack trace from a user-facing action to the handler does not exist.

- `casino-plus` — Nx React WEB SPA (multi-brand). Confirmed consumer.
- `casino-plus-app` — React Native mobile app. HYPOTHESIS until inspected.

## The frontend consumer pattern (real code — casino-plus)

Multi-hop indirection, NOT a direct `client.method()` call:

```
// call site (view-model) — VERIFIED against real casino-plus code:
//   the key is `functionName` (NOT `method`), the payload key is `requestParam`
//   (NOT `body`). requestApi signature = { service, functionName, requestParam }.
WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT,
                         functionName: 'claimDailyFragment', requestParam: {...} })
// -> dispatcher routes by the `service` enum to a thin wrapper class:
class NtSkinFragmentService {
  static claimDailyFragment = (r) => this._net.claimDailyFragment(r)   // forwards 1:1
  // ...9 methods, each forwards to this._net.<sameName>
}
// this._net = a codegen gRPC-web client `SkinFragment` from @snsoft/js-sdk
// (node_modules — NOT local source; the indexer ignores node_modules)
```

Three distinct signals, each proving a DIFFERENT thing (Codex):
- `requestApi({service, method:'X'})` call site → proves **actual consumption**.
- wrapper `this._net.<name>` forward → proves the **local RPC surface** (capability).
- flyover `.proto` → proves **endpoint identity** (`grpc::Service.Method`).

The wrapper method names map 1:1 to proto RPCs (`claimDailyFragment`,
`getActivityStatus`, `getInviteLink`, `bindInvite`, `settlePendingInvites`,
`createGiftLink`, `claimGift`, `precheckCompleteIp`, `submitAddressAndRedeem`).
The proto (repo `flyover`) is the contract source of truth; codegen publishes
`@snsoft/*-grpc-web`.

## Design

### 1. Composite detection (consumption + identity, both required)

Detection is AST-based (web-tree-sitter, already used for ts/tsx) — NOT regex.
Real call sites are prettier-formatted, multi-line, and carry a `requestParam`
object; regex silently misses/misfires on them.

A frontend→endpoint edge is emitted ONLY when it has ALL THREE:
- **Consumption proof**: a `requestApi({ service: <ENUM>, functionName: '<literal>' })`
  call site with a STATICALLY RESOLVABLE service enum and a STRING-LITERAL
  `functionName`. A computed/dynamic functionName or an unresolved enum → NO edge.
- **Identity proof**: the resolved `<Service>.<functionName>` matches an existing
  global endpoint node (`grpcEndpointKey`) — see index-order handling below.
- **Wrapper-verified gate**: `<functionName>` is in `verifiedMethodsByService[service]`,
  a per-repo pre-pass set of wrapper methods that forward 1:1 to
  `this._net.<sameName>`. This gate is WIRED INTO the stitch (not built-and-ignored).

Wrapper 1:1 verification: the wrapper method's body must be a SOLE forward to
`this._net.<sameName>(…)` — a lone arrow-return or a single-return block. If it
renames, batches (calls `_net` more than once), or transforms, the 1:1 assumption
is broken → the method is NOT verified → refuse the edge. Mere presence of
`this._net.<name>(` is insufficient (it would pass batching).

Ranked fallbacks if a signal is missing:
1. call-site + proto (strongest — real use + identity).
2. wrapper + proto (weaker — capability, valid only while 1:1 holds).
3. proto alone → NEVER an edge (contract ≠ proof of consumption).
4. codegen SDK surface → out of scope (node_modules ignored; availability ≠ use).

### 2. Stitching key — proto-qualified, registry aliases (no fuzzy match)

Join key is the canonical `grpc::<Service>.<Method>` derived from the flyover
proto (Service = proto service name, Method = PascalCase RPC), matched to the
backend global endpoint node.

Normalization uses REGISTRY ALIASES, not heuristic casefolding:
- proto `SkinFragment.ClaimDailyFragment` registers its generated camelCase alias
  `claimDailyFragment`.
- the dispatcher enum `NT_SERVICE_INTERFACE.SKINFRAGMENT` maps EXPLICITLY (per-repo
  config) to proto service `SkinFragment`.
- an ambiguous alias (a method name resolvable to >1 service) → NO edge.

### 3. Per-repo dispatcher config (MVP)

The dispatcher hides service resolution behind an enum. A small per-repo config
maps `NT_SERVICE_INTERFACE.*` → proto service names, and names the wrapper
classes / dispatcher entry (`WebServices.requestApi`). Detection = config +
proto registry + wrapper verification. Generic wrapper auto-detection (a class of
static methods forwarding to a `_net`-like field) is used only to VALIDATE, never
as the sole trigger.

### 4. Confirmed-edges-only + index-order handling (deferred re-stitch)

Store ONLY confirmed consumer edges (call site + resolved enum + functionName +
wrapper-verified + endpoint exists). Do NOT create endpoint fan-in from
wrapper-only or proto-only evidence — that floods endpoint nodes with "possible
calls".

**Index-order problem** (confirmed real): the backend consumer path `upsertNode`s
the endpoint (creates it), but the frontend path must NOT (confirmed-only). Proto
endpoints are also processed AFTER the per-file source loop. So a lookup-only
frontend stitch is order-sensitive: if the frontend repo is indexed before
flyover/backend, the endpoint node doesn't exist yet and the edge is silently
lost. **Fix = deferred re-stitch, NOT a placeholder node** (a placeholder would
weaken confirmed-only) and NOT a brittle index-order requirement: persist the
resolved-but-unmatched frontend candidate (`repo, file, src symbol, service,
functionName, sourceType`) in a `pending_frontend_edges` table; when an endpoint
node with that identity later appears (backend/proto index), replay the pending
candidate into a real edge. Idempotent; survives partial re-indexes.

- Tag every frontend edge with `source_type: frontend_web | frontend_mobile`,
  stored in a dedicated `source_type` COLUMN on edges (not buried in provenance
  JSON) so the Wiki can filter frontend fan-in efficiently. Existing backend edges
  default to NULL/`backend`. The graph query must select `source_type`.
- Default full-stack views cap representative callers per endpoint (a few per
  repo/platform), not the full fan-in.
- `casino-plus-app` edges are HYPOTHESIS until its wrapper pattern is inspected;
  do not assume symmetric fan-in.

### 5. Edge provenance rule

No high-confidence frontend edge without ALL of: repo, file, service enum, method
literal, wrapper-or-proto match, proto service/RPC, backend endpoint id,
confidence level. Missing any → lower confidence or no edge. This provenance is
also the evidence the WHY layer (Spec B) cites.

## Data model

- Reuse the existing global endpoint node (`grpc::Service.Method`, branch-less).
- New edge: reuse `invokes` with a `source_type` COLUMN (add the column via
  migration), from the frontend call-site symbol → global endpoint node.
  Branch-less so it crosses the repo/branch boundary like backend stitch edges.
- New table `pending_frontend_edges` for deferred re-stitch (§4).
- Edge carries provenance (§5) + `source_type` column.

## MVP — golden trace first

1. Build ONE end-to-end golden trace for `SkinFragment.claimDailyFragment`:
   frontend call site (casino-plus view-model `requestApi`) → wrapper
   (`NtSkinFragmentService.claimDailyFragment`) → proto RPC → backend global
   endpoint → FPMS-NT handler.
2. Implement ONLY edges that can reproduce that exact evidence shape.
3. Scope: casino-plus (web) SkinFragment service first; expand service-by-service.
4. casino-plus-app: inspect its wrapper pattern before emitting any edge.

## Failure modes / risks

- **Contract/version drift** (biggest): the frontend's installed
  `@snsoft/*-grpc-web` (node_modules), the flyover proto source, and the backend
  global endpoint can be out of sync. Mitigation: proto registry is the single
  identity source; edges that don't resolve against it are dropped, not guessed.
- **Wrapper not 1:1** (rename/batch/transform): refuse the edge (§1 validation).
- **Dynamic method string** / unresolved enum: no edge.
- **Generic shared method names** (`list`/`get`): ambiguous alias → no edge.

## Testing / verification

- The golden trace is the acceptance fixture: the pipeline must reproduce the
  full `claimDailyFragment` chain with correct provenance.
- For a sample of emitted frontend edges, verify each against source: the call
  site exists, the wrapper forwards 1:1, the proto RPC exists, the backend
  endpoint node matches. An edge whose provenance can't be reproduced is a bug.
- Regression: emitting an edge from proto-only or wrapper-only evidence is a
  failure (must stay confirmed-only).

## Out of scope (YAGNI)

- Indexing `node_modules` / the codegen SDK surface.
- Embedding/semantic matching of call sites to endpoints.
- Full fan-in materialization per endpoint (store confirmed, cap display).
- casino-plus-app beyond inspecting/confirming its wrapper pattern.
- The WHY cards themselves (Spec B).

## Open questions for the plan

- Exact per-repo config schema (enum→service map, wrapper/dispatcher names).
- Where the flyover proto registry is parsed from (local flyover checkout path).
- New edge type `frontend_invokes` vs `invokes` + `source_type` tag — pick one.
- How the frontend call-site symbol is identified as the edge `src` (the enclosing
  view-model function).
