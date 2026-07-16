import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore, ResolutionStore } from "../packages/knowledge-core/dist/index.js";
import { resolutionContextFingerprint, dependentInvalidationClosure } from "../packages/knowledge-indexer/dist/index.js";

test("resolution sets are reused only for the complete context fingerprint", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-resolution-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "resolution", rootPath: join(dir, "repo") });
  const facts = store.db.prepare("INSERT INTO file_facts (id,repo_id,file_path,content_hash,language,parser_version,facts_json,exports_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)");
  facts.run("fact", repoId, "consumer.ts", "same", "ts", "p1", "{}", "exports", new Date().toISOString());
  const resolution = new ResolutionStore(store);
  const a = resolution.replaceResolutionSet({ fileFactId: "fact", contextFingerprint: "ctx-main", resolverVersion: "r1", edges: [{ srcIdentityKey: "consumer", dstIdentityKey: "mainRun", edgeType: "calls", method: "resolved", confidence: 1, provenance: {} }] });
  const b = resolution.replaceResolutionSet({ fileFactId: "fact", contextFingerprint: "ctx-feature", resolverVersion: "r1", edges: [{ srcIdentityKey: "consumer", dstIdentityKey: "featureRun", edgeType: "calls", method: "resolved", confidence: 1, provenance: {} }] });
  assert.notEqual(a.id, b.id);
  assert.equal(resolution.findReusableSet({ fileFactId: "fact", contextFingerprint: "ctx-main", resolverVersion: "r1" }).id, a.id);
  assert.equal(store.db.prepare("SELECT dst_identity_key FROM resolved_edges WHERE resolution_set_id=?").get(a.id).dst_identity_key, "mainRun");
  resolution.attachSnapshotResolution({ snapshotId: "snap", filePath: "consumer.ts", resolutionSetId: a.id });
  const old = new Date(Date.now() + 1000);
  assert.deepEqual(resolution.deleteUnreferencedResolutionSets(old), [b.id]);
  store.close();
});

test("context fingerprint and importer invalidation include ambient context", () => {
  const base = { fileFactId: "fact", imports: [{ specifier: "./run", resolvedPath: "run.ts", exportsHash: "a" }], ambientSymbolSurfaceHash: "ambient-a", resolverConfigHash: "config", resolverVersion: "r1" };
  assert.notEqual(resolutionContextFingerprint(base), resolutionContextFingerprint({ ...base, ambientSymbolSurfaceHash: "ambient-b" }));
  assert.deepEqual([...dependentInvalidationClosure(new Set(["run.ts"]), new Map([["run.ts", new Set(["consumer.ts"])], ["consumer.ts", new Set(["transitive.ts"])]]))].sort(), ["consumer.ts", "run.ts", "transitive.ts"]);
});
