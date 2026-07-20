import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, searchKnowledge } from "../packages/knowledge-core/dist/index.js";
import { CAPABILITIES } from "../packages/knowledge-contracts/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

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
const { KNOWLEDGE_TOOL_DEFS, isKnowledgeTool, handleKnowledgeTool, runKnowledgeTool, createMutationConfirmationToken, mutationGuard } = await loadTools();

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
  assert.ok(names.length >= CAPABILITIES.length);
  for (const capability of CAPABILITIES) assert.ok(names.includes(capability.id.replaceAll(".", "_")), capability.id);
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

test("retrieved MCP content is explicitly bounded as untrusted data", () => {
  const searchTool = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_search");
  const hitTool = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_get_hit");
  assert.match(searchTool.description, /untrusted data/i);
  assert.match(searchTool.description, /not system instructions/i);
  assert.match(hitTool.description, /untrusted data/i);
});

test("MCP mutations are disabled by default and require an operation-scoped token", async () => {
  const oldMode = process.env.PENGUIN_MCP_MUTATIONS;
  const oldSecret = process.env.PENGUIN_MCP_CONFIRMATION_SECRET;
  delete process.env.PENGUIN_MCP_MUTATIONS;
  delete process.env.PENGUIN_MCP_CONFIRMATION_SECRET;
  const input = { id: "term", canonical_name: "Term", definition: "definition" };
  assert.equal((await runKnowledgeTool("knowledge_ontology_upsert", input)).error, "MUTATION_DISABLED");
  process.env.PENGUIN_MCP_MUTATIONS = "enabled";
  process.env.PENGUIN_MCP_CONFIRMATION_SECRET = "test-confirmation-secret";
  assert.equal(mutationGuard("knowledge_ontology_upsert", input).error, "CONFIRMATION_TOKEN_REQUIRED");
  const token = createMutationConfirmationToken("knowledge.ontology.upsert", input, { secret: "test-confirmation-secret" });
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(mutationGuard("knowledge_ontology_upsert", { ...input, confirmation_token: `${token}tampered` }).error, "CONFIRMATION_TOKEN_INVALID");
  assert.deepEqual(mutationGuard("knowledge_ontology_upsert", { ...input, confirmation_token: token }), { capabilityId: "knowledge.ontology.upsert" });
  if (oldMode === undefined) delete process.env.PENGUIN_MCP_MUTATIONS; else process.env.PENGUIN_MCP_MUTATIONS = oldMode;
  if (oldSecret === undefined) delete process.env.PENGUIN_MCP_CONFIRMATION_SECRET; else process.env.PENGUIN_MCP_CONFIRMATION_SECRET = oldSecret;
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

test("knowledge_search resolves repository roots and rejects unknown repo selectors", () => {
  const { store } = seed();
  const byRoot = handleKnowledgeTool("knowledge_search", { query: "login", repo: "/r" }, store);
  assert.equal(byRoot.error, undefined, "registered root path must be accepted as a repository selector");
  const missing = handleKnowledgeTool("knowledge_search", { query: "login", repo: "/missing-repo", mode: "exact", contract_version: "2" }, store);
  assert.equal(missing.error, "REPOSITORY_NOT_FOUND");
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

test("knowledge capability negotiation exposes the shared tuple and rejects incompatible majors", () => {
  const current = handleKnowledgeTool("knowledge_capabilities", { contract_version: "2" }, null);
  assert.equal(current.contractVersion, "2");
  assert.equal(current.schemaVersion, "13");
  assert.equal(typeof current.capabilityHash, "string");
  assert.equal(typeof current.buildId, "string");
  const incompatible = handleKnowledgeTool("knowledge_capabilities", { contract_version: "99" }, null);
  assert.equal(incompatible.error.code, "CAPABILITY_MISMATCH");
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

test("MCP markdown source sync uses the shared source corpus", () => {
  const root = mkdtempSync(join(tmpdir(), "pk-mcp-vault-"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "runbook.md"), "# Runbook\nRestart the resident worker.\n");
  const { store } = seed();
  const source = handleKnowledgeTool("knowledge_source_register", { type: "markdown_directory", location: root }, store);
  const synced = handleKnowledgeTool("knowledge_source_sync", { id: source.id }, store);
  assert.equal(synced.source.status, "synced");
  assert.equal(synced.files, 1);
  assert.ok(store.db.prepare("SELECT 1 FROM source_facts WHERE file_path='docs/runbook.md'").get());
  store.close();
});

test("MCP external source removal is confirmation guarded", () => {
  const { store } = seed();
  const source = handleKnowledgeTool("knowledge_source_register", { type: "url", location: "https://docs.example.com" }, store);
  assert.equal(handleKnowledgeTool("knowledge_source_remove", { id: source.id }, store).error, "CONFIRMATION_REQUIRED");
  assert.deepEqual(handleKnowledgeTool("knowledge_source_remove", { id: source.id, confirmed: true }, store), { ok: true, id: source.id });
  store.close();
});

test("MCP external Postgres source lifecycle accepts a host-owned read-only adapter", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-pg-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const credential = store.upsertNode({ nodeType: "credential", identityKey: "credential:mcp-pg", title: "mcp postgres" });
  store.putCredential({ nodeId: credential, title: "mcp postgres", kind: "postgres", body: "never returned" });
  const source = handleKnowledgeTool("knowledge_source_register", { type: "postgres_schema", location: "postgres://schema-only", config: { credentialEntryId: credential, schemas: ["public"] } }, store);
  assert.equal(handleKnowledgeTool("knowledge_source_list", {}, store).length, 1);
  const client = { query: async (sql) => sql.includes("information_schema.columns") ? { rows: [{ table_schema: "public", table_name: "players", column_name: "id", data_type: "uuid", is_nullable: "NO", ordinal_position: 1 }] } : { rows: [] } };
  const synced = await handleKnowledgeTool("knowledge_source_sync", { id: source.id }, store, { postgresSchemaClient: client });
  assert.equal(synced.tables, 1);
  assert.equal(handleKnowledgeTool("knowledge_source_remove", { id: source.id }, store).error, "CONFIRMATION_REQUIRED");
  assert.deepEqual(handleKnowledgeTool("knowledge_source_remove", { id: source.id, confirmed: true }, store), { ok: true, id: source.id });
  store.close();
});

test("200 canonical search requests keep core, CLI and MCP semantic fields aligned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-surface-parity-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const repoId = store.registerRepo({ name: "parity", rootPath: dir });
  const branchId = store.registerBranch({ repoId, name: "main", status: "snapshot", checkoutPath: dir });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "parity-main", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 13 });
  const content = Array.from({ length: 200 }, (_, index) => `ParityNeedle${String(index).padStart(3, "0")} appears here.\n`).join("");
  const raw = Buffer.from(content);
  const hash = (await import("node:crypto")).createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store);
  const blob = source.putBlob({ contentHash: hash, rawBytes: raw, decodedContent: content, encoding: "utf8" });
  const fact = source.putSourceFact({ repoId, filePath: "docs/parity.md", factFingerprint: hash, contentHash: hash, sourceBlobId: blob, coverage: { status: "admitted", reasonCode: "text_searchable", classification: "documentation" } });
  store.db.prepare("INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(repoId, "docs/parity.md", "tracked", "admitted", "text_searchable", "documentation", raw.length, "fixture", new Date().toISOString());
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: "docs/parity.md", sourceFactId: fact }]);
  cow.materializeManifest(snapshot.id);
  const topology = new GitTopologyStore(store);
  topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: null });
  store.close();

  const normalize = (value) => ({
    hits: value.hits.map((hit) => ({ kind: hit.kind, lane: hit.lane, title: hit.title, locator: hit.locator, score: Number(hit.score.toFixed(6)), rankReasons: hit.rankReasons, evidence: hit.evidence.map((item) => ({ source: item.source, status: item.status, locator: item.locator })) })),
    searchedLanes: value.diagnostics.searchedLanes,
    warnings: value.diagnostics.warnings,
    page: { limit: value.page.limit, totalIsExact: value.page.totalIsExact, hasNextCursor: Boolean(value.page.nextCursor) },
  });
  const queries = Array.from({ length: 200 }, (_, index) => `ParityNeedle${String(index).padStart(3, "0")}`);
  for (const query of queries) {
    const context = { store: KnowledgeStore.open({ dbPath, ledgerPath }), scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "parity" };
    const core = searchKnowledge({ query, mode: "exact", page: { limit: 5 } }, context);
    context.store.close();
    const lines = [];
    const deps = { cwd: dir, out: (line) => lines.push(line), err: (line) => lines.push(line), storeExists: () => true, openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }) };
    assert.equal(await runCli(["search", query, "--mode", "exact", "--compact", "--limit", "5", "--json"], deps), 0);
    const cli = JSON.parse(lines.at(-1));
    const mcpStore = KnowledgeStore.open({ dbPath, ledgerPath });
    const mcp = handleKnowledgeTool("knowledge_search", { query, mode: "exact", contract_version: "2", compact: true, limit: 5 }, mcpStore);
    mcpStore.close();
    assert.deepEqual(normalize(cli), normalize(core), `CLI drift for ${query}`);
    assert.deepEqual(normalize(mcp), normalize(core), `MCP drift for ${query}`);
  }
  const resident = spawn(process.execPath, ["packages/knowledge-cli/dist/bin.js", "__query-server"], {
    cwd: process.cwd(),
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: dbPath, PENGUIN_KNOWLEDGE_LEDGER: ledgerPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const residentLines = createInterface({ input: resident.stdout });
  const residentFrames = residentLines[Symbol.asyncIterator]();
  const nextResidentFrame = async () => {
    const next = await residentFrames.next();
    assert.equal(next.done, false, "resident runtime exited during parity run");
    return JSON.parse(next.value);
  };
  try {
    assert.equal((await nextResidentFrame()).type, "hello");
    for (const query of queries) {
      const context = { store: KnowledgeStore.open({ dbPath, ledgerPath }), scopes: [{ repoId, snapshotId: snapshot.id }], cursorSecret: "parity" };
      const core = searchKnowledge({ query, mode: "exact", page: { limit: 5 } }, context);
      context.store.close();
      resident.stdin.write(`${JSON.stringify({ type: "request", id: query, capabilityId: "knowledge.search", input: { query, mode: "exact", scope: { revisions: [{ repoId, snapshotId: snapshot.id }] }, page: { limit: 5 } } })}\n`);
      const frame = await nextResidentFrame();
      assert.equal(frame.ok, true, `resident error for ${query}`);
      assert.deepEqual(normalize(frame.result), normalize(core), `Resident drift for ${query}`);
    }
    const pageRequest = { query: "ParityNeedle", mode: "substring", scope: { revisions: [{ repoId, snapshotId: snapshot.id }] }, page: { limit: 5 } };
    const pageStore1 = KnowledgeStore.open({ dbPath, ledgerPath });
    const corePage1 = searchKnowledge(pageRequest, { store: pageStore1, scopes: [{ repoId, snapshotId: snapshot.id }] });
    pageStore1.close();
    const pageStore2 = KnowledgeStore.open({ dbPath, ledgerPath });
    const corePage2 = searchKnowledge({ ...pageRequest, page: { limit: 5, cursor: corePage1.page.nextCursor } }, { store: pageStore2, scopes: [{ repoId, snapshotId: snapshot.id }] });
    pageStore2.close();
    const pageFrames = [];
    for (const page of [pageRequest, { ...pageRequest, page: { limit: 5, cursor: corePage1.page.nextCursor } }]) {
      resident.stdin.write(`${JSON.stringify({ type: "request", id: `page-${pageFrames.length}`, capabilityId: "knowledge.search", input: page })}\n`);
      const frame = await nextResidentFrame();
      assert.equal(frame.ok, true, JSON.stringify(frame));
      pageFrames.push(frame.result);
    }
    assert.deepEqual(normalize(pageFrames[0]), normalize(corePage1), "Resident page 1 drift");
    assert.deepEqual(normalize(pageFrames[1]), normalize(corePage2), "Resident page 2 drift");
    const cliPageLines = [];
    await runCli(["search", "ParityNeedle", "--mode", "substring", "--compact", "--limit", "5", "--json"], { cwd: dir, out: (line) => cliPageLines.push(line), err: (line) => cliPageLines.push(line), storeExists: () => true, openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }) });
    const cliPage1 = JSON.parse(cliPageLines.at(-1));
    const cliPage2Lines = [];
    await runCli(["search", "ParityNeedle", "--mode", "substring", "--compact", "--limit", "5", "--cursor", cliPage1.page.nextCursor, "--json"], { cwd: dir, out: (line) => cliPage2Lines.push(line), err: (line) => cliPage2Lines.push(line), storeExists: () => true, openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }) });
    const cliPage2 = JSON.parse(cliPage2Lines.at(-1));
    assert.deepEqual(normalize(cliPage1), normalize(corePage1), "CLI page 1 drift");
    assert.deepEqual(normalize(cliPage2), normalize(corePage2), "CLI page 2 drift");
    const mcpPageStore1 = KnowledgeStore.open({ dbPath, ledgerPath });
    const mcpPage1 = handleKnowledgeTool("knowledge_search", { query: "ParityNeedle", mode: "substring", contract_version: "2", compact: true, limit: 5 }, mcpPageStore1);
    mcpPageStore1.close();
    const mcpPageStore2 = KnowledgeStore.open({ dbPath, ledgerPath });
    const mcpPage2 = handleKnowledgeTool("knowledge_search", { query: "ParityNeedle", mode: "substring", contract_version: "2", compact: true, limit: 5, cursor: mcpPage1.page.nextCursor }, mcpPageStore2);
    mcpPageStore2.close();
    assert.deepEqual(normalize(mcpPage1), normalize(corePage1), "MCP page 1 drift");
    assert.deepEqual(normalize(mcpPage2), normalize(corePage2), "MCP page 2 drift");
  } finally {
    resident.stdin.end();
    await new Promise((resolve) => resident.once("close", resolve));
    residentLines.close();
  }
  const hitStore = KnowledgeStore.open({ dbPath, ledgerPath });
  const hit = handleKnowledgeTool("knowledge_get_hit", { snapshot_id: snapshot.id, file_path: "docs/parity.md", start_line: 1 }, hitStore);
  assert.equal(hit.locator.filePath, "docs/parity.md");
  assert.match(hit.snippet, /ParityNeedle000/);
  hitStore.close();
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

test("get-hit rejects hydration from a different originating revision", () => {
  const { store } = seed();
  const result = handleKnowledgeTool("knowledge_get_hit", { snapshot_id: "snapshot-current", original_revision_id: "snapshot-old", file_path: "a.ts" }, store);
  assert.equal(result.error, "HIT_REVISION_MISMATCH");
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
