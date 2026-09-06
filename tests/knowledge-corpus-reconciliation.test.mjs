import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  KnowledgeStore,
  reconcileCorpus,
} from "../packages/knowledge-core/dist/index.js";
import { collectIndependentCorpusOracle, runFullCorpus } from "../packages/knowledge-indexer/dist/index.js";

function gitCommit(root) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.test",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.test",
  };
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "penguin-reconcile-"));
  const projects = join(directory, "Projects");
  mkdirSync(projects);
  const repoRoot = join(projects, "auth");
  mkdirSync(repoRoot);
  writeFileSync(join(repoRoot, "version.controller.ts"), `
    import { Controller } from "@nestjs/common";
    import { GrpcMethod } from "@nestjs/microservices";
    @Controller()
    export class VersionController {
      @GrpcMethod("VersionService", "Version")
      version(): string { return "1.0.0"; }
    }
  `);
  gitCommit(repoRoot);
  const store = KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  return { directory, projects, repoRoot: realpathSync.native(repoRoot), store };
}

test("[corpus-reconciliation] reconciliation proves source, parser, persisted and transport counts share one scope", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    assert.equal(run.failures.length, 0, JSON.stringify(run.failures));
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const source = {
      rootPath: f.repoRoot,
      discoveredFiles: 1,
      admittedFiles: 1,
      excludedFiles: 0,
      failedFiles: 0,
      staleFiles: 0,
      parserEligibleFiles: 1,
      endpointKeys: ["gRPC VersionService.Version"],
      endpointOccurrences: 1,
    };
    const transport = {
      counts: { files: 1, endpoints: 1, coverage: 1 },
      endpointKeys: ["gRPC VersionService.Version"],
      status: "completed",
    };
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source,
      parser: { counts: { files: 1, endpoints: 1, coverage: 1 }, endpointKeys: source.endpointKeys },
      cli: transport,
      mcp: transport,
      tauri: transport,
    });
    assert.equal(result.status, "passed", JSON.stringify(result.gaps));
    assert.deepEqual(result.gaps, []);
    assert.equal(result.identity.readySnapshot, true);
    assert.equal(result.layers.files.matched, true);
    assert.equal(result.layers.endpoints.matched, true);
    assert.deepEqual(result.endpoints.missingFromPersisted, []);
    assert.deepEqual(result.endpoints.unexpectedInPersisted, []);
  } finally {
    f.store.close();
  }
});

test("reconciliation fails closed on endpoint loss and count drift instead of accepting a false green", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: { admittedFiles: 1, endpointKeys: ["gRPC VersionService.Version"] },
      parser: { counts: { endpoints: 2 }, endpointKeys: ["gRPC VersionService.Version", "gRPC VersionService.Missing"] },
      cli: { counts: { endpoints: 0 }, endpointKeys: [] },
    });
    assert.equal(result.status, "failed");
    assert.ok(result.gaps.some((gap) => gap.includes("endpoints")), JSON.stringify(result.gaps));
    assert.deepEqual(result.endpoints.missingFromPersisted, []);
    assert.deepEqual(result.endpoints.unexpectedInPersisted, []);
    assert.ok(result.endpoints.differences.includes("parser_endpoint_set_diff"));
    assert.ok(result.endpoints.differences.includes("cli_endpoint_set_diff"));
    assert.ok(result.layers.endpoints.differences.length > 0);
  } finally {
    f.store.close();
  }
});

test("independent oracle canonicalizes an unqualified gRPC provider against its local proto package", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-reconcile-proto-"));
  const repoRoot = join(directory, "auth");
  mkdirSync(repoRoot);
  writeFileSync(join(repoRoot, "version.proto"), `
    syntax = "proto3";
    package auth;
    service VersionService { rpc Version (VersionReq) returns (VersionRes); }
    message VersionReq {}
    message VersionRes {}
  `);
  writeFileSync(join(repoRoot, "version.controller.ts"), `
    import { GrpcMethod } from "@nestjs/microservices";
    export class VersionController {
      @GrpcMethod("VersionService", "Version")
      version(): string { return "1.0.0"; }
    }
  `);
  gitCommit(repoRoot);

  const oracle = await collectIndependentCorpusOracle(repoRoot);
  assert.deepEqual(oracle.source.endpointKeys, ["gRPC auth.VersionService.Version"]);
  assert.equal(oracle.source.endpointOccurrences, 2);
});

test("persisted endpoint truth excludes consumer-only memberships from provider reconciliation", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const externalEndpointId = f.store.upsertNode({
      nodeType: "endpoint",
      identityKey: "grpc::external.RemoteService.Call",
      title: "gRPC external.RemoteService.Call",
      meta: { protocol: "grpc" },
    });
    f.store.replaceEndpointMembershipsForFile({
      repoId: repo.id,
      filePath: "consumer.ts",
      memberships: [{ endpointId: externalEndpointId, role: "consumer" }],
    });
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: {
        admittedFiles: 1,
        endpointKeys: ["gRPC VersionService.Version"],
        endpointOccurrences: 1,
      },
    });
    assert.equal(result.status, "passed", JSON.stringify(result.gaps));
    assert.deepEqual(result.persisted.endpointKeys, ["gRPC VersionService.Version"]);
  } finally {
    f.store.close();
  }
});

test("reconciliation resolves an unqualified source endpoint through an unambiguous persisted alias", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const endpoint = f.store.db.prepare(`
      SELECT n.id
        FROM nodes n
        JOIN endpoint_memberships em ON em.endpoint_id=n.id
       WHERE em.repo_id=? AND em.role='provider'
       LIMIT 1
    `).get(repo.id);
    assert.ok(endpoint);
    f.store.db.prepare("UPDATE nodes SET title=? WHERE id=?").run("gRPC auth.VersionService.Version", endpoint.id);
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: { admittedFiles: 1, endpointKeys: ["gRPC VersionService.Version"], endpointOccurrences: 1 },
    });
    assert.equal(result.status, "passed", JSON.stringify(result.gaps));
    assert.deepEqual(result.endpoints.source, ["gRPC auth.VersionService.Version"]);
    assert.deepEqual(result.endpoints.persisted, ["gRPC auth.VersionService.Version"]);
  } finally {
    f.store.close();
  }
});

test("reconciliation counts canonical endpoint aliases once in the layer gate", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const endpointId = f.store.upsertGrpcEndpoint({
      packageName: "auth",
      service: "VersionService",
      method: "Version",
    });
    const canonicalTitle = f.store.getNode(endpointId).title;
    const alias = "auth.VersionService.Version";
    f.store.db.prepare(
      `INSERT INTO endpoint_aliases(endpoint_id,alias_key,alias_type,created_at)
       VALUES (?,?,?,?) ON CONFLICT(endpoint_id,alias_key) DO NOTHING`,
    ).run(endpointId, alias, "grpc_identity", new Date().toISOString());
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: {
        admittedFiles: 1,
        endpointKeys: [canonicalTitle, alias],
        endpointOccurrences: 2,
      },
    });
    assert.equal(result.layers.endpoints.source, 1);
    assert.equal(result.layers.endpoints.persisted, 1);
    assert.equal(result.layers.endpoints.matched, true);
    assert.equal(result.status, "passed", JSON.stringify(result.gaps));
  } finally {
    f.store.close();
  }
});

test("reconciliation accounts for a revision-scoped named endpoint exclusion without claiming it queryable", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const handler = f.store.db.prepare(
      "SELECT node_id AS nodeId FROM symbol_versions WHERE branch_id=? AND file_path=? AND status='fresh' LIMIT 1",
    ).get(branch.id, "version.controller.ts");
    assert.ok(handler);
    f.store.db.prepare(`
      INSERT INTO unresolved_reference_items
        (id,repo_id,branch_id,revision_id,file_path,start_line,source_node_id,raw_target,reason_code,reason,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      "unresolved-version-missing",
      repo.id,
      branch.id,
      receipt.snapshotId,
      "version.controller.ts",
      4,
      handler.nodeId,
      "grpc::MissingService.missing",
      "ambiguous-grpc-handler",
      JSON.stringify({ candidateEndpointIds: ["endpoint-a", "endpoint-b"] }),
      new Date().toISOString(),
    );
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: {
        admittedFiles: 1,
        endpointKeys: ["gRPC VersionService.Version", "gRPC MissingService.Missing"],
        endpointOccurrences: 2,
      },
    });
    assert.equal(result.status, "passed", JSON.stringify(result.gaps));
    assert.equal(result.layers.endpoints.source, 1);
    assert.equal(result.layers.endpoints.persisted, 1);
    assert.deepEqual(result.endpoints.missingFromPersisted, []);
    assert.deepEqual(result.persisted.endpointExclusions, [{
      discoveryKey: "grpc::MissingService.missing",
      reasonCode: "ambiguous-grpc-handler",
      filePath: "version.controller.ts",
      startLine: 4,
      candidateEndpointIds: ["endpoint-a", "endpoint-b"],
    }]);
  } finally {
    f.store.close();
  }
});

test("reconciliation fails closed when source HEAD is not the branch last indexed commit", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    f.store.db.prepare("UPDATE branches SET last_indexed_commit=NULL WHERE id=?").run(branch.id);
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: {
        admittedFiles: 1,
        endpointKeys: ["gRPC VersionService.Version"],
        gitCommit: receipt.head,
      },
    });
    assert.equal(result.status, "failed");
    assert.ok(result.gaps.includes("revision:last_indexed_commit_vs_source_head"), JSON.stringify(result.gaps));
  } finally {
    f.store.close();
  }
});

test("reconciliation preserves null for unreported transport dimensions and never coerces them to zero", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    // Transport only provides files; all other dimensions are absent
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      cli: { counts: { files: 1 } },
    });
    // layers that were not reported must carry null, not 0 — unknown != zero
    assert.equal(result.layers.symbols.cli, null, "unreported cli.symbols must be null not 0");
    assert.equal(result.layers.edges.cli, null, "unreported cli.edges must be null not 0");
    assert.equal(result.layers.endpoints.cli, null, "unreported cli.endpoints must be null not 0");
    assert.equal(result.layers.coverage.cli, null, "unreported cli.coverage must be null not 0");
    assert.equal(result.layers.semantic.cli, null, "unreported cli.semantic must be null not 0");
    // The reported dimension must carry the actual value
    assert.equal(result.layers.files.cli, 1, "reported cli.files must equal the provided value");
  } finally {
    f.store.close();
  }
});

test("reconciliation proves an exact dirty worktree by commit and fingerprint without claiming a clean commit", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const fingerprint = "dirty-fixture-fingerprint";
    f.store.db.prepare(`
      UPDATE branches
         SET last_indexed_commit=NULL,
             indexed_worktree_state='dirty',
             indexed_worktree_fingerprint=?
       WHERE id=?
    `).run(fingerprint, branch.id);
    f.store.db.prepare(
      "UPDATE revision_snapshots SET worktree_fingerprint=? WHERE id=?",
    ).run(fingerprint, receipt.snapshotId);
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: {
        admittedFiles: 1,
        endpointKeys: ["gRPC VersionService.Version"],
        gitCommit: receipt.head,
        worktreeState: "dirty",
        worktreeFingerprint: fingerprint,
      },
    });
    assert.equal(result.status, "passed", JSON.stringify(result.gaps));
    assert.equal(result.persisted.lastIndexedCommit, null);
    assert.equal(result.persisted.snapshotCommit, receipt.head);
  } finally {
    f.store.close();
  }
});

test("canonical projection shares reconciliation equations and preserves unknown dimensions", async () => {
  const f = fixture();
  try {
    const run = await runFullCorpus({
      store: f.store,
      rootPath: f.projects,
      modes: ["rebuild"],
      semantic: { enabled: false },
    });
    const receipt = run.repositories.rebuild[0];
    const repo = f.store.getRepoByRoot(f.repoRoot);
    assert.ok(repo);
    const branch = f.store.getBranch(repo.id, "main");
    assert.ok(branch);
    const result = reconcileCorpus({
      store: f.store,
      scope: { repoId: repo.id, branchId: branch.id, snapshotId: receipt.snapshotId },
      source: {
        discoveredFiles: 1,
        admittedFiles: 1,
        excludedFiles: 0,
        endpointKeys: ["gRPC VersionService.Version"],
      },
    });
    assert.equal(result.canonical.files.persisted, result.layers.files.persisted);
    assert.equal(result.canonical.files.queryable, result.persisted.counts.files);
    assert.equal(result.canonical.files.delta, 0);
    assert.equal(result.canonical.endpoints.delta, 0);
    assert.match(result.canonical.files.equation, /discovered = queryable \+ excluded \+ delta/);
    assert.equal(result.canonical.symbols.discovered, null);
    assert.equal(result.canonical.symbols.excluded, null);
    assert.equal(result.canonical.symbols.delta, null);
    assert.deepEqual(result.canonical.exclusions.endpoints, []);
  } finally {
    f.store.close();
  }
});
