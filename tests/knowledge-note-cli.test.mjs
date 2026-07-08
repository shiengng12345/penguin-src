import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

function harness() {
  const dir = mkdtempSync(join(tmpdir(), "pk-note-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const notesDir = join(dir, "notes");
  const lines = [];
  const errs = [];
  const deps = {
    cwd: dir,
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    storeExists: () => existsSync(dbPath),
    openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
    notesDir,
  };
  return { dir, dbPath, notesDir, deps, lines, errs };
}

test("note new creates a Markdown file + indexes it (searchable)", async () => {
  const { deps, lines, notesDir } = harness();
  lines.length = 0;
  assert.equal(await runCli(["note", "new", "My First Note", "--json"], deps), 0);
  const created = JSON.parse(lines[0]);
  assert.equal(created.slug, "my-first-note");
  assert.ok(existsSync(join(notesDir, "my-first-note.md")), "md file written");

  lines.length = 0;
  await runCli(["search", "First", "--json"], deps);
  assert.ok(JSON.parse(lines[0]).some((h) => h.title === "My First Note" && h.nodeType === "note"), "note is searchable");
});

test("note append updates the body (re-indexes same identity)", async () => {
  const { deps, lines } = harness();
  await runCli(["note", "new", "Runbook"], deps);
  assert.equal(await runCli(["note", "append", "runbook", "zebrawombat escalation steps"], deps), 0);

  lines.length = 0;
  await runCli(["search", "zebrawombat", "--json"], deps);
  assert.ok(JSON.parse(lines[0]).length >= 1, "appended body is searchable");

  // still exactly one note node (append re-indexed the same identity, no dup)
  const store = deps.openStore();
  const n = store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE node_type='note'").get().n;
  assert.equal(n, 1);
  store.close();
});

test("note append to a missing note exits 1", async () => {
  const { deps } = harness();
  assert.equal(await runCli(["note", "append", "ghost", "x"], deps), 1);
});

test("note write overwrites the body (keeps frontmatter); note read returns source", async () => {
  const { deps, lines } = harness();
  await runCli(["note", "new", "Editme"], deps);
  await runCli(["note", "append", "editme", "old body kryptonite"], deps);
  // overwrite
  assert.equal(await runCli(["note", "write", "editme", "brand new qwertybody"], deps), 0);

  lines.length = 0;
  await runCli(["note", "read", "editme", "--json"], deps);
  const read = JSON.parse(lines[0]);
  assert.match(read.source, /^---\nid: editme\ntitle: Editme\n---/, "frontmatter preserved");
  assert.match(read.source, /brand new qwertybody/);
  assert.doesNotMatch(read.source, /kryptonite/, "old body replaced");

  // new body searchable, old gone
  lines.length = 0;
  await runCli(["search", "qwertybody", "--json"], deps);
  assert.ok(JSON.parse(lines[0]).length >= 1);
  lines.length = 0;
  await runCli(["search", "kryptonite", "--json"], deps);
  assert.equal(JSON.parse(lines[0]).length, 0, "old body no longer indexed");
});

test("note write to a missing note exits 1", async () => {
  const { deps } = harness();
  assert.equal(await runCli(["note", "write", "ghost", "x"], deps), 1);
});

test("tags verb lists distinct #tags extracted from note bodies", async () => {
  const { deps, lines } = harness();
  await runCli(["note", "new", "Tagged"], deps);
  await runCli(["note", "write", "tagged", "body with #brazil and #urgent tags"], deps);
  await runCli(["note", "new", "Also"], deps);
  await runCli(["note", "write", "also", "another #brazil note"], deps);

  lines.length = 0;
  assert.equal(await runCli(["tags", "--json"], deps), 0);
  const tags = JSON.parse(lines[0]);
  assert.deepEqual(tags, ["brazil", "urgent"], "distinct, sorted");
});

test("note new never clobbers — duplicate title gets a -2 slug", async () => {
  const { deps, lines } = harness();
  await runCli(["note", "new", "Dup Title"], deps);
  lines.length = 0;
  assert.equal(await runCli(["note", "new", "Dup Title", "--json"], deps), 0);
  assert.equal(JSON.parse(lines[0]).slug, "dup-title-2");
});

test("note list shows the note files", async () => {
  const { deps, lines } = harness();
  await runCli(["note", "new", "Alpha"], deps);
  await runCli(["note", "new", "Beta"], deps);
  lines.length = 0;
  await runCli(["note", "list", "--json"], deps);
  assert.deepEqual(JSON.parse(lines[0]), ["alpha.md", "beta.md"]);
});

test("notes survive a DB wipe — reindex rebuilds them from the Markdown on disk", async () => {
  const { deps, dbPath, lines } = harness();
  await runCli(["note", "new", "Persistent Note"], deps);

  // wipe the SQLite index (simulate a full rebuild); the .md files remain
  rmSync(dbPath);
  assert.equal(deps.storeExists(), false);

  lines.length = 0;
  assert.equal(await runCli(["note", "reindex", "--json"], deps), 0);
  assert.equal(JSON.parse(lines[0]).indexed, 1);

  lines.length = 0;
  await runCli(["search", "Persistent", "--json"], deps);
  assert.ok(JSON.parse(lines[0]).some((h) => h.title === "Persistent Note"), "note restored from disk");
});
