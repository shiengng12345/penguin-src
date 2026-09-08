import assert from "node:assert/strict";
import { test } from "node:test";
import * as contracts from "../packages/knowledge-contracts/dist/index.js";

const validStatus = {
  state: "embedding",
  scopeKey: "repo:repo-1",
  repoId: "repo-1",
  generationId: "generation-1",
  activeGenerationId: null,
  snapshotId: "snapshot-1",
  modelId: "nomic-embed-text-v1.5",
  modelHash: "model-hash",
  providerId: "penguin-local-onnx",
  weightsDigest: "weights-digest",
  tokenizerDigest: "tokenizer-digest",
  preprocessingDigest: "preprocessing-digest",
  pooling: "mean",
  normalization: "l2",
  dimensions: 768,
  chunkerVersion: "semantic-chunker-v6-precision",
  expected: 100,
  ready: 40,
  running: 10,
  pending: 50,
  retryableFailed: 0,
  terminalFailed: 0,
  progressPercent: 40,
  ratePerSecond: 12.5,
  etaSeconds: 4.8,
  paused: false,
  pauseRequested: false,
  lastHeartbeatAt: "2026-08-31T12:00:00.000Z",
  workerBuildId: "1.16.0-test",
  lease: {
    active: true,
    ownerId: "semantic-worker:123",
    ownerPid: 123,
    expiresAt: "2026-08-31T12:01:00.000Z",
  },
  reason: null,
  restartRequired: false,
};

test("semantic status contract accepts every canonical state", () => {
  assert.equal(typeof contracts.validateSemanticStatus, "function");
  for (const state of [
    "disabled", "chunks_ready", "queued", "embedding", "pausing", "paused",
    "retry_wait", "stalled", "active", "superseded", "cancelled",
  ]) {
    assert.equal(contracts.validateSemanticStatus({ ...validStatus, state }).state, state);
  }
  const parsed = contracts.validateSemanticStatus(validStatus);
  assert.equal(parsed.tokenizerDigest, "tokenizer-digest");
  assert.equal(parsed.weightsDigest, "weights-digest");
});

test("semantic status contract rejects impossible progress", () => {
  assert.throws(() => contracts.validateSemanticStatus({ ...validStatus, ready: -1 }));
  assert.throws(() => contracts.validateSemanticStatus({ ...validStatus, progressPercent: 101 }));
  assert.throws(() => contracts.validateSemanticStatus({ ...validStatus, expected: 10, ready: 11 }));
  assert.throws(() => contracts.validateSemanticStatus({ ...validStatus, unexpected: true }));
});

test("semantic control requires a scope and constrains generation actions", () => {
  assert.equal(typeof contracts.validateSemanticControlRequest, "function");
  assert.deepEqual(
    contracts.validateSemanticControlRequest({ action: "pause", scopeKey: "repo:repo-1", operationToken: "operation-123" }),
    { action: "pause", scopeKey: "repo:repo-1", operationToken: "operation-123" },
  );
  assert.throws(() => contracts.validateSemanticControlRequest({ action: "pause" }));
  assert.throws(() => contracts.validateSemanticControlRequest({ action: "pause", scopeKey: "repo:repo-1" }));
  assert.throws(() => contracts.validateSemanticControlRequest({ action: "pause", scopeKey: "repo:repo-1", operationToken: "short" }));
  assert.throws(() => contracts.validateSemanticControlRequest({ action: "retry", scopeKey: "repo:repo-1", operationToken: "operation-123" }));
  assert.deepEqual(
    contracts.validateSemanticControlRequest({ action: "retry", scopeKey: "repo:repo-1", generationId: "generation-1", operationToken: "operation-123" }),
    { action: "retry", scopeKey: "repo:repo-1", generationId: "generation-1", operationToken: "operation-123" },
  );
  assert.throws(() => contracts.validateSemanticControlRequest({ action: "resume", scopeKey: "repo:repo-1", generationId: "generation-1", operationToken: "operation-123" }));
});

test("semantic status and control outputs use strict canonical validators", () => {
  const result = {
    accepted: true,
    action: "resume",
    scopeKey: validStatus.scopeKey,
    generationId: null,
    operationToken: "operation-123",
    status: validStatus,
    worker: { status: "started", pid: 123, reason: null, logPath: "/tmp/semantic.log" },
  };
  assert.deepEqual(contracts.validateSemanticControlResult(result), result);
  assert.throws(() => contracts.validateSemanticControlResult({
    ...result,
    status: { ...validStatus, scopeKey: "repo:another" },
  }), /scopeKey/i);
  assert.throws(() => contracts.validateSemanticControlResult({
    ...result,
    action: "retry",
    generationId: "generation-1",
    status: { ...validStatus, generationId: "generation-2" },
  }), /generationId/i);
  assert.deepEqual(contracts.validateSemanticStatusResponse({ statuses: [validStatus] }).statuses[0], validStatus);
  assert.throws(() => contracts.validateSemanticControlResult({ garbage: true }), /semantic control result/i);
  assert.throws(() => contracts.validateSemanticStatusResponse({ statuses: [{ ...validStatus, ready: -1 }] }));
  assert.throws(() => contracts.validateCapabilityOutput("knowledge.semantic_control", { garbage: true }));
  assert.throws(() => contracts.validateCapabilityOutput("knowledge.semantic_status", { garbage: true }));
});

test("semantic capabilities are canonical and controls require confirmation", () => {
  const status = contracts.CAPABILITIES.find((capability) => capability.id === "knowledge.semantic_status");
  const control = contracts.CAPABILITIES.find((capability) => capability.id === "knowledge.semantic_control");
  assert.equal(status?.mutating, false);
  assert.equal(status?.confirmation, "not_required");
  // Wiki no longer uses (or requires) the semantic status/control
  // capabilities — they stay declared and callable (per the disclosed
  // exception), just no longer associated with the wiki surface.
  assert.equal(status?.requiredOn.includes("wiki"), false);
  assert.equal(control?.mutating, true);
  assert.equal(control?.confirmation, "required");
  assert.equal(control?.requiredOn.includes("wiki"), false);
  assert.equal(contracts.canonicalInputSchema("knowledge.semantic_status").additionalProperties, false);
  const schema = contracts.canonicalInputSchema("knowledge.semantic_control");
  assert.deepEqual(schema.required, ["action", "scopeKey", "operationToken"]);
  assert.equal(schema.properties.confirmation_token, undefined, "MCP authorization is not part of the shared semantic request");
  assert.equal(schema.properties.operationToken.minLength, 8);
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 2, "generationId action rules must be machine-readable");
  const mcp = contracts.listMcpRegistrations().find((registration) => registration.capabilityId === "knowledge.semantic_control");
  assert.equal(mcp.wireName, "knowledge_semantic_control");
  assert.equal(contracts.listMcpRegistrations().find((registration) => registration.capabilityId === "knowledge.semantic_status").wireName, "knowledge_semantic_status");
});
