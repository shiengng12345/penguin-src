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
