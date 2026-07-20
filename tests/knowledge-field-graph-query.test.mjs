import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, search } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { graphQuery } from "../packages/knowledge-core/dist/index.js";

test("field search returns a graph-backed locator for writers and readers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-field-"));
  mkdirSync(join(root, ".git", "refs", "heads"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, ".git", "refs", "heads", "main"), "field-fixture\n");
  writeFileSync(join(root, "profile.ts"), `
    export function writeProfile(profile: { cpf: string }) {
      profile.cpf = "synthetic-cpf";
    }
    export function readProfile(profile: { cpf: string }) {
      return profile.cpf;
    }
  `);
  const dir = mkdtempSync(join(tmpdir(), "pk-field-db-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  const fieldHits = search(store, "cpf", { type: ["field"], includeSensitive: false });
  assert.ok(fieldHits.length >= 1);
  assert.ok(fieldHits.every((hit) => hit.nodeType === "field" && hit.filePath === "profile.ts"));
  const field = store.db.prepare("SELECT id FROM nodes WHERE node_type='field' AND title='cpf' LIMIT 1").get();
  assert.ok(field?.id);
  const result = graphQuery(store, { start: { nodeIds: [field.id] }, traverse: [{ edgeTypes: ["writes_field"], direction: "in", minDepth: 1, maxDepth: 1, statuses: ["verified"] }], project: ["nodes", "edges"], limit: 20 });
  assert.ok(result.nodes.some((node) => node.title === "writeProfile"));
  store.close();
});
