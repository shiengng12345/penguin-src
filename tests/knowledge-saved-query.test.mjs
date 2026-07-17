import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, SavedQueryStore } from "../packages/knowledge-core/dist/index.js";

test("saved queries are durable, idempotent by name, and preserve the canonical request", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-saved-query-"));
  const store = KnowledgeStore.open({ dbPath: join(root, "knowledge.db"), ledgerPath: join(root, "ledger.jsonl") });
  const queries = new SavedQueryStore(store);
  const first = queries.write({ name: "cpf lookup", request: { query: "findAllByCpf", mode: "exact" }, scope: { repo: "auth" } });
  const second = queries.write({ name: "cpf lookup", request: { query: "findAllByCpf", mode: "phrase" }, scope: { repo: "auth" } });
  assert.equal(first.id, second.id);
  assert.deepEqual(queries.get("cpf lookup")?.request, { query: "findAllByCpf", mode: "phrase" });
  assert.equal(queries.get("cpf lookup")?.contractVersion, "2");
  assert.equal(queries.list("cpf").length, 1);
  assert.equal(queries.remove("cpf lookup"), true);
  assert.equal(queries.get("cpf lookup"), null);
  store.close();
});
