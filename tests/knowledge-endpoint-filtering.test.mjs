import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KnowledgeStore, affectedByFiles } from "../packages/knowledge-core/dist/index.js";

function seed() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-endpoint-filter-"));
  const store = KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "auth", rootPath: join(dir, "auth") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live", headCommit: "head-auth" });
  const insertMembership = store.db.prepare(
    "INSERT INTO endpoint_memberships(endpoint_id,repo_id,role,file_path,locator_node_id,created_at) VALUES (?,?,?,?,?,?)",
  );
  const endpoint = (service, method, role, filePath) => {
    const id = store.upsertNode({
      nodeType: "endpoint",
      identityKey: `grpc::auth.v1.${service}.${method}`,
      title: `${service}/${method}`,
      repoId: null,
      meta: { protocol: "grpc" },
    });
    insertMembership.run(id, repoId, role, filePath, null, new Date().toISOString());
    return id;
  };
  const version = endpoint("VersionService", "Version", "provider", "libs/tools/src/version/version.controller.ts");
  endpoint("VersionService", "Health", "provider", "libs/tools/src/health/health.controller.ts");
  endpoint("OtherService", "Version", "provider", "libs/tools/src/other/other.controller.ts");
  return { store, repoId, branchId, version };
}

test("endpoint inventory filters service/method/path/handler before returning the page", () => {
  const fixture = seed();
  const page = affectedByFiles.endpointInventoryPage(fixture.store, {
    repoId: fixture.repoId,
    service: "VersionService",
    method: "Version",
    path: "libs/tools/src/version",
    handledOnly: true,
    limit: 1,
  });

  assert.deepEqual(page.items.map((item) => item.nodeId), [fixture.version]);
  assert.equal(page.candidateCount, 1);
  assert.equal(page.totalIsExact, true);
  assert.equal(page.truncated, false);
  assert.equal(page.publication.discovered, 1);
  assert.equal(page.items[0].handlerStatus, "handled");
  assert.ok(page.items[0].occurrences.some((occurrence) => occurrence.provenanceKind === "handler"));
  fixture.store.close();
});

test("endpoint inventory rejects an outdated branch before scanning legacy publications", () => {
  const fixture = seed();
  fixture.store.db.prepare("UPDATE branches SET indexed_schema_version=? WHERE id=?").run(17, fixture.branchId);
  const startedAt = performance.now();
  assert.throws(
    () => affectedByFiles.endpointInventoryPage(fixture.store, { repoId: fixture.repoId, protocol: "grpc", limit: 1 }),
    (error) => error?.code === "SCHEMA_OUTDATED" && error?.details?.indexedSchemaVersion === 17,
  );
  assert.ok(performance.now() - startedAt < 250, "outdated branch must fail before a full graph scan");
  fixture.store.close();
});

test("handled endpoint pagination hydrates only the requested page and keeps cursor continuation bounded", () => {
  const fixture = seed();
  const insertMembership = fixture.store.db.prepare(
    "INSERT INTO endpoint_memberships(endpoint_id,repo_id,role,file_path,locator_node_id,created_at) VALUES (?,?,?,?,?,?)",
  );
  const addEndpoints = fixture.store.db.transaction(() => {
    for (let index = 0; index < 250; index += 1) {
      const endpointId = fixture.store.upsertNode({
        nodeType: "endpoint",
        identityKey: `grpc::auth.v1.ConsumerService.Call${String(index).padStart(4, "0")}`,
        title: `ConsumerService/Call${index}`,
        repoId: null,
        meta: { protocol: "grpc" },
      });
      insertMembership.run(endpointId, fixture.repoId, "consumer", `src/client-${index}.ts`, null, new Date().toISOString());
    }
    for (let index = 0; index < 5; index += 1) {
      const endpointId = fixture.store.upsertNode({
        nodeType: "endpoint",
        identityKey: `grpc::auth.v1.HandledService.Call${String(index).padStart(4, "0")}`,
        title: `HandledService/Call${index}`,
        repoId: null,
        meta: { protocol: "grpc" },
      });
      insertMembership.run(endpointId, fixture.repoId, "provider", `src/handler-${index}.ts`, null, new Date().toISOString());
    }
  });
  addEndpoints();

  const originalListMemberships = fixture.store.listEndpointMemberships.bind(fixture.store);
  let hydrationCalls = 0;
  fixture.store.listEndpointMemberships = (...args) => {
    hydrationCalls += 1;
    return originalListMemberships(...args);
  };

  const first = affectedByFiles.endpointInventoryPage(fixture.store, {
    repoId: fixture.repoId,
    handledOnly: true,
    limit: 2,
  });
  assert.equal(first.items.length, 2);
  assert.equal(first.candidateCount, 8);
  assert.equal(first.truncated, true);
  assert.equal(typeof first.nextCursor, "string");
  assert.ok(hydrationCalls <= 8, `page 1 hydrated ${hydrationCalls} endpoint membership sets for a two-item page`);

  hydrationCalls = 0;
  const second = affectedByFiles.endpointInventoryPage(fixture.store, {
    repoId: fixture.repoId,
    handledOnly: true,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 2);
  assert.equal(second.candidateCount, 8);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.nodeId)).size, 4);
  assert.ok(hydrationCalls <= 8, `continuation hydrated ${hydrationCalls} endpoint membership sets for a two-item page`);
  fixture.store.close();
});
