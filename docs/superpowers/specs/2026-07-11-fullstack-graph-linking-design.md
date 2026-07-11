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
// call site (view-model)
WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT,
                         method: 'claimDailyFragment', body: {...} })
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

A frontend→endpoint edge is emitted ONLY when it has BOTH:
- **Consumption proof**: a `requestApi({ service: <ENUM>, method: '<literal>' })`
  call site with a STATICALLY RESOLVABLE service enum and a STRING-LITERAL method.
  A computed/dynamic method or an unresolved enum → NO edge.
- **Identity proof**: the resolved `<Service>.<Method>` matches a proto RPC in the
  flyover contract registry → binds to the existing global endpoint node.

Wrapper verification is a VALIDATION gate, not a source: the wrapper method must
forward to `this._net.<sameName>` (1:1). If the wrapper renames, batches, or
transforms, the 1:1 assumption is broken → refuse the edge (avoids linking a
frontend method to the wrong endpoint).

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

### 4. Confirmed-edges-only (value vs noise)

Store ONLY confirmed consumer edges (call site + resolved enum + method literal +
proto join). Do NOT create endpoint fan-in from wrapper-only or proto-only
evidence — that floods endpoint nodes with "possible calls".

- Tag every frontend edge with `source_type: frontend_web | frontend_mobile`.
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
- New edge: `frontend_invokes` (or reuse `invokes` with a `source_type` tag) from
  the frontend call-site symbol → global endpoint node. Branch-less so it crosses
  the repo/branch boundary like backend stitch edges.
- Edge carries provenance (§5) + `source_type`.

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
