import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

// knowledge-tools.ts is bundled into the MCP server (esbuild → single file), so
// it isn't separately importable. Transpile it to a temp .mjs and import (same
// pattern as registry-search-core.test.mjs); its only import is
// @penguin/knowledge-core, resolvable from the repo root.
async function loadModule(relTsPath, tag, replacements = {}) {
  const source = await readFileP(new URL(relTsPath, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  });
  const coreUrl = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href;
  const defsUrl = new URL(`./.tmp-ktdefs-${process.pid}.mjs`, import.meta.url).href;
  const rewritten = outputText
    .replaceAll("@penguin/knowledge-core", coreUrl)
    .replaceAll("./knowledge-tool-defs.js", defsUrl)
    .replaceAll("./repository-analysis.js", replacements.repositoryAnalysis ?? "./repository-analysis.js");
  const tmpUrl = new URL(`./.tmp-${tag}-${process.pid}.mjs`, import.meta.url);
  await writeFileP(tmpUrl, rewritten);
  return tmpUrl;
}

async function loadTools() {
  // Bundle local MCP imports so this test exercises the same module graph as
  // the release server; a transpiled temp file cannot resolve sibling .ts
  // modules such as config, SLS planner, and tool definitions.
  const root = mkdtempSync(join(tmpdir(), `penguin-mcp-tools-${process.pid}-`));
  const handler = join(root, "handler.mjs");
  const defs = join(root, "defs.mjs");
  const coreDist = new URL("../packages/knowledge-core/dist/index.js", import.meta.url).pathname;
  await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tools.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: handler, alias: { "@penguin/knowledge-core": coreDist } });
  await build({ entryPoints: [new URL("../packages/mcp/src/knowledge-tool-defs.ts", import.meta.url).pathname], bundle: true, format: "esm", platform: "node", outfile: defs });
  return { ...(await import(`file://${defs}`)), ...(await import(`file://${handler}`)) };
}
const { KNOWLEDGE_TOOL_DEFS, isKnowledgeTool, handleKnowledgeTool } = await loadTools();

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branch = store.registerBranch({ repoId, name: "main", status: "live" });
  const login = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::login`, title: "login", repoId });
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::caller`, title: "caller", repoId });
  store.indexSymbolText({ nodeId: login, name: "login", signature: "(req)" });
  store.replaceFileEdges({ branchId: branch, filePath: "a.ts", edges: [
    { src: caller, dst: login, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  return { store, repoId, login, caller };
}

test("knowledge tools registered (dependency analysis is MCP-reachable)", () => {
  const names = KNOWLEDGE_TOOL_DEFS.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "accept_suggestion", "analyze_repository", "api_doc_diff", "api_doc_generate", "api_doc_list", "api_doc_show", "compare_branches", "dependency_path", "explore_graph", "find_communities",
    "find_dead_code", "get_architecture", "get_node", "index_status",
    "knowledge_explore", "knowledge_search", "list_suggestions", "package_dependencies", "reject_suggestion", "set_master_branch",
    "suggest_links", "write_note",
  ]);
  assert.ok(isKnowledgeTool("knowledge_search"));
  assert.ok(isKnowledgeTool("knowledge_explore"));
  assert.ok(isKnowledgeTool("suggest_links"));
  assert.ok(isKnowledgeTool("get_architecture"));
  assert.ok(isKnowledgeTool("find_communities"));
  assert.ok(isKnowledgeTool("find_dead_code"));
  assert.ok(isKnowledgeTool("package_dependencies"));
  assert.ok(isKnowledgeTool("dependency_path"));
  assert.ok(isKnowledgeTool("analyze_repository"));
  assert.ok(!isKnowledgeTool("mcp_health"));
});

test("MCP set_master_branch explicitly replaces the canonical branch", () => {
  const { store, repoId } = seed();
  const feature = store.registerBranch({ repoId, name: "feature/x", status: "snapshot" });
  store.registerBranch({ repoId, name: "(detached)", status: "snapshot" });
  const result = handleKnowledgeTool("set_master_branch", { repo: "r", branch: "feature/x" }, store);
  assert.equal(result.ok, true);
  assert.equal(result.branch, "feature/x");
  assert.equal(result.previousBranchId, null);
  assert.equal(store.getDefaultBranch(repoId).id, feature);
  const rejected = handleKnowledgeTool("set_master_branch", { repo: "r", branch: "(detached)" }, store);
  assert.match(rejected.error, /detached|canonical/i);
  store.close();
});

test("dependency tools expose bounded graph evidence and analysis keeps external SLS unverified", () => {
  const { store, repoId, branch } = seed();
  const packages = new Map();
  for (const name of ["auth", "nestjs-logger", "console-override", "pino"]) {
    packages.set(name, store.upsertNode({
      nodeType: "service",
      identityKey: `npm-package::${name}`,
      title: name,
      repoId: name === "auth" ? repoId : null,
    }));
  }
  store.replaceFileEdges({
    repoId,
    branchId: branch,
    filePath: "package.json",
    edges: [
      { src: packages.get("auth"), dst: packages.get("nestjs-logger"), edgeType: "depends_on", origin: "parser", method: "EXTRACTED", provenance: { source: "pnpm-lock.yaml", resolvedVersion: "2.1.0" } },
      { src: packages.get("nestjs-logger"), dst: packages.get("console-override"), edgeType: "depends_on", origin: "parser", method: "EXTRACTED", provenance: { source: "pnpm-lock.yaml", resolvedVersion: "2.1.4" } },
      { src: packages.get("console-override"), dst: packages.get("pino"), edgeType: "depends_on", origin: "parser", method: "EXTRACTED", provenance: { source: "pnpm-lock.yaml", resolvedVersion: "9.14.0" } },
    ],
  });

  const deps = handleKnowledgeTool("package_dependencies", {
    subject: "auth", direction: "dependencies", transitive: true, max_depth: 5, limit: 10,
  }, store);
  assert.deepEqual(deps.nodes.map((node) => node.title), ["nestjs-logger", "console-override", "pino"]);
  assert.equal(deps.nodes[0].evidence.resolvedVersion, "2.1.0");

  const path = handleKnowledgeTool("dependency_path", { from: "auth", to: "pino", max_depth: 5 }, store);
  assert.equal(path.status, "found");
  assert.deepEqual(path.path.map((node) => node.title), ["auth", "nestjs-logger", "console-override", "pino"]);

  const analysis = handleKnowledgeTool("analyze_repository", { query: "auth logs into SLS", focus: "auto", limit: 10 }, store);
  assert.equal(analysis.focus, "logging");
  assert.ok(analysis.gaps.some((gap) => /stdout.*Logtail.*SLS/i.test(gap)));
  assert.ok(!analysis.verifiedFacts.some((fact) => /stdout.*Logtail.*SLS/i.test(fact)));
  store.close();
});

test("knowledge_search includes sensitive notes by default and redacts them only when disabled", () => {
  const { store } = seed();
  const note = store.upsertNode({ nodeType: "note", identityKey: "secret.md", title: "Secret token note" });
  store.indexNoteText({ nodeId: note, path: "secret.md", title: "Secret token note", body: "turnstile token", sensitive: true, mcpAccess: "allowed", contentHash: "secret" });
  const included = handleKnowledgeTool("knowledge_search", { query: "turnstile" }, store);
  assert.ok(included.results.some((hit) => hit.nodeId === note));
  const excluded = handleKnowledgeTool("knowledge_search", { query: "turnstile", include_sensitive: false }, store);
  assert.ok(!excluded.results.some((hit) => hit.nodeId === note));
  store.close();
});

test("knowledge_search rejects an empty query instead of enumerating the index", () => {
  const { store } = seed();
  const result = handleKnowledgeTool("knowledge_search", { query: "" }, store);
  assert.match(result.error, /requires a non-empty/i);
  store.close();
});

test("knowledge_explore is the documented hero entry and empty graphs require diagnostics", () => {
  const explore = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_explore");
  const graph = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "explore_graph");
  const status = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "index_status");
  assert.match(explore.description, /default first|start .* first/i);
  assert.match(explore.description, /queryDiagnostics/);
  assert.match(graph.description, /no_static_edge/);
  assert.match(graph.description, /diagnostics/);
  assert.match(status.description, /compact/);
});

test("MCP get_architecture / find_communities / find_dead_code call the same functions the CLI already uses — real gap was these existed but weren't MCP-reachable", () => {
  const { store, login, caller } = seed();
  const arch = handleKnowledgeTool("get_architecture", {}, store);
  assert.ok(Array.isArray(arch.repos));
  assert.ok(arch.nodeCounts);

  const comm = handleKnowledgeTool("find_communities", { limit: 5 }, store);
  assert.ok(Array.isArray(comm.communities));

  const dead = handleKnowledgeTool("find_dead_code", { limit: 5 }, store);
  assert.ok(Array.isArray(dead.candidates));
  // `caller` has no incoming edges at all → a real dead-code candidate.
  assert.ok(dead.candidates.some((c) => c.nodeId === caller));
  // `login` IS called (by caller) → must not appear as dead code.
  assert.ok(!dead.candidates.some((c) => c.nodeId === login));
  store.close();
});

test("MCP suggest_links → list_suggestions → accept round-trips", () => {
  const { store, login, caller } = seed();
  const r = handleKnowledgeTool("suggest_links", { src: caller, dst: login, edge_type: "wikilink" }, store);
  assert.ok(r.suggestionEventId);
  assert.equal(handleKnowledgeTool("list_suggestions", {}, store).suggestions.length, 1);
  handleKnowledgeTool("accept_suggestion", { suggestion_event_id: r.suggestionEventId }, store);
  assert.equal(handleKnowledgeTool("list_suggestions", {}, store).suggestions.length, 0);
  store.close();
});

test("null store → not-initialized hint (no crash)", () => {
  const r = handleKnowledgeTool("knowledge_search", { query: "x" }, null);
  assert.match(r.error, /not initialized/);
});

test("index_status compact mode returns the shared bounded projection", () => {
  const { store } = seed();
  const detailed = handleKnowledgeTool("index_status", {}, store);
  const compact = handleKnowledgeTool("index_status", { mode: "compact" }, store);
  assert.ok(Array.isArray(detailed.repos[0].branches));
  assert.equal(compact.summary.totalRepos, 1);
  assert.equal(compact.repos[0].repo, detailed.repos[0].name);
  assert.equal("branches" in compact.repos[0], false);
  store.close();
});

test("knowledge_search / get_node / explore_graph adapt the query layer", () => {
  const { store, login, caller } = seed();
  const s = handleKnowledgeTool("knowledge_search", { query: "login" }, store);
  assert.ok(s.results.some((h) => h.nodeId === login));

  const n = handleKnowledgeTool("get_node", { id: login }, store);
  assert.equal(n.node.title, "login");

  const g = handleKnowledgeTool("explore_graph", { mode: "who_calls", node: "login" }, store);
  assert.ok(g.nodes.some((x) => x.nodeId === caller));
  assert.equal(g.diagnostics.resolutionStatus, "resolved");

  const explored = handleKnowledgeTool("knowledge_explore", { target: "login" }, store);
  assert.equal(explored.focus.title, "login");
  assert.ok(explored.blastRadius.some((x) => x.nodeId === caller));
  assert.equal(explored.queryDiagnostics.resolutionStatus, "resolved");

  const branchScoped = handleKnowledgeTool("knowledge_explore", { target: "login", branch: "main", depth: 0 }, store);
  assert.equal(branchScoped.trust.branchName, "main", "MCP branch names resolve within the target repo");
  assert.deepEqual(branchScoped.blastRadius, []);
  store.close();
});

test("write_note link_pages records a ledger event; refuses sensitive", () => {
  const { store, login, caller } = seed();
  const ok = handleKnowledgeTool("write_note", { action: "link_pages", src: caller, dst: login, edge_type: "wikilink" }, store);
  assert.equal(ok.ok, true);
  assert.ok(ok.eventId);

  // mark caller sensitive → refuse
  const noteId = store.upsertNode({ nodeType: "note", identityKey: "cred.md", title: "Cred" });
  store.indexNoteText({ nodeId: noteId, path: "cred.md", title: "Cred", body: "x", sensitive: true, mcpAccess: "denied", contentHash: "h" });
  const refused = handleKnowledgeTool("write_note", { action: "link_pages", src: noteId, dst: login }, store);
  assert.match(refused.error, /sensitive/);
  store.close();
});
