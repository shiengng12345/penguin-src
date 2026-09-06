import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import * as core from "../packages/knowledge-core/dist/index.js";

test("semantic control replay retries a failed wake without repeating mutation or audit", async () => {
  assert.equal(typeof core.executeSemanticControl, "function");
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-orchestration-"));
  const store = core.KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const space = core.createEmbeddingSpace(store, {
    providerId: "fixture",
    modelId: "orchestration",
    weightsDigest: "a".repeat(64),
    tokenizerDigest: "b".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "v1",
  });
  new core.EmbeddingLifecycle(store).createGeneration({
    spaceId: space.id,
    snapshotId: "snapshot",
    scopeKey: "repo:orchestration",
    expectedChunks: 1,
  });

  let wakes = 0;
  const request = {
    action: "resume",
    scopeKey: "repo:orchestration",
    operationToken: "orchestration-operation",
  };
  const options = {
    store,
    request,
    runtimeState: { restartRequired: false },
    wake: async () => {
      wakes += 1;
      if (wakes === 1) throw new Error("simulated wake failure after commit");
      return { status: "started", pid: 123, reason: null, logPath: "/tmp/semantic.log" };
    },
  };

  await assert.rejects(core.executeSemanticControl(options), /simulated wake failure/);
  const recovered = await core.executeSemanticControl(options);
  assert.equal(recovered.operationToken, request.operationToken);
  assert.equal(recovered.worker.status, "started");
  assert.equal(wakes, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM semantic_controls").get().count, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit_events WHERE capability_id='knowledge.semantic_control'").get().count, 1);
  store.close();
});

test("semantic control fails before consuming its token when the scope has no generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "penguin-semantic-no-generation-"));
  const store = core.KnowledgeStore.open({
    dbPath: join(directory, "knowledge.db"),
    ledgerPath: join(directory, "ledger.jsonl"),
  });
  const repoId = store.registerRepo({ name: "empty-semantic", rootPath: directory });
  const request = {
    action: "pause",
    scopeKey: `repo:${repoId}`,
    operationToken: "no-generation-operation",
  };
  const options = { store, request, runtimeState: { restartRequired: false } };

  await assert.rejects(core.executeSemanticControl(options), (error) => error.code === "SEMANTIC_STATUS_NOT_FOUND");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM semantic_controls").get().count, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM knowledge_audit_events WHERE capability_id='knowledge.semantic_control'").get().count, 0);

  const space = core.createEmbeddingSpace(store, {
    providerId: "fixture",
    modelId: "after-rejection",
    weightsDigest: "c".repeat(64),
    tokenizerDigest: "d".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "v1",
  });
  new core.EmbeddingLifecycle(store).createGeneration({
    spaceId: space.id,
    snapshotId: "snapshot",
    scopeKey: request.scopeKey,
    expectedChunks: 1,
  });
  const accepted = await core.executeSemanticControl(options);
  assert.equal(accepted.operationToken, request.operationToken, "the rejected attempt must not consume the token");
  store.close();
});
