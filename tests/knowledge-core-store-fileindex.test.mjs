import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

function openTemp() {
  const dir = mkdtempSync(join(tmpdir(), "pk-fchk-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function scope(store) {
  const repoId = store.registerRepo({ name: "fpms", rootPath: "/work/fpms" });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  return { repoId, branchId };
}

test("upsertFileCheckpoint stores + updates on (repo,branch,path) and stamps indexed_at", () => {
  const store = openTemp();
  const { repoId, branchId } = scope(store);
  const id1 = store.upsertFileCheckpoint({
    repoId, branchId, filePath: "src/a.ts", lang: "ts",
    mtimeMs: 1000, sizeBytes: 50, contentHash: "h1", status: "indexed",
  });
  const c1 = store.getFileCheckpoint(repoId, branchId, "src/a.ts");
  assert.equal(c1.content_hash, "h1");
  assert.equal(c1.mtime_ms, 1000);
  assert.ok(c1.indexed_at);

  const id2 = store.upsertFileCheckpoint({
    repoId, branchId, filePath: "src/a.ts",
    mtimeMs: 2000, sizeBytes: 60, contentHash: "h2", status: "indexed",
  });
  assert.equal(id1, id2);
  const c2 = store.getFileCheckpoint(repoId, branchId, "src/a.ts");
  assert.equal(c2.content_hash, "h2");
  assert.equal(c2.mtime_ms, 2000);
  assert.equal(store.getFileCheckpoint(repoId, branchId, "src/missing.ts"), null);
  store.close();
});

test("listFileCheckpoints returns the branch's files ordered by path", () => {
  const store = openTemp();
  const { repoId, branchId } = scope(store);
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "src/b.ts", status: "indexed" });
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "src/a.ts", status: "indexed" });
  const other = store.registerBranch({ repoId, name: "feature/x", status: "live" });
  store.upsertFileCheckpoint({ repoId, branchId: other, filePath: "src/z.ts", status: "indexed" });

  const paths = store.listFileCheckpoints(repoId, branchId).map((r) => r.file_path);
  assert.deepEqual(paths, ["src/a.ts", "src/b.ts"]);
  store.close();
});

test("markFileDeleted flips status to deleted", () => {
  const store = openTemp();
  const { repoId, branchId } = scope(store);
  store.upsertFileCheckpoint({ repoId, branchId, filePath: "src/a.ts", status: "indexed" });
  store.markFileDeleted({ repoId, branchId, filePath: "src/a.ts" });
  assert.equal(store.getFileCheckpoint(repoId, branchId, "src/a.ts").status, "deleted");
  store.markFileDeleted({ repoId, branchId, filePath: "src/nope.ts" });
  assert.equal(store.getFileCheckpoint(repoId, branchId, "src/nope.ts"), null);
  store.close();
});
