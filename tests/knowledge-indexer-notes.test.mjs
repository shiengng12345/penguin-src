import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { parseNote, indexNote, extractEntities } from "../packages/knowledge-indexer/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "pk-notes-"));
  return KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
}

test("parseNote: frontmatter id/title/flags + identity precedence", () => {
  const withId = parseNote({
    path: "cases/x.md",
    source: "---\nid: abc-123\ntitle: My Case\nsensitive: true\nmcp_access: denied\n---\n# Heading\nbody",
  });
  assert.equal(withId.identityKey, "abc-123");
  assert.equal(withId.title, "My Case");
  assert.equal(withId.sensitive, true);
  assert.equal(withId.mcpAccess, "denied");

  const noId = parseNote({ path: "cases/y.md", source: "# H1 Title\ntext" });
  assert.equal(noId.identityKey, "cases/y.md");
  assert.equal(noId.title, "H1 Title");
  assert.equal(noId.sensitive, false);
  assert.equal(noId.mcpAccess, "allowed");
});

test("parseNote: wikilinks (plain + namespaced), tags, headings", () => {
  const p = parseNote({
    path: "n.md",
    source: "# T\nsee [[GetLoginURL]] and [[api:Svc.M]] #alpha #a/b\n```\n#notatag\n```\n## Sub",
  });
  assert.deepEqual(
    p.wikilinks,
    [
      { rawTarget: "GetLoginURL", namespace: null, targetAnchor: null, displayText: null, embedded: false, sourceLine: 2 },
      { rawTarget: "Svc.M", namespace: "api", targetAnchor: null, displayText: null, embedded: false, sourceLine: 2 },
    ],
  );
  assert.ok(p.tags.includes("alpha"));
  assert.ok(p.tags.includes("a/b"));
  assert.ok(!p.tags.includes("notatag"), "tags inside code fence ignored");
  assert.ok(p.headings.some((h) => h.level === 2 && h.text === "Sub"));
});

test("extractEntities: typed + normalized + deduped", () => {
  const ents = extractEntities("playerId: 12345 and playerId=12345 trace_id: DEADBEEF01 on prod");
  const types = ents.map((e) => e.entityType);
  assert.ok(types.includes("player_id"));
  assert.ok(types.includes("trace_id"));
  assert.ok(types.includes("env"));
  // dedupe: playerId 12345 appears twice → one entity
  assert.equal(ents.filter((e) => e.entityType === "player_id").length, 1);
  assert.equal(ents.find((e) => e.entityType === "trace_id").normalizedValue, "deadbeef01");
});

test("indexNote: note searchable; identity stable across path move", () => {
  const store = openStore();
  const p1 = parseNote({ path: "inbox/case.md", source: "---\nid: fixed-id\ntitle: GameURL Issue\n---\nproviderId 2043 empty gameURL" });
  const { nodeId } = indexNote({ store, repoRelPath: "inbox/case.md", parsed: p1 });
  assert.ok(store.searchText("gameURL").some((h) => h.nodeId === nodeId));

  // move file (same id) → same node, updated path
  const p2 = parseNote({ path: "cases/case.md", source: "---\nid: fixed-id\ntitle: GameURL Issue\n---\nstill about gameURL" });
  const { nodeId: nodeId2 } = indexNote({ store, repoRelPath: "cases/case.md", parsed: p2 });
  assert.equal(nodeId2, nodeId, "same frontmatter id → same node across move");
  store.close();
});

test("indexNote: credential note body never enters FTS", () => {
  const store = openStore();
  const p = parseNote({ path: "creds/gh.md", source: "---\nid: gh\ntitle: Github Token\ntype: credential\n---\nSECRET_TOKEN=supersecret gameURL" });
  const { nodeId } = indexNote({ store, repoRelPath: "creds/gh.md", parsed: p });
  // body term must not be searchable (credential body excluded from FTS)
  assert.ok(!store.searchText("supersecret").some((h) => h.nodeId === nodeId));
  assert.ok(!store.searchText("gameURL", { includeSensitive: true }).some((h) => h.nodeId === nodeId));
  // node exists as credential type
  assert.equal(store.getNode(nodeId).node_type, "credential");
  store.close();
});
