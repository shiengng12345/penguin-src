import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile as readFileP, writeFile as writeFileP, unlink as unlinkP } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { build } from "esbuild";
import { KnowledgeStore, GitTopologyStore, SourceStore, SourceSnapshotStore, SavedQueryStore, searchKnowledge, SCHEMA_VERSION } from "../packages/knowledge-core/dist/index.js";
import { CAPABILITIES, validateCapabilityOutput } from "../packages/knowledge-contracts/dist/index.js";
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
const { KNOWLEDGE_TOOL_DEFS, MCP_LISTED_TOOL_DEFS, isKnowledgeTool, handleKnowledgeTool, runKnowledgeTool, createMutationConfirmationToken, mutationGuard, unsupportedArguments, STRICT_TOOL_ARGUMENTS } = await loadTools();

function createJsonLineReader(child) {
  let buffer = "";
  const frames = [];
  const waiters = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const frame = JSON.parse(line);
      const waiter = waiters.find((candidate) => !candidate.predicate || candidate.predicate(frame));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      } else frames.push(frame);
    }
  });
  return {
    next(predicate, timeoutMs = 20_000) {
      const queued = frames.findIndex((frame) => !predicate || predicate(frame));
      if (queued >= 0) return Promise.resolve(frames.splice(queued, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for MCP frame")), timeoutMs);
        waiters.push({ predicate, resolve: (frame) => { clearTimeout(timer); resolve(frame); } });
      });
    },
  };
}

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const repoId = store.registerRepo({ name: "r", rootPath: "/r" });
  const branch = store.registerBranch({ repoId, name: "main", status: "live" });
  const login = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::login`, title: "login", repoId });
  const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::caller`, title: "caller", repoId });
  store.indexSymbolText({ nodeId: login, name: "login", signature: "(req)" });
  for (const [nodeId, title] of [[login, "login"], [caller, "caller"]]) {
    store.upsertSymbolVersion({
      nodeId, branchId: branch, commitSha: "c0", filePath: "a.ts", lang: "ts",
      kind: "function", contentHash: `h_${title}`, status: "fresh", startLine: 1, endLine: 3,
    });
  }
  store.replaceFileEdges({ branchId: branch, filePath: "a.ts", edges: [
    { src: caller, dst: login, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
  ] });
  return { store, repoId, branch, login, caller };
}

function seedSearchSnapshot(store, { name, rootPath, filePath, content }) {
  const repoId = store.registerRepo({ name, rootPath });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({
    snapshotKey: `${name}-snapshot`,
    repoId,
    parserVersion: "test-parser",
    resolverVersion: "test-resolver",
    schemaVersion: SCHEMA_VERSION,
  });
  const raw = Buffer.from(content, "utf8");
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const source = new SourceStore(store);
  const blob = source.putBlob({
    contentHash,
    rawBytes: raw,
    decodedContent: content,
    encoding: "utf8",
  });
  const fact = source.putSourceFact({
    repoId,
    filePath,
    factFingerprint: contentHash,
    contentHash,
    sourceBlobId: blob,
    coverage: {
      status: "admitted",
      reasonCode: "text_searchable",
      classification: "source",
    },
  });
  store.db.prepare(
    "INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(repoId, filePath, "tracked", "admitted", "text_searchable", "source", raw.length, "fixture", new Date().toISOString());
  const snapshots = new SourceSnapshotStore(store);
  snapshots.replaceOverlay(snapshot.id, [{ op: "add", path: filePath, sourceFactId: fact }]);
  snapshots.materializeManifest(snapshot.id);
  topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: null });
  return { repoId, snapshotId: snapshot.id };
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

test("knowledge_search publishes its canonical scope, options, and page contract", () => {
  const searchTool = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_search");
  const properties = searchTool.inputSchema.properties;

  assert.equal(properties.scope.type, "object");
  assert.equal(properties.scope.properties.revisions.type, "array");
  assert.equal(properties.scope.properties.revisions.items.properties.repoId.type, "string");
  assert.equal(properties.scope.properties.revisions.items.properties.snapshotId.type, "string");
  assert.equal(properties.options.properties.caseSensitive.type, "boolean");
  assert.equal(properties.page.properties.cursor.type, "string");
  assert.equal(properties.page.properties.limit.type, "number");
});

test("all primary discovery tools publish actionable canonical input schemas", () => {
  const requiredProperties = {
    get_node: ["id", "identity_key", "repo"],
    knowledge_doctor: ["mutation_preflight"],
    knowledge_files: ["repo", "branch"],
    knowledge_explain: ["target", "repo"],
    knowledge_local_graph: ["node", "target", "depth"],
    knowledge_onboarding_generate: ["repo"],
  };
  for (const [name, expected] of Object.entries(requiredProperties)) {
    const def = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === name);
    assert.ok(def, `${name} must be registered`);
    const keys = Object.keys(def.inputSchema.properties ?? {});
    for (const key of expected) assert.ok(keys.includes(key), `${name} schema must advertise ${key}`);
    assert.ok(keys.length > 0, `${name} must not publish an empty schema`);
  }
});

test("compact support is advertised only for operations with a reachable compact contract", () => {
  const compactCapabilities = CAPABILITIES
    .filter((capability) => capability.supportsCompact)
    .map((capability) => capability.id)
    .sort();
  assert.deepEqual(compactCapabilities, [
    "knowledge.capabilities",
    "knowledge.dead_code",
    "knowledge.endpoints",
    "knowledge.flow",
    "knowledge.index_status",
    "knowledge.search",
  ]);

  const flow = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_flow");
  assert.ok(Object.hasOwn(flow.inputSchema.properties, "limit"));
  assert.ok(Object.hasOwn(flow.inputSchema.properties, "compact"));

  const repositoryGraph = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_repository_graph");
  assert.deepEqual(repositoryGraph.inputSchema.required, ["repo"]);
  assert.ok(Object.hasOwn(repositoryGraph.inputSchema.properties, "limit"));
  assert.ok(Object.hasOwn(repositoryGraph.inputSchema.properties, "edge_limit"));

  const doctor = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_doctor");
  assert.ok(Object.hasOwn(doctor.inputSchema.properties, "deep"));
});

test("owner index mutations publish root requirements and standard MCP safety annotations", () => {
  for (const name of ["knowledge_repository_register", "knowledge_index", "knowledge_rebuild"]) {
    const def = MCP_LISTED_TOOL_DEFS.find((tool) => tool.name === name);
    assert.ok(def, `${name} must be listed`);
    assert.deepEqual(def.inputSchema.required, ["confirmed", "confirmation_token"]);
    assert.deepEqual(def.inputSchema.anyOf, [
      { required: ["root_path"] },
      { required: ["path"] },
    ]);
    assert.deepEqual(def.annotations, {
      title: def["x-penguin-capability-id"],
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  }
});

test("knowledge_doctor validates owner mutations without performing them", () => {
  const { store } = seed();
  const beforeRepos = store.db.prepare("SELECT COUNT(*) AS count FROM repos").get().count;
  const result = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: {
      action: "rebuild",
      root_path: process.cwd(),
    },
  }, store);

  assert.equal(result.status, "valid");
  assert.equal(result.readOnly, true);
  assert.equal(result.mutationPerformed, false);
  assert.equal(result.capability, "knowledge.rebuild");
  assert.equal(result.action, "rebuild");
  assert.equal(result.rootPath, process.cwd());
  assert.equal(result.confirmationRequired, true);
  assert.deepEqual(result.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  assert.deepEqual(result.nextAction, {
    tool: "knowledge_rebuild",
    arguments: { root_path: process.cwd(), confirmed: true },
    ownerApprovalRequired: true,
  });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM repos").get().count, beforeRepos);
  store.close();
});

test("knowledge_doctor mutation preflight returns typed errors before any mutation", () => {
  const { store } = seed();
  const missingRoot = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: { action: "index" },
  }, store);
  assert.equal(missingRoot.error.code, "ROOT_PATH_REQUIRED");
  assert.equal(missingRoot.error.retryable, false);

  const invalidAction = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: { action: "remove", root_path: process.cwd() },
  }, store);
  assert.equal(invalidAction.error.code, "MUTATION_PREFLIGHT_INVALID");
  assert.equal(invalidAction.error.retryable, false);
  assert.match(invalidAction.error.remediation, /register|index|rebuild/i);

  const outsideWorkspaceRoot = mkdtempSync(join(tmpdir(), "outside-penguin-workspace-"));
  execFileSync("git", ["init", "--quiet", outsideWorkspaceRoot]);
  const outsideWorkspace = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: { action: "register", root_path: outsideWorkspaceRoot },
  }, store);
  assert.equal(outsideWorkspace.error.code, "ROOT_PATH_OUT_OF_SCOPE");
  assert.equal(outsideWorkspace.error.retryable, false);
  assert.match(outsideWorkspace.error.remediation, /configured workspace roots/i);

  const relativeMissingRoot = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: { action: "rebuild", root_path: "not-an-absolute-path" },
  }, store);
  assert.equal(relativeMissingRoot.error.code, "MUTATION_PREFLIGHT_INVALID");
  assert.equal(relativeMissingRoot.error.retryable, false);
  assert.match(relativeMissingRoot.error.remediation, /absolute.*existing repository/i);
  assert.equal(relativeMissingRoot.nextAction, undefined);

  const absoluteMissingRoot = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: { action: "rebuild", root_path: join(process.cwd(), "not-an-existing-repository") },
  }, store);
  assert.equal(absoluteMissingRoot.error.code, "MUTATION_PREFLIGHT_INVALID");
  assert.equal(absoluteMissingRoot.error.retryable, false);
  assert.match(absoluteMissingRoot.error.remediation, /existing repository/i);
  assert.equal(absoluteMissingRoot.nextAction, undefined);
  store.close();
});

test("knowledge_doctor accepts exact registered roots for index and rebuild but not registration", () => {
  const { store } = seed();
  const registeredRoot = mkdtempSync(join(tmpdir(), "pk-mcp-registered-owner-root-"));
  execFileSync("git", ["init", "--quiet", registeredRoot]);
  store.registerRepo({ name: "registered-owner-root", rootPath: registeredRoot });

  for (const action of ["index", "rebuild"]) {
    const result = handleKnowledgeTool("knowledge_doctor", {
      mutation_preflight: { action, root_path: registeredRoot },
    }, store);
    assert.equal(result.status, "valid", JSON.stringify(result));
    assert.equal(result.rootPath, realpathSync.native(registeredRoot));
    assert.equal(result.mutationPerformed, false);
  }

  const register = handleKnowledgeTool("knowledge_doctor", {
    mutation_preflight: { action: "register", root_path: registeredRoot },
  }, store);
  assert.equal(register.error.code, "ROOT_PATH_OUT_OF_SCOPE");
  store.close();
});

test("knowledge_doctor is bounded by default and makes the expensive integrity scan explicit", () => {
  const { store } = seed();
  const bounded = handleKnowledgeTool("knowledge_doctor", {}, store);
  assert.equal(bounded.mode, "bounded");
  assert.equal(bounded.integrity.status, "not_run");
  assert.equal(bounded.integrity.deepRequired, true);
  assert.equal(bounded.foreignKeys.status, "not_run");
  assert.ok(bounded.registeredRepositories.some((repo) => repo.name === "r" && repo.rootPath === "/r"));
  assert.ok(Array.isArray(bounded.configuredWorkspaceRoots));

  const deep = handleKnowledgeTool("knowledge_doctor", { deep: true }, store);
  assert.equal(deep.mode, "deep");
  assert.equal(deep.integrity.status, "ok");
  assert.deepEqual(deep.foreignKeys.violations, []);
  store.close();
});

test("get_node names the accepted key when the caller uses an unsupported alias", () => {
  const { store, login } = seed();
  const result = handleKnowledgeTool("get_node", { node: login }, store);
  assert.equal(result.error.code, "MISSING_REQUIRED_ARGUMENT");
  assert.deepEqual(result.error.details.requiredAnyOf, ["id", "identity_key"]);
  assert.match(result.error.message, /id.*identity_key/i);
  store.close();
});

test("unknown node and endpoint targets return typed remediation errors", () => {
  const { store } = seed();
  const node = handleKnowledgeTool("get_node", { id: "node_missing" }, store);
  assert.equal(node.error.code, "NODE_NOT_FOUND");
  assert.match(node.error.remediation, /knowledge_search/i);

  const endpoint = handleKnowledgeTool("knowledge_flow", {
    target: "grpc://missing.Service/Call",
    repo: "r",
  }, store);
  assert.equal(endpoint.error.code, "ENDPOINT_NOT_FOUND");
  assert.match(endpoint.error.remediation, /knowledge_endpoints|endpoint/i);
  store.close();
});

test("graph trust separates current storage schema from the indexed parser format", () => {
  const { store, branch, login } = seed();
  store.db.prepare("UPDATE branches SET indexed_schema_version=17 WHERE id=?").run(branch);
  const result = handleKnowledgeTool("knowledge_context", { target: login, repo: "r" }, store);
  assert.equal(result.error.code, "SCHEMA_OUTDATED");
  assert.equal(result.error.details.runtimeSchemaVersion, SCHEMA_VERSION);
  assert.equal(result.error.details.indexedSchemaVersion, 17);
  store.close();
});

test("knowledge_affected reports the same completeness metadata for an equivalent path and node", () => {
  const { store, login } = seed();
  const byPath = handleKnowledgeTool("knowledge_affected", { repo: "r", path: "a.ts" }, store);
  const byNode = handleKnowledgeTool("knowledge_affected", { repo: "r", node: login }, store);
  assert.equal(byNode.candidateCount, byPath.candidateCount);
  assert.equal(byNode.returnedCount, byPath.returnedCount);
  assert.equal(byNode.totalIsExact, byPath.totalIsExact);
  assert.equal(byNode.completeness, byPath.completeness);
  assert.deepEqual(byNode.evidence.gaps, byPath.evidence.gaps);
  store.close();
});

test("node affected preserves symbol granularity while context may surface file-level test evidence", () => {
  const { store, repoId, branch, login } = seed();
  const provider = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::provider`, title: "provider", repoId });
  const spec = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::login-spec`, title: "login.spec", repoId });
  for (const [nodeId, filePath] of [[provider, "a.ts"], [spec, "a.spec.ts"]]) {
    store.upsertSymbolVersion({ nodeId, branchId: branch, commitSha: "c0", filePath, lang: "ts", kind: "function", contentHash: `h_${nodeId}`, status: "fresh", startLine: 1, endLine: 3 });
  }
  store.replaceFileEdges({ branchId: branch, filePath: "a.spec.ts", edges: [
    { src: spec, dst: provider, edgeType: "tests", origin: "parser", method: "EXTRACTED" },
  ] });
  const byPath = handleKnowledgeTool("knowledge_affected", { repo: "r", path: "a.ts" }, store);
  const byNode = handleKnowledgeTool("knowledge_affected", { repo: "r", node: login }, store);
  const context = handleKnowledgeTool("knowledge_context", { repo: "r", target: login }, store);
  assert.deepEqual(byNode.tests, []);
  assert.equal(byNode.impacted.some((item) => item.nodeId === provider), false);
  assert.ok(byPath.tests.some((item) => item.nodeId === spec));
  assert.ok(byPath.changed.some((item) => item.nodeId === provider));
  assert.ok(context.tests.some((item) => item.nodeId === spec), "context must surface file-level test evidence for the stable node handoff");
  store.close();
});

test("canonical nested semantic option routes through the async adapter and degrades to deterministic lanes", async () => {
  const { store, repoId } = seed();
  const response = await runKnowledgeTool("knowledge_search", {
    query: "login behavior",
    contract_version: "2",
    scope: { revisions: [{ repoId }] },
    options: { semantic: "blend" },
    page: { limit: 5 },
  }, { store });
  // The semantic/hybrid vector lane has been removed from knowledge-core: a
  // request for options.semantic now always gets a deterministic-only
  // result with an explicit degradation reason instead of a hybrid-fused
  // response (see search-engine.ts's searchKnowledgeAsync doc comment).
  assert.equal(response.diagnostics?.semantic?.requested, true, JSON.stringify(response));
  assert.equal(response.diagnostics?.semantic?.applied, false, JSON.stringify(response));
  assert.equal(response.diagnostics?.semantic?.reason, "async_semantic_lane_required", JSON.stringify(response));
  store.close();
});

test("knowledge_explain applies the requested repository scope to duplicate symbol names", async () => {
  const { store, repoId, login } = seed();
  const otherRepoId = store.registerRepo({ name: "other", rootPath: "/other" });
  const otherBranch = store.registerBranch({ repoId: otherRepoId, name: "main", status: "live" });
  const otherLogin = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${otherRepoId}::login`,
    title: "login",
    repoId: otherRepoId,
  });
  store.indexSymbolText({ nodeId: otherLogin, name: "login", signature: "(other)" });
  store.upsertSymbolVersion({
    nodeId: otherLogin,
    branchId: otherBranch,
    commitSha: "other-c0",
    filePath: "other.ts",
    lang: "ts",
    kind: "function",
    contentHash: "other-login",
    status: "fresh",
    startLine: 1,
    endLine: 3,
  });

  const result = await runKnowledgeTool("knowledge_explain", { target: "login", repo: "r" }, { store });

  assert.equal(result.context.focus?.nodeId, login, JSON.stringify(result));
  assert.equal(result.context.ambiguous, null, JSON.stringify(result));
  assert.equal(result.context.evidence?.scope?.repoId ?? result.context.scope?.repoId, repoId, JSON.stringify(result));

  const scopedMiss = await runKnowledgeTool("knowledge_explain", { target: otherLogin, repo: "r" }, { store });
  assert.equal(scopedMiss.context.focus, null, JSON.stringify(scopedMiss));
  assert.equal(scopedMiss.confidence, "unknown", JSON.stringify(scopedMiss));

  const unknownRepo = await runKnowledgeTool("knowledge_explain", { target: "login", repo: "missing" }, { store });
  assert.equal(unknownRepo.error?.code, "REPOSITORY_NOT_FOUND", JSON.stringify(unknownRepo));
  store.close();
});

test("architecture endpoint count uses the same repository ownership rule as endpoint inventory", () => {
  const { store, repoId, branch, caller } = seed();
  const ownedEndpoint = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc://owned.Service/Call", title: "owned.Service/Call", repoId, meta: { protocol: "grpc" } });
  const globalEndpoint = store.upsertNode({ nodeType: "endpoint", identityKey: "grpc://shared.Service/Call", title: "shared.Service/Call", repoId: null, meta: { protocol: "grpc" } });
  store.db.prepare("INSERT INTO endpoint_memberships(endpoint_id,repo_id,role,file_path,locator_node_id,created_at) VALUES (?,?,?,?,?,?)")
    .run(globalEndpoint, repoId, "consumer", "src/client.ts", null, new Date().toISOString());
  store.replaceFileEdges({ branchId: branch, filePath: "endpoint.ts", edges: [
    { src: ownedEndpoint, dst: caller, edgeType: "handles", origin: "parser", method: "EXTRACTED" },
  ] });

  const architecture = handleKnowledgeTool("get_architecture", { repo: "r" }, store);
  const endpoints = handleKnowledgeTool("knowledge_endpoints", { repo: "r", limit: 10 }, store);
  assert.equal(architecture.nodeCounts.endpoint, endpoints.candidateCount);
  assert.equal(architecture.nodeCounts.endpoint, 2);

  const compact = handleKnowledgeTool("knowledge_endpoints", { repo: "r", limit: 10, compact: true }, store);
  const normal = handleKnowledgeTool("knowledge_endpoints", { repo: "r", limit: 10, compact: false }, store);
  const owned = compact.items.find((item) => item.nodeId === ownedEndpoint);
  assert.equal(owned.handlers.length, 1);
  assert.equal("firstHopRelations" in owned, false, "identical endpoint relation aliases must not be duplicated");
  assert.equal("evidence" in compact, false, "compact responses must omit the root evidence mirror");
  assert.ok(compact.stats.compactRatio < 1, JSON.stringify(compact.stats));
  assert.equal(normal.stats.rawBytesEstimate, normal.stats.sentBytesEstimate);
  assert.equal(normal.stats.compactRatio, 1);
  assert.equal(compact.stats.rawBytesEstimate, normal.stats.sentBytesEstimate);
  const flow = handleKnowledgeTool("knowledge_flow", { target: globalEndpoint, repo: "r" }, store);
  assert.equal(flow.target.repoId, repoId);
  store.close();
});

test("knowledge_flow is bounded, truthful about truncation, and compact removes duplicate projections", () => {
  const { store, repoId, branch, login } = seed();
  let parent = login;
  for (let index = 0; index < 8; index += 1) {
    const child = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::flow-child-${index}`, title: `flowChild${index}`, repoId });
    store.upsertSymbolVersion({
      nodeId: child,
      branchId: branch,
      commitSha: "c0",
      filePath: `flow-${index}.ts`,
      lang: "ts",
      kind: "function",
      contentHash: `flow-${index}`,
      status: "fresh",
      startLine: 1,
      endLine: 2,
    });
    store.replaceFileEdges({ branchId: branch, filePath: `flow-${index}.ts`, edges: [
      { src: parent, dst: child, edgeType: "calls", origin: "parser", method: "EXTRACTED" },
    ] });
    parent = child;
  }

  const normal = handleKnowledgeTool("knowledge_flow", { target: login, repo: "r", limit: 3 }, store);
  const compact = handleKnowledgeTool("knowledge_flow", { target: login, repo: "r", limit: 3, compact: true }, store);
  assert.equal(normal.steps.length, 3);
  assert.equal(normal.returnedCount, 3);
  assert.equal(normal.truncated, true);
  assert.equal(normal.totalIsExact, false);
  assert.equal(compact.steps.length, 3);
  assert.equal("executionSteps" in compact, false);
  assert.equal("referenceSteps" in compact, false);
  assert.equal("evidence" in compact, false);
  assert.ok(compact.stats.sentBytesEstimate < normal.stats.sentBytesEstimate);
  assert.equal("sentBytes" in compact.stats, false);
  store.close();
});

test("knowledge_repository_graph defaults to the live revision and returns typed bounded errors", () => {
  const { store } = seed();
  const graph = handleKnowledgeTool("knowledge_repository_graph", { repo: "r", limit: 2, edge_limit: 2 }, store);
  assert.equal(graph.repo.name, "r");
  assert.ok(graph.revision);
  assert.ok(graph.nodes.length <= 2);
  assert.ok(graph.edges.length <= 2);
  assert.equal(graph.returnedCount, graph.nodes.length);

  const missingRepo = handleKnowledgeTool("knowledge_repository_graph", { repo: "missing" }, store);
  assert.equal(missingRepo.error.code, "REPOSITORY_NOT_FOUND");
  assert.match(missingRepo.error.remediation, /status_panel|repository/i);

  const missingBranch = handleKnowledgeTool("knowledge_repository_graph", { repo: "r", branch: "missing" }, store);
  assert.equal(missingBranch.error.code, "BRANCH_NOT_FOUND");
  assert.match(missingBranch.error.remediation, /branch|status_panel/i);
  store.close();
});

test("context counters include importer payloads and keep the evidence mirror aligned", () => {
  const { store, repoId, branch, login } = seed();
  const targetFile = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::a.ts`, title: "a.ts", repoId });
  const importerFile = store.upsertNode({ nodeType: "file", identityKey: `${repoId}::file::consumer.ts`, title: "consumer.ts", repoId });
  store.replaceFileEdges({ branchId: branch, filePath: "a.ts", edges: [
    { src: targetFile, dst: login, edgeType: "defines", origin: "parser", method: "EXTRACTED" },
  ] });
  store.replaceFileEdges({ branchId: branch, filePath: "consumer.ts", edges: [
    { src: importerFile, dst: targetFile, edgeType: "imports", origin: "parser", method: "EXTRACTED" },
  ] });

  const result = handleKnowledgeTool("knowledge_context", { target: login, repo: "r" }, store);
  assert.equal(result.importers.length, 1);
  assert.ok(result.returnedCount >= result.importers.length);
  assert.equal(result.evidence.returnedCount, result.returnedCount);
  store.close();
});

test("knowledge_context publishes and consumes a signed non-overlapping continuation cursor", () => {
  const { store, repoId, branch, login } = seed();
  for (let index = 0; index < 12; index += 1) {
    const caller = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::page-caller-${index}`, title: `pageCaller${index}`, repoId });
    store.upsertSymbolVersion({ nodeId: caller, branchId: branch, commitSha: "c0", filePath: `caller-${index}.ts`, lang: "ts", kind: "function", contentHash: `caller-${index}`, status: "fresh", startLine: 1, endLine: 2 });
    store.db.prepare("INSERT INTO edges(id,src,dst,edge_type,branch_id,origin,method,confidence,provenance,status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`context-page-${index}`, caller, login, "calls", branch, "parser", "EXTRACTED", 1, "{}", "active");
  }
  const first = handleKnowledgeTool("knowledge_context", { target: login, repo: "r", limit: 5 }, store);
  const second = handleKnowledgeTool("knowledge_context", { target: login, repo: "r", limit: 5, cursor: first.cursor }, store);
  assert.ok(first.cursor);
  assert.equal(first.callers.length, 5);
  assert.equal(second.callers.length, 5);
  assert.equal(first.callers.some((item) => second.callers.some((candidate) => candidate.nodeId === item.nodeId)), false);
  assert.equal(second.evidence.cursor, second.cursor);
  const schema = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "knowledge_context").inputSchema;
  assert.ok(Object.hasOwn(schema.properties, "cursor"));
  store.close();
});

test("knowledge_context keeps mixed-relation totals stable and identifies relation occurrences", () => {
  const { store, repoId, branch, login, caller } = seed();
  for (let index = 0; index < 4; index += 1) {
    const nodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${repoId}::mixed-page-caller-${index}`,
      title: `mixedPageCaller${index}`,
      repoId,
    });
    store.upsertSymbolVersion({
      nodeId,
      branchId: branch,
      commitSha: "c0",
      filePath: `mixed-caller-${index}.ts`,
      lang: "ts",
      kind: "function",
      contentHash: `mixed-caller-${index}`,
      status: "fresh",
      startLine: 1,
      endLine: 2,
    });
    store.db.prepare("INSERT INTO edges(id,src,dst,edge_type,branch_id,origin,method,confidence,provenance,status) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(`context-mixed-call-${index}`, nodeId, login, "calls", branch, "parser", "EXTRACTED", 1, "{}", "active");
  }
  store.db.prepare("INSERT INTO edges(id,src,dst,edge_type,branch_id,origin,method,confidence,provenance,status) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("context-mixed-reference", caller, login, "references", branch, "parser", "EXTRACTED", 1, "{}", "active");

  const pages = [];
  let cursor;
  do {
    const page = handleKnowledgeTool("knowledge_context", {
      target: login,
      repo: "r",
      limit: 2,
      ...(cursor ? { cursor } : {}),
    }, store);
    pages.push(page);
    cursor = page.cursor ?? undefined;
  } while (cursor && pages.length < 10);

  assert.ok(pages.length >= 3);
  assert.equal(cursor, undefined, "context continuation must deterministically exhaust");
  assert.ok(pages.every((page) => page.returnedCount <= 2));
  assert.ok(pages.every((page) => page.totalIsExact === true));
  assert.equal(new Set(pages.map((page) => page.candidateCount)).size, 1);

  const relationItems = pages.flatMap((page) => [
    ...page.callers,
    ...page.referencedBy,
  ]);
  assert.equal(relationItems.length, 6);
  assert.ok(relationItems.every((item) => typeof item.relationType === "string"));
  assert.ok(relationItems.every((item) => typeof item.relationItemId === "string"));
  assert.equal(new Set(relationItems.map((item) => item.relationItemId)).size, relationItems.length);
  const callerOccurrences = relationItems.filter((item) => item.nodeId === caller);
  assert.deepEqual(new Set(callerOccurrences.map((item) => item.relationType)), new Set(["callers", "referencedBy"]));
  store.close();
});

test("explore confidence counts inferred edges present in its call path", () => {
  const { store, repoId, branch, login } = seed();
  const inferred = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::inferred`, title: "inferred", repoId });
  store.upsertSymbolVersion({ nodeId: inferred, branchId: branch, commitSha: "c0", filePath: "inferred.ts", lang: "ts", kind: "function", contentHash: "h_inferred", status: "fresh", startLine: 1, endLine: 2 });
  store.replaceFileEdges({ branchId: branch, filePath: "inferred-edge.ts", edges: [
    { src: login, dst: inferred, edgeType: "injects", origin: "parser", method: "DI_MODULE_PROVIDER", confidence: 0.4 },
  ] });

  const result = handleKnowledgeTool("knowledge_explore", { target: login, repo: "r" }, store);
  assert.ok(result.callPath.some((step) => step.graphEvidence?.evidenceState === "inferred"));
  assert.ok(result.confidence.inferredEdges >= 1);
  store.close();
});

test("MCP mutations are disabled by default and require an operation-scoped token", async () => {
  const oldMode = process.env.PENGUIN_MCP_MUTATIONS;
  const oldSecret = process.env.PENGUIN_MCP_CONFIRMATION_SECRET;
  delete process.env.PENGUIN_MCP_MUTATIONS;
  delete process.env.PENGUIN_MCP_CONFIRMATION_SECRET;
  const input = { id: "term", canonical_name: "Term", definition: "definition" };
  assert.equal((await runKnowledgeTool("knowledge_ontology_upsert", input)).error.code, "MUTATION_DISABLED");
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
  assert.match(rejected.error.message, /detached|canonical/i);
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
  assert.match(result.error.message, /requires a non-empty/i);
  assert.equal(result.error.code, "INVALID_QUERY");
  assert.equal(result.error.retryable, false);
  assert.match(result.error.details.remediation, /non-empty/i);
  store.close();
});

test("knowledge_search resolves repository roots and rejects unknown repo selectors", () => {
  const { store } = seed();
  const byRoot = handleKnowledgeTool("knowledge_search", { query: "login", repo: "/r" }, store);
  assert.equal(byRoot.error, undefined, "registered root path must be accepted as a repository selector");
  const missing = handleKnowledgeTool("knowledge_search", { query: "login", repo: "/missing-repo", mode: "exact", contract_version: "2" }, store);
  assert.equal(missing.error.code, "REPOSITORY_NOT_FOUND");
  assert.equal(missing.error.retryable, false);
  assert.match(missing.error.details.remediation, /status/i);
  store.close();
});

test("knowledge_search keeps an unknown canonical repository distinct from a missing branch", () => {
  const { store } = seed();
  const missing = handleKnowledgeTool("knowledge_search", {
    query: "x",
    mode: "exact",
    scope: { revisions: [{ repoName: "NO-SUCH-REPO-R22", branch: "main" }] },
    page: { limit: 3 },
  }, store);
  assert.equal(missing.error.code, "REPOSITORY_NOT_FOUND");
  assert.match(missing.error.details.remediation, /index_status/);
  assert.doesNotMatch(JSON.stringify(missing.error), /penguin\s|--repo|--branch/);
  store.close();
});

test("knowledge_search applies canonical nested repo/snapshot scope without resolving unrelated repositories", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-search-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const target = seedSearchSnapshot(store, {
    name: "target",
    rootPath: "/target",
    filePath: "src/target.ts",
    content: "export const SharedScopeNeedle = true;\n",
  });
  seedSearchSnapshot(store, {
    name: "unrelated",
    rootPath: "/unrelated",
    filePath: "src/unrelated.ts",
    content: "export const SharedScopeNeedle = false;\n",
  });

  const result = handleKnowledgeTool("knowledge_search", {
    query: "SharedScopeNeedle",
    mode: "exact",
    scope: { repo: target.repoId, snapshot_id: target.snapshotId },
    page: { limit: 20 },
  }, store);

  assert.deepEqual(
    result.diagnostics.resolvedScopes.map(({ repoId, snapshotId }) => ({ repoId, snapshotId })),
    [target],
  );
  assert.deepEqual(result.diagnostics.requestedScope.revisions, [target]);
  assert.equal(result.diagnostics.scopeApplied, true);
  assert.ok(result.hits.length > 0);
  assert.ok(result.hits.every((hit) => hit.locator.repoId === target.repoId && hit.locator.revisionId === target.snapshotId));
  store.close();
});

test("knowledge_search preserves every canonical revision instead of silently using only the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-search-multi-scope-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const first = seedSearchSnapshot(store, {
    name: "first",
    rootPath: "/first",
    filePath: "src/first.ts",
    content: "export const MultiScopeNeedleFirst = true;\n",
  });
  const second = seedSearchSnapshot(store, {
    name: "second",
    rootPath: "/second",
    filePath: "src/second.ts",
    content: "export const MultiScopeNeedleSecond = true;\n",
  });

  const result = handleKnowledgeTool("knowledge_search", {
    query: "MultiScopeNeedle",
    mode: "exact",
    scope: {
      revisions: [
        { repoId: first.repoId, snapshotId: first.snapshotId },
        { repoId: second.repoId, snapshotId: second.snapshotId },
      ],
    },
    page: { limit: 20 },
  }, store);

  assert.deepEqual(
    result.diagnostics.requestedScope.revisions,
    [first, second],
  );
  assert.deepEqual(
    result.diagnostics.resolvedScopes.map(({ repoId, snapshotId }) => ({ repoId, snapshotId })),
    [first, second],
  );
  assert.deepEqual(
    [...new Set(result.hits.map((hit) => hit.locator.repoId))].sort(),
    [first.repoId, second.repoId].sort(),
  );
  store.close();
});

test("knowledge_search applies canonical nested page cursor and advances without repeating page one", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-search-page-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const target = seedSearchSnapshot(store, {
    name: "paged",
    rootPath: "/paged",
    filePath: "src/paged.ts",
    content: Array.from({ length: 12 }, (_, index) => `export const PagingNeedle${index} = "PagingNeedle";`).join("\n"),
  });
  const base = {
    query: "PagingNeedle",
    mode: "exact",
    scope: { repo: target.repoId, snapshot_id: target.snapshotId },
  };

  const first = handleKnowledgeTool("knowledge_search", { ...base, page: { limit: 5 } }, store);
  const second = handleKnowledgeTool("knowledge_search", {
    ...base,
    page: { limit: 5, cursor: first.page.nextCursor },
  }, store);

  assert.equal(first.hits.length, 5);
  assert.equal(second.hits.length, 5);
  assert.ok(first.page.nextCursor);
  assert.ok(second.page.nextCursor);
  assert.equal(
    first.hits.some((hit) => second.hits.some((candidate) => candidate.hitId === hit.hitId)),
    false,
  );
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
  assert.ok(Array.isArray(dead.items));
  assert.equal("candidates" in dead, false, "dead-code items must not be emitted twice");
  // `caller` has no incoming edges at all → a real dead-code candidate.
  assert.ok(dead.items.some((c) => c.nodeId === caller));
  // `login` IS called (by caller) → must not appear as dead code.
  assert.ok(!dead.items.some((c) => c.nodeId === login));
  store.close();
});

test("dead-code normal and compact responses publish honest byte statistics", () => {
  const { store } = seed();
  const normal = handleKnowledgeTool("find_dead_code", { limit: 5, compact: false }, store);
  const compact = handleKnowledgeTool("find_dead_code", { limit: 5, compact: true }, store);
  assert.equal(normal.compact, false);
  assert.equal(compact.compact, true);
  assert.equal(normal.stats.rawBytesEstimate, compact.stats.rawBytesEstimate);
  assert.equal(normal.stats.sentBytesEstimate, normal.stats.rawBytesEstimate);
  assert.equal(normal.stats.compactRatio, 1);
  assert.ok(compact.stats.sentBytesEstimate < normal.stats.sentBytesEstimate);
  assert.ok(compact.stats.compactRatio < 1);
  assert.deepEqual(compact.items.map((item) => item.nodeId), normal.items.map((item) => item.nodeId));
  store.close();
});

test("MCP read capabilities expose root total timing consistently", async () => {
  const { store, caller } = seed();
  const responses = await Promise.all([
    runKnowledgeTool("knowledge_endpoints", { repo: "r", limit: 5 }, { store }),
    runKnowledgeTool("knowledge_affected", { repo: "r", node: caller }, { store }),
  ]);
  for (const response of responses) {
    assert.equal(typeof response.timingsMs?.total, "number", JSON.stringify(response).slice(0, 500));
    assert.ok(response.timingsMs.total >= 0);
  }
  store.close();
});

test("MCP bounded search exposes the same measurable phase timing shape", async () => {
  const { store } = seed();
  const dbPath = store.db.name;
  const ledgerPath = store.ledgerPath;
  store.close();
  const server = spawn(process.execPath, ["packages/mcp/dist/index.js"], {
    env: {
      ...process.env,
      PENGUIN_KNOWLEDGE_DB: dbPath,
      PENGUIN_KNOWLEDGE_LEDGER: ledgerPath,
      PENGUIN_CLI_LAUNCHER: join(tmpdir(), "penguin-c3-not-installed"),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const reader = createJsonLineReader(server);
  try {
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c3-test", version: "1" } },
    }) + "\n");
    await reader.next((frame) => frame.id === 1);
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "knowledge_search", arguments: { query: "login", contract_version: "2", repo: "r", limit: 5 } },
    }) + "\n");
    const reply = await reader.next((frame) => frame.id === 2);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    const response = reply.result.structuredContent;
    const timings = response.diagnostics.timingsMs;
    for (const phase of ["scopeResolution", "count", "candidateSelection", "hydration", "evidence", "serialization", "total"]) {
      assert.equal(typeof timings?.[phase], "number", phase);
      assert.ok(timings[phase] >= 0, phase);
    }
  } finally {
    server.kill();
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((resolve) => server.once("close", resolve));
    }
  }
});

test("MCP bounded timeout preserves an actionable typed payload", async () => {
  const { store, repoId } = seed();
  const dbPath = store.db.name;
  const ledgerPath = store.ledgerPath;
  store.close();
  const server = spawn(process.execPath, ["packages/mcp/dist/index.js"], {
    env: {
      ...process.env,
      PENGUIN_KNOWLEDGE_DB: dbPath,
      PENGUIN_KNOWLEDGE_LEDGER: ledgerPath,
      PENGUIN_MCP_QUERY_WORKERS: "1",
      PENGUIN_MCP_QUERY_TIMEOUT_MS: "1",
      PENGUIN_CLI_LAUNCHER: join(tmpdir(), "penguin-c3-timeout-not-installed"),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const reader = createJsonLineReader(server);
  try {
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "c3-timeout-test", version: "1" } },
    }) + "\n");
    await reader.next((frame) => frame.id === 1);
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "knowledge_search",
        arguments: { query: "login", contract_version: "2", scope: { revisions: [{ repoId }] }, limit: 5 },
      },
    }) + "\n");
    const reply = await reader.next((frame) => frame.id === 2);
    assert.equal(reply.error, undefined, JSON.stringify(reply));
    const error = reply.result.structuredContent.error;
    assert.equal(error.code, "QUERY_TIMEOUT");
    assert.equal(error.details.capability, "knowledge.search");
    assert.equal(error.details.budgetMs, 1);
    assert.deepEqual(error.details.scope, { revisions: [{ repoId }] });
    assert.match(error.details.nextAction, /retry/i);
    assert.match(error.remediation, /scope|limit/i);
  } finally {
    server.kill();
    if (server.exitCode === null && server.signalCode === null) {
      await new Promise((resolve) => server.once("close", resolve));
    }
  }
});

test("MCP bounded search preserves typed cursor and schema errors", async () => {
  const { store, repoId } = seed();
  const cursor = await runKnowledgeTool("knowledge_search", {
    query: "login",
    contract_version: "2",
    scope: { revisions: [{ repoId }] },
    limit: 5,
    cursor: "not-a-real-cursor",
  }, { store });
  assert.equal(cursor.error.code, "CURSOR_INVALID");

  const schema = await runKnowledgeTool("knowledge_search", {
    query: "login",
    contract_version: "2",
    mode: "not-a-supported-mode",
    limit: 5,
  }, { store });
  assert.equal(schema.error.code, "INVALID_SEARCH_REQUEST", JSON.stringify(schema));
  store.close();
});

test("get_architecture honours repo scope and reports the resolved revision", () => {
  const { store, repoId } = seed();
  const otherRepoId = store.registerRepo({ name: "other", rootPath: "/other" });
  store.registerBranch({ repoId: otherRepoId, name: "main", status: "live" });
  store.upsertNode({ nodeType: "endpoint", identityKey: `${otherRepoId}::foreign`, title: "foreign endpoint", repoId: otherRepoId });

  const scoped = handleKnowledgeTool("get_architecture", { repo: "r", branch: "main" }, store);

  assert.deepEqual(scoped.repos, [{ name: "r", branches: 1 }]);
  assert.equal(scoped.revision?.repoId, repoId);
  assert.equal(scoped.revision?.branch, "main");
  assert.equal(scoped.locator?.repoName, "r");
  assert.ok(!scoped.entryPoints.includes("foreign endpoint"));
  store.close();
});

test("knowledge_note_list filters by repo and provides stable cursor pagination", async () => {
  const { store, repoId } = seed();
  const notesDir = mkdtempSync(join(tmpdir(), "pk-mcp-notes-"));
  for (const [id, title] of [["scoped-a", "Scoped A"], ["scoped-b", "Scoped B"], ["global", "Global"]]) {
    writeFileSync(join(notesDir, `${id}.md`), `---\nid: ${id}\ntitle: ${title}\n---\nbody\n`);
    store.upsertNode({ nodeType: "note", identityKey: id, title, repoId: id === "global" ? undefined : repoId });
  }

  const first = await runKnowledgeTool("knowledge_note_list", { repo: "r", branch: "main", limit: 1 }, { store, notesDir });
  const second = await runKnowledgeTool("knowledge_note_list", { repo: "r", branch: "main", limit: 1, cursor: first.nextCursor }, { store, notesDir });

  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.ok(first.nextCursor);
  assert.equal(second.nextCursor, null);
  assert.equal(first.candidateCount, 2);
  assert.equal(second.candidateCount, 2);
  assert.equal(first.items[0].scope.repoId, repoId);
  assert.equal(second.items[0].scope.repoId, repoId);
  assert.notEqual(first.items[0].path, second.items[0].path);
  assert.equal(first.locator?.repoName, "r");
  store.close();
});

test("knowledge_files consumes the cursor it advertises without repeating paths", () => {
  const { store, repoId, branch } = seed();
  const insert = store.db.prepare(`INSERT INTO files_index
    (id,repo_id,branch_id,file_path,lang,size_bytes,indexed_at,status)
    VALUES (?,?,?,?,?,?,?,'indexed')`);
  for (const [index, path] of ["a.ts", "b.ts", "c.ts"].entries()) {
    insert.run(`file-${index}`, repoId, branch, path, "ts", 10, new Date().toISOString());
  }
  const first = handleKnowledgeTool("knowledge_files", { repo: "r", limit: 2 }, store);
  assert.deepEqual(first.items.map((item) => item.filePath), ["a.ts", "b.ts"]);
  assert.equal(typeof first.nextCursor, "string");
  const second = handleKnowledgeTool("knowledge_files", { repo: "r", limit: 2, cursor: first.nextCursor }, store);
  assert.deepEqual(second.items.map((item) => item.filePath), ["c.ts"]);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.filePath)).size, 3);
  store.close();
});

test("knowledge_files includes admitted source-only files and reconciles its exact total", () => {
  const { store } = seed();
  const scoped = seedSearchSnapshot(store, {
    name: "source-only-repo",
    rootPath: "/source-only-repo",
    filePath: "README.md",
    content: "Searchable documentation without parser graph facts\n",
  });

  const result = handleKnowledgeTool("knowledge_files", {
    repo: "source-only-repo",
    snapshot_id: scoped.snapshotId,
  }, store);

  assert.equal(result.candidateCount, 1);
  assert.equal(result.totalIsExact, true);
  assert.deepEqual(result.items, [{
    filePath: "README.md",
    lang: null,
    status: "source_only",
    sizeBytes: null,
    indexedAt: null,
    error: null,
  }]);
  assert.deepEqual(result.reconciliation, {
    admittedSourceFiles: 1,
    graphParsedFiles: 0,
    sourceAndGraphFiles: 0,
    sourceOnlyFiles: 1,
    graphOnlyFiles: 0,
    candidateFiles: 1,
    equations: [
      "admittedSourceFiles = sourceAndGraphFiles + sourceOnlyFiles",
      "graphParsedFiles = sourceAndGraphFiles + graphOnlyFiles",
      "candidateFiles = admittedSourceFiles + graphOnlyFiles",
    ],
    reconciles: true,
  });
  store.close();
});

test("knowledge_saved_query_run applies caller pagination to the saved request", () => {
  const { store } = seed();
  const scoped = seedSearchSnapshot(store, {
    name: "saved-query-repo",
    rootPath: "/saved-query-repo",
    filePath: "src/saved.ts",
    content: "SavedQueryNeedle\nSavedQueryNeedle\n",
  });
  new SavedQueryStore(store).write({
    name: "saved-two-hits",
    request: {
      query: "SavedQueryNeedle",
      mode: "exact",
      scope: { revisions: [{ repoId: scoped.repoId, snapshotId: scoped.snapshotId }] },
      options: { caseSensitive: true },
      page: { limit: 100 },
    },
  });
  const first = handleKnowledgeTool("knowledge_saved_query_run", { name: "saved-two-hits", limit: 1 }, store);
  assert.equal(first.hits.length, 1);
  assert.equal(typeof first.page.nextCursor, "string");
  const second = handleKnowledgeTool("knowledge_saved_query_run", { name: "saved-two-hits", limit: 1, cursor: first.page.nextCursor }, store);
  assert.equal(second.hits.length, 1);
  assert.notEqual(second.hits[0].hitId, first.hits[0].hitId);
  store.close();
});

test("find_dead_code emits a stable cursor and preserves total count across pages", () => {
  const { store, repoId, branch } = seed();
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({
    snapshotKey: "dead-code-main",
    repoId,
    parserVersion: "test-parser",
    resolverVersion: "test-resolver",
    schemaVersion: 18,
  });
  topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId: branch, snapshotId: snapshot.id, headCommit: "c0" });
  for (let index = 0; index < 4; index += 1) {
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::dead-${index}`, title: `dead-${index}`, repoId });
    store.upsertSymbolVersion({
      nodeId,
      branchId: branch,
      commitSha: "c0",
      filePath: `dead-${index}.ts`,
      lang: "ts",
      kind: "function",
      contentHash: `dead-hash-${index}`,
      status: "fresh",
      startLine: index + 1,
      endLine: index + 1,
    });
  }

  const first = handleKnowledgeTool("find_dead_code", { repo: "r", branch: "main", limit: 2 }, store);
  const second = handleKnowledgeTool("find_dead_code", { repo: "r", branch: "main", limit: 2, cursor: first.nextCursor }, store);

  assert.equal(first.items.length, 2);
  assert.equal(second.items.length, 2);
  assert.equal("candidates" in first, false);
  assert.equal("candidates" in second, false);
  assert.ok(first.nextCursor);
  assert.equal(first.candidateCount, 5);
  assert.equal(second.candidateCount, 5);
  assert.equal(first.items.some((item) => second.items.some((candidate) => candidate.nodeId === item.nodeId)), false);
  const [cursorBody] = first.nextCursor.split(".");
  const cursorPayload = JSON.parse(Buffer.from(cursorBody, "base64url").toString("utf8"));
  assert.equal(cursorPayload.revision, `repo:${repoId}|snapshot:${snapshot.id}`);
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
  assert.match(r.error.message, /not initialized/);
});

test("knowledge capability negotiation exposes the shared tuple and rejects incompatible majors", () => {
  const current = handleKnowledgeTool("knowledge_capabilities", { contract_version: "2" }, null);
  assert.equal(current.contractVersion, "2");
  assert.equal(current.schemaVersion, "18");
  assert.equal(typeof current.capabilityHash, "string");
  assert.equal(typeof current.buildId, "string");
  const rebuild = current.capabilities.find((capability) => capability.id === "knowledge.rebuild");
  assert.deepEqual(rebuild.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  });
  const incompatible = handleKnowledgeTool("knowledge_capabilities", { contract_version: "99" }, null);
  assert.equal(incompatible.error.code, "CAPABILITY_MISMATCH");
});

test("knowledge_capabilities compact mode is consumable by an MCP client", () => {
  const compact = handleKnowledgeTool("knowledge_capabilities", { compact: true }, null);
  const serialized = JSON.stringify(compact);
  assert.equal(compact.compact, true);
  assert.equal(compact.capabilityCount, compact.registrations.length);
  assert.ok(serialized.length < 8_000, `compact manifest is ${serialized.length} characters`);
  assert.ok(compact.registrations.every((registration) => typeof registration.capabilityId === "string"));
  assert.ok(compact.registrations.every((registration) => typeof registration.status === "string"));
});

test("async MCP dispatcher uses the same compact capability contract", async () => {
  const { store } = seed();
  const compact = await runKnowledgeTool("knowledge_capabilities", { compact: true }, { store });
  assert.equal(compact.compact, true);
  assert.equal(compact.capabilityCount, compact.registrations.length);
  assert.ok(compact.schemaReferences.input.includes("input.v2"));
  assert.ok(JSON.stringify(compact).length < 8_000);
  store.close();
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
  assert.equal(handleKnowledgeTool("knowledge_source_remove", { id: source.id }, store).error.code, "CONFIRMATION_REQUIRED");
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
  assert.equal(handleKnowledgeTool("knowledge_source_remove", { id: source.id }, store).error.code, "CONFIRMATION_REQUIRED");
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
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({ snapshotKey: "parity-main", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: SCHEMA_VERSION });
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
  assert.equal(result.error.code, "HIT_REVISION_MISMATCH");
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
  assert.match(refused.error.message, /sensitive/);
  store.close();
});

test("tools/list advertises a tiered, explore-first surface without hiding any capability", async () => {
  const { MCP_LISTED_TOOL_DEFS } = await loadTools();
  const listed = MCP_LISTED_TOOL_DEFS.map((tool) => tool.name);

  // The entry point is first, so an agent scanning the list top-down starts
  // where the routing advice lives.
  assert.equal(listed[0], "knowledge_explore");
  assert.match(MCP_LISTED_TOOL_DEFS[0].description, /Default FIRST call/);
  assert.match(MCP_LISTED_TOOL_DEFS[0].description, /knowledge_search for text\/regex/);

  // The listing is curated, not minimal. An earlier version asserted <30 here
  // and that number was the bug: it was met by hiding 44 implemented read-only
  // capabilities (file_symbols, callers, callees, flow, affected...), which
  // cost an agent two unanswerable questions. The ceiling now guards against
  // drifting back toward the unreadable 119, not against completeness.
  assert.ok(listed.length <= 62, `listed ${listed.length} tools — re-tier rather than append`);
  assert.ok(KNOWLEDGE_TOOL_DEFS.length > 100, "full manifest still carries every capability");

  // Nothing is removed: every listed tool stays dispatchable, and so do the
  // placeholders that are no longer advertised.
  for (const name of listed) assert.ok(isKnowledgeTool(name), name);
  assert.ok(isKnowledgeTool("knowledge_onboarding_generate"), "unlisted capability still callable");
  assert.ok(listed.includes("knowledge_index"), "MCP-only coverage remediation must expose index");
  assert.ok(listed.includes("knowledge_rebuild"), "MCP-only recovery must expose rebuild");

  // Tier labelling: core tools carry no prefix, later tiers announce
  // themselves so the agent knows they are not the default move.
  const byName = new Map(MCP_LISTED_TOOL_DEFS.map((tool) => [tool.name, tool.description]));
  assert.doesNotMatch(byName.get("knowledge_search"), /^\[/);
  assert.match(byName.get("find_dead_code"), /^\[specialised/);
  assert.match(byName.get("api_doc_list"), /^\[occasional/);

  // Ordering is stable and tier-grouped, not source-order.
  assert.ok(listed.indexOf("knowledge_search") < listed.indexOf("find_dead_code"));
  assert.ok(listed.indexOf("find_dead_code") < listed.indexOf("api_doc_list"));

  // Descriptions are decorated for the listing only — the shared defs (used
  // by parity checks and the dispatcher) keep their original text.
  const shared = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === "find_dead_code");
  assert.doesNotMatch(shared.description, /^\[specialised/);
});

test("the server's tools/list keeps explore first instead of alphabetising it away", async () => {
  const { spawn } = await import("node:child_process");
  const server = spawn(process.execPath, ["packages/mcp/dist/index.js"], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const done = new Promise((resolve, reject) => {
    let buffer = "";
    server.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n")) {
        try {
          const frame = JSON.parse(line);
          if (frame.id === 2) resolve(frame.result.tools);
        } catch { /* partial frame */ }
      }
    });
    server.on("error", reject);
    setTimeout(() => reject(new Error("tools/list timed out")), 20_000).unref?.();
  });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  const tools = await done;
  server.kill();

  const names = tools.map((tool) => tool.name);
  assert.equal(names[0], "knowledge_explore", "entry point leads the list");
  assert.ok(names.length <= 90, `advertised ${names.length} tools (knowledge + log + rpc surfaces)`);
  // Non-knowledge tools still sort alphabetically after the tiered block.
  const tail = names.slice(names.indexOf("knowledge_capabilities") + 1);
  assert.deepEqual(tail, [...tail].sort(), "remaining tools stay alphabetical");
});

// —— arguments a tool does not accept ————————————————————————————————
// The schemas said additionalProperties: false, but nothing enforced it. An
// agent passing a filter the tool lacks got the unfiltered answer with no hint
// its scope had been dropped: a wrong answer that reads as right, which is
// worse than an error. find_dead_code is the case that surfaced it — `repo` and
// `path` were accepted and ignored.

test("an argument the tool does not accept is refused, not ignored", () => {
  const result = unsupportedArguments("find_dead_code", { repo: "alpha", package: "x" });
  assert.ok(result, "an undeclared argument must not pass silently");
  assert.equal(result.error.code, "UNSUPPORTED_FILTER");
  assert.deepEqual(result.error.unsupported, ["package"]);
  assert.ok(result.error.message.includes("package"), "the message must name the argument");
  assert.ok(result.error.accepted.includes("repo"), "the caller needs to know what IS accepted");
  assert.equal(result.error.retryable, false, "retrying the same call cannot help");
});

test("dead_code accepts every filter it now implements", () => {
  assert.equal(unsupportedArguments("find_dead_code", { repo: "alpha", path: "apps/", limit: 10, branch: "main" }), null);
  assert.equal(unsupportedArguments("find_dead_code", {}), null, "an empty input cannot contain an unsupported key");
});

test("tools whose MCP surface takes more than their schema declares stay permissive", () => {
  // knowledge_search deliberately accepts flat aliases its canonical schema
  // does not list. Enforcing there would reject working callers rather than
  // catch mistakes, so strictness is opt-in per tool.
  assert.equal(unsupportedArguments("knowledge_search", { query: "x", include_sensitive: false }), null);
  const { store } = seed();
  const searched = handleKnowledgeTool("knowledge_search", { query: "turnstile", include_sensitive: false }, store);
  assert.ok(Array.isArray(searched.results), "search must still answer");
  store.close();
});

test("the dispatcher refuses the call, not just the helper", () => {
  // unsupportedArguments passing in isolation proves nothing if the dispatcher
  // never calls it.
  const { store } = seed();
  const result = handleKnowledgeTool("find_dead_code", { limit: 5, package: "nope" }, store);
  assert.equal(result.error?.code, "UNSUPPORTED_FILTER", `got ${JSON.stringify(result).slice(0, 200)}`);
  store.close();
});

test("find_dead_code scopes by repo and path through MCP", () => {
  const { store } = seed();
  const scoped = handleKnowledgeTool("find_dead_code", { repo: "r", path: "a.ts" }, store);
  assert.equal(scoped.scope.repo, "r", "the answer reports the scope it used");
  assert.ok(scoped.items.some((c) => c.title === "caller"), "caller has no inbound edges");
  assert.ok(!scoped.items.some((c) => c.title === "login"), "login is called");
  assert.ok(scoped.items.every((c) => c.filePath), "items carry coordinates");

  const missed = handleKnowledgeTool("find_dead_code", { repo: "r", path: "other/" }, store);
  assert.deepEqual(missed.items, [], "a prefix that matches nothing returns nothing");

  const unknown = handleKnowledgeTool("find_dead_code", { repo: "no-such-repo" }, store);
  assert.match(unknown.note, /no indexed repo matches/);
  store.close();
});

test("a strict tool's allowlist matches the schema it advertises", () => {
  // The allowlist is hand-written because the tool-def module is deliberately
  // outside knowledge-tools' import graph. Drift here would reject an argument
  // the tool publicly promises to accept, so it must fail as a test, not in
  // front of a caller.
  for (const [toolName, accepted] of Object.entries(STRICT_TOOL_ARGUMENTS)) {
    const def = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === toolName);
    if (!def) continue; // alias name not published as its own tool
    assert.deepEqual(
      [...accepted].sort(),
      Object.keys(def.inputSchema.properties ?? {}).sort(),
      `${toolName}'s strict allowlist and advertised schema disagree`,
    );
  }
});

test("a source hit inside a symbol carries that symbol's node id", () => {
  // Search returned bare source_occurrence hits with no handle, so the only way
  // from a hit into the graph was to guess a name for `explore` — which for a
  // name repeated across repos is the ambiguity search was supposed to settle.
  const dir = mkdtempSync(join(tmpdir(), "pk-mcp-search-node-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "k.db"), ledgerPath: join(dir, "l.jsonl") });
  const seeded = seedSearchSnapshot(store, {
    name: "handles",
    rootPath: "/handles",
    filePath: "src/svc.ts",
    content: "export function findSomething() {\n  return 1;\n}\n",
  });

  // A symbol occupying those lines, as the indexer would have written.
  const branchId = store.db.prepare("SELECT id FROM branches WHERE repo_id=?").get(seeded.repoId).id;
  const nodeId = store.upsertNode({
    nodeType: "symbol", identityKey: `${seeded.repoId}::src/svc.ts::findSomething`,
    title: "findSomething", repoId: seeded.repoId,
  });
  store.upsertSymbolVersion({
    nodeId, branchId, commitSha: "c0", filePath: "src/svc.ts", lang: "ts", kind: "function",
    contentHash: "h_find", status: "fresh", startLine: 1, endLine: 3,
  });

  const hits = searchKnowledge(
    { query: "findSomething", mode: "exact", page: { limit: 10 } },
    { store, scopes: [{ repoId: seeded.repoId, snapshotId: seeded.snapshotId }] },
  ).hits;
  const located = hits.find((hit) => hit.locator?.filePath === "src/svc.ts");
  assert.ok(located, `expected a hit in src/svc.ts, got ${JSON.stringify(hits.map((h) => h.locator?.filePath))}`);
  assert.equal(located.nodeId, nodeId, "the handle points at the symbol containing the hit");
  assert.equal(located.symbol, "findSomething", "and names it, so the handle is legible before use");
  store.close();
});

test("unknown repo on knowledge_coverage returns typed REPOSITORY_NOT_FOUND error", () => {
  const { store } = seed();
  try {
    const result = handleKnowledgeTool("knowledge_coverage", { repo: "nonexistent-repo" }, store);
    assert.equal(result.error.code, "REPOSITORY_NOT_FOUND");
    assert.match(result.error.message, /nonexistent-repo/);
    assert.equal(typeof result.error.retryable, "boolean");
  } finally {
    store.close();
  }
});

test("unknown repo on knowledge_service_graph returns typed error", () => {
  const { store } = seed();
  try {
    const result = handleKnowledgeTool("knowledge_service_graph", { repo: "nonexistent-repo" }, store);
    assert.ok(result.error.code);
    assert.equal(typeof result.error.message, "string");
    assert.equal(typeof result.error.retryable, "boolean");
  } finally {
    store.close();
  }
});

test("missing required argument on knowledge_search returns typed error", () => {
  const { store } = seed();
  try {
    const result = handleKnowledgeTool("knowledge_search", {}, store);
    assert.ok(result.error.code);
    assert.ok(result.error.message);
    assert.equal(typeof result.error.retryable, "boolean");
  } finally {
    store.close();
  }
});

test("invalid semantic mode on knowledge_search returns typed error", () => {
  const { store } = seed();
  try {
    const result = handleKnowledgeTool("knowledge_search", { query: "test", semantic: "invalid-mode" }, store);
    if (result.error) {
      assert.ok(result.error.code);
      assert.ok(result.error.message);
      assert.equal(typeof result.error.retryable, "boolean");
    }
  } finally {
    store.close();
  }
});

test("malformed cursor on knowledge_endpoints returns CURSOR_INVALID error", () => {
  const { store } = seed();
  try {
    const result = handleKnowledgeTool("knowledge_endpoints", { protocol: "grpc", cursor: "malformed-cursor" }, store);
    assert.equal(result.error.code, "CURSOR_INVALID");
    assert.equal(typeof result.error.retryable, "boolean");
  } finally {
    store.close();
  }
});

test("wrong cursor family and tampered cursor remain distinct through MCP", () => {
  const { store, repoId } = seed();
  for (let index = 0; index < 2; index += 1) {
    const endpointId = store.upsertGrpcEndpoint({ packageName: "cursor.v1", service: "CursorService", method: `Method${index}` });
    store.replaceEndpointMembershipsForFile({ repoId, filePath: `proto/cursor-${index}.proto`, memberships: [{ endpointId, role: "declaration" }] });
  }
  const page = handleKnowledgeTool("knowledge_endpoints", { repo: "r", protocol: "grpc", limit: 1 }, store);
  assert.ok(page.nextCursor);
  const wrongFamily = handleKnowledgeTool("knowledge_search", { query: "login", contract_version: "2", repo: "r", limit: 1, cursor: page.nextCursor }, store);
  const tampered = handleKnowledgeTool("knowledge_search", { query: "login", contract_version: "2", repo: "r", limit: 1, cursor: `${page.nextCursor.slice(0, -1)}x` }, store);
  assert.equal(wrongFamily.error.code, "CURSOR_OPERATION_MISMATCH");
  assert.equal(tampered.error.code, "CURSOR_INVALID");
  assert.match(wrongFamily.error.details.remediation, /restart search pagination/i);
  store.close();
});
