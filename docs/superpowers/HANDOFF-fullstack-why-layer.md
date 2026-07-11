# Handoff — Full-Stack Graph Linking + Wiki WHY Layer

Date: 2026-07-11 · Branch: `feature/knowledge-core`
Audience: an engineer new to this codebase. This is the single entry point.
Read this top-to-bottom, then open the referenced spec/plan for the phase you execute.

---

## 0. TL;DR

We are adding two things to the Pengvi knowledge graph (a SQLite graph of every
symbol/edge across the FPMS microservices + frontends):

1. **Spec A — Full-Stack Graph Linking.** Today the graph connects backend
   services via gRPC. It does NOT see the frontends. Spec A links the frontend
   repos (starting with `casino-plus` web) into the graph as consumers, so a
   single trace runs **frontend call → gRPC endpoint → backend handler**.
2. **Spec B — Wiki WHY Layer.** The graph tells you *what connects to what*, never
   *why*. Spec B adds `penguin why`: a command that generates evidence-grounded
   "WHY cards" for each cross-service endpoint and shows them in the Wiki.

**Build order: Spec A first (it produces the full-stack edges Spec B's cards hang on).**

**Status:** design + plan for both are written, reviewed (Codex + DeepSeek,
2 rounds each), and corrected. No implementation code yet. Your job is to execute
the plans task-by-task (TDD).

---

## 1. The four documents

| # | Document | What it is |
|---|----------|-----------|
| A-spec | `docs/superpowers/specs/2026-07-11-fullstack-graph-linking-design.md` | Why/what of full-stack linking |
| A-plan | `docs/superpowers/plans/2026-07-11-fullstack-graph-linking.md` | 8 TDD tasks, exact code |
| B-spec | `docs/superpowers/specs/2026-07-11-wiki-why-layer-design.md` | Why/what of the WHY layer |
| B-plan | `docs/superpowers/plans/2026-07-11-wiki-why-layer.md` | 7 TDD tasks, MVP (no PRD) |

The plans are the source of truth for *how*. This handoff is the map + the
gotchas so you don't repeat mistakes we already found and fixed in review.

---

## 2. Glossary (know these before you start)

- **global endpoint node** — a graph node for a gRPC method, identity
  `grpc::<Service>.<method_lowercased>`, `repo_id = NULL`, `branch_id = NULL`.
  Both the backend handler (`handles` edge) and consumers (`invokes` edge) attach
  to this ONE shared node — that's how cross-repo linking works.
- **`grpcEndpointKey(service, method)`** — the function (in
  `packages/knowledge-indexer/src/grpc-client.ts`) that builds that identity.
  It lowercases the method, so frontend `claimDailyFragment` and proto
  `ClaimDailyFragment` collapse to the same key. **Reuse it; never re-implement.**
- **branch-less edge** (`branchless: true`) — an edge with `branch_id = NULL`.
  Cross-service edges MUST be branch-less (each microservice is indexed on a
  different branch; a branch-scoped edge wouldn't cross the boundary).
- **contract** — the whole span of a cross-service call: consumer edge(s) +
  endpoint node + handler edge. This is the SUBJECT of a WHY card.
- **WHY card** — an endpoint-bound explanation made of **claims**.
- **claim** — one statement with a `kind` (fact/inference/evidence/gap), a
  `source_type`, a `verification_state`, cited `evidence_ids`, and a confidence.
  Stored in the new `why_claims` table (NOT in note frontmatter).

---

## 3. Environment & prerequisites

- Monorepo: `packages/knowledge-core` (deterministic graph + SQLite store),
  `packages/knowledge-indexer` (parses repos into the graph),
  `packages/knowledge-cli` (`penguin` CLI, incl. the BYOK AI layer),
  `packages/mcp` (MCP tools), `src/` (Tauri React app + Wiki UI).
- Build a package: `pnpm -C packages/<name> build`
- Run a test: `node --test tests/<file>.test.mjs` (tests are `.mjs`, import from
  each package's `dist/` — so **build before testing**).
- ESM everywhere: local imports use `.js` specifiers even from `.ts`.
- The WHY layer's LLM call is BYOK: set `DEEPSEEK_API_KEY` (default provider) or
  `OPENAI_API_KEY` + `PENGUIN_AI_PROVIDER=openai`. Tests use an injected stub — no
  network — so you can build the whole thing without a key; you only need a key
  for the manual end-to-end verification.
- The real repos being indexed live under `/Users/shieng/Desktop/Projects/`
  (`casino-plus`, `fly` = flyover protos, `fpmsnt`, etc.).

---

## 4. Spec A — Full-Stack Graph Linking (build this first)

**Goal:** emit a frontend `invokes` edge from a casino-plus call site to the
global endpoint node, gated so it is never wrong.

**The real frontend call shape (verified — do NOT trust the word `method`):**
```ts
WebServices.requestApi({
  service: NT_SERVICE_INTERFACE.SKINFRAGMENT,   // enum → proto service via config
  functionName: 'claimDailyFragment',           // the RPC name (camelCase)
  requestParam: { ... },
})
```
A thin wrapper `NtSkinFragmentService.claimDailyFragment` forwards 1:1 to
`this._net.claimDailyFragment(...)`. The real gRPC-web client is codegen in
`node_modules` (which the indexer ignores) — so we match on the call site +
proto identity, and use the wrapper only to VALIDATE.

**8 TDD tasks (full code in A-plan):**
1. `frontend-grpc-config.ts` — load `.penguin-frontend-grpc.json` (`dispatcher`,
   `serviceEnumMap`, `wrappers`).
2. `frontend-grpc-client.ts` — **AST** extractor for `requestApi({service, functionName})`.
3. same file — **AST** wrapper verifier: method is verified only if its body is a
   SOLE forward to `this._net.<sameName>` (rejects batching/rename).
4. `extract.ts` — thread `frontendGrpcCalls` + `wrapperVerified` through.
5. `store.ts` + `schema.ts` — add `source_type` COLUMN, `pending_frontend_edges`
   table, `findNodeIdByIdentity`, enqueue/replay methods.
6. `pipeline.ts` — after the per-file loop: gate each call on wrapper-verified +
   endpoint-exists → emit `invokes` (branch-less, `source_type='frontend_web'`);
   if the endpoint doesn't exist yet, ENQUEUE and replay later (deferred re-stitch).
7. `query.ts` — expose `source_type` in the graph query (Wiki filtering).
8. Real `casino-plus/.penguin-frontend-grpc.json` + manual golden-trace verify.

**Definition of done (A):** re-indexing `flyover` + `casino-plus` in either order
leaves `grpc::SkinFragment.claimdailyfragment` with an incoming `invokes` edge
tagged `frontend_web` from the casino-plus view-model, and the FPMS handler still
`handles` it. All 8 tasks' tests green; `node --test tests/` shows no regressions.

---

## 5. Spec B — Wiki WHY Layer, MVP (build second; NO PRD in MVP)

**Goal:** `penguin why` generates a grounded WHY card per endpoint contract and
the Wiki shows it. MVP uses **graph + git + tests only — no PRD** (PRD is phase 2).

**How generation works:** reuse the EXISTING BYOK layer — `buildContextPack` +
`aiComplete` in `packages/knowledge-cli`. `penguin why` is a NEW CLI verb, NOT
part of the deterministic indexer, and does NOT use MCP `write_note`.

**Storage:** the card binds to the endpoint node; per-claim state lives in a NEW
queryable `why_claims` table (note frontmatter cannot hold nested claims).

**The guardrail (the single most important rule):** the LLM returns structured
JSON claims that cite `evidence_ids`. Every fact's evidence IDs must resolve to a
real artifact (a `handles`/`invokes`/`tests` edge). Unresolved → the claim is
demoted from `code_observed` fact to `ai_inferred`. A card with zero grounded
facts (or all below confidence 0.3) is NOT written. This is what stops the WHY
layer from becoming plausible-sounding hallucination.

**7 TDD tasks (full code in B-plan):**
1. `why_claims` table + store CRUD.
2. `whyTargets()` — endpoints that have a handler AND ≥1 consumer.
3. `why-card.ts` — parse LLM JSON + the grounding guardrail (pure, no I/O).
4. `why-evidence.ts` — deterministic evidence IDs for an endpoint.
5. `why.ts` + `index.ts` — the `penguin why` verb (injectable `complete` fn for tests).
6. `penguin why --check` — mark claims stale when their evidence edge disappears.
7. `WikiWhyPanel.tsx` — render facts (prominent) / inference (collapsed) / gaps +
   stale badge + confirm/reject.

**Definition of done (B):** `penguin why` on a real DB produces a card for
`SkinFragment.ClaimDailyFragment` whose FACTS cite the casino-plus consumer + FPMS
handler; the Wiki shows facts/inference/gaps separately; `penguin why --check`
flags a stale claim after the code changes. All 7 tasks' tests green (via stub LLM).

---

## 6. Critical decisions & gotchas (do NOT re-litigate — these came from review)

1. **Frontend call key is `functionName`, not `method`; payload is `requestParam`,
   not `body`.** (An earlier draft used `method` and would have matched zero real calls.)
2. **Use AST (web-tree-sitter), not regex,** for the frontend extractors — real
   code is multi-line/prettier-formatted. tree-sitter is already a dependency.
3. **Wrapper gate must be WIRED into the stitch** (build a per-repo
   `verifiedMethodsByService`; only emit an edge if the functionName is in it).
   1:1 = sole forward; mere presence of `this._net.<name>(` is NOT enough.
4. **Index-order safety = deferred re-stitch** (a `pending_frontend_edges` queue
   replayed when the endpoint appears). NOT a placeholder node (weakens
   confirmed-only), NOT a "index backend first" requirement (brittle).
5. **`source_type` is a COLUMN**, not JSON inside provenance (the Wiki filters on it).
6. **Confirmed-only:** never `upsertNode` an endpoint from the frontend side — if
   it's missing, enqueue; don't invent it.
7. **WHY MVP ships without PRD.** AC numbers collide across PRDs (there are 40+
   `AC-003`s in different features), proto AC comments cover only ~3-4 of 16 rpc,
   and matching needs human-confirmed bindings — all high-effort. Cards are useful
   without it. PRD = phase 2, feature/module-scoped.
8. **WHY generation lives in the CLI, reusing `aiComplete`/`buildContextPack`** —
   NOT in the indexer (which stays deterministic), NOT via MCP `write_note` (that
   only records ledger intent).
9. **WHY claims go in the `why_claims` table**, not note frontmatter (the parser
   only does flat key:value, and `content_hash` is only the markdown hash).
10. **Contract references = stable selectors (identity keys), never parser edge
    IDs** — parser edges are deleted+reinserted with random IDs on every re-index.

---

## 7. "Reconcile with the real code" checklist (both plans flag these)

Before finalizing the affected task, read the neighbouring verbatim code and match it:
- `pipeline.ts`: the exact locals in the per-file loop (`fileSymbolIds`, `structural`),
  the `extractSymbols` call site, and whether a frontend file's `replaceFileEdges`
  is called twice (it would wipe edges — merge instead).
- `store.ts`: the real `edges` INSERT column list; the store's timestamp convention
  (does it forbid `new Date()` in deterministic paths?); is `db` public?
- `index.ts` (CLI): the real `deps` object (openStore/storeExists/err/emit) and the
  per-verb store open/close convention — mirror an existing verb like `explain`.
- tree-sitter TS/TSX node type names (`pair`, `object`, `class_declaration`, static
  field) — print `root.toString()` on a fixture and confirm before trusting.
- `indexRepo` / `collectGraph` / `buildContextPack` signatures — confirm arg names.

When a plan step's code disagrees with the real code, the REAL CODE wins — adjust
the step and keep going.

---

## 8. Out of scope (don't build these now)

- casino-plus-app (React Native) linking — inspect its wrapper pattern first; not
  in Spec A MVP.
- PRD binding + AC coverage check — Spec B phase 2.
- Full diff-since-confirmed + background FACT-vs-graph discrepancy recompute —
  Spec B phase 1.5 (MVP does edge-presence staleness only).
- Indexing `node_modules` / the codegen gRPC-web SDK.
- Embedding/semantic matching.

---

## 9. Suggested working rhythm

1. Confirm the environment (build each package once, run the existing `tests/`
   suite green).
2. Execute A-plan tasks 1→8 in order, TDD (failing test → code → green → commit).
   Use `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
3. Manually verify A's golden trace on the real DB.
4. Execute B-plan tasks 1→7 the same way (stub LLM in tests — no key needed).
5. Manually verify B with a real `DEEPSEEK_API_KEY` on the real DB.
6. Report per-task: test output (proof), not just "done".
