import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  DomainScopeError,
  KnowledgeStore,
  buildDomainClaims,
  buildDomainFlow,
} from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";

function file(root, path, content) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function fixture(prefix, packageName) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  file(root, "proto/domain.proto", `syntax = \"proto3\"; package ${packageName}; message Req {} message Res {} service DomainService { rpc Ping (Req) returns (Res); }\n`);
  file(root, "src/domain.ts", "export class DomainService { ping() { return true; } }\n");
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-domain-scope-"));
  return {
    dir,
    store: KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }),
  };
}

test("domain claims and flow remain inside the selected repo and snapshot envelope", async () => {
  const { store } = open();
  const one = fixture("penguin-domain-one-", "one");
  const two = fixture("penguin-domain-two-", "two");
  try {
    const first = await indexRepo({ store, rootPath: one, mode: "incremental" });
    const second = await indexRepo({ store, rootPath: two, mode: "incremental" });
    const claims = buildDomainClaims(store, {
      repoId: first.repoId,
      snapshotId: first.revisionTruth.snapshotId,
      limit: 50,
    });
    assert.ok(claims.length > 0);
    assert.ok(claims.every((claim) => claim.repoId === first.repoId));
    assert.ok(claims.every((claim) => claim.snapshotId === first.revisionTruth.snapshotId));
    assert.equal(claims.some((claim) => claim.repoId === second.repoId), false);

    const targetNodeId = claims.find((claim) => claim.kind === "entry_point")?.evidence[0]?.nodeId;
    assert.ok(targetNodeId, "fixture should expose a scoped endpoint node");
    const flow = buildDomainFlow(store, {
      repoId: first.repoId,
      snapshotId: first.revisionTruth.snapshotId,
      targetNodeId,
      maxDepth: 2,
      limit: 20,
    });
    assert.ok(flow.every((step) => step.repoId === first.repoId));
    assert.ok(flow.every((step) => step.snapshotId === first.revisionTruth.snapshotId));

    const crossTargetClaims = buildDomainClaims(store, {
      repoId: second.repoId,
      snapshotId: second.revisionTruth.snapshotId,
      targetNodeId,
    });
    assert.equal(crossTargetClaims.length, 1);
    assert.equal(crossTargetClaims[0].status, "insufficient");
    assert.match(crossTargetClaims[0].gaps[0], /selected repo\/revision envelope/);
  } finally {
    store.close();
  }
});

test("an unknown explicit domain revision fails closed instead of falling back", () => {
  const { store } = open();
  try {
    assert.throws(
      () => buildDomainClaims(store, { repoId: "missing-repo", snapshotId: "missing-snapshot" }),
      (error) => error instanceof DomainScopeError && error.code === "DOMAIN_SCOPE_NOT_FOUND",
    );
  } finally {
    store.close();
  }
});
