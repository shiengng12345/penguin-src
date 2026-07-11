# Full-Stack Graph Linking Implementation Plan (v2 — post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link frontend gRPC-web consumers (casino-plus web's `SkinFragment` service first) into the graph as `invokes` edges to the existing global gRPC endpoint nodes, so a full-stack trace (frontend call site → endpoint → backend handler) exists.

**Architecture:** AST-based (web-tree-sitter) detection of the real call
`WebServices.requestApi({ service:<ENUM>, functionName:'<literal>' })`, resolved to
a proto service via a per-repo config. A per-repo pre-pass builds a set of
wrapper methods that forward 1:1 to `this._net.<sameName>`. The stitch runs AFTER
the per-file loop (like the existing proto pass): it emits a branch-less `invokes`
edge to the global endpoint node `grpc::<Service>.<functionName.toLowerCase()>`
ONLY when (a) the functionName is wrapper-verified for that service AND (b) the
endpoint node already exists. If the endpoint does not exist yet, the candidate is
queued in `pending_frontend_edges` and replayed when the endpoint later appears
(deferred re-stitch — no placeholder node, no index-order requirement). Frontend
edges carry a `source_type` COLUMN.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), better-sqlite3, web-tree-sitter, `node --test` (`.mjs` tests).

## Global Constraints

- Endpoint node identity is `grpcEndpointKey(service, method)` = `grpc::${service}.${method.toLowerCase()}` in `packages/knowledge-indexer/src/grpc-client.ts`. Reuse verbatim. The frontend `functionName` (camelCase) and the proto RPC (PascalCase) collapse to the same key because the method half is lowercased; the SERVICE half must match proto casing (via `serviceEnumMap`).
- REAL call shape (verified in casino-plus): key is `functionName` (NOT `method`); payload key is `requestParam` (NOT `body`). Detection is AST, NOT regex.
- Cross-service edges to the global (repo-less) endpoint MUST be `branchless: true`.
- Confirmed-only: emit a frontend edge only when the endpoint node EXISTS. If missing → enqueue in `pending_frontend_edges`, never drop, never upsert a placeholder.
- Wrapper 1:1 = the method body is a SOLE forward to `this._net.<sameName>(…)` (lone arrow-return or single-return block). Batching / rename / transform → NOT verified.
- Frontend edge tag lives in a dedicated `source_type` COLUMN on `edges` (value `frontend_web`); backend edges default NULL. The graph query selects it.
- ESM: local imports use `.js` specifiers.
- MVP: casino-plus web, `SkinFragment` only. casino-plus-app (native) deferred.

---

### Task 1: Per-repo frontend gRPC config (type + loader)

**Files:**
- Create: `packages/knowledge-indexer/src/frontend-grpc-config.ts`
- Test: `tests/frontend-grpc-config.test.mjs`

**Interfaces:**
- Produces:
  - `interface FrontendGrpcConfig { dispatcher: string; serviceEnumMap: Record<string,string>; wrappers: Record<string,string> }`
  - `function loadFrontendGrpcConfig(repoRoot: string): FrontendGrpcConfig | null`

`dispatcher` = call name carrying `{service, functionName}` (e.g. `"requestApi"`).
`serviceEnumMap` = enum member as written → proto service (`"NT_SERVICE_INTERFACE.SKINFRAGMENT"` → `"SkinFragment"`).
`wrappers` = proto service → wrapper class name (`"SkinFragment"` → `"NtSkinFragmentService"`).
Config at `<repoRoot>/.penguin-frontend-grpc.json`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend-grpc-config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFrontendGrpcConfig } from "../packages/knowledge-indexer/dist/frontend-grpc-config.js";

test("loads config", () => {
  const dir = mkdtempSync(join(tmpdir(), "fgc-"));
  writeFileSync(join(dir, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
    wrappers: { "SkinFragment": "NtSkinFragmentService" },
  }));
  const cfg = loadFrontendGrpcConfig(dir);
  assert.equal(cfg.dispatcher, "requestApi");
  assert.equal(cfg.serviceEnumMap["NT_SERVICE_INTERFACE.SKINFRAGMENT"], "SkinFragment");
  assert.equal(cfg.wrappers["SkinFragment"], "NtSkinFragmentService");
});

test("null when absent", () => {
  assert.equal(loadFrontendGrpcConfig(mkdtempSync(join(tmpdir(), "fgc-"))), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-config.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/knowledge-indexer/src/frontend-grpc-config.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface FrontendGrpcConfig {
  dispatcher: string;
  serviceEnumMap: Record<string, string>; // "NS.ENUM" → proto service
  wrappers: Record<string, string>;        // proto service → wrapper class name
}

export function loadFrontendGrpcConfig(repoRoot: string): FrontendGrpcConfig | null {
  try {
    const p = JSON.parse(readFileSync(join(repoRoot, ".penguin-frontend-grpc.json"), "utf8"));
    if (!p.dispatcher || typeof p.serviceEnumMap !== "object" || !p.serviceEnumMap) return null;
    return {
      dispatcher: p.dispatcher,
      serviceEnumMap: p.serviceEnumMap,
      wrappers: p.wrappers ?? {},
    };
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

### Task 2: AST call-site extractor (functionName)

**Files:**
- Create: `packages/knowledge-indexer/src/frontend-grpc-client.ts`
- Test: `tests/frontend-grpc-client.test.mjs`

**Interfaces:**
- Consumes: `FrontendGrpcConfig`; a web-tree-sitter root `Node`.
- Produces:
  - `interface FrontendGrpcCall { service: string; functionName: string; startLine: number; enclosingQualifiedName: string | null }`
  - `function extractFrontendGrpcCalls(root: Node, config: FrontendGrpcConfig): FrontendGrpcCall[]`

Detect a `call_expression` whose function is a `member_expression` with property = `config.dispatcher`, whose first argument is an `object` containing a `service` property (a `member_expression` matching a `serviceEnumMap` key) and a `functionName` property (a string literal). Non-literal functionName or unmapped enum → skip. `enclosingQualifiedName` filled later by extract.ts.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend-grpc-client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFrontendCallsFromSource } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

const CFG = { dispatcher: "requestApi",
  serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" }, wrappers: {} };

test("extracts a real requestApi call (functionName + requestParam)", async () => {
  const src = `
    const res = await WebServices.requestApi({
      service: NT_SERVICE_INTERFACE.SKINFRAGMENT,
      functionName: 'claimDailyFragment',
      requestParam: { linkCode },
    })`;
  const calls = await extractFrontendCallsFromSource("tsx", src, CFG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].service, "SkinFragment");
  assert.equal(calls[0].functionName, "claimDailyFragment");
});

test("skips unmapped enum and computed functionName", async () => {
  const a = await extractFrontendCallsFromSource("tsx",
    `WebServices.requestApi({ service: NT_SERVICE_INTERFACE.OTHER, functionName: 'x' })`, CFG);
  const b = await extractFrontendCallsFromSource("tsx",
    `WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: fn })`, CFG);
  assert.equal(a.length, 0);
  assert.equal(b.length, 0);
});
```

> `extractFrontendCallsFromSource(lang, src, cfg)` is a small test-only helper exported from the same module that parses `src` with the existing `loadLanguage`/`Parser` and calls `extractFrontendGrpcCalls(root, cfg)`. Model the parse on `extract.ts` lines ~97-112.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-client.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** (model the `walk`/`childForFieldName` style on `grpc-client.ts`)

```typescript
// packages/knowledge-indexer/src/frontend-grpc-client.ts
import { Parser, type Node } from "web-tree-sitter";
import { loadLanguage } from "./parser.js";
import type { Lang } from "./registry.js";
import type { FrontendGrpcConfig } from "./frontend-grpc-config.js";

export interface FrontendGrpcCall {
  service: string;
  functionName: string;
  startLine: number;
  enclosingQualifiedName: string | null;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

// "A.B" for a member_expression object.property; null otherwise.
function dottedName(n: Node | null): string | null {
  if (!n) return null;
  if (n.type === "member_expression") {
    const o = n.childForFieldName("object");
    const p = n.childForFieldName("property");
    if (o?.type === "identifier" && p) return `${o.text}.${p.text}`;
  }
  return null;
}

// Value of an object property by key, given the `object` node.
function propValue(obj: Node, key: string): Node | null {
  for (let i = 0; i < obj.namedChildCount; i++) {
    const pair = obj.namedChild(i)!;
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    if (k && (k.text === key || k.text === `'${key}'` || k.text === `"${key}"`)) {
      return pair.childForFieldName("value");
    }
  }
  return null;
}

function stringLiteral(n: Node | null): string | null {
  if (!n || n.type !== "string") return null;
  return n.namedChild(0)?.text ?? n.text.replace(/^['"]|['"]$/g, "");
}

export function extractFrontendGrpcCalls(root: Node, config: FrontendGrpcConfig): FrontendGrpcCall[] {
  const calls: FrontendGrpcCall[] = [];
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    if (fn.childForFieldName("property")?.text !== config.dispatcher) return;
    const args = n.childForFieldName("arguments");
    const obj = args?.namedChildren.find((c) => c?.type === "object");
    if (!obj) return;
    const svcEnum = dottedName(propValue(obj, "service"));
    const functionName = stringLiteral(propValue(obj, "functionName"));
    if (!svcEnum || !functionName) return;          // computed / missing → skip
    const service = config.serviceEnumMap[svcEnum];
    if (!service) return;                            // unmapped enum → skip
    calls.push({ service, functionName, startLine: n.startPosition.row + 1, enclosingQualifiedName: null });
  });
  return calls;
}

// Test-only helper: parse source then extract.
export async function extractFrontendCallsFromSource(lang: Lang, source: string, config: FrontendGrpcConfig): Promise<FrontendGrpcCall[]> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? extractFrontendGrpcCalls(tree.rootNode, config) : [];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-client.test.mjs`
Expected: PASS (2 tests).

> If `pair`/`object` node types differ in the installed tree-sitter TS grammar, print `root.toString()` for the fixture and adjust the type names. Verify against the grammar before assuming.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/frontend-grpc-client.ts tests/frontend-grpc-client.test.mjs
git commit -m "feat(knowledge): AST frontend requestApi call-site extractor (functionName)"
```

---

### Task 3: AST wrapper 1:1 verifier (sole-forward)

**Files:**
- Modify: `packages/knowledge-indexer/src/frontend-grpc-client.ts`
- Test: `tests/frontend-grpc-wrapper.test.mjs`

**Interfaces:**
- Produces: `function verifiedForwardingMethods(root: Node, className: string): Set<string>` — static methods of `class <className>` whose body is a SOLE forward to `this._net.<sameName>(…)`. Rejects rename/batch/transform.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/frontend-grpc-wrapper.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifiedMethodsFromSource } from "../packages/knowledge-indexer/dist/frontend-grpc-client.js";

test("collects sole-forward methods; rejects rename/batch", async () => {
  const src = `
    class NtSkinFragmentService {
      static claimDailyFragment = (r) => this._net.claimDailyFragment(r)
      static getInviteLink = async (r) => { return this._net.getInviteLink(r) }
      static renamed = (r) => this._net.somethingElse(r)
      static batched = (r) => { this._net.a(r); return this._net.claimGift(r) }
    }`;
  const s = await verifiedMethodsFromSource("tsx", src, "NtSkinFragmentService");
  assert.ok(s.has("claimDailyFragment"));
  assert.ok(s.has("getInviteLink"));
  assert.ok(!s.has("renamed"));
  assert.ok(!s.has("batched"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-wrapper.test.mjs`
Expected: FAIL — export missing.

- [ ] **Step 3: Write minimal implementation** (append to `frontend-grpc-client.ts`)

```typescript
// Count occurrences of `this._net.<X>(` in a body node; return the single X or null.
function soleNetForward(body: Node, name: string): boolean {
  let netCalls = 0;
  let matchesName = false;
  walk(body, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text;
    // obj is `this._net`
    if (obj?.type === "member_expression"
        && obj.childForFieldName("object")?.type === "this"
        && obj.childForFieldName("property")?.text === "_net") {
      netCalls += 1;
      if (prop === name) matchesName = true;
    }
  });
  return netCalls === 1 && matchesName; // exactly one _net call, and it is <name>
}

export function verifiedForwardingMethods(root: Node, className: string): Set<string> {
  const out = new Set<string>();
  walk(root, (cls) => {
    if (cls.type !== "class_declaration" && cls.type !== "class") return;
    if (cls.childForFieldName("name")?.text !== className) return;
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i)!;
      // static field: `static <name> = <arrow_function>`
      const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
      const value = member.childForFieldName("value");
      const name = nameNode?.text;
      if (!name || !value || value.type !== "arrow_function") continue;
      const abody = value.childForFieldName("body");
      if (abody && soleNetForward(abody, name)) out.add(name);
    }
  });
  return out;
}

export async function verifiedMethodsFromSource(lang: Lang, source: string, className: string): Promise<Set<string>> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? verifiedForwardingMethods(tree.rootNode, className) : new Set();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/frontend-grpc-wrapper.test.mjs`
Expected: PASS.

> If the TS grammar names static members differently (e.g. `public_field_definition`), print `root.toString()` for the fixture and adjust `childForFieldName` keys.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/frontend-grpc-client.ts tests/frontend-grpc-wrapper.test.mjs
git commit -m "feat(knowledge): AST wrapper sole-forward verifier"
```

---

### Task 4: Thread frontend calls + wrapper-verified through extract.ts

**Files:**
- Modify: `packages/knowledge-indexer/src/extract.ts`
- Test: `tests/extract-frontend.test.mjs`

**Interfaces:**
- `extractSymbols` input gains `frontendGrpcConfig?: FrontendGrpcConfig`.
- `ExtractedFile` gains:
  - `frontendGrpcCalls: FrontendGrpcCall[]` (enclosing symbol attributed like `grpcClientCalls`)
  - `wrapperVerified: Record<string, string[]>` — for each configured wrapper class PRESENT in this file, `className → verified method names`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/extract-frontend.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSymbols } from "../packages/knowledge-indexer/dist/extract.js";

const CFG = { dispatcher: "requestApi",
  serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
  wrappers: { "SkinFragment": "NtSkinFragmentService" } };

test("call attributed to enclosing fn", async () => {
  const src = `export function useSF(){ async function claim(){ return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: 'claimDailyFragment' }) } return {claim} }`;
  const out = await extractSymbols({ lang: "tsx", source: src, relPath: "vm.tsx", frontendGrpcConfig: CFG });
  assert.equal(out.frontendGrpcCalls.length, 1);
  assert.equal(out.frontendGrpcCalls[0].functionName, "claimDailyFragment");
  assert.ok(out.frontendGrpcCalls[0].enclosingQualifiedName?.endsWith("claim"));
});

test("wrapper file yields verified methods", async () => {
  const src = `class NtSkinFragmentService { static claimDailyFragment = (r) => this._net.claimDailyFragment(r) }`;
  const out = await extractSymbols({ lang: "ts", source: src, relPath: "w.ts", frontendGrpcConfig: CFG });
  assert.deepEqual(out.wrapperVerified["NtSkinFragmentService"], ["claimDailyFragment"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/extract-frontend.test.mjs`
Expected: FAIL — fields undefined.

- [ ] **Step 3: Implement — modify `extract.ts`**

3a. Imports (near other extractor imports):

```typescript
import { extractFrontendGrpcCalls, verifiedForwardingMethods, type FrontendGrpcCall } from "./frontend-grpc-client.js";
import type { FrontendGrpcConfig } from "./frontend-grpc-config.js";
```

3b. Add to `ExtractedFile` (after `grpcClientCalls`):

```typescript
  frontendGrpcCalls: FrontendGrpcCall[];
  wrapperVerified: Record<string, string[]>;
```

3c. Add both to the `base` literal:

```typescript
  const base: ExtractedFile = { lang, symbols: [], refs: [], fileImports: [], endpoints: [], grpcClientCalls: [], frontendGrpcCalls: [], wrapperVerified: {}, parseError: null };
```

3d. Add input param (next to `relPath?`):

```typescript
  frontendGrpcConfig?: FrontendGrpcConfig;
```

3e. After the `grpcClientCalls` attribution loop, add (uses the already-parsed `tree`):

```typescript
  let frontendGrpcCalls: FrontendGrpcCall[] = [];
  const wrapperVerified: Record<string, string[]> = {};
  if (isTs && input.frontendGrpcConfig) {
    frontendGrpcCalls = extractFrontendGrpcCalls(tree.rootNode, input.frontendGrpcConfig);
    for (const fc of frontendGrpcCalls) {
      let best: ExtractedSymbol | null = null;
      for (const sym of symbols) {
        if (sym.startLine <= fc.startLine && fc.startLine <= sym.endLine) {
          if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
        }
      }
      fc.enclosingQualifiedName = best ? best.qualifiedName : null;
    }
    for (const className of Object.values(input.frontendGrpcConfig.wrappers)) {
      const v = verifiedForwardingMethods(tree.rootNode, className);
      if (v.size > 0) wrapperVerified[className] = [...v];
    }
  }
```

3f. Add both to the final `return { ... }`:

```typescript
  return { lang, symbols, refs, fileImports, endpoints, grpcClientCalls, frontendGrpcCalls, wrapperVerified, parseError: null };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-indexer build && node --test tests/extract-frontend.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-indexer/src/extract.ts tests/extract-frontend.test.mjs
git commit -m "feat(knowledge): thread frontend calls + wrapper-verified through extractSymbols"
```

---

### Task 5: Store — source_type column, node lookup, pending-edge queue

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts` (add `source_type` column; `pending_frontend_edges` table)
- Modify: `packages/knowledge-core/src/store.ts` (`ParsedEdge.sourceType`; write column; `findNodeIdByIdentity`; `enqueuePendingFrontendEdge`; `replayPendingFrontendEdges`)
- Test: `tests/store-frontend.test.mjs`

**Interfaces:**
- `ParsedEdge.sourceType?: string` → written to the `edges.source_type` column.
- `findNodeIdByIdentity(identityKey: string): string | null`
- `enqueuePendingFrontendEdge(p: { repoId: string; filePath: string; srcNodeId: string; service: string; functionName: string; sourceType: string }): void`
- `replayPendingFrontendEdges(): number` — for every pending row whose `grpcEndpointKey(service, functionName)` node now exists, insert the `invokes` edge (branch-less, source_type) and delete the row; returns count replayed.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/store-frontend.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { grpcEndpointKey } from "../packages/knowledge-indexer/dist/grpc-client.js";

test("findNodeIdByIdentity + pending replay", () => {
  const store = new KnowledgeStore(":memory:");
  const src = store.upsertNode({ nodeType: "symbol", identityKey: "casino::useSF.claim", repoId: "cp", title: "claim" });
  // endpoint does NOT exist yet → enqueue
  store.enqueuePendingFrontendEdge({ repoId: "cp", filePath: "vm.tsx", srcNodeId: src, service: "SkinFragment", functionName: "claimDailyFragment", sourceType: "frontend_web" });
  assert.equal(store.replayPendingFrontendEdges(), 0); // still no endpoint
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  assert.equal(store.replayPendingFrontendEdges(), 1); // now replayed
  assert.equal(store.replayPendingFrontendEdges(), 0); // idempotent (row deleted)
  assert.equal(store.findNodeIdByIdentity(grpcEndpointKey("SkinFragment", "ClaimDailyFragment")), ep);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && node --test tests/store-frontend.test.mjs`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

3a. `schema.ts` — in the `edges` table DDL add `source_type TEXT` (nullable). If the table is created via `CREATE TABLE IF NOT EXISTS`, also add an idempotent migration right after `openDatabase` opens it:

```typescript
  // Additive migration: source_type on edges (frontend_web/frontend_mobile tag).
  const cols = db.prepare("PRAGMA table_info(edges)").all() as { name: string }[];
  if (!cols.some((c) => c.name === "source_type")) {
    db.exec("ALTER TABLE edges ADD COLUMN source_type TEXT");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS pending_frontend_edges (
    id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, file_path TEXT NOT NULL,
    src_node_id TEXT NOT NULL, service TEXT NOT NULL, function_name TEXT NOT NULL,
    source_type TEXT NOT NULL
  )`);
```

3b. `store.ts` — `ParsedEdge` gains `sourceType?: string`. Both edge INSERTs (the `edges` INSERT around line 418 and inside `replaceFileEdges` around line 639) must include the `source_type` column. Add `source_type` to the column list and bind `p...sourceType ?? null` / `e.sourceType ?? null` respectively. Read the two INSERT statements first and add the column consistently.

3c. `store.ts` — add methods:

```typescript
  findNodeIdByIdentity(identityKey: string): string | null {
    const r = this.db.prepare("SELECT id FROM nodes WHERE identity_key = ?").get(identityKey) as { id: string } | undefined;
    return r?.id ?? null;
  }

  enqueuePendingFrontendEdge(p: { repoId: string; filePath: string; srcNodeId: string; service: string; functionName: string; sourceType: string }): void {
    this.db.prepare(`INSERT INTO pending_frontend_edges
      (id, repo_id, file_path, src_node_id, service, function_name, source_type)
      VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), p.repoId, p.filePath, p.srcNodeId, p.service, p.functionName, p.sourceType);
  }

  replayPendingFrontendEdges(): number {
    const { grpcEndpointKey } = requireGrpcKey();
    const rows = this.db.prepare("SELECT * FROM pending_frontend_edges").all() as any[];
    let replayed = 0;
    for (const row of rows) {
      const endpointId = this.findNodeIdByIdentity(grpcEndpointKey(row.service, row.function_name));
      if (!endpointId) continue;
      this.db.prepare(`INSERT INTO edges (id, src, dst, raw_target, edge_type, branch_id, origin, method, confidence, provenance, source_type)
        VALUES (?,?,?,NULL,'invokes',NULL,'parser','EXTRACTED',NULL,?,?)`)
        .run(randomUUID(), row.src_node_id, endpointId, JSON.stringify({ origin: "parser", method: "EXTRACTED" }), row.source_type);
      this.db.prepare("DELETE FROM pending_frontend_edges WHERE id = ?").run(row.id);
      replayed += 1;
    }
    return replayed;
  }
```

> `grpcEndpointKey` lives in the indexer package; `store.ts` is in core and must not import the indexer (dependency direction). Instead inline the key formula in `replayPendingFrontendEdges`: ``const key = `grpc::${row.service}.${String(row.function_name).toLowerCase()}`;`` and drop `requireGrpcKey()`. Keep it byte-identical to `grpcEndpointKey`.
> Match the exact column list of the real `edges` INSERT (read line ~418 first); the snippet above assumes `(id,src,dst,raw_target,edge_type,branch_id,origin,method,confidence,provenance,source_type)`. Adjust to the actual columns.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && node --test tests/store-frontend.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/schema.ts packages/knowledge-core/src/store.ts tests/store-frontend.test.mjs
git commit -m "feat(knowledge): source_type column + pending_frontend_edges queue + node lookup"
```

---

### Task 6: Pipeline — collect, gate, stitch-or-enqueue, replay

**Files:**
- Modify: `packages/knowledge-indexer/src/pipeline.ts`
- Test: `tests/pipeline-fullstack.test.mjs`

**Interfaces:**
- Consumes: `ExtractedFile.frontendGrpcCalls`, `ExtractedFile.wrapperVerified`, `store.findNodeIdByIdentity`, `store.enqueuePendingFrontendEdge`, `store.replayPendingFrontendEdges`, `grpcEndpointKey`, `loadFrontendGrpcConfig`.
- Behaviour: over the whole repo, accumulate frontend calls (with resolved src node id) + `verifiedMethodsByService`. AFTER the per-file loop: for each call, if `verifiedMethodsByService[service]` has `functionName` AND the endpoint node exists → emit `invokes` (branchless, source_type="frontend_web"); else if verified but endpoint missing → `enqueuePendingFrontendEdge`. Finally call `replayPendingFrontendEdges()` (covers endpoints created by THIS repo's proto pass or a prior repo's pending rows).

- [ ] **Step 1: Write the failing test (golden trace, REAL call shape)**

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

function cpRepo() {
  const repo = mkdtempSync(join(tmpdir(), "cp-"));
  writeFileSync(join(repo, ".penguin-frontend-grpc.json"), JSON.stringify({
    dispatcher: "requestApi",
    serviceEnumMap: { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
    wrappers: { "SkinFragment": "NtSkinFragmentService" },
  }));
  mkdirSync(join(repo, "svc"), { recursive: true });
  // wrapper (1:1) — required for the verified gate
  writeFileSync(join(repo, "svc", "wrapper.ts"),
    `export class NtSkinFragmentService { static claimDailyFragment = (r) => this._net.claimDailyFragment(r) }`);
  // real call shape: functionName + requestParam
  writeFileSync(join(repo, "svc", "vm.tsx"),
    `export function useSF(){ async function claim(){ return WebServices.requestApi({ service: NT_SERVICE_INTERFACE.SKINFRAGMENT, functionName: 'claimDailyFragment' }) } return {claim} }`);
  return repo;
}

test("golden trace: endpoint exists first → edge emitted", async () => {
  const store = new KnowledgeStore(":memory:");
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  await indexRepo({ store, repoId: "casino-plus", rootPath: cpRepo(), branchId: "main" });
  const edges = store.db.prepare("SELECT edge_type, source_type FROM edges WHERE dst = ?").all(ep);
  assert.ok(edges.some((e) => e.edge_type === "invokes" && e.source_type === "frontend_web"));
});

test("deferred: frontend first, endpoint later → replay links it", async () => {
  const store = new KnowledgeStore(":memory:");
  await indexRepo({ store, repoId: "casino-plus", rootPath: cpRepo(), branchId: "main" });
  // endpoint appears later (e.g. flyover indexed after)
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  assert.equal(store.replayPendingFrontendEdges(), 1);
});

test("no wrapper verification → no edge, no pending", async () => {
  const store = new KnowledgeStore(":memory:");
  store.upsertNode({ nodeType: "endpoint", identityKey: grpcEndpointKey("SkinFragment", "ClaimDailyFragment"), repoId: null, title: "ep" });
  const repo = cpRepo();
  writeFileSync(join(repo, "svc", "wrapper.ts"), `export class NtSkinFragmentService { static claimDailyFragment = (r) => this._net.renamedRpc(r) }`);
  await indexRepo({ store, repoId: "cp3", rootPath: repo, branchId: "main" });
  const n = store.db.prepare("SELECT COUNT(*) c FROM edges WHERE source_type = 'frontend_web'").get();
  assert.equal(n.c, 0);
});
```

> Reconcile `indexRepo`'s option names (`store`/`repoId`/`rootPath`/`branchId`) with the real signature before running; adjust the calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && node --test tests/pipeline-fullstack.test.mjs`
Expected: FAIL — no frontend edges.

- [ ] **Step 3: Implement — modify `pipeline.ts`**

3a. Import + load config (near the proto/other setup in `indexRepo`):

```typescript
import { loadFrontendGrpcConfig } from "./frontend-grpc-config.js";
```
```typescript
  const frontendGrpcConfig = loadFrontendGrpcConfig(scanRoot) ?? undefined;
  const frontendCalls: Array<{ src: string; service: string; functionName: string; filePath: string }> = [];
  const verifiedMethodsByService: Record<string, Set<string>> = {};
```

3b. Pass config into the `extractSymbols(...)` call: add `frontendGrpcConfig,`.

3c. Inside the per-file block, after symbols are stored and `fileSymbolIds` is known, accumulate (do NOT stitch yet):

```typescript
    for (const fc of extracted.frontendGrpcCalls) {
      if (!fc.enclosingQualifiedName) continue;
      const src = fileSymbolIds.get(fc.enclosingQualifiedName);
      if (src) frontendCalls.push({ src, service: fc.service, functionName: fc.functionName, filePath: p.filePath });
    }
    for (const [service, cls] of Object.entries(frontendGrpcConfig?.wrappers ?? {})) {
      const methods = extracted.wrapperVerified[cls];
      if (methods) (verifiedMethodsByService[service] ??= new Set()).forEach; // ensure key
      if (methods) methods.forEach((m) => (verifiedMethodsByService[service] ??= new Set()).add(m));
    }
```

3d. AFTER the per-file loop AND after the proto post-pass (so this repo's own proto endpoints exist), add the frontend stitch + replay:

```typescript
    // Frontend gRPC-web consumers → 'invokes' the global endpoint, gated on
    // wrapper 1:1 verification + endpoint existence; else queued for re-stitch.
    for (const fc of frontendCalls) {
      if (!verifiedMethodsByService[fc.service]?.has(fc.functionName)) continue; // wrapper gate
      const endpointId = store.findNodeIdByIdentity(grpcEndpointKey(fc.service, fc.functionName));
      if (endpointId) {
        store.replaceFileEdges({
          repoId, branchId, filePath: fc.filePath,
          edges: [{ src: fc.src, dst: endpointId, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true, sourceType: "frontend_web" }],
        });
      } else {
        store.enqueuePendingFrontendEdge({ repoId, filePath: fc.filePath, srcNodeId: fc.src, service: fc.service, functionName: fc.functionName, sourceType: "frontend_web" });
      }
    }
    store.replayPendingFrontendEdges();
```

> CAUTION: `replaceFileEdges` replaces ALL edges for (repo, file). If a frontend file also produces other edges in the per-file loop, calling it again here would wipe them. Check whether the view-model files produce other structural edges; if so, accumulate frontend edges per-file and merge them into that file's single `replaceFileEdges` call instead of calling it twice. Read how the per-file loop calls `replaceFileEdges` and integrate accordingly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-indexer build && node --test tests/pipeline-fullstack.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Full indexer suite (no regressions)**

Run: `node --test tests/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/knowledge-indexer/src/pipeline.ts tests/pipeline-fullstack.test.mjs
git commit -m "feat(knowledge): frontend stitch with wrapper gate + deferred re-stitch"
```

---

### Task 7: Expose source_type in the graph query (Wiki filtering)

**Files:**
- Modify: `packages/knowledge-core/src/query.ts` (the graph edge SELECT ~line 472-482)
- Test: `tests/graph-source-type.test.mjs`

**Interfaces:**
- The graph/collectGraph edge rows gain `sourceType` (from the `source_type` column) so the Wiki can filter frontend edges.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/graph-source-type.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("graph edges expose sourceType", () => {
  const store = new KnowledgeStore(":memory:");
  const a = store.upsertNode({ nodeType: "symbol", identityKey: "cp::claim", repoId: "cp", title: "claim" });
  const b = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "ep" });
  store.replaceFileEdges({ repoId: "cp", branchId: "main", filePath: "vm.tsx",
    edges: [{ src: a, dst: b, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true, sourceType: "frontend_web" }] });
  const g = store.collectGraph({ branchId: "main" }); // reconcile with real collectGraph signature
  const e = g.edges.find((x) => x.dst === b);
  assert.equal(e.sourceType, "frontend_web");
});
```

> Reconcile `collectGraph`'s real name/signature/return shape before finalizing.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && node --test tests/graph-source-type.test.mjs`
Expected: FAIL — `sourceType` undefined.

- [ ] **Step 3: Implement**

In the graph edge SELECT (query.ts ~472-482), add `source_type` to the selected columns and map it to `sourceType` in the returned edge object. If there is a TypeScript type for the edge row, add `sourceType?: string | null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && node --test tests/graph-source-type.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/query.ts tests/graph-source-type.test.mjs
git commit -m "feat(knowledge): expose edge source_type in graph query"
```

---

### Task 8: Real casino-plus config + manual golden-trace verification

**Files:**
- Create: `/Users/shieng/Desktop/Projects/casino-plus/.penguin-frontend-grpc.json`

- [ ] **Step 1: Write the real config**

```json
{
  "dispatcher": "requestApi",
  "serviceEnumMap": { "NT_SERVICE_INTERFACE.SKINFRAGMENT": "SkinFragment" },
  "wrappers": { "SkinFragment": "NtSkinFragmentService" }
}
```
Path: `/Users/shieng/Desktop/Projects/casino-plus/.penguin-frontend-grpc.json`

- [ ] **Step 2: Verify the real wrapper is sole-forward for all 9 methods**

```bash
node -e "const {verifiedMethodsFromSource}=require('/Users/shieng/Desktop/Pengvi/packages/knowledge-indexer/dist/frontend-grpc-client.js'); const fs=require('fs'); verifiedMethodsFromSource('ts', fs.readFileSync('/Users/shieng/Desktop/Projects/casino-plus/libs/web-service/src/lib/services/nt-skin-fragment-service.ts','utf8'),'NtSkinFragmentService').then(s=>console.log([...s]))"
```
Expected: the 9 methods (getActivityStatus, claimDailyFragment, getInviteLink, bindInvite, settlePendingInvites, createGiftLink, claimGift, precheckCompleteIp, submitAddressAndRedeem). Any missing → its wrapper is not sole-forward; record the discrepancy (no edge for it).

- [ ] **Step 3: Re-index flyover + casino-plus, verify the full-stack edge**

Re-index both repos (order-independent thanks to deferred re-stitch). Verify a graph query shows `grpc::SkinFragment.claimdailyfragment` with an incoming `invokes` edge whose `source_type = frontend_web` originating from the casino-plus view-model symbol, and that the backend handler `handles` the same endpoint. Full-stack trace resolved.

- [ ] **Step 4: Commit the config** (external repo — confirm with the user first)

```bash
cd /Users/shieng/Desktop/Projects/casino-plus
git add .penguin-frontend-grpc.json
git commit -m "chore: penguin frontend gRPC config (SkinFragment)"
```

---

## Self-Review

**1. Spec coverage** (against corrected `2026-07-11-fullstack-graph-linking-design.md`):
- §1 Composite detection (consumption + identity + wrapper gate, AST) → Tasks 2 (functionName), 3 (sole-forward), 4 (thread), 6 (gate wired). ✓
- §2 Proto-qualified stitch via grpcEndpointKey + enum→service map → Tasks 1, 6. ✓
- §3 Per-repo config → Task 1 (incl. wrappers). ✓
- §4 Confirmed-only + deferred re-stitch (pending_frontend_edges) + source_type COLUMN → Tasks 5, 6. ✓
- §5 Edge provenance/source_type → Tasks 5, 7. ✓
- MVP golden trace (real functionName) + deferred-order test → Tasks 6, 8. ✓
- casino-plus-app deferred → not in plan. ✓

**2. Placeholder scan:** No TBD/TODO. Every code step shows code. Several explicit "reconcile with real signature" notes (indexRepo options, replaceFileEdges column list/double-call, collectGraph shape, tree-sitter node type names) are grounded verify-against-real-code instructions, not placeholders — flagged so the implementer checks the neighbouring verbatim code first.

**3. Type consistency:** `FrontendGrpcConfig`(dispatcher/serviceEnumMap/wrappers), `FrontendGrpcCall`(service/functionName), `wrapperVerified`, `verifiedMethodsByService`, `findNodeIdByIdentity`, `enqueuePendingFrontendEdge`, `replayPendingFrontendEdges`, `sourceType`/`source_type`, `grpcEndpointKey` used consistently. ✓

**Known risks to resolve during execution (read real code first):**
- Task 5/6: the real `edges` INSERT column list and whether a frontend file's `replaceFileEdges` is called twice (would wipe edges) — integrate frontend edges into the file's single call if so.
- Tasks 2/3: tree-sitter TS/TSX node type names (`pair`, `object`, `class_declaration`, static-member field) — verify with `root.toString()` before trusting.
- Tasks 6/7: `indexRepo` and `collectGraph` real signatures.
