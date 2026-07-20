import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, search } from "../packages/knowledge-core/dist/index.js";

test("legacy search keeps array fields and exposes canonical v2 response during deprecation window", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-legacy-search-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: "repo::src/a.ts::login", title: "login", repoId: "repo" });
  store.indexSymbolText({ nodeId, name: "login", signature: "login()" });
  const result = search(store, "login");
  assert.ok(Array.isArray(result));
  assert.ok(result.some((row) => row.nodeId === nodeId));
  assert.equal(result.schemaVersion, "2");
  assert.equal(result.deprecation.removalVersion, "3.0.0");
  assert.equal(result.v2.schemaVersion, "2");
  store.close();
});
