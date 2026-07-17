import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";
import { extractMarkdownLinks, extractMarkdownProperties, indexNote, parseNote, reindexNotesDir, validateMarkdownProperties } from "../packages/knowledge-indexer/dist/index.js";

test("Markdown properties and Obsidian links are indexed as rebuildable rows", () => {
  const source = "---\ntitle: Decision\npriority: 2\nreviewed: true\ntags: [auth, risk]\n---\n\n# Decision\nSee [[Login#guard|login flow]] and ![[Architecture]].\n";
  const properties = extractMarkdownProperties({ title: "Decision", priority: 2, reviewed: true, tags: ["auth", "risk"] }, source);
  assert.ok(properties.some((property) => property.key === "priority" && property.valueNumber === 2));
  assert.equal(extractMarkdownLinks(source).length, 2);
  assert.equal(extractMarkdownLinks(source)[0].targetAnchor, "guard");

  const dir = mkdtempSync(join(tmpdir(), "pk-markdown-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  store.upsertNode({ nodeType: "note", identityKey: "login.md", title: "Login" });
  const parsed = parseNote({ path: "decision.md", source });
  const { nodeId } = indexNote({ store, repoRelPath: "decision.md", parsed });
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM note_properties WHERE note_node_id=?").get(nodeId).n, 5);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM note_links WHERE source_node_id=?").get(nodeId).n, 2);
  assert.ok(store.db.prepare("SELECT 1 FROM edges WHERE src=? AND edge_type='wikilink' AND dst IS NOT NULL").get(nodeId));
  store.close();
});

test("frontmatter preserves typed scalar, null, date, and block-list properties", () => {
  const parsed = parseNote({ path: "typed.md", source: "---\ntitle: Typed\ncount: 3\nenabled: false\ndue: 2026-07-17\nempty: null\naliases:\n  - Login blacklist\n  - Auth login\n---\n\nbody\n" });
  const properties = extractMarkdownProperties(parsed.frontmatter, "---\ncount: 3\nenabled: false\ndue: 2026-07-17\nempty: null\naliases:\n  - Login blacklist\n  - Auth login\n---");
  assert.ok(properties.some((property) => property.key === "count" && property.valueType === "number" && property.valueNumber === 3));
  assert.ok(properties.some((property) => property.key === "enabled" && property.valueType === "boolean" && property.valueBoolean === false));
  assert.ok(properties.some((property) => property.key === "due" && property.valueType === "date" && property.valueDate === "2026-07-17"));
  assert.ok(properties.some((property) => property.key === "empty" && property.valueType === "null"));
  assert.equal(properties.filter((property) => property.key === "aliases").length, 2);
  assert.equal(parsed.frontmatter.aliases[0], "Login blacklist");
});

test("reserved properties are validated while unknown properties remain searchable", () => {
  const result = validateMarkdownProperties({ title: 42, status: "not-a-status", custom_owner_system: "platform" });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.key === "title" && error.code === "invalid_type"));
  const properties = extractMarkdownProperties({ custom_owner_system: "platform" }, "custom_owner_system: platform");
  assert.equal(properties[0].key, "custom_owner_system");
});

test("secret-looking frontmatter is redacted in the derived index", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-property-secret-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const parsed = parseNote({ path: "secret.md", source: "---\ntitle: Safe\napi_token: super-secret-value-123456\n---\nbody" });
  const { nodeId } = indexNote({ store, repoRelPath: "secret.md", parsed });
  const row = store.db.prepare("SELECT frontmatter FROM notes_index WHERE node_id=?").get(nodeId);
  assert.doesNotMatch(JSON.stringify(row), /super-secret-value/);
  assert.match(JSON.stringify(row), /REDACTED_SECRET/);
  store.close();
});

test("Obsidian canvas nodes become searchable note/link facts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-canvas-"));
  const notesDir = join(dir, "vault");
  mkdirSync(notesDir);
  writeFileSync(join(notesDir, "map.canvas"), JSON.stringify({ nodes: [{ id: "a", type: "text", text: "Canvas architecture decision" }, { id: "b", type: "file", file: "design.md" }], edges: [{ fromNode: "a", toNode: "b" }] }));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const result = reindexNotesDir({ store, notesDir });
  assert.equal(result.indexed, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM fts_notes WHERE body LIKE '%Canvas architecture decision%'").get().n, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM note_links WHERE raw_target='design.md'").get().n, 1);
  store.close();
});

test("deleting a Markdown source removes every derived note row", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-markdown-prune-"));
  const notesDir = join(dir, "vault");
  mkdirSync(notesDir);
  const notePath = join(notesDir, "gone.md");
  writeFileSync(notePath, "---\ntitle: Gone\npriority: 3\n---\nSee [[Missing]].\n");
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  assert.equal(reindexNotesDir({ store, notesDir }).indexed, 1);
  const node = store.db.prepare("SELECT node_id FROM notes_index WHERE path=?").get("gone.md");
  assert.ok(node);
  unlinkSync(notePath);
  assert.equal(reindexNotesDir({ store, notesDir }).pruned, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM note_properties WHERE note_node_id=?").get(node.node_id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM note_links WHERE source_node_id=?").get(node.node_id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM notes_index WHERE node_id=?").get(node.node_id).n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE id=?").get(node.node_id).n, 0);
  store.close();
});

test("a wiped database rebuilds note properties and links from Markdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-markdown-rebuild-"));
  const notesDir = join(dir, "vault");
  mkdirSync(notesDir);
  writeFileSync(join(notesDir, "source.md"), "---\nid: source\ntitle: Source\npriority: 4\n---\nSee [[target]].\n");
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const first = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(reindexNotesDir({ store: first, notesDir }).indexed, 1);
  const before = first.db.prepare("SELECT node_id FROM notes_index WHERE path=?").get("source.md");
  assert.equal(first.db.prepare("SELECT COUNT(*) AS n FROM note_properties WHERE note_node_id=?").get(before.node_id).n, 3);
  assert.equal(first.db.prepare("SELECT COUNT(*) AS n FROM note_links WHERE source_node_id=?").get(before.node_id).n, 1);
  first.close();
  rmSync(dbPath, { force: true });
  const rebuilt = KnowledgeStore.open({ dbPath, ledgerPath });
  assert.equal(reindexNotesDir({ store: rebuilt, notesDir }).indexed, 1);
  const after = rebuilt.db.prepare("SELECT node_id FROM notes_index WHERE path=?").get("source.md");
  assert.equal(rebuilt.db.prepare("SELECT value_number FROM note_properties WHERE note_node_id=? AND property_key='priority'").get(after.node_id).value_number, 4);
  assert.equal(rebuilt.db.prepare("SELECT COUNT(*) AS n FROM note_links WHERE source_node_id=?").get(after.node_id).n, 1);
  rebuilt.close();
});
