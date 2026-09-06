import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  canonicalGrpcIdentity,
  grpcIdentityAliases,
} from "../packages/knowledge-contracts/dist/index.js";
import {
  KnowledgeStore,
  resolveGrpcEndpoint,
} from "../packages/knowledge-core/dist/index.js";
import {
  grpcEndpointKey,
  indexRepo,
} from "../packages/knowledge-indexer/dist/index.js";

function openStore() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-endpoint-identity-"));
  return KnowledgeStore.open({
    dbPath: join(dir, "knowledge.db"),
    ledgerPath: join(dir, "ledger.jsonl"),
  });
}

function addRepo(store, name) {
  const repoId = store.registerRepo({ name, rootPath: `/fixture/${name}` });
  const branchId = store.registerBranch({ repoId, name: "main", status: "live" });
  return { repoId, branchId };
}

function addImplementation(store, repo, title, filePath) {
  const nodeId = store.upsertNode({
    nodeType: "symbol",
    identityKey: `${repo.repoId}::${filePath}::${title}`,
    repoId: repo.repoId,
    title,
  });
  store.upsertSymbolVersion({
    nodeId,
    branchId: repo.branchId,
    commitSha: "fixture-commit",
    filePath,
    lang: "typescript",
    kind: "method",
    contentHash: `${title}-hash`,
    status: "fresh",
    startLine: 10,
    endLine: 12,
  });
  return nodeId;
}

function gitFixture(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  for (const [filePath, source] of Object.entries(files)) {
    const fullPath = join(root, filePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, source);
  }
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

test("package metadata produces one package-qualified canonical gRPC identity", () => {
  const input = {
    packageName: "acme.inventory.v1",
    service: "Inventory",
    method: "GetThing",
  };

  assert.equal(
    canonicalGrpcIdentity(input),
    "grpc::acme.inventory.v1.Inventory.getthing",
  );
  assert.deepEqual(
    new Set(grpcIdentityAliases(input)),
    new Set([
      "grpc::Inventory.getthing",
      "gRPC Inventory.GetThing",
      "Inventory.GetThing",
      "gRPC acme.inventory.v1.Inventory.GetThing",
      "acme.inventory.v1.Inventory.GetThing",
      "/acme.inventory.v1.Inventory/GetThing",
    ]),
  );
});

test("the indexer grpc key delegates package qualification to the shared contract", () => {
  assert.equal(
    grpcEndpointKey("Inventory", "GetThing", "acme.inventory.v1"),
    "grpc::acme.inventory.v1.Inventory.getthing",
  );
});

test("unqualified ingestion is promoted to the package-qualified endpoint without changing node id", () => {
  const store = openStore();
  try {
    const original = store.upsertGrpcEndpoint({ service: "Inventory", method: "GetThing" });
    const canonical = store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "GetThing",
    });

    assert.equal(canonical, original, "package discovery must preserve the existing node primary key");
    assert.equal(
      store.getNode(canonical)?.identity_key,
      "grpc::acme.inventory.v1.Inventory.getthing",
    );
    const twins = store.db.prepare(
      "SELECT id FROM nodes WHERE node_type='endpoint' AND LOWER(identity_key) LIKE '%inventory%getthing'",
    ).all();
    assert.deepEqual(twins.map((row) => row.id), [canonical]);

    for (const form of [
      "gRPC Inventory.GetThing",
      "grpc::Inventory.getthing",
      "grpc::acme.inventory.v1.Inventory.getthing",
      "/acme.inventory.v1.Inventory/GetThing",
      `node:${canonical}`,
    ]) {
      assert.deepEqual(resolveGrpcEndpoint(store, form), { kind: "unique", nodeId: canonical }, form);
    }
  } finally {
    store.close();
  }
});

test("same service and method in two packages keep distinct canonical nodes and an ambiguous bare alias", () => {
  const store = openStore();
  try {
    const first = store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "GetThing",
    });
    const second = store.upsertGrpcEndpoint({
      packageName: "other.inventory.v1",
      service: "Inventory",
      method: "GetThing",
    });

    assert.notEqual(first, second);
    assert.deepEqual(resolveGrpcEndpoint(store, "grpc::acme.inventory.v1.Inventory.getthing"), { kind: "unique", nodeId: first });
    assert.deepEqual(resolveGrpcEndpoint(store, "grpc::other.inventory.v1.Inventory.getthing"), { kind: "unique", nodeId: second });
    const bare = resolveGrpcEndpoint(store, "gRPC Inventory.GetThing");
    assert.equal(bare.kind, "ambiguous");
    assert.deepEqual(new Set(bare.candidates.map((candidate) => candidate.nodeId)), new Set([first, second]));
  } finally {
    store.close();
  }
});

test("proto declaration method metadata wins deterministically over handler casing", () => {
  const store = openStore();
  try {
    const endpointId = store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "getThing",
      meta: { controller: "InventoryController" },
    });
    store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "GetThing",
      meta: { source: "proto/inventory.proto" },
    });
    store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "getThing",
      meta: { controller: "InventoryController" },
    });

    const meta = JSON.parse(store.getNode(endpointId).meta);
    assert.equal(meta.method, "GetThing");
    assert.equal(meta.source, "proto/inventory.proto");
    assert.equal(meta.controller, "InventoryController");
  } finally {
    store.close();
  }
});

test("removeRepo collects only the orphaned global endpoint and makes its bare alias unique again", () => {
  const store = openStore();
  try {
    const keepRepo = addRepo(store, "keep-provider");
    const dropRepo = addRepo(store, "drop-provider");
    const keepEndpoint = store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "GetThing",
    });
    const dropEndpoint = store.upsertGrpcEndpoint({
      packageName: "other.inventory.v1",
      service: "Inventory",
      method: "GetThing",
    });
    const keepHandler = addImplementation(store, keepRepo, "KeepInventory.getThing", "src/keep.ts");
    const dropHandler = addImplementation(store, dropRepo, "DropInventory.getThing", "src/drop.ts");
    store.replaceFileEdges({
      repoId: keepRepo.repoId,
      branchId: keepRepo.branchId,
      filePath: "src/keep.ts",
      edges: [{ src: keepEndpoint, dst: keepHandler, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }],
    });
    store.replaceFileEdges({
      repoId: dropRepo.repoId,
      branchId: dropRepo.branchId,
      filePath: "src/drop.ts",
      edges: [{ src: dropEndpoint, dst: dropHandler, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }],
    });

    assert.equal(resolveGrpcEndpoint(store, "gRPC Inventory.GetThing").kind, "ambiguous");
    store.removeRepo(dropRepo.repoId);

    assert.equal(store.getNode(dropEndpoint), null, "an endpoint with no remaining membership or edge must be collected");
    assert.deepEqual(store.getEndpointAliases(dropEndpoint), []);
    assert.ok(store.getNode(keepEndpoint), "an endpoint still owned through another repository membership must survive");
    assert.deepEqual(
      resolveGrpcEndpoint(store, "gRPC Inventory.GetThing"),
      { kind: "unique", nodeId: keepEndpoint },
    );
  } finally {
    store.close();
  }
});

test("endpoint membership is explicit and handler status requires a provider implementation locator", () => {
  const store = openStore();
  try {
    const providerRepo = addRepo(store, "provider");
    const consumerRepo = addRepo(store, "consumer");
    const declarationRepo = addRepo(store, "declaration");
    const unrelatedRepo = addRepo(store, "unrelated");
    const endpointId = store.upsertGrpcEndpoint({
      packageName: "acme.inventory.v1",
      service: "Inventory",
      method: "GetThing",
    });
    const provider = addImplementation(store, providerRepo, "InventoryController.getThing", "src/provider.ts");
    const consumer = addImplementation(store, consumerRepo, "InventoryClient.getThing", "src/consumer.ts");
    const declaration = store.upsertNode({
      nodeType: "service",
      identityKey: `${declarationRepo.repoId}::proto::Inventory`,
      repoId: declarationRepo.repoId,
      title: "Inventory",
    });

    store.replaceFileEdges({
      repoId: providerRepo.repoId,
      branchId: providerRepo.branchId,
      filePath: "src/provider.ts",
      edges: [{ src: endpointId, dst: provider, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true }],
    });
    store.replaceFileEdges({
      repoId: consumerRepo.repoId,
      branchId: consumerRepo.branchId,
      filePath: "src/consumer.ts",
      edges: [{ src: consumer, dst: endpointId, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true }],
    });
    store.replaceFileEdges({
      repoId: declarationRepo.repoId,
      branchId: declarationRepo.branchId,
      filePath: "proto/inventory.proto",
      edges: [{ src: endpointId, dst: declaration, edgeType: "declares", origin: "parser", method: "EXTRACTED", branchless: true }],
    });

    assert.deepEqual(
      store.listEndpointMemberships(endpointId).map(({ repoId, role }) => ({ repoId, role })),
      [
        { repoId: consumerRepo.repoId, role: "consumer" },
        { repoId: declarationRepo.repoId, role: "declaration" },
        { repoId: providerRepo.repoId, role: "provider" },
      ].sort((a, b) => a.repoId.localeCompare(b.repoId) || a.role.localeCompare(b.role)),
    );
    assert.deepEqual(store.listEndpointMemberships(endpointId, unrelatedRepo.repoId), []);
    assert.equal(store.getNode(endpointId)?.repo_id, null, "global does not imply membership");
    assert.equal(store.endpointHandlerStatus(endpointId, providerRepo.repoId), "handled");
    assert.equal(store.endpointHandlerStatus(endpointId, consumerRepo.repoId), "incomplete");
    assert.equal(store.endpointHandlerStatus(endpointId, declarationRepo.repoId), "proto_only");

    store.replaceFileEdges({
      repoId: providerRepo.repoId,
      branchId: providerRepo.branchId,
      filePath: "src/provider.ts",
      edges: [],
    });
    assert.equal(store.endpointHandlerStatus(endpointId, providerRepo.repoId), "incomplete");
    assert.deepEqual(store.listEndpointMemberships(endpointId, providerRepo.repoId), []);
  } finally {
    store.close();
  }
});

test("pipeline collapses provider, consumer, and proto declaration into one canonical endpoint", async () => {
  const store = openStore();
  const root = mkdtempSync(join(tmpdir(), "penguin-endpoint-pipeline-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "proto"), { recursive: true });
  writeFileSync(join(root, "src", "inventory.controller.ts"), [
    "export class InventoryController {",
    "  @GrpcMethod('Inventory', 'GetThing')",
    "  async getThing(data) { return data; }",
    "}",
  ].join("\n"));
  writeFileSync(join(root, "src", "inventory.client.ts"), [
    "export class InventoryClient {",
    "  onInit() { this.inventory = this.client.getService('Inventory'); }",
    "  async call() { return this.inventory.getThing({}); }",
    "}",
  ].join("\n"));
  writeFileSync(join(root, "proto", "inventory.proto"), [
    "syntax = \"proto3\";",
    "package acme.inventory.v1;",
    "service Inventory {",
    "  rpc GetThing (GetThingRequest) returns (GetThingResponse);",
    "}",
  ].join("\n"));
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });

  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const endpoints = store.db.prepare(
      "SELECT id, identity_key AS identityKey FROM nodes WHERE node_type='endpoint'",
    ).all();
    assert.deepEqual(endpoints, [{
      id: endpoints[0]?.id,
      identityKey: "grpc::acme.inventory.v1.Inventory.getthing",
    }]);
    const endpointId = endpoints[0].id;
    assert.deepEqual(
      store.listEndpointMemberships(endpointId).map(({ repoId, role }) => ({ repoId, role })),
      [
        { repoId: report.repoId, role: "consumer" },
        { repoId: report.repoId, role: "declaration" },
        { repoId: report.repoId, role: "provider" },
      ],
    );
    assert.equal(store.endpointHandlerStatus(endpointId, report.repoId), "handled");
    const declarationHandles = store.db.prepare(
      `SELECT COUNT(*) AS count FROM edges e
        JOIN nodes n ON n.id=e.dst
       WHERE e.src=? AND e.edge_type='handles' AND n.node_type='service'`,
    ).get(endpointId);
    assert.equal(declarationHandles.count, 0, "proto declarations are not implementation handlers");
    assert.equal(resolveGrpcEndpoint(store, "gRPC Inventory.GetThing").nodeId, endpointId);
    assert.equal(resolveGrpcEndpoint(store, "/acme.inventory.v1.Inventory/GetThing").nodeId, endpointId);
  } finally {
    store.close();
  }
});

test("indexRepo records an ambiguous unqualified gRPC consumer without creating or linking an endpoint", async () => {
  const store = openStore();
  const firstProvider = gitFixture("penguin-endpoint-provider-a-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "package acme.inventory.v1;",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });
  const secondProvider = gitFixture("penguin-endpoint-provider-b-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "package other.inventory.v1;",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });
  const consumer = gitFixture("penguin-endpoint-consumer-", {
    "src/consumer.ts": [
      "export class InventoryConsumer {",
      "  onInit() { this.inventory = this.client.getService('Inventory'); }",
      "  async call() { return this.inventory.getThing({}); }",
      "}",
    ].join("\n"),
  });

  try {
    await indexRepo({ store, rootPath: firstProvider, mode: "incremental" });
    await indexRepo({ store, rootPath: secondProvider, mode: "incremental" });
    const report = await indexRepo({ store, rootPath: consumer, mode: "incremental" });

    assert.equal(report.errors, 0, "endpoint ambiguity is an unresolved reference, not a file failure");
    const endpoints = store.db.prepare(
      "SELECT identity_key AS identityKey FROM nodes WHERE node_type='endpoint' ORDER BY identity_key",
    ).all();
    assert.deepEqual(endpoints, [
      { identityKey: "grpc::acme.inventory.v1.Inventory.getthing" },
      { identityKey: "grpc::other.inventory.v1.Inventory.getthing" },
    ]);
    assert.deepEqual(
      store.db.prepare("SELECT endpoint_id FROM endpoint_memberships WHERE repo_id=?").all(report.repoId),
      [],
      "an ambiguous consumer must not claim membership in either endpoint",
    );
    assert.equal(
      store.db.prepare(
        `SELECT COUNT(*) AS count FROM edges e
          JOIN nodes s ON s.id=e.src
          JOIN nodes d ON d.id=e.dst
         WHERE s.repo_id=? AND d.node_type='endpoint' AND e.edge_type='invokes'`,
      ).get(report.repoId).count,
      0,
      "an ambiguous consumer must not create a wrong invokes edge",
    );
    assert.deepEqual(
      store.db.prepare(
        `SELECT callee,receiver,specifier,reason,line
           FROM external_calls
          WHERE repo_id=? AND reason='ambiguous-grpc-endpoint'`,
      ).all(report.repoId),
      [{
        callee: "getThing",
        receiver: "Inventory",
        specifier: "grpc::Inventory.getthing",
        reason: "ambiguous-grpc-endpoint",
        line: 3,
      }],
      "the skipped edge must remain diagnosable at its exact call site",
    );
    const coverage = store.db.prepare(
      "SELECT unresolved_references AS unresolvedReferences FROM coverage_records WHERE repo_id=? AND file_path='src/consumer.ts'",
    ).get(report.repoId);
    assert.ok(coverage.unresolvedReferences >= 1, "coverage must expose the unresolved endpoint reference");
  } finally {
    store.close();
  }
});

test("indexRepo records an ambiguous unqualified gRPC handler without aborting or guessing a package", async () => {
  const store = openStore();
  const firstProvider = gitFixture("penguin-endpoint-handler-provider-a-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "package acme.inventory.v1;",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });
  const secondProvider = gitFixture("penguin-endpoint-handler-provider-b-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "package other.inventory.v1;",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });
  const ambiguousProvider = gitFixture("penguin-endpoint-handler-ambiguous-", {
    "src/inventory.controller.ts": [
      "import { GrpcMethod } from '@nestjs/microservices';",
      "export class InventoryController {",
      "  @GrpcMethod('Inventory', 'GetThing')",
      "  getThing() { return {}; }",
      "}",
    ].join("\n"),
  });

  try {
    await indexRepo({ store, rootPath: firstProvider, mode: "incremental" });
    await indexRepo({ store, rootPath: secondProvider, mode: "incremental" });
    const report = await indexRepo({ store, rootPath: ambiguousProvider, mode: "incremental" });

    assert.equal(report.errors, 0, "handler ambiguity is unresolved evidence, not an index failure");
    const candidateEndpointIds = store.db.prepare(
      "SELECT id FROM nodes WHERE node_type='endpoint' ORDER BY identity_key",
    ).all().map((row) => row.id).sort();
    assert.deepEqual(report.endpointPublication, {
      discovered: 1,
      persisted: 0,
      queryable: 0,
      excluded: [{
        discoveryKey: "grpc::Inventory.getthing",
        reasonCode: "ambiguous-grpc-handler",
        candidateEndpointIds,
        provenance: { provenanceKind: "handler", filePath: "src/inventory.controller.ts", startLine: 3 },
      }],
      totalIsExact: true,
    }, "publication must type the honest abstention instead of counting discovery as success");
    assert.deepEqual(
      store.db.prepare(
        "SELECT identity_key AS identityKey FROM nodes WHERE node_type='endpoint' ORDER BY identity_key",
      ).all(),
      [
        { identityKey: "grpc::acme.inventory.v1.Inventory.getthing" },
        { identityKey: "grpc::other.inventory.v1.Inventory.getthing" },
      ],
      "an unqualified handler must not invent or choose a canonical package",
    );
    assert.equal(
      store.db.prepare(
        `SELECT COUNT(*) AS count FROM edges e
          JOIN nodes d ON d.id=e.dst
         WHERE d.repo_id=? AND e.edge_type='handles'`,
      ).get(report.repoId).count,
      0,
      "the ambiguous handler must not attach either package endpoint to the implementation",
    );
    assert.deepEqual(
      store.db.prepare(
        `SELECT callee,receiver,specifier,reason
           FROM external_calls
          WHERE repo_id=? AND reason='ambiguous-grpc-handler'`,
      ).all(report.repoId),
      [{
        callee: "GetThing",
        receiver: "Inventory",
        specifier: "grpc::Inventory.getthing",
        reason: "ambiguous-grpc-handler",
      }],
      "the skipped handler binding remains diagnosable",
    );
    const unresolved = store.db.prepare(
      `SELECT raw_target AS discoveryKey,reason_code AS reasonCode,start_line AS startLine,reason
         FROM unresolved_reference_items
        WHERE repo_id=? AND revision_id=? AND reason_code='ambiguous-grpc-handler'`,
    ).get(report.repoId, report.revisionTruth.snapshotId);
    assert.equal(unresolved.discoveryKey, "grpc::Inventory.getthing");
    assert.equal(unresolved.reasonCode, "ambiguous-grpc-handler");
    assert.equal(unresolved.startLine, 3);
    assert.deepEqual(JSON.parse(unresolved.reason).candidateEndpointIds, candidateEndpointIds);
    const coverage = store.db.prepare(
      "SELECT unresolved_references AS unresolvedReferences FROM coverage_records WHERE repo_id=? AND file_path='src/inventory.controller.ts'",
    ).get(report.repoId);
    assert.ok(coverage.unresolvedReferences >= 1, "coverage exposes the unresolved handler identity");
  } finally {
    store.close();
  }
});

test("indexRepo records an ambiguous package-less gRPC declaration without aborting or guessing a package", async () => {
  const store = openStore();
  const firstProvider = gitFixture("penguin-endpoint-declaration-provider-a-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "package acme.inventory.v1;",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });
  const secondProvider = gitFixture("penguin-endpoint-declaration-provider-b-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "package other.inventory.v1;",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });
  const ambiguousDeclaration = gitFixture("penguin-endpoint-declaration-ambiguous-", {
    "proto/inventory.proto": [
      "syntax = \"proto3\";",
      "service Inventory { rpc GetThing (Request) returns (Response); }",
    ].join("\n"),
  });

  try {
    await indexRepo({ store, rootPath: firstProvider, mode: "incremental" });
    await indexRepo({ store, rootPath: secondProvider, mode: "incremental" });
    const report = await indexRepo({ store, rootPath: ambiguousDeclaration, mode: "incremental" });

    assert.equal(report.errors, 0, "declaration ambiguity is unresolved evidence, not an index failure");
    assert.deepEqual(
      store.db.prepare(
        "SELECT identity_key AS identityKey FROM nodes WHERE node_type='endpoint' ORDER BY identity_key",
      ).all(),
      [
        { identityKey: "grpc::acme.inventory.v1.Inventory.getthing" },
        { identityKey: "grpc::other.inventory.v1.Inventory.getthing" },
      ],
      "a package-less declaration must not invent or choose a canonical package",
    );
    assert.deepEqual(
      store.db.prepare(
        `SELECT callee,receiver,specifier,reason
           FROM external_calls
          WHERE repo_id=? AND reason='ambiguous-grpc-declaration'`,
      ).all(report.repoId),
      [{
        callee: "GetThing",
        receiver: "Inventory",
        specifier: "grpc::Inventory.getthing",
        reason: "ambiguous-grpc-declaration",
      }],
      "the skipped declaration remains diagnosable",
    );
    const unresolved = store.db.prepare(
      `SELECT raw_target AS discoveryKey,reason_code AS reasonCode,start_line AS startLine,reason
         FROM unresolved_reference_items
        WHERE repo_id=? AND revision_id=? AND reason_code='ambiguous-grpc-declaration'`,
    ).get(report.repoId, report.revisionTruth.snapshotId);
    assert.equal(unresolved.discoveryKey, "grpc::Inventory.getthing");
    assert.equal(unresolved.reasonCode, "ambiguous-grpc-declaration");
    assert.equal(unresolved.startLine, 2);
    assert.equal(JSON.parse(unresolved.reason).candidateEndpointIds.length, 2);
    const coverage = store.db.prepare(
      "SELECT unresolved_references AS unresolvedReferences FROM coverage_records WHERE repo_id=? AND file_path='proto/inventory.proto'",
    ).get(report.repoId);
    assert.ok(coverage.unresolvedReferences >= 1, "coverage exposes the unresolved declaration identity");

    const repeated = await indexRepo({ store, rootPath: ambiguousDeclaration, mode: "rebuild" });
    assert.equal(repeated.errors, 0);
    const repeatedCoverage = store.db.prepare(
      "SELECT unresolved_references AS unresolvedReferences FROM coverage_records WHERE repo_id=? AND file_path='proto/inventory.proto'",
    ).get(report.repoId);
    assert.equal(
      repeatedCoverage.unresolvedReferences,
      coverage.unresolvedReferences,
      "rebuilding the same ambiguous declaration must not accumulate coverage debt",
    );
  } finally {
    store.close();
  }
});
