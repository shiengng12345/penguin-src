import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";

async function loadClient() {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  // strip the @tauri-apps/api/core import — parseSearchFilters is pure and we
  // don't exercise invoke here.
  const stripped = outputText.replace(/import\s*\{[^}]*\}\s*from\s*["']@tauri-apps\/api\/core["'];?/, "const invoke = async () => '';");
  const encoded = Buffer.from(stripped).toString("base64");
  return import(`data:text/javascript;base64,${encoded}`);
}

test("parseSearchFilters splits type:/repo:/tag:/entity: from free text", async () => {
  const { parseSearchFilters } = await loadClient();
  const r = parseSearchFilters("gameurl type:note repo:fpms tag:brazil rest words");
  assert.equal(r.query, "gameurl rest words");
  assert.deepEqual(r.filters, { type: "note", repo: "fpms", tag: "brazil" });

  const plain = parseSearchFilters("just a query");
  assert.equal(plain.query, "just a query");
  assert.deepEqual(plain.filters, {});
});

test("WikiPage wires the knowledge client (search/node/backlinks/reindex/status)", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  for (const fn of ["knowledgeSearch", "knowledgeNode", "knowledgeExplore", "knowledgeReindex", "knowledgeDbStatus", "parseSearchFilters"]) {
    assert.match(source, new RegExp(fn), `WikiPage should use ${fn}`);
  }
  // read-first: reindex button + search-on-Enter + backlinks panel
  assert.match(source, /重建索引/);
  assert.match(source, /runSearch/);
  assert.match(source, /backlinks/);
});

test("knowledge-client routes through the Rust bridge commands", async () => {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  assert.match(source, /invoke<string>\("knowledge_query"/);
  assert.match(source, /invoke<KnowledgeDbStatus>\("knowledge_db_status"\)/);
  assert.match(source, /invoke<string>\("knowledge_reindex"/);
});

test("knowledge-client exposes index-browse + graph wrappers over the CLI verbs", async () => {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  // each wrapper maps to its CLI verb through the generic query() passthrough
  assert.match(source, /query<KnowledgeIndexStatus>\(\["status"\]\)/);
  assert.match(source, /query<KnowledgeFileRow\[\]>\(\["files", repoId, branchId\]\)/);
  assert.match(source, /query<KnowledgeFileSymbol\[\]>\(\["filesymbols", branchId, filePath\]\)/);
  assert.match(source, /query<KnowledgeGraphView>\(\["graph", node, String\(depth\)\]\)/);
  assert.match(source, /query<KnowledgeGraphView>\(\["repograph", repoId, branchId\]\)/);
});

test("WikiPage has browse/search/graph modes wiring the tree + graph", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(source, /type Mode = "browse" \| "search" \| "graph"/);
  assert.match(source, /useState<Mode>\("browse"\)/); // default = browse, not a blank search box
  assert.match(source, /<WikiBrowseTree/);
  assert.match(source, /<WikiGraph/);
  assert.match(source, /knowledgeFileSymbols/);
  assert.match(source, /knowledgeRepoGraph/);
  assert.match(source, /knowledgeGraph/);
});

test("WikiBrowseTree lazy-loads repo→branch→file and can open a repo graph", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiBrowseTree.tsx", import.meta.url), "utf8");
  assert.match(source, /knowledgeIndexStatus/); // repos + branches
  assert.match(source, /knowledgeFiles\(repoId, branchId\)/); // files lazy per branch
  assert.match(source, /onSelectFile/);
  assert.match(source, /onOpenRepoGraph/);
});

test("WikiGraph renders via a dynamically-imported force-graph (code-split, defensive)", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiGraph.tsx", import.meta.url), "utf8");
  assert.match(source, /import\("force-graph"\)/); // dynamic → own chunk + graceful failure
  assert.match(source, /new ForceGraph\(el\)/);
  assert.match(source, /onNodeClick/);
  assert.match(source, /\.catch\(/); // load failure must not break the rest of the Wiki
});

test("WikiNoteEditor is a CodeMirror editor with search-backed [[ wikilink autocomplete", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiNoteEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /@codemirror\/view/);
  assert.match(source, /autocompletion/);
  assert.match(source, /noteCompletionTrigger/); // uses the unit-tested trigger
  assert.match(source, /knowledgeSearch/); // wikilink candidates come from search
  assert.match(source, /apply: `\$\{h\.title\}\]\]`/); // completes to [[Title]]
});

test("WikiPage wires note create/edit/save via the C9 note verbs", async () => {
  const source = await readFile(new URL("../src/components/wiki/WikiPage.tsx", import.meta.url), "utf8");
  assert.match(source, /knowledgeNoteNew/);
  assert.match(source, /knowledgeNoteWrite/);
  assert.match(source, /knowledgeNoteRead/);
  assert.match(source, /<WikiNoteEditor/);
  assert.match(source, /新建笔记/); // create affordance
  assert.match(source, /editing/); // edit state
});

test("knowledge-client exposes note new/write/read/list wrappers", async () => {
  const source = await readFile(new URL("../src/lib/knowledge-client.ts", import.meta.url), "utf8");
  assert.match(source, /\["note", "new", title\]/);
  assert.match(source, /\["note", "write", slug, body\]/);
  assert.match(source, /\["note", "read", slug\]/);
  assert.match(source, /\["note", "list"\]/);
});
