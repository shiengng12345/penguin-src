import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("outdated schema + read-only open throws SCHEMA_OUTDATED instead of migrating", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-readonly-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  store.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run();
  store.close();

  assert.throws(
    () => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false }),
    (err) => err.code === "SCHEMA_OUTDATED",
  );
  // Stored version untouched by the failed read-only open:
  const writable = KnowledgeStore.open({ dbPath, ledgerPath });
  // (writable open migrates as before)
  const stored = writable.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 14);
  writable.close();
});
