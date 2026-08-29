import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

// Delete detection compared the walker's output against the stored file
// CHECKPOINTS. A rebuild clears those first, so it had nothing to compare and
// retired nothing — the operation meant to produce a clean index was the one
// that could not. Any file that left the candidate set kept its symbols, still
// marked fresh: adding one .gitignore line left 152 live symbols behind for
// compiled .js the indexer no longer reads.

function repo() {
  const root = mkdtempSync(join(tmpdir(), "pk-orphan-"));
  const write = (path, body) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  };
  write("src/keep.ts", "export function keptFunction() { return 1; }\n");
  write("src/generated.js", "export function ghostFunction() { return 2; }\n");
  write(".gitignore", "node_modules\n");
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });

  const dir = mkdtempSync(join(tmpdir(), "pk-orphandb-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  return { root, store, write };
}

const freshTitles = (store, like) => store.db
  .prepare("SELECT n.title FROM symbol_versions sv JOIN nodes n ON n.id = sv.node_id WHERE sv.status='fresh' AND sv.file_path LIKE ?")
  .all(like)
  .map((row) => row.title);

test("a file that becomes git-ignored loses its symbols on the next index", async () => {
  const { root, store } = repo();
  await indexRepo({ store, rootPath: root, mode: "rebuild" });
  assert.deepEqual(freshTitles(store, "src/generated.js"), ["ghostFunction"], "baseline: it was indexed");

  // Ignore it and untrack it — the file stays on disk, so a
  // does-the-file-exist check would never notice.
  appendFileSync(join(root, ".gitignore"), "src/generated.js\n");
  execFileSync("git", ["rm", "--cached", "-q", "src/generated.js"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore"], { cwd: root });

  await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.deepEqual(
    freshTitles(store, "src/generated.js"),
    [],
    "a symbol from a file the index no longer covers must not stay fresh",
  );
  assert.deepEqual(freshTitles(store, "src/keep.ts"), ["keptFunction"], "real code is untouched");
  store.close();
});

test("a rebuild retires them too, not just an incremental run", async () => {
  // This is the case the checkpoint comparison could not see at all: rebuild
  // clears the checkpoints before the sweep runs.
  const { root, store } = repo();
  await indexRepo({ store, rootPath: root, mode: "rebuild" });
  appendFileSync(join(root, ".gitignore"), "src/generated.js\n");
  execFileSync("git", ["rm", "--cached", "-q", "src/generated.js"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore"], { cwd: root });

  await indexRepo({ store, rootPath: root, mode: "rebuild" });
  assert.deepEqual(freshTitles(store, "src/generated.js"), []);
  assert.deepEqual(freshTitles(store, "src/keep.ts"), ["keptFunction"]);
  store.close();
});

test("edges into a retired file go with it", async () => {
  const { root, store, write } = repo();
  write("src/caller.ts", [
    "import { ghostFunction } from './generated.js';",
    "export function callsGhost() { return ghostFunction(); }",
  ].join("\n"));
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "caller"], { cwd: root });
  await indexRepo({ store, rootPath: root, mode: "rebuild" });

  const edgesInto = () => store.db.prepare(`
    SELECT COUNT(*) AS n FROM edges e
      JOIN symbol_versions sv ON sv.node_id = e.dst
     WHERE e.status='active' AND sv.file_path = 'src/generated.js'`).get().n;
  assert.ok(edgesInto() > 0, "baseline: the call resolved");

  appendFileSync(join(root, ".gitignore"), "src/generated.js\n");
  execFileSync("git", ["rm", "--cached", "-q", "src/generated.js"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "ignore"], { cwd: root });
  await indexRepo({ store, rootPath: root, mode: "rebuild" });

  assert.equal(freshTitles(store, "src/generated.js").length, 0);
  store.close();
});

test("an unchanged file skipped by the incremental filter is not mistaken for an orphan", async () => {
  // `seen` must hold every path the walker produced, including ones skipped as
  // unchanged — otherwise the sweep would retire the entire index on the second
  // run of any incremental index.
  const { root, store } = repo();
  await indexRepo({ store, rootPath: root, mode: "rebuild" });
  await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.deepEqual(freshTitles(store, "src/keep.ts"), ["keptFunction"]);
  assert.deepEqual(freshTitles(store, "src/generated.js"), ["ghostFunction"]);
  store.close();
});

test("a deleted file is still retired", async () => {
  // The original behaviour must survive the new sweep.
  const { root, store } = repo();
  await indexRepo({ store, rootPath: root, mode: "rebuild" });
  rmSync(join(root, "src/generated.js"));
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "rm"], { cwd: root });
  const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
  assert.deepEqual(freshTitles(store, "src/generated.js"), []);
  assert.ok(report.deleted >= 1, `the deletion must be reported, got ${JSON.stringify(report.deleted)}`);
  store.close();
});
