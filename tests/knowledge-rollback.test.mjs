import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, exportKnowledgeArtifact, importKnowledgeArtifact } from "../packages/knowledge-core/dist/index.js";

test("rollback artifact can be validated without mutating the active store", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-rollback-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const artifact = exportKnowledgeArtifact(store, { signingKey: "rollback-sign", encryptionKey: "rollback-encrypt" });
  const restored = importKnowledgeArtifact(artifact.bytes, { signingKey: "rollback-sign", encryptionKey: "rollback-encrypt" });
  assert.equal(restored.manifest.formatVersion, 1);
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, String(13));
  store.close();
});
