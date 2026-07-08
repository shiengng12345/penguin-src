import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { indexGitObjects } from "../packages/knowledge-indexer/dist/index.js";

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], {
    stdio: ["ignore", "ignore", "ignore"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x",
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
    },
  });
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "pk-gg-"));
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1");
  git(dir, "add", "."); git(dir, "commit", "-q", "-m", "root");
  writeFileSync(join(dir, "a.txt"), "2");
  git(dir, "commit", "-qam", "second");
  git(dir, "tag", "v1.0.0");
  // a feature branch then merge → creates a merge commit (2 parents)
  git(dir, "checkout", "-q", "-b", "feat");
  writeFileSync(join(dir, "b.txt"), "x");
  git(dir, "add", "."); git(dir, "commit", "-qm", "feat work");
  git(dir, "checkout", "-q", "main");
  git(dir, "merge", "-q", "--no-ff", "feat", "-m", "merge feat");
  return dir;
}

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-gg-db-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("indexGitObjects captures commit/tag nodes + parent/merge/tagged edges", () => {
  const repo = makeRepo();
  const store = openStore();
  const r = indexGitObjects({ store, rootPath: repo });

  // 4 commits (root, second, feat work, merge)
  assert.equal(r.commits, 4);
  assert.equal(r.tags, 1);

  const commitNodes = store.db.prepare("SELECT COUNT(*) n FROM nodes WHERE node_type='commit'").get();
  assert.equal(commitNodes.n, 4);
  const tagNode = store.db.prepare("SELECT * FROM nodes WHERE node_type='tag'").get();
  assert.equal(tagNode.title, "v1.0.0");
  assert.equal(tagNode.identity_key, "tag:v1.0.0");

  // the merge commit has 2 parents → both edges typed 'merge'
  const mergeEdges = store.db.prepare("SELECT COUNT(*) n FROM edges WHERE edge_type='merge'").get();
  assert.equal(mergeEdges.n, 2);
  // non-merge parent links exist too
  const parentEdges = store.db.prepare("SELECT COUNT(*) n FROM edges WHERE edge_type='parent'").get();
  assert.ok(parentEdges.n >= 2);
  // tagged edge tag→commit
  const tagged = store.db.prepare("SELECT COUNT(*) n FROM edges WHERE edge_type='tagged'").get();
  assert.equal(tagged.n, 1);

  // all git edges are parser/active (traversable by default)
  const active = store.db.prepare("SELECT COUNT(*) n FROM edges WHERE origin='parser' AND status='active'").get();
  assert.equal(active.n, r.edges);
  store.close();
});

test("indexGitObjects is idempotent (re-run adds nothing)", () => {
  const repo = makeRepo();
  const store = openStore();
  const a = indexGitObjects({ store, rootPath: repo });
  const before = store.db.prepare("SELECT COUNT(*) n FROM edges").get().n;
  const b = indexGitObjects({ store, rootPath: repo });
  const after = store.db.prepare("SELECT COUNT(*) n FROM edges").get().n;
  assert.equal(before, after);
  assert.equal(a.commits, b.commits);
  store.close();
});

test("indexGitObjects on a non-git dir degrades to zero", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-gg-nogit-"));
  const store = openStore();
  const r = indexGitObjects({ store, rootPath: dir });
  assert.deepEqual(r, { commits: 0, tags: 0, edges: 0 });
  store.close();
});

test("maxCommits bounds the window; parents outside window are skipped", () => {
  const repo = makeRepo();
  const store = openStore();
  const r = indexGitObjects({ store, rootPath: repo, maxCommits: 1 });
  assert.equal(r.commits, 1); // only HEAD (the merge commit)
  // its parents are outside the window → no parent/merge edges land
  const edges = store.db.prepare("SELECT COUNT(*) n FROM edges WHERE edge_type IN ('parent','merge')").get();
  assert.equal(edges.n, 0);
  store.close();
});
