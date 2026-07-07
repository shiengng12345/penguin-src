import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openDatabase, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";

function tempDbPath() {
  return join(mkdtempSync(join(tmpdir(), "pk-fidx-")), "knowledge.db");
}

test("schema version is 3 and meta records it", () => {
  assert.equal(SCHEMA_VERSION, 3);
  const db = openDatabase(tempDbPath());
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  assert.equal(row.value, "3");
  db.close();
});

test("files_index table exists with the spec columns and unique key", () => {
  const db = openDatabase(tempDbPath());
  const cols = db.prepare("PRAGMA table_info(files_index)").all().map((c) => c.name);
  for (const c of [
    "id", "repo_id", "branch_id", "file_path", "lang",
    "mtime_ms", "size_bytes", "content_hash", "indexed_at", "status", "error",
  ]) {
    assert.ok(cols.includes(c), `files_index missing column: ${c}`);
  }
  db.prepare(
    "INSERT INTO files_index (id, repo_id, branch_id, file_path, status) VALUES ('f1','r1','b1','src/a.ts','indexed')",
  ).run();
  assert.throws(
    () =>
      db.prepare(
        "INSERT INTO files_index (id, repo_id, branch_id, file_path, status) VALUES ('f2','r1','b1','src/a.ts','indexed')",
      ).run(),
    /UNIQUE/i,
  );
  db.close();
});

test("openDatabase remains idempotent with the new table", () => {
  const path = tempDbPath();
  openDatabase(path).close();
  const db = openDatabase(path);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files_index").get().n, 0);
  db.close();
});
