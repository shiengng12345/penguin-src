import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, GitTopologyStore, SourceSnapshotStore, SourceStore, searchPath } from "../packages/knowledge-core/dist/index.js";

test("path search ranks exact paths, normalizes separators, and exposes excluded metadata only", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-path-search-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "paths", rootPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "paths", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
  const source = new SourceStore(store);
  const paths = ["libs/tools/src/vault/types/legitimuz-config.type.ts", "apps/other/legitimuz-config.type.ts"];
  const cow = new SourceSnapshotStore(store);
  const overlays = [];
  for (const filePath of paths) {
    const raw = Buffer.from(`export const ${filePath.replaceAll("/", "_")} = true;`, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: raw.toString("utf8"), encoding: "utf8" });
    const fact = source.putSourceFact({ repoId, filePath, factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "source" } });
    overlays.push({ op: "add", path: filePath, sourceFactId: fact });
  }
  cow.replaceOverlay(snapshot.id, overlays);
  cow.materializeManifest(snapshot.id);
  store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(repoId, "secrets/config.env", "tracked", "excluded", "secret_path", "secret", 10, "secret", new Date().toISOString());
  const exact = searchPath(store, { repoId, snapshotId: snapshot.id }, "libs/tools/src/vault/types/legitimuz-config.type.ts");
  assert.equal(exact[0].filePath, paths[0]);
  const slash = searchPath(store, { repoId, snapshotId: snapshot.id }, "libs\\tools\\src\\vault\\types\\legitimuz-config.type.ts");
  assert.equal(slash[0].filePath, paths[0]);
  assert.throws(() => searchPath(store, { repoId, snapshotId: snapshot.id }, "../secrets/config.env"), /PATH_OUTSIDE_WORKSPACE/);
  const excluded = searchPath(store, { repoId, snapshotId: snapshot.id }, "secrets/config.env", true);
  assert.equal(excluded[0].metadataOnly, true);
  store.close();
});
