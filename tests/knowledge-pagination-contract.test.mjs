import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, HmacOperationCursorCodec, SCHEMA_VERSION, affectedByFiles } from "../packages/knowledge-core/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";

const ENDPOINT_INVENTORY_TRIGGER_NAMES = [
  "trg_endpoint_inventory_nodes_insert",
  "trg_endpoint_inventory_nodes_update",
  "trg_endpoint_inventory_nodes_delete",
  "trg_endpoint_inventory_memberships_insert",
  "trg_endpoint_inventory_memberships_update",
  "trg_endpoint_inventory_memberships_delete",
];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-pagination-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const repo = "pagination-repo";
  const repoId = store.registerRepo({ name: repo, rootPath: dir });
  const branchId = store.registerBranch({ repoId, name: "main", headCommit: "pagination-commit", status: "live" });
  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("pagination-commit", branchId);
  for (let index = 0; index < 5; index += 1) {
    const nodeId = store.upsertNode({ nodeType: "symbol", identityKey: `${repoId}::PaginationSymbol${index}`, title: `PaginationSymbol${index}`, repoId });
    store.upsertSymbolVersion({ nodeId, branchId, commitSha: "pagination-commit", filePath: "src/pagination.ts", lang: "typescript", kind: "function", signature: `PaginationSymbol${index}()`, contentHash: `pagination-${index}`, status: "fresh", startLine: index + 1, endLine: index + 1 });
    const endpointId = store.upsertGrpcEndpoint({ packageName: "pagination.v1", service: "PaginationService", method: `method${index}` });
    store.replaceEndpointMembershipsForFile({
      repoId,
      filePath: `proto/pagination-${index}.proto`,
      memberships: [{ endpointId, role: "declaration" }],
    });
  }
  const lines = [];
  const deps = { cwd: dir, openStore: () => KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }), storeExists: () => true, out: (line) => lines.push(line), err: (line) => lines.push(line) };
  const json = () => JSON.parse([...lines].reverse().find((line) => { try { JSON.parse(line); return true; } catch { return false; } }));
  return { store, repo, repoId, branchId, dbPath, ledgerPath, lines, deps, json };
}

test("shared operation cursor binds operation, scope, revision and expiry", () => {
  const codec = new HmacOperationCursorCodec("pagination-secret", () => Date.parse("2026-08-30T00:00:00.000Z"));
  const payload = { schemaVersion: "1", contractVersion: "2", operation: "endpoints", scope: "pagination-repo|grpc", orderingKey: "title,nodeId", lastKey: "PaginationService.method0\u0000node_0", revision: null, expiresAt: "2026-08-30T00:01:00.000Z" };
  const cursor = codec.encode(payload);
  assert.deepEqual(codec.decode(cursor, { operation: "endpoints", scope: "pagination-repo|grpc", revision: null }), payload);
  assert.throws(() => codec.decode(cursor, { operation: "filesymbols", scope: "pagination-repo|grpc", revision: null }), /CURSOR_OPERATION_MISMATCH/);
  const expired = new HmacOperationCursorCodec("pagination-secret", () => Date.parse("2026-08-30T00:02:00.000Z"));
  assert.throws(() => expired.decode(cursor, { operation: "endpoints", scope: "pagination-repo|grpc", revision: null }), /CURSOR_EXPIRED/);
});

test("signed cursor family mismatch stays distinct from a tampered cursor", () => {
  const codec = new HmacOperationCursorCodec("pagination-secret", () => Date.parse("2026-08-30T00:00:00.000Z"));
  const cursor = codec.encode({
    schemaVersion: "1", contractVersion: "2", operation: "endpoints",
    scope: "repo-a|grpc", orderingKey: "title,nodeId", lastKey: "A\u0000node-a",
    revision: null, expiresAt: "2026-08-30T00:01:00.000Z",
  });
  assert.throws(() => codec.decode(cursor, { operation: "deadcode", scope: "repo-a|grpc", revision: null }), /CURSOR_OPERATION_MISMATCH/);
  assert.throws(() => codec.decode(`${cursor.slice(0, -1)}x`, { operation: "endpoints", scope: "repo-a|grpc", revision: null }), /CURSOR_INVALID/);
});

test("[stable-candidate-count] CLI endpoint pages are stable, signed, and terminate without duplicates", async () => {
  const { store, repo, lines, deps, json } = fixture();
  const seen = new Set();
  let cursor = null;
  let terminal = false;
  let candidateCount = null;
  for (let page = 0; page < 10; page += 1) {
    lines.length = 0;
    const args = ["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--json"];
    if (cursor) args.push("--cursor", cursor);
    assert.equal(await runCli(args, deps), 0);
    const payload = json();
    candidateCount ??= payload.candidateCount;
    assert.equal(payload.candidateCount, candidateCount, "candidateCount is the full stable inventory total on every page");
    assert.equal(payload.remainingCount, candidateCount - seen.size - payload.items.length, "remainingCount excludes this page and prior pages");
    for (const item of payload.items) { assert.equal(seen.has(item.nodeId), false); seen.add(item.nodeId); }
    cursor = payload.nextCursor;
    if (!cursor) { terminal = true; assert.equal(payload.totalIsExact, true); assert.equal(payload.truncated, false); break; }
  }
  assert.equal(terminal, true);
  assert.equal(seen.size, 5);
  store.close();
});

test("CLI endpoint page hydrates only the requested core page rows", async () => {
  const { store, repo, lines, deps, json } = fixture();
  const close = store.close.bind(store);
  const endpointHandlerStatus = store.endpointHandlerStatus.bind(store);
  const hydrated = [];
  store.close = () => {};
  store.endpointHandlerStatus = (endpointId, repoId) => {
    hydrated.push(endpointId);
    if (hydrated.length > 1) throw new Error(`hydrated endpoint outside requested page: ${endpointId}`);
    return endpointHandlerStatus(endpointId, repoId);
  };
  try {
    assert.equal(await runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "1", "--json"], {
      ...deps,
      openStore: () => store,
    }), 0);
    const payload = json();
    assert.equal(payload.items.length, 1);
    assert.equal(payload.candidateCount, 5);
    assert.equal(payload.remainingCount, 4);
    assert.equal(typeof payload.nextCursor, "string");
    assert.equal(hydrated.length, 1);
  } finally {
    store.endpointHandlerStatus = endpointHandlerStatus;
    store.close = close;
    close();
  }
});

test("core endpoint page batches first-hop edge hydration for the whole page", () => {
  const { store, repoId } = fixture();
  const prepare = store.db.prepare.bind(store.db);
  let firstHopReads = 0;
  store.db.prepare = (sql) => {
    const normalized = String(sql).replace(/\s+/g, " ");
    if (normalized.includes("FROM edges") && normalized.includes("status='active'") && normalized.includes("edge_type IN")) {
      firstHopReads += 1;
    }
    return prepare(sql);
  };
  try {
    const page = affectedByFiles.endpointInventoryPage(store, { repoId, protocol: "grpc", limit: 5 });
    assert.equal(page.items.length, 5);
    assert.equal(firstHopReads, 1, "one page must not issue one first-hop edge query per endpoint");
  } finally {
    store.db.prepare = prepare;
    store.close();
  }
});

test("core endpoint page reads scope count rows and hydration from one SQLite snapshot", () => {
  const { store, repoId, branchId, dbPath, ledgerPath } = fixture();
  const writer = KnowledgeStore.open({ dbPath, ledgerPath });
  const prepare = store.db.prepare.bind(store.db);
  let publishedEndpointId = null;
  let interleaved = false;
  store.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!String(sql).includes("FROM branches") || !String(sql).includes("status <> 'gone'")) return statement;
    const get = statement.get.bind(statement);
    return new Proxy(statement, {
      get(target, property) {
        if (property === "get") return (...params) => {
          const scopeRow = get(...params);
          if (!interleaved) {
            publishedEndpointId = writer.upsertGrpcEndpoint({ packageName: "pagination.v1", service: "InterleavedService", method: "published" });
            writer.replaceEndpointMembershipsForFile({
              repoId,
              filePath: "proto/interleaved.proto",
              memberships: [{ endpointId: publishedEndpointId, role: "declaration" }],
            });
            writer.db.prepare("UPDATE branches SET last_indexed_commit=?,head_commit=? WHERE id=?").run("pagination-commit-next", "pagination-commit-next", branchId);
            interleaved = true;
          }
          return scopeRow;
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  try {
    const page = affectedByFiles.endpointInventoryPage(store, { repoId, protocol: "grpc", limit: 10 });
    assert.equal(interleaved, true);
    assert.equal(page.scope.revisionId, "pagination-commit");
    assert.equal(page.candidateCount, 5);
    assert.equal(page.items.length, 5);
    assert.equal(page.items.some((item) => item.nodeId === publishedEndpointId), false);
  } finally {
    store.db.prepare = prepare;
    writer.close();
    store.close();
  }
});

test("CLI endpoint cursor is pinned to the selected repository revision", async () => {
  const { store, repo, branchId, lines, deps, json } = fixture();
  assert.equal(await runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--json"], deps), 0);
  const first = json();
  assert.equal(typeof first.nextCursor, "string");

  store.db.prepare("UPDATE branches SET last_indexed_commit=? WHERE id=?").run("pagination-commit-next", branchId);
  lines.length = 0;
  assert.notEqual(await runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--cursor", first.nextCursor, "--json"], deps), 0);
  assert.equal(json().error.code, "CURSOR_SCOPE_MISMATCH");
  store.close();
});

test("repo-less endpoint cursor rejects membership publication from an obsolete global inventory", async () => {
  const { store, repoId, lines, deps, json } = fixture();
  const unpublishedEndpointId = store.upsertGrpcEndpoint({ packageName: "pagination.v1", service: "GlobalService", method: "publishedLater" });
  assert.equal(await runCli(["endpoints", "--protocol", "grpc", "--limit", "2", "--json"], deps), 0);
  const first = json();
  assert.equal(typeof first.nextCursor, "string");

  store.replaceEndpointMembershipsForFile({
    repoId,
    filePath: "proto/global-published-later.proto",
    memberships: [{ endpointId: unpublishedEndpointId, role: "declaration" }],
  });
  lines.length = 0;
  const exitCode = await runCli(["endpoints", "--protocol", "grpc", "--limit", "2", "--cursor", first.nextCursor, "--json"], deps);
  assert.notEqual(exitCode, 0);
  assert.equal(json().error.code, "CURSOR_SCOPE_MISMATCH", JSON.stringify(json()));
  store.close();
});

test("endpoint cursor rejects reuse when a direct inventory filter changes", async () => {
  const { store, repo, lines, deps, json } = fixture();
  assert.equal(await runCli([
    "endpoints", repo, "--protocol", "grpc", "--service", "PaginationService", "--limit", "2", "--json",
  ], deps), 0);
  const first = json();
  assert.equal(typeof first.nextCursor, "string");

  lines.length = 0;
  const exitCode = await runCli([
    "endpoints", repo, "--protocol", "grpc", "--service", "PaginationService",
    "--method", "method0", "--limit", "2", "--cursor", first.nextCursor, "--json",
  ], deps);
  assert.notEqual(exitCode, 0);
  assert.equal(json().error.code, "CURSOR_SCOPE_MISMATCH");
  store.close();
});

test("endpoint inventory generation increments for endpoint and membership insert update delete", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-endpoint-generation-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const generation = () => Number(store.db.prepare(
    "SELECT value FROM meta WHERE key='endpoint_inventory_generation'",
  ).get()?.value);
  try {
    assert.equal(generation(), 0);
    const repoId = store.registerRepo({ name: "generation-repo", rootPath: dir });
    const endpointId = store.upsertNode({
      nodeType: "endpoint",
      identityKey: "grpc::Generation.Service.Method",
      repoId,
      title: "Generation.Service.Method",
    });
    assert.equal(generation(), 1, "endpoint INSERT must increment generation");

    store.db.prepare("UPDATE nodes SET title=? WHERE id=?").run("Generation.Service.Renamed", endpointId);
    assert.equal(generation(), 2, "endpoint UPDATE must increment generation");

    const locatorNodeId = store.upsertNode({
      nodeType: "symbol",
      identityKey: `${repoId}::GenerationLocator`,
      repoId,
      title: "GenerationLocator",
    });
    assert.equal(generation(), 2, "non-endpoint node mutation must not increment generation");
    store.db.prepare(
      "INSERT INTO endpoint_memberships (endpoint_id,repo_id,role,file_path,locator_node_id,created_at) VALUES (?,?,?,?,?,?)",
    ).run(endpointId, repoId, "declaration", "proto/generation.proto", null, "2026-08-31T00:00:00.000Z");
    assert.equal(generation(), 3, "membership INSERT must increment generation");

    store.db.prepare(
      "UPDATE endpoint_memberships SET locator_node_id=? WHERE endpoint_id=? AND repo_id=? AND role=? AND file_path=?",
    ).run(locatorNodeId, endpointId, repoId, "declaration", "proto/generation.proto");
    assert.equal(generation(), 4, "membership UPDATE must increment generation");

    store.db.prepare(
      "DELETE FROM endpoint_memberships WHERE endpoint_id=? AND repo_id=? AND role=? AND file_path=?",
    ).run(endpointId, repoId, "declaration", "proto/generation.proto");
    assert.equal(generation(), 5, "membership DELETE must increment generation");

    store.db.prepare("DELETE FROM nodes WHERE id=?").run(endpointId);
    assert.equal(generation(), 6, "endpoint DELETE must increment generation");
  } finally {
    store.close();
  }
});

test("endpoint inventory triggers are required and writable open installs a same-version additive migration", () => {
  const { store, dbPath, ledgerPath } = fixture();
  const storedVersion = Number(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value);
  assert.equal(storedVersion, SCHEMA_VERSION);
  store.db.exec(ENDPOINT_INVENTORY_TRIGGER_NAMES.map((name) => `DROP TRIGGER IF EXISTS ${name}`).join(";"));
  store.db.prepare("DELETE FROM meta WHERE key='endpoint_inventory_generation'").run();
  store.close();

  assert.throws(
    () => KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false }),
    (error) => error?.code === "SCHEMA_OUTDATED",
  );

  const writable = KnowledgeStore.open({ dbPath, ledgerPath });
  try {
    const installed = writable.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name IN (${ENDPOINT_INVENTORY_TRIGGER_NAMES.map(() => "?").join(",")}) ORDER BY name`,
    ).all(...ENDPOINT_INVENTORY_TRIGGER_NAMES).map((row) => row.name);
    assert.deepEqual(installed, [...ENDPOINT_INVENTORY_TRIGGER_NAMES].sort());
    assert.equal(writable.db.prepare(
      "SELECT value FROM meta WHERE key='endpoint_inventory_generation'",
    ).get().value, "0");
    assert.equal(Number(writable.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value), SCHEMA_VERSION);
  } finally {
    writable.close();
  }

  const readOnly = KnowledgeStore.open({ dbPath, ledgerPath, allowSchemaMutation: false });
  readOnly.close();
});

test("repo-less endpoint inventory revision is one O(1) meta key lookup with no endpoint row scan", () => {
  const { store } = fixture();
  const generation = store.db.prepare(
    "SELECT value FROM meta WHERE key='endpoint_inventory_generation'",
  ).get()?.value;
  assert.equal(typeof generation, "string");
  const queryPlan = store.db.prepare(
    "EXPLAIN QUERY PLAN SELECT value FROM meta WHERE key=?",
  ).all("endpoint_inventory_generation").map((row) => String(row.detail));
  assert.ok(queryPlan.some((detail) => detail.includes("SEARCH meta")), JSON.stringify(queryPlan));
  assert.equal(queryPlan.some((detail) => detail.includes("SCAN")), false, JSON.stringify(queryPlan));
  const prepare = store.db.prepare.bind(store.db);
  const statements = [];
  store.db.prepare = (sql) => {
    statements.push(String(sql).replace(/\s+/g, " ").trim());
    return prepare(sql);
  };
  try {
    assert.equal(affectedByFiles.inventoryRevision(store), `global-endpoints:${generation}`);
    assert.deepEqual(statements, ["SELECT value FROM meta WHERE key=?"]);
  } finally {
    store.db.prepare = prepare;
    store.close();
  }
});

test("repo-less endpoint cursor rejects endpoint insert update and delete generations", () => {
  const { store, repoId } = fixture();
  const nextCursor = () => {
    const page = affectedByFiles.endpointInventoryPage(store, { protocol: "grpc", limit: 2 });
    assert.equal(typeof page.nextCursor, "string");
    return page.nextCursor;
  };
  const assertStale = (cursor) => assert.throws(
    () => affectedByFiles.endpointInventoryPage(store, { protocol: "grpc", limit: 2, cursor }),
    /CURSOR_SCOPE_MISMATCH/,
  );
  try {
    let cursor = nextCursor();
    const endpointId = store.upsertNode({
      nodeType: "endpoint",
      identityKey: "grpc::Generation.Cursor.Mutation",
      repoId,
      title: "Generation.Cursor.Mutation",
    });
    assertStale(cursor);

    cursor = nextCursor();
    store.db.prepare("UPDATE nodes SET title=? WHERE id=?").run("Generation.Cursor.Updated", endpointId);
    assertStale(cursor);

    cursor = nextCursor();
    store.db.prepare("DELETE FROM nodes WHERE id=?").run(endpointId);
    assertStale(cursor);
  } finally {
    store.close();
  }
});

test("core endpoint page rejects a non-integer limit", () => {
  const { store, repoId } = fixture();
  try {
    assert.throws(
      () => affectedByFiles.endpointInventoryPage(store, { repoId, protocol: "grpc", limit: 1.5 }),
      (error) => error?.code === "INVALID_ARGUMENT" && error.message === "endpoint page limit must be an integer between 1 and 500",
    );
  } finally {
    store.close();
  }
});

test("CLI endpoint page maps a non-integer limit to INVALID_ARGUMENT", async () => {
  const { store, repo, deps, json } = fixture();
  try {
    const exitCode = await runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "1.5", "--json"], deps);
    assert.notEqual(exitCode, 0);
    const payload = json();
    assert.equal(payload.error.code, "INVALID_ARGUMENT");
    assert.equal(payload.error.message, "endpoint page limit must be an integer between 1 and 500");
  } finally {
    store.close();
  }
});

test("CLI filesymbols and deadcode expose the same terminal cursor contract", async () => {
  const { store, repo, lines, deps, json } = fixture();
  for (const command of ["filesymbols", "deadcode"]) {
    const seen = new Set();
    let cursor = null;
    let terminal = false;
    for (let page = 0; page < 10; page += 1) {
      lines.length = 0;
      const args = command === "filesymbols"
        ? ["filesymbols", repo, "main", "src/pagination.ts", "--limit", "2", "--json"]
        : ["deadcode", "--repo", repo, "--limit", "2", "--json"];
      if (cursor) args.push("--cursor", cursor);
      assert.equal(await runCli(args, deps), 0);
      const payload = json();
      const items = payload.items ?? payload.candidates ?? [];
      for (const item of items) { const id = item.nodeId; assert.equal(seen.has(id), false); seen.add(id); }
      cursor = payload.nextCursor;
      if (!cursor) { terminal = true; assert.equal(payload.totalIsExact, true); assert.equal(payload.truncated, false); break; }
    }
    assert.equal(terminal, true, command);
    assert.equal(seen.size, 5, command);
  }
  store.close();
});

test("unknown repo on coverage returns REPOSITORY_NOT_FOUND error", async () => {
  const { store, lines, deps, json } = fixture();
  try {
    const exitCode = await runCli(["coverage", "--repo", "nonexistent-repo", "--json"], deps);
    assert.notEqual(exitCode, 0);
    const payload = json();
    assert.equal(payload.error.code, "REPOSITORY_NOT_FOUND");
    assert.ok(payload.error.message.includes("nonexistent-repo"));
    assert.equal(payload.error.retryable, false);
  } finally {
    store.close();
  }
});

test("unknown repo on endpoints returns REPOSITORY_NOT_FOUND error", async () => {
  const { store, lines, deps, json } = fixture();
  try {
    const exitCode = await runCli(["endpoints", "nonexistent-repo", "--protocol", "grpc", "--json"], deps);
    assert.notEqual(exitCode, 0);
    const payload = json();
    assert.equal(payload.error.code, "REPOSITORY_NOT_FOUND");
    assert.ok(payload.error.message.includes("nonexistent-repo"));
    assert.equal(payload.error.retryable, false);
  } finally {
    store.close();
  }
});

test("malformed cursor returns CURSOR_INVALID error", () => {
  const { store, repoId } = fixture();
  try {
    assert.throws(
      () => affectedByFiles.endpointInventoryPage(store, { repoId, protocol: "grpc", limit: 2, cursor: "not-a-valid-cursor" }),
      (error) => error?.code === "CURSOR_INVALID" && error.message.includes("malformed cursor"),
    );
  } finally {
    store.close();
  }
});

test("cursor with changed limit returns CURSOR_REQUEST_MISMATCH error", async () => {
  const { store, repo, lines, deps, json } = fixture();
  try {
    assert.equal(await runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "2", "--json"], deps), 0);
    const first = json();
    assert.equal(typeof first.nextCursor, "string");

    lines.length = 0;
    const exitCode = await runCli(["endpoints", repo, "--protocol", "grpc", "--limit", "3", "--cursor", first.nextCursor, "--json"], deps);
    assert.notEqual(exitCode, 0);
    const payload = json();
    assert.equal(payload.error.code, "CURSOR_REQUEST_MISMATCH");
    assert.ok(payload.error.message.includes("limit"));
  } finally {
    store.close();
  }
});

test("missing required argument returns typed error with remediation", async () => {
  const { store, lines, deps, json } = fixture();
  try {
    const exitCode = await runCli(["path", "--json"], deps);
    assert.notEqual(exitCode, 0);
    const payload = json();
    assert.ok(payload.error);
    assert.ok(payload.error.code);
    assert.ok(payload.error.message);
    assert.equal(typeof payload.error.retryable, "boolean");
    assert.ok(payload.error.details || payload.error.remediation);
  } finally {
    store.close();
  }
});
