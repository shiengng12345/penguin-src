# Full-Stack Graph Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link frontend gRPC-web consumers (starting with casino-plus web's `SkinFragment` service) into the knowledge graph as `invokes` edges to the existing global gRPC endpoint nodes, so a full-stack trace (frontend call site → endpoint → backend handler) exists.

**Architecture:** A new per-file extractor detects the frontend dispatcher call `WebServices.requestApi({ service: <ENUM>, method: '<literal>' })`, resolves the service enum to a proto service name via a per-repo config, and (in the pipeline) emits a branch-less `invokes` edge to the SAME global endpoint node `grpc::<Service>.<method.toLowerCase()>` that backend `@GrpcMethod` handlers already register — but ONLY when that endpoint node already exists (confirmed-only / identity proof). A wrapper-forwarding check validates the 1:1 assumption. Frontend edges are tagged `source_type: frontend_web`.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), better-sqlite3, web-tree-sitter (existing), Node test runner (`node --test`, `.mjs` tests as in `tests/`).

## Global Constraints

- Global gRPC endpoint node identity is exactly `grpc::${service}.${method.toLowerCase()}` via `grpcEndpointKey(service, method)` in `packages/knowledge-indexer/src/grpc-client.ts`. Reuse it verbatim — do NOT re-implement normalization.
- Cross-service edges to a global (repo-less) endpoint MUST be persisted branch-less (`branchless: true`) so branch-scoped traversal crosses service boundaries.
- Confirmed-only: a frontend edge is emitted ONLY if the target endpoint node already exists (do NOT `upsertNode` to create it from the frontend side). Missing endpoint → drop, no edge.
- Frontend edges carry `sourceType: "frontend_web"` (or `"frontend_mobile"`), persisted inside the edge `provenance` JSON (no schema migration).
- ESM: all local imports use `.js` specifiers even for `.ts` files.
- MVP scope: casino-plus web, `SkinFragment` service only. `casino-plus-app` (native) is NOT wired in this plan (inspect-only, deferred).

---

### Task 1: Per-repo frontend gRPC config (type + loader)

**Files:**
- Create: `packages/knowledge-indexer/src/frontend-grpc-config.ts`
- Test: `tests/frontend-grpc-config.test.mjs`

**Interfaces:**
- Produces:
  - `interface FrontendGrpcConfig { dispatcher: string; serviceEnumMap: Record<string, string> }`
  - `function loadFrontendGrpcConfig(repoRoot: string): FrontendGrpcConfig | null`

`dispatcher` is the call name whose object arg carries `{service, method}` (e.g. `"requestApi"`). `serviceEnumMap` maps a fully-qualified enum member as written at the call site (e.g. `"NT_SERVICE_INTERFACE.SKINFRAGMENT"`) to the proto service name (e.g. `"SkinFragment"`). Config lives at `<repoRoot>/.penguin-frontend-grpc.json`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend-grpc-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFrontendGrpcConfig } from "../packages/knowledge-indexer/dist/frontend-grpc-config.js";

test("loads config when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "fgc-"));
  writeFileSync(join(dir, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
  }));
  const cfg = loadFrontendGrpcConfig(dir);
  assert.equal(cfg.dispatcher, "requestApi");
  assert.equal(cfg.serviceEnumMap["NT_SERVICE_INTERFACE.SKINFRAGMENT"], "SkinFragment");
});

test("returns null when absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "fgc-"));
  assert.equal(loadFrontendGrpcConfig(dir), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-config.test.mjs`
Expected: FAIL — module `dist/frontend-grpc-config.js` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/knowledge-indexer/src/frontend-grpc-config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrontendGrpcConfig {
  /** dispatcher call name whose object arg carries {service, method} (e.g. "requestApi") */
  dispatcher: string;
  /** enum member as written at the call site → proto service name.
   *  e.g. "NT_SERVICE_INTERFACE.SKINFRAGMENT" → "SkinFragment" */
  serviceEnumMap: Record<string, string>;
}

export function loadFrontendGrpcConfig(repoRoot: string): FrontendGrpcConfig | null {
  try {
    const raw = readFileSync(join(repoRoot, ".penguin-frontend-grpc.json"), "utf8");
    const parsed = JSON.parse(raw) as Partial<FrontendGrpcConfig>;
    if (!parsed.dispatcher || typeof parsed.serviceEnumMap !== "object" || !parsed.serviceEnumMap) {
      return null;
    }
    return { dispatcher: parsed.dispatcher, serviceEnumMap: parsed.serviceEnumMap };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-config.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/frontend-grpc-config.ts tests/frontend-grpc-config.test.mjs
git commit -m "feat(knowledge): per-repo frontend gRPC config loader"
```

---

### Task 2: Frontend call-site extractor

**Files:**
- Create: `packages/knowledge-indexer/src/frontend-grpc-client.ts`
- Test: `tests/frontend-grpc-client.test.mjs`

**Interfaces:**
- Consumes: `FrontendGrpcConfig` from Task 1.
- Produces:
  - `interface FrontendGrpcCall { service: string; method: string; startLine: number; enclosingQualifiedName: string | null }`
  - `function extractFrontendGrpcCalls(source: string, config: FrontendGrpcConfig): FrontendGrpcCall[]`

`service` is the RESOLVED proto service (post `serviceEnumMap`). Calls whose enum is not in the map, or whose method is not a string literal, are skipped (no guessing). `enclosingQualifiedName` is left `null` here (filled by extract.ts, mirroring `GrpcClientCall`).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend-grpc-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFrontendGrpcCalls } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

const CONFIG = { dispatcher: "requestApi", serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" } };

test("extracts a resolved requestApi call", () => {
  const src = `
    const res = await WebServices.requestApi({
      service: NT_SERVICE_INTERFACE.SKINFRAGMENT,
      method: 'claimDailyFragment',
      body: {},
    })`;
  const calls = extractFrontendGrpcCalls(src, CONFIG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "SkinFragment");
  assert.equal(calls[0].method, "claimDailyFragment");
});

test("skips unmapped service enum", () => {
  const src = `WebServices.requestApi({ service: NT_SERVICE_INTERFACE.OTHER, method: 'x' })`;
  assert.equal(extractFrontendGrpcCalls(src, CONFIG).length, 0);
});

test("skips computed (non-literal) method", () => {
  const src = `WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, method: someVar })`;
  assert.equal(extractFrontendGrpcCalls(src, CONFIG).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-client.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Model the regex approach on the existing `grpc-js-client.ts`.

```typescript
// packages/knowledge-indexer/src/frontend-grpc-client.ts
import type { FrontendGrpcConfig } from "./frontend-grpc-config.js";

export interface FrontendGrpcCall {
  /** resolved proto service name (post serviceEnumMap) */
  service: string;
  /** method name as written at the call site (camelCase) */
  method: string;
  startLine: number;
  /** filled by extract.ts, mirroring GrpcClientCall */
  enclosingQualifiedName: string | null;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

export function extractFrontendGrpcCalls(source: string, config: FrontendGrpcConfig): FrontendGrpcCall[] {
  const calls: FrontendGrpcCall[] = [];
  // Match: <dispatcher>({ ... service: <ENUM.MEMBER> ... method: '<literal>' ... })
  // The object body is matched non-greedily; service/method may appear in any order.
  const callRe = new RegExp(`\\b${config.dispatcher}\\s*\\(\\s*\\{([\\s\\S]*?)\\}`, "g");
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const body = m[1];
    const svcMatch = /\bservice\s*:\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)/.exec(body);
    const methodMatch = /\bmethod\s*:\s*['"](\w+)['"]/.exec(body);
    if (!svcMatch || !methodMatch) continue; // computed method or missing service → skip
    const resolved = config.serviceEnumMap[svcMatch[1]];
    if (!resolved) continue; // unmapped enum → skip, no guessing
    calls.push({
      service: resolved,
      method: methodMatch[1],
      startLine: lineOf(source, m.index),
      enclosingQualifiedName: null,
    });
  }
  return calls;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-client.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/frontend-grpc-client.ts tests/frontend-grpc-client.test.mjs
git commit -m "feat(knowledge): frontend requestApi call-site extractor"
```

---

### Task 3: Wrapper 1:1 forwarding verifier

**Files:**
- Modify: `packages/knowledge-indexer/src/frontend-grpc-client.ts`
- Test: `tests/frontend-grpc-wrapper.test.mjs`

**Interfaces:**
- Produces: `function verifiedForwardingMethods(source: string): Set<string>` — the set of method names in a wrapper class that forward 1:1 to `this._net.<sameName>(...)`. Used to validate that a frontend method name actually maps to that proto RPC (rejects rename/batch/transform).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend-grpc-wrapper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedForwardingMethods } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

test("collects 1:1 forwarding methods, rejects renamed", () => {
  const src = `
    class NtSkinFragmentService {
      static claimDailyFragment = (r) => this._net.claimDailyFragment(r)
      static getInviteLink = async (r) => { return this._net.getInviteLink(r) }
      static renamed = (r) => this._net.somethingElse(r)
      static batched = (r) => { this._net.a(r); return this._net.b(r) }
    }`;
  const s = verifiedForwardingMethods(src);
  assert.ok(s.has("claimDailyFragment"));
  assert.ok(s.has("getInviteLink"));
  assert.ok(!s.has("renamed"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-wrapper.test.mjs`
Expected: FAIL — `verifiedForwardingMethods` not exported.

- [ ] **Step 3: Write minimal implementation (append to frontend-grpc-client.ts)**

```typescript
// A wrapper method forwards 1:1 iff its body calls this._net.<sameName>(...).
// Matches: `static <name> = (...) => this._net.<name>(` and
//          `static <name> = async (...) => { ... return this._net.<name>( }`
export function verifiedForwardingMethods(source: string): Set<string> {
  const out = new Set<string>();
  const declRe = /\bstatic\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>\s*(\{[\s\S]*?\n\s*\}|[^\n;]+)/g;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    const name = m[1];
    const body = m[2];
    const fwd = new RegExp(`this\\._net\\.${name}\\s*\\(`);
    if (fwd.test(body)) out.add(name);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-wrapper.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/frontend-grpc-client.ts tests/frontend-grpc-wrapper.test.mjs
git commit -m "feat(knowledge): wrapper 1:1 forwarding verifier"
```

---

### Task 4: Thread frontend calls through extract.ts

**Files:**
- Modify: `packages/knowledge-indexer/src/extract.ts` (interface `ExtractedFile`; `extractSymbols` input + body)
- Test: `tests/extract-frontend.test.mjs`

**Interfaces:**
- Consumes: `extractFrontendGrpcCalls`, `FrontendGrpcConfig`.
- Produces: `ExtractedFile.frontendGrpcCalls: FrontendGrpcCall[]`; `extractSymbols` input gains `frontendGrpcConfig?: FrontendGrpcConfig`. Each call's `enclosingQualifiedName` is attributed to the innermost containing symbol (same algorithm as `grpcClientCalls`).

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extract-frontend.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols } from "../packages/knowledge-indexer/dist/extract.js";

test("frontend call attributed to enclosing function", async () => {
  const source = `
    export function useSkinFragment() {
      async function claim() {
        return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, method: 'claimDailyFragment' })
      }
      return { claim }
    }`;
  const out = await extractSymbols({
    lang: "tsx", source, relPath: "libs/pages/skin-fragment/vm.tsx",
    frontendGrpcConfig: { dispatcher: "requestApi", serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" } },
  });
  assert.equal(out.frontendGrpcCalls.length, 1);
  assert.equal(out.frontendGrpcCalls[0].service, "SkinFragment");
  assert.ok(out.frontendGrpcCalls[0].enclosingQualifiedName?.endsWith("claim"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/extract-frontend.test.mjs`
Expected: FAIL — `frontendGrpcCalls` undefined.

- [ ] **Step 3: Implement — modify `extract.ts`**

3a. Add the import near the other extractor imports (top of file):

```typescript
import { extractFrontendGrpcCalls, type FrontendGrpcCall } from "./frontend-grpc-client.js";
import type { FrontendGrpcConfig } from "./frontend-grpc-config.js";
```

3b. Add the field to `ExtractedFile` (after `grpcClientCalls`):

```typescript
  frontendGrpcCalls: FrontendGrpcCall[]; // frontend gRPC-web consumer calls (ts/tsx)
```

3c. Add to the `base` object literal in `extractSymbols` (mirror `grpcClientCalls: []`):

```typescript
  const base: ExtractedFile = { lang, symbols: [], refs: [], fileImports: [], endpoints: [], grpcClientCalls: [], frontendGrpcCalls: [], parseError: null };
```

3d. Add the input param to the `extractSymbols` input type (next to `relPath?`):

```typescript
  frontendGrpcConfig?: FrontendGrpcConfig;
```

3e. After the existing `grpcClientCalls` attribution block (the loop that sets `gc.enclosingQualifiedName`), add:

```typescript
  const frontendGrpcCalls = isTs && input.frontendGrpcConfig
    ? extractFrontendGrpcCalls(input.source, input.frontendGrpcConfig)
    : [];
  for (const fc of frontendGrpcCalls) {
    let best: ExtractedSymbol | null = null;
    for (const sym of symbols) {
      if (sym.startLine <= fc.startLine && fc.startLine <= sym.endLine) {
        if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
      }
    }
    fc.enclosingQualifiedName = best ? best.qualifiedName : null;
  }
```

3f. Add `frontendGrpcCalls` to the final `return { ... }` of `extractSymbols`:

```typescript
  return { lang, symbols, refs, fileImports, endpoints, grpcClientCalls, frontendGrpcCalls, parseError: null };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/extract-frontend.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/extract.ts tests/extract-frontend.test.mjs
git commit -m "feat(knowledge): thread frontend gRPC calls through extractSymbols"
```

---

### Task 5: Store — sourceType on edges + node lookup by identity

**Files:**
- Modify: `packages/knowledge-core/src/store.ts` (`ParsedEdge`; edge insert in `replaceFileEdges`; add `findNodeIdByIdentity`)
- Test: `tests/store-source-type.test.mjs`

**Interfaces:**
- Produces:
  - `ParsedEdge.sourceType?: string` — persisted inside the edge `provenance` JSON as `{ ...existing, sourceType }`.
  - `KnowledgeStore.findNodeIdByIdentity(identityKey: string): string | null` — returns an existing node id (any node_type) or null. Used by the pipeline for confirmed-only stitching.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/store-source-type.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("findNodeIdByIdentity returns id or null", () => {
  const store = new KnowledgeStore(":memory:");
  const id = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "x" });
  assert.equal(store.findNodeIdByIdentity("grpc::SkinFragment.claimdailyfragment"), id);
  assert.equal(store.findNodeIdByIdentity("grpc::Nope.nope"), null);
});
```

> Note: verify the `KnowledgeStore` constructor/exports match existing tests in `tests/` (e.g. `tests/wiki-page.test.mjs`); adjust the import/instantiation to the existing convention if it differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && node --test tests/store-source-type.test.mjs`
Expected: FAIL — `findNodeIdByIdentity` is not a function.

- [ ] **Step 3: Implement — modify `store.ts`**

3a. Add to `ParsedEdge` (after `branchless?`):

```typescript
  /** Provenance tag for cross-layer edges, e.g. "frontend_web" | "frontend_mobile".
   *  Persisted inside the edge provenance JSON, not a column. */
  sourceType?: string;
```

3b. Add the public method (near `getNode`, around line 169):

```typescript
  findNodeIdByIdentity(identityKey: string): string | null {
    const row = this.db.prepare("SELECT id FROM nodes WHERE identity_key = ?").get(identityKey) as { id: string } | undefined;
    return row?.id ?? null;
  }
```

3c. In `replaceFileEdges`, where each edge's `provenance` value is built for the INSERT (around line 639-653), fold `sourceType` into the provenance JSON. If provenance is currently `JSON.stringify({...})`, extend it:

```typescript
        // provenance column value for edge e:
        JSON.stringify({ origin: e.origin, method: e.method, ...(e.sourceType ? { sourceType: e.sourceType } : {}) }),
```

> If `replaceFileEdges` already writes a provenance object, add `...(e.sourceType ? { sourceType: e.sourceType } : {})` to that existing object literal rather than replacing it. Match the existing shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && node --test tests/store-source-type.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/store.ts tests/store-source-type.test.mjs
git commit -m "feat(knowledge): edge sourceType + findNodeIdByIdentity"
```

---

### Task 6: Pipeline stitch — confirmed-only frontend `invokes` edges

**Files:**
- Modify: `packages/knowledge-indexer/src/pipeline.ts` (load config in `indexRepo`; stitch loop next to the `grpcClientCalls` block ~line 298; pass config into `extractSymbols`)
- Test: `tests/pipeline-fullstack.test.mjs` (golden trace)

**Interfaces:**
- Consumes: `ExtractedFile.frontendGrpcCalls` (Task 4), `store.findNodeIdByIdentity` (Task 5), `grpcEndpointKey` (existing), `loadFrontendGrpcConfig` (Task 1).
- Produces: for each frontend call whose endpoint node EXISTS, one edge `{ src: <frontend symbol>, dst: <endpoint id>, edgeType: "invokes", branchless: true, sourceType: "frontend_web" }`.

- [ ] **Step 1: Write the failing test (golden trace)**

```javascript
// tests/pipeline-fullstack.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { indexRepo } from "../packages/knowledge-indexer/dist/pipeline.js";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { grpcEndpointKey } from "../packages/knowledge-indexer/dist/grpc-client.js";

test("golden trace: frontend claimDailyFragment invokes the SkinFragment endpoint", async () => {
  const store = new KnowledgeStore(":memory:");
  // 1. Seed the global endpoint node as a proto/backend index would (identity proof).
  const endpointId = store.upsertNode({
    nodeType: "endpoint",
    identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"),
    repoId: null, title: "SkinFragment.ClaimDailyFragment",
    meta: { protocol: "grpc", service: "SkinFragment", method: "ClaimDailyFragment" },
  });

  // 2. A casino-plus repo with config + a view-model call site.
  const repo = mkdtempSync(join(tmpdir(), "cp-"));
  writeFileSync(join(repo, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
  }));
  mkdirSync(join(repo, "vm"), { recursive: true });
  writeFileSync(join(repo, "vm", "vm.tsx"), `
    export function useSkinFragment() {
      async function claim() {
        return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, method: 'claimDailyFragment' })
      }
      return { claim }
    }`);

  await indexRepo({ store, repoId: "casino-plus", rootPath: repo, branchId: "main" });

  // 3. There must be an invokes edge into the endpoint tagged frontend_web.
  const edges = store.rawEdgesInto(endpointId); // see note below
  const fe = edges.find((e) => e.edge_type === "invokes" && (e.provenance ?? "").includes("frontend_web"));
  assert.ok(fe, "expected a frontend_web invokes edge into the endpoint");
});

test("no endpoint node → no frontend edge (confirmed-only)", async () => {
  const store = new KnowledgeStore(":memory:");
  const repo = mkdtempSync(join(tmpdir(), "cp2-"));
  writeFileSync(join(repo, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi", serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
  }));
  writeFileSync(join(repo, "vm.tsx"), `export function f(){ return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, method: 'claimDailyFragment' }) }`);
  await indexRepo({ store, repoId: "cp2", rootPath: repo, branchId: "main" });
  assert.equal(store.findNodeIdByIdentity(grpcEndpointKey("SkinFragment", "ClaimDailyFragment")), null);
});
```

> Note: `indexRepo`'s exact option names (`store`/`repoId`/`rootPath`/`branchId`) and a raw-edge accessor must match the current code. Before writing the stitch, read `indexRepo`'s signature and how existing tests query edges; if there is no `rawEdgesInto`, add a tiny read helper on the store (`rawEdgesInto(dst): {edge_type,provenance}[]`) in Task 5's style, or reuse an existing edge-query method. Adjust the test to the real API.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && node --test tests/pipeline-fullstack.test.mjs`
Expected: FAIL — no frontend edge emitted.

- [ ] **Step 3: Implement — modify `pipeline.ts`**

3a. Import the config loader (top of file):

```typescript
import { loadFrontendGrpcConfig } from "./frontend-grpc-config.js";
```

3b. In `indexRepo`, load the config once (near where `rootPath`/repo setup happens, before the per-file loop):

```typescript
  const frontendGrpcConfig = loadFrontendGrpcConfig(rootPath);
```

3c. Where `extractSymbols(...)` is called in the per-file path (currently passing `relPath`), pass the config too:

```typescript
    frontendGrpcConfig,
```

3d. Immediately AFTER the existing consumer-side `grpcClientCalls` stitch loop (the `for (const gc of extracted.grpcClientCalls) { ... }` block ~line 298-309), add the confirmed-only frontend stitch:

```typescript
    // frontend gRPC-web consumers → 'invokes' the SAME global endpoint, but ONLY
    // when that endpoint already exists (confirmed-only / identity proof). Tagged
    // source_type so full-stack views can filter frontend fan-in.
    for (const fc of extracted.frontendGrpcCalls) {
      if (!fc.enclosingQualifiedName) continue;
      const src = fileSymbolIds.get(fc.enclosingQualifiedName);
      if (!src) continue;
      const endpointId = store.findNodeIdByIdentity(grpcEndpointKey(fc.service, fc.method));
      if (!endpointId) continue; // no endpoint → drop, no phantom edge
      structural.push({ src, dst: endpointId, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true, sourceType: "frontend_web" });
    }
```

> `fileSymbolIds` and `structural` are the same locals the `grpcClientCalls` block uses — reuse them verbatim. Read lines ~296-309 first and mirror the exact variable names.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && node --test tests/pipeline-fullstack.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full indexer test suite (no regressions)**

Run: `node --test tests/`
Expected: PASS (existing tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add packages/knowledge-indexer/src/pipeline.ts tests/pipeline-fullstack.test.mjs
git commit -m "feat(knowledge): confirmed-only frontend->endpoint stitch (full-stack graph linking)"
```

---

### Task 7: Real config for casino-plus + manual golden-trace verification

**Files:**
- Create: `/Users/shieng/Desktop/Projects/casino-plus/.penguin-frontend-grpc.json`

**Interfaces:**
- Consumes: everything above. No new code — this is the real-repo config + a manual end-to-end check.

- [ ] **Step 1: Write the casino-plus config**

```json
{
  "dispatcher": "requestApi",
  "serviceEnumMap": {
    "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment"
  }
}
```

Path: `/Users/shieng/Desktop/Projects/casino-plus/.penguin-frontend-grpc.json`

- [ ] **Step 2: Confirm the SkinFragment wrapper is 1:1 (validation)**

Run:
```bash
node -e "const {verifiedForwardingMethods}=require('/Users/shieng/Desktop/Pengvi/packages/knowledge-indexer/dist/frontend-grpc-client.js'); const fs=require('fs'); const s=fs.readFileSync('/Users/shieng/Desktop/Projects/casino-plus/libs/web-service/src/lib/services/nt-skin-fragment-service.ts','utf8'); console.log([...verifiedForwardingMethods(s)])"
```
Expected: prints the 9 method names (claimDailyFragment, getActivityStatus, getInviteLink, bindInvite, settlePendingInvites, createGiftLink, claimGift, precheckCompleteIp, submitAddressAndRedeem). If any is missing, the wrapper is not 1:1 for that method — do not trust its edge; record the discrepancy.

- [ ] **Step 3: Re-index casino-plus + flyover and verify the edge exists**

Re-index via the app/CLI as usual (both flyover, for the endpoint node, and casino-plus). Then verify with a graph query that `grpc::SkinFragment.claimdailyfragment` has an incoming `invokes` edge tagged `frontend_web` from the casino-plus view-model symbol.

Expected: the full-stack trace resolves: casino-plus `claim` (or enclosing view-model symbol) → `grpc::SkinFragment.claimdailyfragment` ← FPMS-NT handler.

- [ ] **Step 4: Commit the config**

```bash
cd /Users/shieng/Desktop/Projects/casino-plus
git add .penguin-frontend-grpc.json
git commit -m "chore: penguin frontend gRPC config (SkinFragment)"
```

> This commit lands in the casino-plus repo, not Pengvi. Confirm with the user before committing to an external repo.

---

## Self-Review

**1. Spec coverage** (against `2026-07-11-fullstack-graph-linking-design.md`):
- §1 Composite detection (consumption + identity + wrapper validation) → Tasks 2 (call-site consumption), 3 (wrapper 1:1), 6 (identity via `findNodeIdByIdentity`). ✓
- §2 Proto-qualified stitching via `grpcEndpointKey` + explicit enum→service map → Tasks 1 (map), 6 (key reuse). ✓
- §3 Per-repo dispatcher config → Task 1. ✓
- §4 Confirmed-only + `source_type` tag → Task 5 (sourceType), Task 6 (endpoint-exists gate, tag). ✓
- §5 Edge provenance → Task 5 (provenance JSON with sourceType) + Task 6 (src/endpoint/method captured). Partial: full provenance record (repo/file) relies on the existing edge/symbol rows; adequate for MVP. ✓
- MVP golden trace (SkinFragment.claimDailyFragment) → Tasks 6, 7. ✓
- casino-plus-app deferred → not in plan (matches spec). ✓

**2. Placeholder scan:** No TBD/TODO in code steps; every code step shows code. Two explicit "verify against existing API" notes (Task 5 import convention, Task 6 `indexRepo` signature / edge accessor) are grounded instructions to match real code, not placeholders — the implementer reads the neighbouring block and mirrors it. Acceptable but flagged.

**3. Type consistency:** `FrontendGrpcConfig`, `FrontendGrpcCall`, `frontendGrpcCalls`, `frontendGrpcConfig`, `verifiedForwardingMethods`, `findNodeIdByIdentity`, `sourceType`, `grpcEndpointKey` used consistently across tasks. Edge shape matches existing `structural.push({...})` calls in pipeline.ts. ✓

**Known risk to confirm during execution:** the exact locals in `pipeline.ts` (`fileSymbolIds`, `structural`, the `extractSymbols` call site) and `replaceFileEdges` provenance shape — Tasks 5/6 instruct the implementer to read the adjacent verbatim block first. `indexRepo` option names in the Task 6 test must be reconciled with the real signature before running.
