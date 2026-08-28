import assert from "node:assert/strict";
import { test } from "node:test";
import { MCP_IMPLEMENTED_CAPABILITIES } from "../packages/knowledge-contracts/dist/index.js";
import { KNOWLEDGE_TOOL_DEFS, MCP_LISTED_TOOL_DEFS } from "../packages/mcp/dist/knowledge-tool-defs.js";

// The first pass at collapsing tools/list from 119 entries assumed the
// auto-generated ones were mostly unimplemented placeholders. They were not:
// 98 capabilities have real MCP handlers, and 44 read-only ones became
// undiscoverable. An agent asked to list a file's symbols tried five tools and
// gave up while knowledge_file_symbols sat there working. These tests keep the
// listing curated WITHOUT hiding load-bearing read-only capability again.

const WRITE_OR_MAINTENANCE = /(create|write|append|remove|delete|set_master|accept|reject|sync|repair|bind|unbind|draft|install|import|capture|register|pin|materialize|watch|rebuild|improve|forget|remember|upsert)/;

test("knowledge_explore still leads the listing", () => {
  assert.equal(MCP_LISTED_TOOL_DEFS[0].name, "knowledge_explore");
});

test("the primitives an agent needs are all discoverable", () => {
  const listed = new Set(MCP_LISTED_TOOL_DEFS.map((tool) => tool.name));
  // Each of these answers a question that cannot be composed cheaply from the
  // others — enumerate a file, walk one relation, locate a symbol.
  for (const name of [
    "knowledge_file_symbols", // the one whose absence cost an agent 5 failed tools
    "knowledge_files",
    "knowledge_callers",
    "knowledge_callees",
    "knowledge_impact",
    "knowledge_affected",
    "knowledge_flow",
    "knowledge_path",
    "knowledge_locate",
    "knowledge_context",
    "knowledge_search",
    "knowledge_get_hit",
    "get_node",
  ]) {
    assert.ok(listed.has(name), `${name} must be discoverable from tools/list`);
  }
});

test("read-only implemented capabilities are not silently hidden", () => {
  const served = new Set(MCP_LISTED_TOOL_DEFS.map((tool) => tool["x-penguin-capability-id"]).filter(Boolean));
  const hiddenReadOnly = [...MCP_IMPLEMENTED_CAPABILITIES]
    .filter((id) => !served.has(id) && !WRITE_OR_MAINTENANCE.test(id));
  // A handful of niche read-only capabilities may stay unlisted, but the bulk
  // of them must not — that is the regression this file exists for.
  assert.ok(
    hiddenReadOnly.length < 25,
    `${hiddenReadOnly.length} read-only implemented capabilities are unreachable from tools/list: ${hiddenReadOnly.slice(0, 12).join(", ")}`,
  );
});

test("write and maintenance capabilities stay out of the listing", () => {
  const listed = MCP_LISTED_TOOL_DEFS.map((tool) => tool.name);
  for (const name of [
    "knowledge_memory_remember",
    "knowledge_note_create",
    "knowledge_source_sync",
    "knowledge_artifact_import",
    "knowledge_cli_install",
    "knowledge_repository_remove",
  ]) {
    assert.ok(!listed.includes(name), `${name} is a mutation and must not be advertised`);
  }
});

test("the listing stays short enough to scan", () => {
  // The point of curating is that an agent can read the list. Restoring the
  // read-only capabilities must not drift back toward 119.
  assert.ok(
    MCP_LISTED_TOOL_DEFS.length <= 60,
    `listing grew to ${MCP_LISTED_TOOL_DEFS.length} — re-tier instead of appending`,
  );
  assert.ok(KNOWLEDGE_TOOL_DEFS.length > 100, "the full manifest is still complete for parity checks");
});

test("every listed tool is dispatchable", async () => {
  const { isKnowledgeTool } = await import("../packages/mcp/dist/knowledge-tool-defs.js");
  for (const tool of MCP_LISTED_TOOL_DEFS) {
    assert.ok(isKnowledgeTool(tool.name), `${tool.name} is advertised but not dispatchable`);
  }
});

test("file_symbols answers the natural {repo, path} call with coordinates", async () => {
  // It used to require a bare branch_id and returned [] for {repo, path} — a
  // silent empty list for a file that HAS symbols, which reads as "nothing is
  // defined here". Now it resolves the repo's live branch, and every row
  // carries a line number so a caller does not re-query each symbol.
  const { KnowledgeStore, listFileSymbols } = await import("../packages/knowledge-core/dist/index.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pk-fs-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = "repo_fs";
  store.db.prepare("INSERT INTO repos(id,name,root_path,created_at) VALUES (?,?,?,?)")
    .run(repoId, "fsrepo", "/tmp/fsrepo", new Date().toISOString());
  store.db.prepare("INSERT INTO branches(id,repo_id,name,status,default_branch) VALUES (?,?,?,?,1)")
    .run("branch_fs", repoId, "main", "live");
  const node = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::Thing`, repoId, title: "Thing", meta: {} });
  store.db.prepare(`INSERT INTO symbol_versions
    (node_id,branch_id,commit_sha,file_path,lang,kind,content_hash,status,start_line,end_line)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(node, "branch_fs", "c0", "src/thing.ts", "ts", "class", "h0", "fresh", 10, 42);

  const rows = listFileSymbols(store, "branch_fs", "src/thing.ts");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, "Thing");
  assert.equal(rows[0].startLine, 10, "coordinates come back with the row");
  assert.equal(rows[0].endLine, 42);
  store.close();
});
