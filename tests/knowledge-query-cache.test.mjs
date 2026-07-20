import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { QueryServerCaches } from "../packages/knowledge-cli/dist/query-server.js";

test("resident query caches retain prepared/capability state and invalidate explicitly", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-query-cache-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const caches = new QueryServerCaches(store);
  caches.prepare("SELECT 1");
  caches.prepare("SELECT 1");
  assert.equal(caches.stats().preparedStatements, 1);
  assert.equal(caches.capabilityRegistry.length > 0, true);
  const before = caches.stats().invalidationEpoch;
  caches.invalidate();
  assert.equal(caches.stats().invalidationEpoch, before + 1);
  store.close();
});

