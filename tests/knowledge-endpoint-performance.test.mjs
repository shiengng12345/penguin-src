import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { performance } from "node:perf_hooks";

import { GitTopologyStore, KnowledgeStore, affectedByFiles } from "../packages/knowledge-core/dist/index.js";

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function seedProjectedEndpoints(count = 2_000) {
  const directory = mkdtempSync(join(tmpdir(), "penguin-endpoint-performance-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "large-endpoint-fixture", rootPath: join(directory, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({
    snapshotKey: "main", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 18,
  });
  const commitSha = "endpoint-performance-commit";
  store.db.prepare("UPDATE branches SET current_snapshot_id=?,last_indexed_commit=? WHERE id=?")
    .run(snapshot.id, commitSha, branchId);
  const insertOccurrence = store.db.prepare(`
    INSERT INTO revision_endpoint_occurrences(
      snapshot_id,endpoint_node_id,endpoint_identity_key,protocol,locator_node_id,
      locator_identity_key,edge_type,provenance_kind,file_path,start_line,end_line,
      method,confidence,provenance
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  store.db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const identityKey = `grpc::fixture.v1.LoadService.Call${String(index).padStart(5, "0")}`;
      const nodeId = store.upsertNode({
        nodeType: "endpoint", identityKey, repoId: null, title: `LoadService/Call${index}`, meta: { protocol: "grpc" },
      });
      const filePath = `src/handlers/load-${index}.controller.ts`;
      insertOccurrence.run(
        snapshot.id, nodeId, identityKey, "grpc", null, "", "handles", "handler",
        filePath, index + 1, index + 2, "EXTRACTED", 1,
        JSON.stringify({ filePath, startLine: index + 1, endLine: index + 2 }),
      );
    }
    store.db.prepare(
      "INSERT INTO revision_endpoint_publications(snapshot_id,repo_id,commit_sha,occurrence_count,materialized_at) VALUES (?,?,?,?,?)",
    ).run(snapshot.id, repoId, commitSha, count, new Date().toISOString());
  })();
  const scope = {
    repoId,
    branchId,
    revisionId: snapshot.id,
    revision: { repoId, branchId, branch: "main", commitSha, snapshotId: snapshot.id, trust: "exact_commit" },
  };
  return { store, repoId, scope, count };
}

test("[endpoint-filter-latency] projected large-corpus endpoint filters meet the Core p95 budget", () => {
  const fixture = seedProjectedEndpoints();
  try {
    const request = {
      repoId: fixture.repoId,
      scope: fixture.scope,
      protocol: "grpc",
      service: "LoadService",
      handledOnly: true,
      path: "src/handlers",
      limit: 8,
    };
    affectedByFiles.endpointInventoryPage(fixture.store, request);
    const durations = [];
    for (let index = 0; index < 30; index += 1) {
      const startedAt = performance.now();
      const page = affectedByFiles.endpointInventoryPage(fixture.store, request);
      durations.push(performance.now() - startedAt);
      assert.equal(page.candidateCount, fixture.count);
      assert.equal(page.items.length, 8);
    }
    assert.ok(percentile(durations, 0.95) <= 200, JSON.stringify(durations));
  } finally {
    fixture.store.close();
  }
});

test("[endpoint-cursor-continuation] endpoint cursors exhaust without duplicates and continuation meets p95", () => {
  const fixture = seedProjectedEndpoints(73);
  try {
    const seen = new Set();
    const durations = [];
    let cursor;
    let candidateCount;
    do {
      const startedAt = performance.now();
      const page = affectedByFiles.endpointInventoryPage(fixture.store, {
        repoId: fixture.repoId,
        scope: fixture.scope,
        handledOnly: true,
        limit: 7,
        ...(cursor ? { cursor } : {}),
      });
      durations.push(performance.now() - startedAt);
      candidateCount ??= page.candidateCount;
      assert.equal(page.candidateCount, candidateCount);
      for (const item of page.items) assert.equal(seen.has(item.nodeId), false, `duplicate ${item.nodeId}`), seen.add(item.nodeId);
      assert.equal(page.remainingCount, candidateCount - seen.size, "remainingCount must be exact after every cursor page");
      cursor = page.nextCursor ?? undefined;
      assert.equal(page.truncated, Boolean(cursor));
    } while (cursor);
    assert.equal(seen.size, fixture.count);
    assert.ok(percentile(durations.slice(1), 0.95) <= 100, JSON.stringify(durations));
  } finally {
    fixture.store.close();
  }
});

test("[endpoint-revision-query-plan] scoped endpoint hydration uses identity-first indexes", () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-endpoint-revision-plan-"));
  const store = KnowledgeStore.open({ dbPath: join(directory, "knowledge.db"), ledgerPath: join(directory, "ledger.jsonl") });
  const repoId = store.registerRepo({ name: "revision-plan-fixture", rootPath: join(directory, "repo") });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  const snapshot = new GitTopologyStore(store).createBuildingSnapshot({
    snapshotKey: "main", repoId, parserVersion: "p", resolverVersion: "r", schemaVersion: 18,
  });
  const commitSha = "revision-plan-commit";
  store.db.prepare("UPDATE branches SET current_snapshot_id=?,last_indexed_commit=? WHERE id=?")
    .run(snapshot.id, commitSha, branchId);
  const endpointIdentity = "grpc::fixture.v1.VersionService.Version";
  const endpointId = store.upsertNode({
    nodeType: "endpoint", identityKey: endpointIdentity, repoId: null,
    title: "VersionService/Version", meta: { protocol: "grpc" },
  });
  const handlerId = store.upsertNode({
    nodeType: "symbol", identityKey: "fixture::VersionController.version", repoId,
    title: "VersionController.version", meta: {},
  });
  const insertRef = store.db.prepare(
    "INSERT INTO snapshot_resolution_refs(snapshot_id,file_path,resolution_set_id) VALUES (?,?,?)",
  );
  const insertEdge = store.db.prepare(
    `INSERT INTO resolved_edges(
       id,resolution_set_id,src_identity_key,dst_identity_key,raw_target,edge_type,
       method,confidence,provenance
     ) VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  const resolutionSetCount = 3_287;
  store.db.transaction(() => {
    for (let index = 0; index < resolutionSetCount; index += 1) {
      const resolutionSetId = `resolution-plan-${index}`;
      insertRef.run(snapshot.id, `src/file-${index}.ts`, resolutionSetId);
      for (const edgeType of ["calls", "references", "uses", "reads", "writes", "throws"]) {
        insertEdge.run(
          `edge-plan-${index}-${edgeType}`, resolutionSetId,
          `fixture::source-${index}`, `fixture::target-${index}`, null, edgeType,
          "INFERRED", 0.1, JSON.stringify({ filePath: `src/file-${index}.ts`, startLine: 1 }),
        );
      }
    }
    insertEdge.run(
      "edge-plan-handler", "resolution-plan-0", endpointIdentity,
      "fixture::VersionController.version", null, "handles", "EXTRACTED", 1,
      JSON.stringify({ filePath: "src/version.controller.ts", startLine: 9, endLine: 11 }),
    );
  })();
  try {
    affectedByFiles.materializeEndpointOccurrences(store, {
      snapshotId: snapshot.id, repoId, commitSha,
    });
    const types = ["calls", "renders", "invokes_dynamic", "invokes", "references", "reads", "writes", "throws", "uses", "handles"];
    const resolutionSets = Array.from({ length: resolutionSetCount }, (_, index) => `resolution-plan-${index}`);
    const plan = store.db.prepare(
      `EXPLAIN QUERY PLAN
         SELECT r.* FROM resolved_edges r
          WHERE r.resolution_set_id IN (${resolutionSets.map(() => "?").join(",")})
            AND r.src_identity_key IN (?)
            AND r.edge_type IN (${types.map(() => "?").join(",")})
          ORDER BY r.edge_type,r.src_identity_key,r.dst_identity_key,r.id
          LIMIT ?`,
    ).all(...resolutionSets, endpointIdentity, ...types, 10_000);
    const planText = plan.map((row) => row.detail).join(" | ");
    assert.match(planText, /idx_resolved_edges_src_type_set/);
    assert.doesNotMatch(planText, /SCAN r/);

    const scope = {
      repoId, branchId, revisionId: snapshot.id,
      revision: { repoId, branchId, branch: "main", commitSha, snapshotId: snapshot.id, trust: "exact_commit" },
    };
    const startedAt = performance.now();
    const page = affectedByFiles.endpointInventoryPage(store, {
      repoId, scope, protocol: "grpc", service: "VersionService", method: "Version",
      handledOnly: true, limit: 1,
    });
    const elapsedMs = performance.now() - startedAt;
    assert.equal(page.items.length, 1, JSON.stringify(page));
    assert.equal(page.items[0].handlers[0].nodeId, handlerId, JSON.stringify(page.items[0]));
    assert.ok(elapsedMs <= 200, `${elapsedMs}ms: ${JSON.stringify(page)}`);
  } finally {
    store.close();
  }
});
