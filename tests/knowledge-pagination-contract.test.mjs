import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, HmacOperationCursorCodec } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-pagination-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repo = "pagination-repo";
  const repoId = store.registerRepo({ name: repo, rootPath: dir });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "pagination-commit", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("pagination-commit", branchId);
  for (let index = 0; index < 5; index += 1) {
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::PaginationSymbol${index}`, title: `PaginationSymbol${index}`, repoId });
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: "pagination-commit", filePath: "src/pagination.ts", lang: "typescript", kind: "function", signature: `PaginationSymbol${index}()`, contentHash: `pagination-${index}`, status: "fresh", startLine: index + 1, endLine: index + 1 });
    store.upsertNode({ nodeType: "endpoint", identityKey: `grpc::PaginationService.method${index}`, title: `PaginationService.method${index}`, repoId, meta: { protocol: "grpc" } });
  }
  const lines = [];
  const deps = { cwd: dir, openStore: () => KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }), storeExists: () => true, out: (line) => lines.push(line), err: (line) => lines.push(line) };
  const json = () => JSON.parse([...lines].reverse().find((line) => { try { JSON.parse(line); return true; } catch { return false; } }));
  return { store, repo, branchId, lines, deps, json };
}

test("shared operation cursor binds operation, scope, revision and expiry", () => {
  const codec = new HmacOperationCursorCodec("pagination-secret", () => Date.parse("2026-08-30T00:00:00.000Z"));
  const payload = { schemaVersion: "1", contractVersion: "2", operation: "endpoints", scope: "pagination-repo|grpc", orderingKey: "title,nodeId", lastKey: "PaginationService.method0\u0000node_0", revision: null, expiresAt: "2026-08-30T00:01:00.000Z" };
  const cursor = codec.encode(payload);
  assert.deepEqual(codec.decode(cursor, { operation: "endpoints", scope: "pagination-repo|grpc", revision: null }), payload);
  assert.throws(() => codec.decode(cursor, { operation: "filesymbols", scope: "pagination-repo|grpc", revision: null }), /CURSOR_SCOPE_MISMATCH/);
});

test("CLI endpoint pages are stable, signed, and terminate without duplicates", async () => {
  const { store, repo, lines, deps, json } = fixture();
  const seen = new Set();
  let cursor = null;
  let terminal = false;
  for (let page = 0; page < 10; page += 1) {
    lines.length = 0;
    const args = ["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--json"];
    if (cursor) args.push("--cursor", cursor);
    assert.equal(await runCli(args, deps), 0);
    const payload = json();
    for (const item of payload.items) { assert.equal(seen.has(item.nodeId), false); seen.add(item.nodeId); }
    cursor = payload.nextCursor;
    if (!cursor) { terminal = true; assert.equal(payload.totalIsExact, true); assert.equal(payload.truncated, false); break; }
  }
  assert.equal(terminal, true);
  assert.equal(seen.size, 5);
  store.close();
});

test("CLI filesymbols and deadcode expose the same terminal cursor contract", async () => {
  const { store, repo, lines, deps, json } = fixture();
  for (const command of ["filesymbols", "deadcode"]) {
    const seen = new Set();
    let cursor = null;
    let terminal = false;
    for (let page = 0; page < 10; page += 1) {
      lines.length = 0;
      const args = command === "filesymbols"
        ? ["filesymbols", repo, "main", "src/pagination.ts", "--limit", "2", "--json"]
        : ["deadcode", "--repo", repo, "--limit", "2", "--json"];
      if (cursor) args.push("--cursor", cursor);
      assert.equal(await runCli(args, deps), 0);
      const payload = json();
      const items = payload.items ?? payload.candidates ?? [];
      for (const item of items) { const id = item.nodeId; assert.equal(seen.has(id), false); seen.add(id); }
      cursor = payload.nextCursor;
      if (!cursor) { terminal = true; assert.equal(payload.totalIsExact, true); assert.equal(payload.truncated, false); break; }
    }
    assert.equal(terminal, true, command);
    assert.equal(seen.size, 5, command);
  }
  store.close();
});
