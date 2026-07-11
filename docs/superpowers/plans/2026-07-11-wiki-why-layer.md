# Wiki WHY Layer — Implementation Plan (MVP, phase 1 — no PRD)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `penguin why` CLI that generates evidence-grounded, human-confirmable "WHY cards" for cross-service gRPC endpoints (endpoint-bound Markdown note + queryable `why_claims` rows), reusing the existing BYOK `aiComplete` + `buildContextPack`. NO PRD (phase 2).

**Architecture:** `penguin why` selects endpoint contracts (handler + ≥1 consumer), builds a Context Pack per endpoint, asks the LLM for STRUCTURED JSON claims, validates each claim's evidence IDs against real graph/git artifacts (guardrail — demote/reject ungrounded claims), then persists a Markdown note bound to the endpoint node + `why_claims` rows with code fingerprints. A `--check` pass recomputes fingerprints for staleness. Wiki renders stored `why_claims` (no AI/graph parsing at render).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), better-sqlite3, existing `knowledge-cli` (`aiComplete`, `resolveProvider`), `knowledge-core` (`buildContextPack`, `renderContextPackMarkdown`, `KnowledgeStore`), `node --test` (`.mjs`).

## Global Constraints

- MVP is phase 1: graph + git + tests only. NO PRD binding / AC coverage (phase 2).
- Reuse `aiComplete(cfg, messages)` + `resolveProvider(opts)` from `packages/knowledge-cli/src/ai.ts`; `buildContextPack(store, target)` + `renderContextPackMarkdown(pack)` from knowledge-core. Do NOT add AI to the deterministic indexer. Do NOT use MCP `write_note`.
- Card subject = the global endpoint node (`grpc::Service.method`, repo-less). Human note binds to it; per-claim state lives in the NEW `why_claims` table (frontmatter can't hold nested claims).
- Contract refs are stable selectors (node identity keys), never parser edge IDs.
- Guardrail: every claim's `evidence_ids` must resolve to a real artifact; unresolved → demote to `ai_inferred`/`unchecked` (never `code_observed`). A card with zero grounded FACTS or all-below-confidence-floor (0.3) claims is NOT written (logged).
- `source_type ∈ {code_observed, ai_inferred}` (MVP; `prd_declared` = phase 2). `verification_state ∈ {verified_against_code, conflicts_with_code, unchecked, stale}`. `status ∈ {draft, confirmed, rejected}`.
- The `why` command takes an injectable `complete` fn (default `aiComplete`) so tests use a deterministic stub.

---

### Task 1: `why_claims` table + store CRUD

**Files:**
- Modify: `packages/knowledge-core/src/schema.ts` (create table)
- Modify: `packages/knowledge-core/src/store.ts` (CRUD)
- Test: `tests/why-claims-store.test.mjs`

**Interfaces:**
- Produces on `KnowledgeStore`:
  - `interface WhyClaim { claimId: string; noteNodeId: string; claimKind: "fact"|"inference"|"evidence"|"gap"; text: string; sourceType: string; verificationState: string; status: string; evidenceIdsJson: string; codeFingerprint: string | null; confidence: number | null; lastCheckedAt: string }`
  - `replaceWhyClaims(noteNodeId: string, claims: Omit<WhyClaim,"lastCheckedAt">[]): void` — delete existing rows for the note then insert (idempotent regen).
  - `whyClaimsFor(noteNodeId: string): WhyClaim[]`
  - `setClaimVerification(claimId: string, verificationState: string): void`

- [ ] **Step 1: Write the failing test**

```javascript
// tests/why-claims-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("replace + read why_claims", () => {
  const store = new KnowledgeStore(":memory:");
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "ep" });
  store.replaceWhyClaims(ep, [
    { claimId: "c1", noteNodeId: ep, claimKind: "fact", text: "casino-plus invokes it", sourceType: "code_observed", verificationState: "verified_against_code", status: "draft", evidenceIdsJson: '["edge:invokes:1"]', codeFingerprint: "abc", confidence: 0.9 },
  ]);
  const rows = store.whyClaimsFor(ep);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceType, "code_observed");
  store.setClaimVerification("c1", "stale");
  assert.equal(store.whyClaimsFor(ep)[0].verificationState, "stale");
  // idempotent regen
  store.replaceWhyClaims(ep, []);
  assert.equal(store.whyClaimsFor(ep).length, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && node --test tests/why-claims-store.test.mjs`
Expected: FAIL — methods missing.

- [ ] **Step 3: Implement**

3a. `schema.ts` — add near the other `CREATE TABLE` statements:

```sql
CREATE TABLE IF NOT EXISTS why_claims (
  claim_id TEXT PRIMARY KEY,
  note_node_id TEXT NOT NULL,
  claim_kind TEXT NOT NULL,
  text TEXT NOT NULL,
  source_type TEXT NOT NULL,
  verification_state TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  code_fingerprint TEXT,
  confidence REAL,
  last_checked_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_why_claims_note ON why_claims(note_node_id);
CREATE INDEX IF NOT EXISTS idx_why_claims_verif ON why_claims(verification_state);
```

3b. `store.ts` — add the interface + methods (use `this.db`, `randomUUID` already imported; use a fixed timestamp source consistent with the rest of the store — reuse the same `now`/`@now` pattern already used by `upsertNode`):

```typescript
export interface WhyClaim {
  claimId: string; noteNodeId: string; claimKind: string; text: string;
  sourceType: string; verificationState: string; status: string;
  evidenceIdsJson: string; codeFingerprint: string | null; confidence: number | null; lastCheckedAt: string;
}
```
```typescript
  replaceWhyClaims(noteNodeId: string, claims: Array<Omit<WhyClaim, "lastCheckedAt">>): void {
    const now = new Date().toISOString();      // match the store's existing timestamp approach
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM why_claims WHERE note_node_id = ?").run(noteNodeId);
      const ins = this.db.prepare(`INSERT INTO why_claims
        (claim_id, note_node_id, claim_kind, text, source_type, verification_state, status, evidence_ids_json, code_fingerprint, confidence, last_checked_at)
        VALUES (@claimId,@noteNodeId,@claimKind,@text,@sourceType,@verificationState,@status,@evidenceIdsJson,@codeFingerprint,@confidence,@now)`);
      for (const c of claims) ins.run({ ...c, now });
    });
    tx();
  }

  whyClaimsFor(noteNodeId: string): WhyClaim[] {
    return this.db.prepare(`SELECT claim_id AS claimId, note_node_id AS noteNodeId, claim_kind AS claimKind,
      text, source_type AS sourceType, verification_state AS verificationState, status,
      evidence_ids_json AS evidenceIdsJson, code_fingerprint AS codeFingerprint, confidence, last_checked_at AS lastCheckedAt
      FROM why_claims WHERE note_node_id = ? ORDER BY claim_id`).all(noteNodeId) as WhyClaim[];
  }

  setClaimVerification(claimId: string, verificationState: string): void {
    this.db.prepare("UPDATE why_claims SET verification_state = ? WHERE claim_id = ?").run(verificationState, claimId);
  }
```

> Reconcile the timestamp approach with the store's existing convention (grep `toISOString`/`@now` in store.ts); if the store forbids `new Date()` in a deterministic path, thread a timestamp param instead. Match the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && node --test tests/why-claims-store.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/schema.ts packages/knowledge-core/src/store.ts tests/why-claims-store.test.mjs
git commit -m "feat(knowledge): why_claims table + store CRUD"
```

---

### Task 2: Endpoint contract-target selection

**Files:**
- Modify: `packages/knowledge-core/src/store.ts`
- Test: `tests/why-targets.test.mjs`

**Interfaces:**
- Produces: `whyTargets(): Array<{ endpointId: string; identityKey: string; title: string; consumerCount: number }>` — global gRPC endpoint nodes (identity `grpc::…`, repo_id NULL) that have ≥1 incoming `invokes` edge AND ≥1 `handles` edge. This is the evidence-gated MVP target set.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/why-targets.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("whyTargets returns endpoints with handler + consumer", () => {
  const store = new KnowledgeStore(":memory:");
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "SkinFragment.ClaimDailyFragment" });
  const handler = store.upsertNode({ nodeType: "symbol", identityKey: "fpms::Handler.claim", repoId: "fpms", title: "claim" });
  const consumer = store.upsertNode({ nodeType: "symbol", identityKey: "cp::vm.claim", repoId: "cp", title: "claim" });
  const lonely = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::Other.ping", repoId: null, title: "Other.Ping" });
  store.replaceFileEdges({ repoId: "fpms", branchId: "main", filePath: "h.ts", edges: [
    { src: ep, dst: handler, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true } ] });
  store.replaceFileEdges({ repoId: "cp", branchId: "main", filePath: "vm.tsx", edges: [
    { src: consumer, dst: ep, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true } ] });
  const t = store.whyTargets();
  assert.equal(t.length, 1);
  assert.equal(t[0].endpointId, ep);
  assert.equal(t[0].consumerCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && node --test tests/why-targets.test.mjs`
Expected: FAIL — `whyTargets` missing.

- [ ] **Step 3: Implement — add to `store.ts`**

```typescript
  whyTargets(): Array<{ endpointId: string; identityKey: string; title: string; consumerCount: number }> {
    return this.db.prepare(`
      SELECT n.id AS endpointId, n.identity_key AS identityKey, n.title AS title,
             COUNT(DISTINCT inv.id) AS consumerCount
      FROM nodes n
      JOIN edges h ON h.src = n.id AND h.edge_type = 'handles'
      JOIN edges inv ON inv.dst = n.id AND inv.edge_type = 'invokes'
      WHERE n.node_type = 'endpoint' AND n.repo_id IS NULL AND n.identity_key LIKE 'grpc::%'
      GROUP BY n.id
      HAVING consumerCount >= 1
      ORDER BY consumerCount DESC`).all() as Array<{ endpointId: string; identityKey: string; title: string; consumerCount: number }>;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && node --test tests/why-targets.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-core/src/store.ts tests/why-targets.test.mjs
git commit -m "feat(knowledge): whyTargets endpoint contract selection"
```

---

### Task 3: WHY-card generation module (structured output + guardrail) — pure, no I/O

**Files:**
- Create: `packages/knowledge-cli/src/why-card.ts`
- Test: `tests/why-card.test.mjs`

**Interfaces:**
- Produces:
  - `interface RawClaim { kind: "fact"|"inference"|"evidence"|"gap"; text: string; evidence_ids: string[]; confidence: number }`
  - `function parseClaims(llmText: string): RawClaim[]` — extract the JSON array from the LLM response (tolerates code fences); throws on unparseable.
  - `function groundClaims(claims: RawClaim[], resolvableEvidenceIds: Set<string>): { claims: Array<{ claimId: string; claimKind: string; text: string; sourceType: string; verificationState: string; status: string; evidenceIdsJson: string; codeFingerprint: string | null; confidence: number }>; writable: boolean }` — the GUARDRAIL: a `fact` whose evidence all resolves → `code_observed`/`verified_against_code`; otherwise demote to `ai_inferred`/`unchecked`. `writable` = false when there is no grounded fact or every claim is below the 0.3 confidence floor.
  - `const WHY_SYSTEM_PROMPT: string` and `function whyUserPrompt(title: string, packMarkdown: string, evidenceIds: string[]): string` — instruct the model to return ONLY a JSON array of claims citing evidence IDs from the provided list.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/why-card.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClaims, groundClaims } from "../packages/knowledge-cli/dist/why-card.js";

test("parses JSON claims (fenced)", () => {
  const out = "```json\n[{\"kind\":\"fact\",\"text\":\"x\",\"evidence_ids\":[\"e1\"],\"confidence\":0.9}]\n```";
  const c = parseClaims(out);
  assert.equal(c.length, 1);
  assert.equal(c[0].kind, "fact");
});

test("guardrail: unresolved fact demoted; ungrounded card not writable", () => {
  const claims = [
    { kind: "fact", text: "grounded", evidence_ids: ["e1"], confidence: 0.9 },
    { kind: "fact", text: "ungrounded", evidence_ids: ["nope"], confidence: 0.9 },
  ];
  const g = groundClaims(claims, new Set(["e1"]));
  const grounded = g.claims.find((c) => c.text === "grounded");
  const bad = g.claims.find((c) => c.text === "ungrounded");
  assert.equal(grounded.sourceType, "code_observed");
  assert.equal(bad.sourceType, "ai_inferred");        // demoted
  assert.equal(g.writable, true);                      // has ≥1 grounded fact
  const g2 = groundClaims([{ kind: "fact", text: "x", evidence_ids: ["nope"], confidence: 0.9 }], new Set());
  assert.equal(g2.writable, false);                    // no grounded fact
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-cli build && node --test tests/why-card.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/knowledge-cli/src/why-card.ts
import { randomUUID } from "node:crypto";

export interface RawClaim { kind: string; text: string; evidence_ids: string[]; confidence: number }

export function parseClaims(llmText: string): RawClaim[] {
  const fenced = llmText.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : llmText;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end < 0) throw new Error("no JSON array in LLM output");
  const arr = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error("LLM output is not an array");
  return arr.map((c) => ({
    kind: String(c.kind ?? "inference"),
    text: String(c.text ?? "").trim(),
    evidence_ids: Array.isArray(c.evidence_ids) ? c.evidence_ids.map(String) : [],
    confidence: typeof c.confidence === "number" ? c.confidence : 0,
  })).filter((c) => c.text.length > 0);
}

const CONFIDENCE_FLOOR = 0.3;

export function groundClaims(claims: RawClaim[], resolvable: Set<string>) {
  const out = claims.map((c) => {
    const allResolve = c.evidence_ids.length > 0 && c.evidence_ids.every((id) => resolvable.has(id));
    const isFact = c.kind === "fact" && allResolve;
    return {
      claimId: randomUUID(),
      claimKind: isFact ? "fact" : (c.kind === "fact" ? "inference" : c.kind), // demote unresolved fact
      text: c.text,
      sourceType: isFact ? "code_observed" : "ai_inferred",
      verificationState: isFact ? "verified_against_code" : "unchecked",
      status: "draft",
      evidenceIdsJson: JSON.stringify(c.evidence_ids.filter((id) => resolvable.has(id))),
      codeFingerprint: null as string | null,
      confidence: c.confidence,
    };
  });
  const hasGroundedFact = out.some((c) => c.sourceType === "code_observed");
  const anyAboveFloor = out.some((c) => c.confidence >= CONFIDENCE_FLOOR);
  return { claims: out, writable: hasGroundedFact && anyAboveFloor };
}

export const WHY_SYSTEM_PROMPT =
  "You are a senior engineer writing a WHY card for a cross-service gRPC endpoint. " +
  "Return ONLY a JSON array of claim objects: {kind:'fact'|'inference'|'gap', text, evidence_ids:[...], confidence:0..1}. " +
  "A 'fact' MUST cite evidence_ids drawn ONLY from the provided evidence list; if you cannot cite, use kind 'inference'. " +
  "Use 'gap' for what cannot be determined from the context. Do not invent evidence IDs or APIs.";

export function whyUserPrompt(title: string, packMarkdown: string, evidenceIds: string[]): string {
  return `Endpoint: ${title}\n\nAllowed evidence IDs (cite only these):\n${evidenceIds.join("\n")}\n\nContext:\n${packMarkdown}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-cli build && node --test tests/why-card.test.mjs`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-cli/src/why-card.ts tests/why-card.test.mjs
git commit -m "feat(cli): WHY-card structured-output parser + grounding guardrail"
```

---

### Task 4: Evidence-ID resolver (what the guardrail checks against)

**Files:**
- Create: `packages/knowledge-cli/src/why-evidence.ts`
- Test: `tests/why-evidence.test.mjs`

**Interfaces:**
- Produces: `function evidencePack(store, endpointId): { ids: string[]; markdown: string }` — deterministic evidence IDs for an endpoint: `edge:invokes:<consumerNodeId>`, `edge:handles:<handlerNodeId>`, `edge:tests:<testNodeId>`, plus a short markdown listing them. The returned `ids` become the `resolvable` set for the guardrail AND the allowed-IDs the prompt shows the model.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/why-evidence.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { evidencePack } from "../packages/knowledge-cli/dist/why-evidence.js";

test("evidence ids from handles/invokes edges", () => {
  const store = new KnowledgeStore(":memory:");
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "ep" });
  const h = store.upsertNode({ nodeType: "symbol", identityKey: "fpms::H.claim", repoId: "fpms", title: "claim" });
  const c = store.upsertNode({ nodeType: "symbol", identityKey: "cp::vm.claim", repoId: "cp", title: "claim" });
  store.replaceFileEdges({ repoId: "fpms", branchId: "main", filePath: "h.ts", edges: [{ src: ep, dst: h, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }] });
  store.replaceFileEdges({ repoId: "cp", branchId: "main", filePath: "v.tsx", edges: [{ src: c, dst: ep, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true }] });
  const ev = evidencePack(store, ep);
  assert.ok(ev.ids.includes(`edge:handles:${h}`));
  assert.ok(ev.ids.includes(`edge:invokes:${c}`));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-cli build && node --test tests/why-evidence.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/knowledge-cli/src/why-evidence.ts
import type { KnowledgeStore } from "@penguin/knowledge-core";

export function evidencePack(store: KnowledgeStore, endpointId: string): { ids: string[]; markdown: string } {
  const db = (store as unknown as { db: import("better-sqlite3").Database }).db;
  const ids: string[] = [];
  const lines: string[] = [];
  const handlers = db.prepare("SELECT dst FROM edges WHERE src = ? AND edge_type = 'handles'").all(endpointId) as { dst: string }[];
  for (const h of handlers) { ids.push(`edge:handles:${h.dst}`); lines.push(`- edge:handles:${h.dst} (server handler)`); }
  const consumers = db.prepare("SELECT src FROM edges WHERE dst = ? AND edge_type = 'invokes'").all(endpointId) as { src: string }[];
  for (const c of consumers) { ids.push(`edge:invokes:${c.src}`); lines.push(`- edge:invokes:${c.src} (consumer)`); }
  return { ids, markdown: lines.join("\n") };
}
```

> If `store.db` is private, add a tiny public accessor on the store instead of the cast. Match the codebase convention (the store already exposes `db` for the proto pass in pipeline.ts).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/why-evidence.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-cli/src/why-evidence.ts tests/why-evidence.test.mjs
git commit -m "feat(cli): deterministic evidence pack + IDs for an endpoint"
```

---

### Task 5: `penguin why` command (generation + persistence, injectable completion)

**Files:**
- Create: `packages/knowledge-cli/src/why.ts` (the command body)
- Modify: `packages/knowledge-cli/src/index.ts` (register `verb === "why"`; add `why` to help ~line 102-114)
- Test: `tests/why-command.test.mjs`

**Interfaces:**
- Consumes: `whyTargets`, `buildContextPack`, `renderContextPackMarkdown`, `evidencePack`, `parseClaims`, `groundClaims`, `WHY_SYSTEM_PROMPT`, `whyUserPrompt`, `resolveProvider`, `aiComplete`, `store.replaceWhyClaims`, `store.upsertNode` (bind note), note writer.
- Produces: `async function runWhy(deps, opts: { complete?: (messages) => Promise<string> }): Promise<{ generated: number; skipped: number }>` — for each `whyTargets()` endpoint: build pack + evidence, call `complete` (default aiComplete via resolveProvider), parseClaims → groundClaims; if `writable`, `replaceWhyClaims(endpointId, claims)` + write/update the Markdown note bound to the endpoint node; else count skipped.

- [ ] **Step 1: Write the failing test (stub completion — no network)**

```javascript
// tests/why-command.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runWhy } from "../packages/knowledge-cli/dist/why.js";

test("generates a card for a grounded endpoint via stub LLM", async () => {
  const store = new KnowledgeStore(":memory:");
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::SkinFragment.claimdailyfragment", repoId: null, title: "SkinFragment.ClaimDailyFragment" });
  const h = store.upsertNode({ nodeType: "symbol", identityKey: "fpms::H.claim", repoId: "fpms", title: "claim" });
  const c = store.upsertNode({ nodeType: "symbol", identityKey: "cp::vm.claim", repoId: "cp", title: "claim" });
  store.replaceFileEdges({ repoId: "fpms", branchId: "main", filePath: "h.ts", edges: [{ src: ep, dst: h, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }] });
  store.replaceFileEdges({ repoId: "cp", branchId: "main", filePath: "v.tsx", edges: [{ src: c, dst: ep, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true }] });

  const stub = async () => JSON.stringify([
    { kind: "fact", text: "casino-plus consumes this endpoint; FPMS handles it.", evidence_ids: [`edge:invokes:${c}`, `edge:handles:${h}`], confidence: 0.9 },
    { kind: "gap", text: "business reason not in code", evidence_ids: [], confidence: 0.5 },
  ]);
  const deps = { openStore: () => store, storeExists: () => true, notesDir: null, err: () => {}, };
  const r = await runWhy(deps, { complete: stub });
  assert.equal(r.generated, 1);
  const claims = store.whyClaimsFor(ep);
  assert.ok(claims.some((x) => x.sourceType === "code_observed"));
});
```

> Reconcile the `deps` shape with the real CLI `deps` object (openStore/storeExists/err/notesDir/emit). The command must not require `notesDir` to persist claims (the note file is optional in MVP — claims in `why_claims` are the source of truth).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-cli build && node --test tests/why-command.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `why.ts`**

```typescript
// packages/knowledge-cli/src/why.ts
import { buildContextPack, renderContextPackMarkdown } from "@penguin/knowledge-core";
import { resolveProvider, aiComplete, type AIMessage } from "./ai.js";
import { evidencePack } from "./why-evidence.js";
import { parseClaims, groundClaims, WHY_SYSTEM_PROMPT, whyUserPrompt } from "./why-card.js";

type CompleteFn = (messages: AIMessage[]) => Promise<string>;

export async function runWhy(
  deps: { openStore: () => any; err: (m: string) => void },
  opts: { complete?: CompleteFn; provider?: string; model?: string; key?: string } = {},
): Promise<{ generated: number; skipped: number }> {
  const store = deps.openStore();
  const complete: CompleteFn = opts.complete
    ?? ((messages) => aiComplete(resolveProvider({ provider: opts.provider, model: opts.model, apiKey: opts.key }), messages));
  let generated = 0, skipped = 0;
  try {
    for (const t of store.whyTargets()) {
      const pack = buildContextPack(store, t.title);
      if (!pack.focus) { skipped++; continue; }
      const ev = evidencePack(store, t.endpointId);
      const md = `${renderContextPackMarkdown(pack)}\n\nEvidence:\n${ev.markdown}`;
      let claims;
      try {
        claims = parseClaims(await complete([
          { role: "system", content: WHY_SYSTEM_PROMPT },
          { role: "user", content: whyUserPrompt(t.title, md, ev.ids) },
        ]));
      } catch (e) { deps.err(`why ${t.title}: ${(e as Error).message}`); skipped++; continue; }
      const grounded = groundClaims(claims, new Set(ev.ids));
      if (!grounded.writable) { skipped++; continue; }
      store.replaceWhyClaims(t.endpointId, grounded.claims.map((c) => ({ ...c, noteNodeId: t.endpointId })));
      generated++;
    }
  } finally {
    store.close();
  }
  return { generated, skipped };
}
```

3b. `index.ts` — register the command (mirror the `explain` block ~line 310) and add `why` to the help text (~line 102-114):

```typescript
  if (verb === "why") {
    if (!deps.storeExists()) { deps.err("no knowledge database — run `penguin init` first"); return 3; }
    const flagVal = (name: string) => flags.find((fl) => fl.startsWith(`--${name}=`))?.slice(name.length + 3);
    const r = await runWhy(deps, { provider: flagVal("provider"), model: flagVal("model"), key: flagVal("key") });
    emit(deps, json, `why: generated ${r.generated}, skipped ${r.skipped}`, { ok: true, ...r });
    return 0;
  }
```

> `runWhy` calls `deps.openStore()`/`store.close()` itself; ensure that matches how other verbs manage the store (some open+close in `index.ts`). If `index.ts` already opens the store per verb, refactor `runWhy` to accept a `store` instead. Match the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-cli build && node --test tests/why-command.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-cli/src/why.ts packages/knowledge-cli/src/index.ts tests/why-command.test.mjs
git commit -m "feat(cli): penguin why — grounded WHY-card generation (MVP, no PRD)"
```

---

### Task 6: `penguin why --check` — code-fingerprint staleness

**Files:**
- Modify: `packages/knowledge-cli/src/why.ts` (add `checkWhy`)
- Modify: `packages/knowledge-cli/src/index.ts` (route `--check`)
- Test: `tests/why-check.test.mjs`

**Interfaces:**
- Produces: `function checkWhy(store): { stale: number }` — for each note with claims, recompute the endpoint's evidence-ID set; any claim whose stored `evidenceIdsJson` references an ID no longer present → `setClaimVerification(claimId, "stale")`.

- [ ] **Step 1: Write the failing test**

```javascript
// tests/why-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { checkWhy } from "../packages/knowledge-cli/dist/why.js";

test("claim goes stale when its evidence edge disappears", () => {
  const store = new KnowledgeStore(":memory:");
  const ep = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc::S.m", repoId: null, title: "ep" });
  store.replaceWhyClaims(ep, [{ claimId: "c1", noteNodeId: ep, claimKind: "fact", text: "x", sourceType: "code_observed", verificationState: "verified_against_code", status: "draft", evidenceIdsJson: '["edge:invokes:GONE"]', codeFingerprint: null, confidence: 0.9 }]);
  const r = checkWhy(store); // GONE is not a live edge
  assert.equal(r.stale, 1);
  assert.equal(store.whyClaimsFor(ep)[0].verificationState, "stale");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm -C packages/knowledge-cli build && node --test tests/why-check.test.mjs`
Expected: FAIL — `checkWhy` missing.

- [ ] **Step 3: Implement — add to `why.ts`**

```typescript
import { evidencePack } from "./why-evidence.js";

export function checkWhy(store: any): { stale: number } {
  let stale = 0;
  for (const t of store.whyTargets()) {
    const live = new Set(evidencePack(store, t.endpointId).ids);
    for (const c of store.whyClaimsFor(t.endpointId)) {
      const ids: string[] = JSON.parse(c.evidenceIdsJson || "[]");
      const drifted = ids.length > 0 && ids.some((id) => !live.has(id));
      if (drifted && c.verificationState !== "stale") { store.setClaimVerification(c.claimId, "stale"); stale++; }
    }
  }
  // Also cover notes whose endpoint no longer appears in whyTargets (handler/consumer gone):
  return { stale };
}
```

> The test's claim references an endpoint (`grpc::S.m`) with NO live edges, so it won't appear in `whyTargets()` (needs handler+consumer). Extend `checkWhy` to iterate ALL notes with claims (add `store.notesWithClaims(): string[]` returning distinct `note_node_id`) rather than only `whyTargets()`, so orphaned/drifted cards are caught. Add that tiny store method in this task and iterate it.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm -C packages/knowledge-core build && pnpm -C packages/knowledge-cli build && node --test tests/why-check.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/knowledge-cli/src/why.ts packages/knowledge-cli/src/index.ts packages/knowledge-core/src/store.ts tests/why-check.test.mjs
git commit -m "feat(cli): penguin why --check staleness pass"
```

---

### Task 7: Wiki display — read-only WHY claims in WikiWhyPanel

**Files:**
- Modify: `packages/knowledge-core/src/query.ts` (or knowledge-client bridge) — expose `whyClaimsFor(nodeId)` result to the app
- Modify: `src/lib/knowledge-client.ts` — a `getWhyClaims(nodeId)` call
- Modify: `src/components/wiki/WikiWhyPanel.tsx` — render claims: FACTS block + collapsed INFERENCE block + GAPS; confirm/reject buttons call a status setter; a `stale` badge
- Test: `tests/why-claims-store.test.mjs` already covers the store read; add a light render smoke test if the repo has component tests (else manual).

**Interfaces:**
- Consumes: `store.whyClaimsFor`. Produces: WHY claims visible in the Wiki, FACTS and INFERENCE visually isolated (inference collapsed by default), `stale` badge, confirm/reject wired to a status update.

- [ ] **Step 1: Add the client read + render (no new test infra)**

Wire `whyClaimsFor` through the existing knowledge-client bridge the same way `ContextPack`/notes are surfaced (`src/lib/knowledge-client.ts:150-229` region). In `WikiWhyPanel.tsx`, render three sections from the claims: `code_observed` facts (prominent), `ai_inferred` (a collapsed "AI interpretation" block, grey), `gap` (needs-a-human). Add a `stale` badge when any claim `verification_state === 'stale'`. Add confirm/reject buttons that set claim `status`.

- [ ] **Step 2: Manual verification**

Run `penguin why` against a real indexed DB (flyover + casino-plus + FPMS), open the Wiki, select the `SkinFragment.ClaimDailyFragment` endpoint, confirm the WHY panel shows grounded FACTS (casino-plus consumer + FPMS handler), a collapsed inference block, and a GAP. Confirm one card, edit code, run `penguin why --check`, confirm the stale badge appears.

- [ ] **Step 3: Commit**

```bash
git add src/lib/knowledge-client.ts src/components/wiki/WikiWhyPanel.tsx packages/knowledge-core/src/query.ts
git commit -m "feat(wiki): render WHY claims (facts/inference/gaps) with stale badge"
```

---

## Self-Review

**1. Spec coverage** (against corrected `2026-07-11-wiki-why-layer-design.md`, MVP scope):
- Generation = new `penguin why` reusing aiComplete + buildContextPack (NOT indexer, NOT write_note) → Tasks 3, 5. ✓
- Endpoint-bound + `why_claims` table + stable selectors → Tasks 1, 5. ✓
- Guardrail (evidence-ID must resolve or demote; no ungrounded card) + confidence floor → Tasks 3, 4. ✓
- Two-axis trust (source_type × verification_state), status lifecycle → Task 1 schema + Task 3 grounding. ✓
- Target gate (handler + consumer) → Task 2. ✓
- Checks at generation + `--check` pass, not render; render reads stored state → Tasks 5, 6, 7. ✓
- Governance UX (facts/inference isolation, confirm/reject, stale badge) → Task 7. ✓
- NO PRD (phase 2) → out of this plan. ✓
- Diff-since-confirmed + FACT-vs-graph discrepancy background check → PARTIAL (only edge-presence staleness in Task 6; full discrepancy recompute + diff UI deferred — note as a phase-1.5 follow-up).

**2. Placeholder scan:** No TBD/TODO; code in every code step. Several grounded "reconcile with real CLI deps/store-lifecycle/timestamp convention" notes — verify-against-real-code instructions, flagged.

**3. Type consistency:** `WhyClaim`/`replaceWhyClaims`/`whyClaimsFor`/`setClaimVerification`/`whyTargets`/`evidencePack`/`parseClaims`/`groundClaims`/`runWhy`/`checkWhy` consistent across tasks. Claim object shape (claimId/claimKind/text/sourceType/verificationState/status/evidenceIdsJson/codeFingerprint/confidence) matches between Task 1 store and Task 3 grounding. ✓

**Known risks to resolve during execution:**
- Real CLI `deps` object + per-verb store open/close convention (Tasks 5/6) — mirror an existing verb.
- Store `db` visibility for `evidencePack`/timestamp convention for `replaceWhyClaims` (Tasks 1/4).
- Task 6 must iterate ALL notes-with-claims, not just `whyTargets()`, to catch orphaned/drifted cards.
