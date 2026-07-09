import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, timeline } from "../packages/knowledge-core/dist/index.js";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "pk-tl-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("timeline returns commits newest-first with author/merge/repo", () => {
  const s = store();
  const repoId = s.registerRepo({ name: "svc", rootPath: "/svc" });
  const mk = (sha, date, merge) => s.upsertNode({
    nodeType: "commit", identityKey: `commit::${sha}`, title: sha, repoId,
    meta: { author: "dev", date, merge, parents: merge ? ["a", "b"] : ["a"] },
  });
  mk("older", "2026-01-01T00:00:00Z", false);
  mk("newer", "2026-06-01T00:00:00Z", true);
  const t = timeline(s, { limit: 10 });
  assert.equal(t.entries[0].subject, "newer", "newest first");
  assert.equal(t.entries[0].merge, true);
  assert.equal(t.entries[0].repo, "svc");
  assert.equal(t.entries[1].subject, "older");
  s.close();
});

test("timeline respects the repo filter", () => {
  const s = store();
  const r1 = s.registerRepo({ name: "a", rootPath: "/a" });
  const r2 = s.registerRepo({ name: "b", rootPath: "/b" });
  s.upsertNode({ nodeType: "commit", identityKey: "commit::c1", title: "c1", repoId: r1, meta: { date: "2026-01-01T00:00:00Z" } });
  s.upsertNode({ nodeType: "commit", identityKey: "commit::c2", title: "c2", repoId: r2, meta: { date: "2026-02-01T00:00:00Z" } });
  const t = timeline(s, { repoId: r1 });
  assert.equal(t.entries.length, 1);
  assert.equal(t.entries[0].repo, "a");
  s.close();
});
