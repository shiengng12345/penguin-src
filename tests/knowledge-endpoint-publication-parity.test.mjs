import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  affectedByFiles,
  resolveRevisionContext,
  resolveTarget,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { runCli } from "../packages/knowledge-cli/dist/index.js";
import { handleKnowledgeTool } from "../packages/mcp/dist/knowledge-tools.js";
import {
  classifyEndpointProvenanceKind,
  compareEndpointOccurrences,
  endpointOccurrenceRank,
} from "../packages/knowledge-contracts/dist/index.js";

function openStore(prefix = "penguin-endpoint-publication-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const store = KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
  return { dir, store };
}

function writeFixtureFile(root, filePath, source) {
  const fullPath = join(root, filePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, source);
}

function commit(root, message) {
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", [
    "-c", "user.name=fixture",
    "-c", "user.email=fixture@example.test",
    "commit", "--allow-empty", "-m", message,
  ], { cwd: root, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

function gitFixture(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  for (const [filePath, source] of Object.entries(files)) writeFixtureFile(root, filePath, source);
  commit(root, "fixture A");
  return root;
}

function revision(store, repoId, snapshotId) {
  const result = resolveRevisionContext(store, { repoId, snapshotId });
  assert.equal(result.status, "resolved", JSON.stringify(result));
  return result.context;
}

test("publication receipt separates an ambiguous Version handler from persisted/queryable endpoints", async () => {
  const { store } = openStore();
  const cms = gitFixture("penguin-version-cms-", {
    "proto/version.proto": "syntax = \"proto3\"; package CMS; service VersionService { rpc Version (Req) returns (Res); }",
  });
  const player = gitFixture("penguin-version-player-", {
    "proto/version.proto": "syntax = \"proto3\"; package player; service VersionService { rpc Version (Req) returns (Res); }",
  });
  const auth = gitFixture("penguin-version-auth-", {
    "libs/tools/src/version/version.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class VersionController {",
      "  @GrpcMethod('VersionService', 'Version')",
      "  version() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    await indexRepo({ store, rootPath: cms, mode: "incremental" });
    await indexRepo({ store, rootPath: player, mode: "incremental" });
    const report = await indexRepo({ store, rootPath: auth, mode: "incremental" });
    const page = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId,
      scope: {
        repoId: report.repoId,
        branchId: report.branchId,
        revisionId: report.revisionTruth.snapshotId,
        revision: revision(store, report.repoId, report.revisionTruth.snapshotId),
      },
      protocol: "grpc",
      service: "VersionService",
      method: "Version",
      path: "libs/tools/src/version",
      handledOnly: true,
      provenanceKind: "handler",
      limit: 10,
    });

    assert.equal(page.candidateCount, 0, "ambiguous handler must not become queryable");
    const candidateEndpointIds = [
      store.findNodeIdByIdentity("grpc::CMS.VersionService.version"),
      store.findNodeIdByIdentity("grpc::player.VersionService.version"),
    ].sort();
    assert.deepEqual(page.publication, {
      discovered: 1,
      persisted: 0,
      queryable: 0,
      excluded: [{
        discoveryKey: "grpc::VersionService.version",
        reasonCode: "ambiguous-grpc-handler",
        candidateEndpointIds,
        provenance: {
          provenanceKind: "handler",
          filePath: "libs/tools/src/version/version.controller.ts",
          startLine: 3,
        },
      }],
      totalIsExact: true,
    });
    assert.deepEqual(report.endpointPublication, page.publication);
  } finally {
    store.close();
  }
});

test("like-for-like protocol and direct filters reconcile discovered persisted and queryable counts", async () => {
  const { store } = openStore();
  const root = gitFixture("penguin-endpoint-filter-", {
    "src/version.controller.ts": [
      "import { Controller, Get } from '@nestjs/common';",
      "import { GrpcMethod } from '@nestjs/microservices';",
      "@Controller('health')",
      "export class VersionController {",
      "  @GrpcMethod('player.VersionService', 'Version')",
      "  version() { return {}; }",
      "  @Get('ready')",
      "  ready() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const scope = {
      repoId: report.repoId,
      branchId: report.branchId,
      revisionId: report.revisionTruth.snapshotId,
      revision: revision(store, report.repoId, report.revisionTruth.snapshotId),
    };
    const all = affectedByFiles.endpointInventoryPage(store, { repoId: report.repoId, scope, limit: 10 });
    const grpc = affectedByFiles.endpointInventoryPage(store, { repoId: report.repoId, scope, protocol: "grpc", limit: 10 });
    const http = affectedByFiles.endpointInventoryPage(store, { repoId: report.repoId, scope, protocol: "http", limit: 10 });
    assert.equal(all.candidateCount, grpc.candidateCount + http.candidateCount);
    assert.equal(all.candidateCount, 2);
    assert.deepEqual(grpc.publication, {
      discovered: 1, persisted: 1, queryable: 1, excluded: [], totalIsExact: true,
    });
    assert.deepEqual(
      grpc.items.map((item) => item.identityKey),
      ["grpc::player.VersionService.version"],
    );
    const exact = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId,
      scope,
      protocol: "grpc",
      service: "VersionService",
      method: "Version",
      path: "src/version.controller.ts",
      handledOnly: true,
      limit: 1,
    });
    assert.equal(exact.candidateCount, 1);
    assert.equal(exact.totalIsExact, true);
    assert.equal(exact.nextCursor, null);
  } finally {
    store.close();
  }
});

test("endpoint inventory is isolated by selected snapshot when B deletes A endpoint", async () => {
  const { store } = openStore();
  const filePath = "src/version.controller.ts";
  const root = gitFixture("penguin-endpoint-revision-", {
    [filePath]: [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class VersionController {",
      "  @GrpcMethod('player.VersionService', 'Version')",
      "  version() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    const a = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const snapshotA = a.revisionTruth.snapshotId;
    rmSync(join(root, filePath));
    commit(root, "fixture B deletes endpoint");
    const b = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const snapshotB = b.revisionTruth.snapshotId;

    const pageA = affectedByFiles.endpointInventoryPage(store, {
      repoId: a.repoId,
      scope: { repoId: a.repoId, branchId: a.branchId, revisionId: snapshotA, revision: revision(store, a.repoId, snapshotA) },
      protocol: "grpc",
      limit: 10,
    });
    const pageB = affectedByFiles.endpointInventoryPage(store, {
      repoId: b.repoId,
      scope: { repoId: b.repoId, branchId: b.branchId, revisionId: snapshotB, revision: revision(store, b.repoId, snapshotB) },
      protocol: "grpc",
      limit: 10,
    });
    assert.deepEqual(pageA.items.map((item) => item.identityKey), ["grpc::player.VersionService.version"]);
    assert.deepEqual(pageB.items, []);
    assert.equal(pageA.publication.queryable, 1);
    assert.equal(pageB.publication.queryable, 0);
  } finally {
    store.close();
  }
});

test("publication failure exposes neither a ready revision nor endpoint inventory", async () => {
  const { store } = openStore();
  const root = gitFixture("penguin-endpoint-atomic-", {
    "src/atomic.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class AtomicController {",
      "  @GrpcMethod('atomic.VersionService', 'Version')",
      "  version() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    await assert.rejects(
      indexRepo({
        store,
        rootPath: root,
        mode: "rebuild",
        testHooks: { beforeSnapshotPublish: () => { throw new Error("publication-fault"); } },
      }),
      /publication-fault/,
    );
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM revision_snapshots WHERE state='ready'").get().count, 0);
    assert.equal(affectedByFiles.endpointInventoryPage(store, { protocol: "grpc", limit: 10 }).candidateCount, 0);
  } finally {
    store.close();
  }
});

test("Service.Method resolution narrows candidates by selected repo revision before ambiguity", async () => {
  const { store } = openStore();
  const cms = gitFixture("penguin-target-cms-", {
    "src/version.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class CmsVersionController {",
      "  @GrpcMethod('CMS.VersionService', 'Version')",
      "  version() { return {}; }",
      "}",
    ].join("\n"),
  });
  const player = gitFixture("penguin-target-player-", {
    "src/version.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class PlayerVersionController {",
      "  @GrpcMethod('player.VersionService', 'Version')",
      "  version() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    const cmsReport = await indexRepo({ store, rootPath: cms, mode: "incremental" });
    await indexRepo({ store, rootPath: player, mode: "incremental" });
    const selectedRevision = revision(store, cmsReport.repoId, cmsReport.revisionTruth.snapshotId);
    const result = resolveTarget(store, "VersionService.Version", {
      repoId: cmsReport.repoId,
      revision: selectedRevision,
      allowedKinds: ["endpoint"],
    });
    assert.equal(store.getNode(result.nodeId).identity_key, "grpc::CMS.VersionService.version");
    assert.equal(result.revisionId, selectedRevision.snapshotId);
  } finally {
    store.close();
  }
});

test("Core CLI and MCP consume the same endpoint filter revision and cursor fingerprint", async () => {
  const { dir, store } = openStore();
  const root = gitFixture("penguin-endpoint-transport-", {
    "libs/tools/src/version/version.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class VersionController {",
      "  @GrpcMethod('player.VersionService', 'Version')",
      "  version() { return {}; }",
      "  @GrpcMethod('player.VersionService', 'Build')",
      "  build() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const snapshotId = report.revisionTruth.snapshotId;
    const selected = revision(store, report.repoId, snapshotId);
    const scope = { repoId: report.repoId, branchId: report.branchId, revisionId: snapshotId, revision: selected };
    const core = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId,
      scope,
      protocol: "grpc",
      service: "VersionService",
      method: "Version",
      path: "libs/tools/src/version",
      handledOnly: true,
      provenanceKind: "handler",
      limit: 10,
    });

    const lines = [];
    const dbPath = join(dir, "knowledge.db");
    const ledgerPath = join(dir, "ledger.jsonl");
    const deps = {
      cwd: root,
      openStore: () => KnowledgeStore.open({ dbPath, ledgerPath }),
      storeExists: () => true,
      out: (line) => lines.push(line),
      err: (line) => lines.push(line),
    };
    assert.equal(await runCli([
      "endpoints", "--repo", report.repoId,
      "--snapshot", snapshotId,
      "--protocol", "grpc",
      "--service", "VersionService",
      "--method", "Version",
      "--path", "libs/tools/src/version",
      "--handled-only",
      "--provenance-kind", "handler",
      "--limit", "10",
      "--json",
    ], deps), 0);
    const cli = JSON.parse(lines.at(-1));
    const mcp = handleKnowledgeTool("knowledge_endpoints", {
      repo: report.repoId,
      snapshot_id: snapshotId,
      protocol: "grpc",
      service: "VersionService",
      method: "Version",
      path: "libs/tools/src/version",
      handled_only: true,
      provenance_kind: "handler",
      limit: 10,
      compact: true,
    }, store);

    const expectedIds = core.items.map((item) => item.nodeId);
    assert.deepEqual(cli.items.map((item) => item.nodeId), expectedIds);
    assert.deepEqual(mcp.items.map((item) => item.nodeId), expectedIds);
    assert.equal(cli.candidateCount, core.candidateCount);
    assert.equal(mcp.candidateCount, core.candidateCount);
    assert.equal(cli.revision.snapshotId, snapshotId);
    assert.equal(mcp.revision.snapshotId, snapshotId);
    assert.deepEqual(cli.publication, core.publication);
    assert.deepEqual(mcp.publication, core.publication);

    const first = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId,
      scope,
      protocol: "grpc",
      service: "VersionService",
      path: "libs/tools/src/version",
      handledOnly: true,
      limit: 1,
    });
    assert.equal(typeof first.nextCursor, "string");
    assert.throws(
      () => affectedByFiles.endpointInventoryPage(store, {
        repoId: report.repoId,
        scope,
        protocol: "grpc",
        service: "VersionService",
        method: "Version",
        path: "libs/tools/src/version",
        handledOnly: true,
        limit: 1,
        cursor: first.nextCursor,
      }),
      /CURSOR_SCOPE_MISMATCH/,
    );
    const provenancePage = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId,
      scope,
      protocol: "grpc",
      service: "VersionService",
      path: "libs/tools/src/version",
      provenanceKind: "handler",
      limit: 1,
    });
    assert.equal(typeof provenancePage.nextCursor, "string");
    assert.throws(
      () => affectedByFiles.endpointInventoryPage(store, {
        repoId: report.repoId,
        scope,
        protocol: "grpc",
        service: "VersionService",
        path: "libs/tools/src/version",
        provenanceKind: "test",
        limit: 1,
        cursor: provenancePage.nextCursor,
      }),
      /CURSOR_SCOPE_MISMATCH/,
      "provenanceKind must participate in the endpoint cursor fingerprint",
    );
  } finally {
    store.close();
  }
});

test("[endpoint-locator] endpoint occurrences expose canonical source locators and stable production-first ranking", async () => {
  const { store } = openStore();
  const root = gitFixture("penguin-endpoint-occurrence-", {
    "proto/version.proto": [
      "syntax = \"proto3\";",
      "package player;",
      "service VersionService {",
      "  rpc Version (Req) returns (Res);",
      "}",
    ].join("\n"),
    "src/version.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class VersionController {",
      "  @GrpcMethod('player.VersionService', 'Version')",
      "  version() { return {}; }",
      "}",
    ].join("\n"),
    "src/version.client.ts": [
      "export class VersionClient {",
      "  private versionService;",
      "  onInit() { this.versionService = this.client.getService('player.VersionService'); }",
      "  load() { return this.versionService.version({}); }",
      "}",
    ].join("\n"),
    "tests/mock.controller.spec.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class MockController {",
      "  @GrpcMethod('player.MockService', 'Mock')",
      "  mock() { return {}; }",
      "}",
    ].join("\n"),
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const selected = revision(store, report.repoId, report.revisionTruth.snapshotId);
    const scope = {
      repoId: report.repoId,
      branchId: report.branchId,
      revisionId: selected.snapshotId,
      revision: selected,
    };
    const all = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId,
      scope,
      protocol: "grpc",
      limit: 20,
    });
    const version = all.items.find((item) => item.identityKey === "grpc::player.VersionService.version");
    assert.ok(version, JSON.stringify(all));
    assert.deepEqual(
      [...new Set(version.occurrences.map((occurrence) => occurrence.provenanceKind))],
      ["handler", "definition", "client"],
    );
    for (const occurrence of version.occurrences) {
      assert.equal(occurrence.repoId, report.repoId);
      assert.equal(occurrence.commit, selected.commitSha);
      assert.equal(occurrence.snapshot, selected.snapshotId);
      assert.equal(typeof occurrence.file, "string");
      assert.ok(occurrence.line > 0, JSON.stringify(occurrence));
      assert.equal(typeof occurrence.locatorNodeId, "string", JSON.stringify(occurrence));
    }

    const handlers = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId, scope, protocol: "grpc", provenanceKind: "handler", limit: 20,
    });
    const handledOnly = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId, scope, protocol: "grpc", handledOnly: true, limit: 20,
    });
    assert.deepEqual(
      handledOnly.items.map((item) => item.nodeId),
      handlers.items.map((item) => item.nodeId),
      "handledOnly must be the canonical handler-occurrence filter",
    );
    assert.ok(!handlers.items.some((item) => item.identityKey === "grpc::player.MockService.mock"));
    const testsOnly = affectedByFiles.endpointInventoryPage(store, {
      repoId: report.repoId, scope, protocol: "grpc", provenanceKind: "test", limit: 20,
    });
    assert.deepEqual(testsOnly.items.map((item) => item.identityKey), ["grpc::player.MockService.mock"]);

    assert.equal(classifyEndpointProvenanceKind({ edgeType: "handles", filePath: "tests/mock.fixture.ts" }), "test");
    assert.equal(classifyEndpointProvenanceKind({ edgeType: "handles", filePath: "src/controller.ts" }), "handler");
    assert.equal(classifyEndpointProvenanceKind({ edgeType: "declares", filePath: "proto/version.proto" }), "definition");
    assert.equal(classifyEndpointProvenanceKind({ edgeType: "invokes", filePath: "src/client.ts" }), "client");
    assert.ok(endpointOccurrenceRank("handler") < endpointOccurrenceRank("definition"));
    assert.ok(endpointOccurrenceRank("definition") < endpointOccurrenceRank("client"));
    assert.ok(endpointOccurrenceRank("client") < endpointOccurrenceRank("test"));
    const testFirst = [
      { provenanceKind: "test", repoId: "r", commit: "c", snapshot: "s", file: "a.spec.ts", line: 1 },
      { provenanceKind: "handler", repoId: "r", commit: "c", snapshot: "s", file: "z.ts", line: 9 },
    ].sort(compareEndpointOccurrences);
    assert.equal(testFirst[0].provenanceKind, "handler");
  } finally {
    store.close();
  }
});
