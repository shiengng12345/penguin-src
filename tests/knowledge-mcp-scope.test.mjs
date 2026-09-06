import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

const knowledgeCoreRequire = createRequire(new URL("../packages/knowledge-core/package.json", import.meta.url));
const Database = knowledgeCoreRequire("better-sqlite3");

// knowledge-tools.ts is bundled into the MCP server (esbuild → single file), so
// it isn't separately importable as TS. Bundle it the same way
// tests/knowledge-mcp-tools.test.mjs does, so this exercises the same module
// graph as the release server.
async function loadTools() {
  const root = mkdtempSync(join(tmpdir(), `penguin-mcp-scope-tools-${process.pid}-`));
  // openKnowledgeStore() (bundled inline via the @penguin/knowledge-core
  // alias below) does a runtime `require("better-sqlite3")` for the native
  // binding -- a real require, not something esbuild can bundle. Node
  // resolves that from handler.mjs's own directory, which is outside the
  // repo tree (OS tmpdir) and so has no ancestor node_modules of its own.
  // Symlink one in from packages/mcp (a real workspace member that already
  // resolves better-sqlite3) so any test that lets the bundled code open a
  // real on-disk store (not just pass a pre-opened `store` in, like every
  // other test in this file) still works.
  try { symlinkSync(new URL("../packages/mcp/node_modules", import.meta.url).pathname, join(root, "node_modules")); } catch { /* best effort */ }
  const handler = join(root, "handler.mjs");
  const defs = join(root, "defs.mjs");
  const coreDist = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname;
  await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: handler, alias: { "@penguin/knowledge-core": coreDist } });
  await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tool-defs.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: defs });
  return { ...(await import(`file://${defs}`)), ...(await import(`file://${handler}`)) };
}
const { handleKnowledgeTool, runKnowledgeTool } = await loadTools();

// Same fixture idiom as tests/knowledge-cli-scope.test.mjs: a real git repo
// checked out on an un-indexed branch ("feature-x"), with only "main"
// registered + indexed in the knowledge store.
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-mcp-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const rootPath = join(dir, "repo");
  const repoId = store.registerRepo({ name: "demo", rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "sha-main", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit='sha-main' WHERE id=?").run(branchId);
  const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Alpha`, repoId, title: "Alpha" });
  store.upsertSymbolVersion({ nodeId, branchId, commitSha: "sha-main", filePath: "src/a.ts", lang: "typescript", kind: "function", signature: "Alpha()", contentHash: "h1" });
  store.indexSymbolText({ nodeId, name: "Alpha", signature: "Alpha()" });
  execFileSync("git", ["init", "-b", "feature-x", rootPath]);
  execFileSync("git", ["-C", rootPath, "commit", "--allow-empty", "-m", "x"], {
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  return { store, dir, rootPath, nodeId };
}

test("knowledge_context on an un-indexed checked-out branch returns a BRANCH_NOT_INDEXED tool error", () => {
  const { store } = fixture();
  const result = handleKnowledgeTool("knowledge_context", { target: "Alpha" }, store);
  const serialized = JSON.stringify(result);
  assert.match(serialized, /BRANCH_NOT_INDEXED/);
  assert.match(serialized, /knowledge_index/);
  store.close();
});

test("knowledge_context with allow_fallback:true answers from the live branch and carries the scope envelope", () => {
  const { store } = fixture();
  const result = handleKnowledgeTool("knowledge_context", { target: "Alpha", allow_fallback: true }, store);
  assert.equal(result.locator?.branchName, "main");
  assert.equal(result.alignment, "fallback");
  assert.ok(result.warnings?.some((w) => w.code === "BRANCH_NOT_INDEXED_FALLBACK"), JSON.stringify(result.warnings));
  store.close();
});

test("knowledge_endpoints applies the canonical nested page contract", () => {
  const { store } = fixture();
  const repoId = store.resolveRepoIds("demo")[0];
  const firstEndpoint = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::Demo.First",
    repoId,
    title: "Demo.First",
  });
  const secondEndpoint = store.upsertNode({
    nodeType: "endpoint",
    identityKey: "grpc::Demo.Second",
    repoId,
    title: "Demo.Second",
  });
  const protocolMeta = JSON.stringify({ protocol: "grpc" });
  store.db.prepare("UPDATE nodes SET meta=? WHERE id IN (?, ?)").run(protocolMeta, firstEndpoint, secondEndpoint);

  const pageOne = handleKnowledgeTool("knowledge_endpoints", {
    repo: "demo",
    protocol: "grpc",
    page: { limit: 1 },
  }, store);
  assert.equal(pageOne.returnedCount, 1, JSON.stringify(pageOne));
  assert.equal(pageOne.truncated, true, JSON.stringify(pageOne));

  const pageTwo = handleKnowledgeTool("knowledge_endpoints", {
    repo: "demo",
    protocol: "grpc",
    page: { limit: 1, cursor: pageOne.nextCursor },
  }, store);
  assert.equal(pageTwo.returnedCount, 1, JSON.stringify(pageTwo));
  assert.notEqual(pageTwo.items[0].nodeId, pageOne.items[0].nodeId, JSON.stringify({ pageOne, pageTwo }));

  const invalid = handleKnowledgeTool("knowledge_endpoints", {
    repo: "demo",
    protocol: "grpc",
    page: { limit: 1, cursor: "BOGUS" },
  }, store);
  assert.equal(invalid.error?.code, "CURSOR_INVALID", JSON.stringify(invalid));
  store.close();
});

test("knowledge_endpoints maps nested and top-level non-integer limits to the same INVALID_ARGUMENT", () => {
  const { store } = fixture();
  const nested = handleKnowledgeTool("knowledge_endpoints", {
    repo: "demo",
    protocol: "grpc",
    page: { limit: 1.5 },
  }, store);
  const topLevel = handleKnowledgeTool("knowledge_endpoints", {
    repo: "demo",
    protocol: "grpc",
    limit: 1.5,
  }, store);
  for (const result of [nested, topLevel]) {
    assert.equal(result.error?.code, "INVALID_ARGUMENT", JSON.stringify(result));
    assert.equal(result.error?.message, "endpoint page limit must be an integer between 1 and 500", JSON.stringify(result));
  }
  store.close();
});

for (const toolName of ["find_dead_code", "knowledge_dead_code"]) {
  test(`${toolName} accepts a valid canonical nested page limit`, () => {
    const { store } = fixture();
    try {
      const result = handleKnowledgeTool(toolName, {
        repo: "demo",
        path: "src/",
        page: { limit: 1 },
      }, store);
      assert.equal(result.error, undefined, JSON.stringify(result));
      assert.equal(result.returnedCount, 1, JSON.stringify(result));
      assert.equal(result.items.length, 1, JSON.stringify(result));
      assert.equal("candidates" in result, false, JSON.stringify(result));
      assert.equal(result.scope.repo, "demo", JSON.stringify(result));
      assert.equal(result.scope.path, "src/", JSON.stringify(result));
    } finally {
      store.close();
    }
  });
}

test("knowledge_file_symbols keeps valid canonical nested limit and cursor paging", () => {
  const { store } = fixture();
  try {
    const repoId = store.resolveRepoIds("demo")[0];
    const branchId = store.getBranch(repoId, "main").id;
    const secondNodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${repoId}::Beta`,
      repoId,
      title: "Beta",
    });
    store.upsertSymbolVersion({
      nodeId: secondNodeId,
      branchId,
      commitSha: "sha-main",
      filePath: "src/a.ts",
      lang: "typescript",
      kind: "function",
      signature: "Beta()",
      contentHash: "h2",
      status: "fresh",
      startLine: 2,
      endLine: 2,
    });

    const pageOne = handleKnowledgeTool("knowledge_file_symbols", {
      repo: "demo",
      path: "src/a.ts",
      page: { limit: 1 },
    }, store);
    assert.equal(pageOne.error, undefined, JSON.stringify(pageOne));
    assert.equal(pageOne.returnedCount, 1, JSON.stringify(pageOne));
    assert.equal(typeof pageOne.nextCursor, "string", JSON.stringify(pageOne));

    const pageTwo = handleKnowledgeTool("knowledge_file_symbols", {
      repo: "demo",
      path: "src/a.ts",
      page: { limit: 1, cursor: pageOne.nextCursor },
    }, store);
    assert.equal(pageTwo.error, undefined, JSON.stringify(pageTwo));
    assert.equal(pageTwo.returnedCount, 1, JSON.stringify(pageTwo));
    assert.notEqual(pageTwo.items[0].nodeId, pageOne.items[0].nodeId, JSON.stringify({ pageOne, pageTwo }));
  } finally {
    store.close();
  }
});

test("knowledge_file_symbols returns FILE_NOT_FOUND for an absent indexed path", () => {
  const { store } = fixture();
  try {
    const result = handleKnowledgeTool("knowledge_file_symbols", {
      repo: "demo",
      path: "src/missing.ts",
      page: { limit: 10 },
    }, store);
    assert.equal(result.error?.code, "FILE_NOT_FOUND", JSON.stringify(result));
    assert.equal(result.error?.retryable, false, JSON.stringify(result));
    assert.equal(result.items, undefined, JSON.stringify(result));
  } finally {
    store.close();
  }
});

test("shared MCP pagination rejects invalid file-symbol and dead-code limits before handlers", () => {
  const { store } = fixture();
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = () => { throw new Error("HANDLER_REACHED"); };
  const tools = [
    ["knowledge_file_symbols", { repo: "demo", path: "src/a.ts" }],
    ["knowledge_dead_code", { repo: "demo" }],
    ["find_dead_code", { repo: "demo" }],
  ];
  try {
    for (const [name, base] of tools) {
      for (const invalidLimit of [1.5, 0, 501, "2"]) {
        for (const input of [
          { ...base, page: { limit: invalidLimit } },
          { ...base, limit: invalidLimit },
        ]) {
          const result = handleKnowledgeTool(name, input, store);
          assert.equal(result.error?.code, "INVALID_ARGUMENT", JSON.stringify({ name, input, result }));
          assert.equal(result.error?.message, "page limit must be an integer between 1 and 500", JSON.stringify({ name, input, result }));
          assert.equal(result.items, undefined, JSON.stringify({ name, input, result }));
          assert.equal(result.candidates, undefined, JSON.stringify({ name, input, result }));
        }
      }
    }
    const conflict = handleKnowledgeTool("knowledge_file_symbols", {
      repo: "demo",
      path: "src/a.ts",
      limit: 1,
      page: { limit: 2 },
    }, store);
    assert.equal(conflict.error?.code, "INVALID_ARGUMENT", JSON.stringify(conflict));
    assert.equal(conflict.error?.message, "top-level limit conflicts with page.limit", JSON.stringify(conflict));
    const cursorConflict = handleKnowledgeTool("knowledge_file_symbols", {
      repo: "demo",
      path: "src/a.ts",
      cursor: "top-level-cursor",
      page: { cursor: "nested-cursor" },
    }, store);
    assert.equal(cursorConflict.error?.code, "INVALID_ARGUMENT", JSON.stringify(cursorConflict));
    assert.equal(cursorConflict.error?.message, "top-level cursor conflicts with page.cursor", JSON.stringify(cursorConflict));
  } finally {
    store.db.prepare = prepare;
    store.close();
  }
});

test("knowledge_search compact mode keeps locators and evidence while dropping excerpts", () => {
  const { store } = fixture();
  const result = handleKnowledgeTool("knowledge_search", {
    query: "Alpha",
    repo: "demo",
    allow_fallback: true,
    mode: "lexical",
    options: { compact: true },
    page: { limit: 5 },
  }, store);
  assert.ok(result.hits.length > 0, JSON.stringify(result));
  assert.ok(result.hits.every((hit) => hit.locator?.filePath), JSON.stringify(result.hits));
  assert.ok(result.hits.every((hit) => !Object.hasOwn(hit, "snippet")), JSON.stringify(result.hits));
  assert.ok(result.hits.every((hit) => hit.evidence.every((evidence) => !Object.hasOwn(evidence, "excerpt"))), JSON.stringify(result.hits));
  assert.ok(["candidate", "not_proven", "proven"].includes(result.proofStatus));
  store.close();
});

// get_node/explore_graph/compare_branches are selector-gated (see
// legacyGatedRepoId in knowledge-tools.ts): they don't have allow_fallback in
// their schemas or locator/warnings on their results, so unlike the 9 named
// scoped tools above, routing their symbol-inferred repo through
// resolveQueryScope unconditionally would newly hard-fail previously-answering
// calls with BRANCH_NOT_INDEXED. These two cases pin that gate down.
test("get_node with no selector against an un-indexed checked-out branch still answers (selector-gated, not scope-unified)", () => {
  const { store, nodeId } = fixture();
  const result = handleKnowledgeTool("get_node", { id: nodeId }, store);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /BRANCH_NOT_INDEXED/);
  assert.equal(result.node?.title, "Alpha");
  store.close();
});

test("get_node with an explicit branch selector for a non-existent branch still errors (SCOPE_NOT_FOUND path unchanged)", () => {
  const { store, nodeId } = fixture();
  const result = handleKnowledgeTool("get_node", { id: nodeId, branch: "no-such-branch" }, store);
  assert.equal(result.error?.code, "SCOPE_NOT_FOUND", JSON.stringify(result));
  store.close();
});

// status_panel is the MCP-side wiring for knowledge.status_panel (Task 3):
// same fixture as above (git checked out on un-indexed "feature-x", only
// "main" registered/indexed) exercises the same branch_not_indexed +
// live-fallback path already covered end-to-end for the native query-server
// runtime in tests/knowledge-status-panel.test.mjs.
test("status_panel reports branch_not_indexed with a live fallback via the MCP handler", () => {
  const { store, rootPath } = fixture();
  const result = handleKnowledgeTool("status_panel", {}, store);
  assert.equal(result.db.schemaVersion, 18);
  assert.equal(result.repos.length, 1);
  assert.equal(result.repos[0].rootPath, rootPath);
  assert.equal(result.repos[0].branchName, "feature-x");
  assert.equal(result.repos[0].revisionAlignment, "branch_not_indexed");
  assert.equal(result.repos[0].indexedBranch, "main");
  store.close();
});

// Phase 1B Task 9: the MCP server opens its own store (openKnowledgeStore(),
// via PENGUIN_KNOWLEDGE_DB/PENGUIN_KNOWLEDGE_LEDGER) independently of any
// caller-supplied `store` -- runKnowledgeTool (unlike handleKnowledgeTool
// above, which always takes a pre-opened store) is the actual code path that
// must refuse to migrate a stale on-disk schema.
test("MCP tool call against a version-spoofed store returns the standard SCHEMA_OUTDATED error without migrating", async () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-mcp-schema-outdated-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const seed = KnowledgeStore.open({ dbPath, ledgerPath });
  seed.db.prepare("UPDATE meta SET value='12' WHERE key='schema_version'").run();
  seed.close();

  const priorDb = process.env.PENGUIN_KNOWLEDGE_DB;
  const priorLedger = process.env.PENGUIN_KNOWLEDGE_LEDGER;
  process.env.PENGUIN_KNOWLEDGE_DB = dbPath;
  process.env.PENGUIN_KNOWLEDGE_LEDGER = ledgerPath;
  try {
    const result = await runKnowledgeTool("knowledge_capabilities", {});
    // knowledge_capabilities itself never touches the store, so this pins
    // that the gate fires before any handler runs, not just for
    // store-dependent tools.
    assert.equal(result?.error?.code, "SCHEMA_OUTDATED", JSON.stringify(result));
    assert.match(result.error.message, /knowledge_index/);
  } finally {
    if (priorDb === undefined) delete process.env.PENGUIN_KNOWLEDGE_DB; else process.env.PENGUIN_KNOWLEDGE_DB = priorDb;
    if (priorLedger === undefined) delete process.env.PENGUIN_KNOWLEDGE_LEDGER; else process.env.PENGUIN_KNOWLEDGE_LEDGER = priorLedger;
  }

  // The failed read-only open must not have run DDL/migration.
  const db = new Database(dbPath);
  const stored = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  assert.equal(Number(stored.value), 12);
  db.close();
});
