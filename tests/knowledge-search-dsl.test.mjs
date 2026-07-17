import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileKnowledgeDsl, KnowledgeStore, filterHitsByPropertyPredicates, filterHitsByMarkdownPredicates } from "../packages/knowledge-core/dist/index.js";
import { indexNote, parseNote } from "../packages/knowledge-indexer/dist/index.js";

test("knowledge DSL compiles safe predicates into a SearchRequest without SQL", () => {
  const compiled = compileKnowledgeDsl('path:"apps/player" AND property:priority>=2 OR regex:/findAllByCpf\\s*\\(/ AND repo:auth');
  assert.deepEqual(compiled.request.scope.paths, ["apps/player"]);
  assert.equal(compiled.request.mode, "regex");
  assert.equal(compiled.propertyPredicates[0].field, "property");
  assert.equal(compiled.request.scope.revisions[0].repoName, "auth");
});

test("knowledge DSL reports exact positions for malformed syntax", () => {
  assert.throws(() => compileKnowledgeDsl("path:"), /DSL_EXPECTED_VALUE@5/);
  assert.throws(() => compileKnowledgeDsl("unknown:value"), /DSL_UNKNOWN_FIELD@0/);
  assert.throws(() => compileKnowledgeDsl('regex:"not-a-regex"'), /DSL_REGEX_INVALID@0/);
});

test("typed property predicates filter note hits without converting values to text", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-dsl-property-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  store.db.prepare("INSERT INTO nodes(id,node_type,identity_key,title,meta,created_at) VALUES (?,?,?,?,?,?)").run("note:one", "note", "one", "One", "{}", new Date().toISOString());
  store.db.prepare("INSERT INTO notes_index(node_id,path,frontmatter,content_hash) VALUES (?,?,?,?)").run("note:one", "one.md", "{}", "hash");
  store.db.prepare("INSERT INTO note_properties(note_node_id,property_key,ordinal,value_type,value_number,source_line) VALUES (?,?,?,?,?,?)").run("note:one", "priority", 0, "number", 3, 1);
  const compiled = compileKnowledgeDsl("property:priority>=2");
  const hits = [{ hitId: "h", kind: "note", lane: "note", title: "One", locator: { repoId: "", repoName: "", revisionId: "s", revisionKind: "commit", filePath: "one.md" }, score: 1, rankReasons: [], evidence: [] }];
  assert.equal(filterHitsByPropertyPredicates(store, hits, compiled.propertyPredicates).length, 1);
  store.close();
});

test("line/section/block DSL predicates return exact Markdown locators", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-dsl-markdown-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const { nodeId } = indexNote({ store, repoRelPath: "decision.md", parsed: parseNote({ path: "decision.md", source: "# Decision\n\n## Guard\n\n- [ ] ^decision-1\nCPF validation\n" }) });
  const hit = { hitId: "h", kind: "note", lane: "note", title: "Decision", locator: { repoId: "", repoName: "", revisionId: "s", revisionKind: "commit", filePath: "decision.md" }, score: 1, rankReasons: [], evidence: [], nodeId };
  const compiled = compileKnowledgeDsl("section:Guard AND block:decision-1");
  const located = filterHitsByMarkdownPredicates(store, [hit], compiled.markdownPredicates);
  assert.equal(located.length, 1);
  assert.equal(located[0].locator.startLine, 5);
  assert.ok((located[0].locator.startByte ?? 0) > 0);
  store.close();
});
