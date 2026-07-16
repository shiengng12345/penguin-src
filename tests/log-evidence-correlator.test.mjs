import { test } from "node:test";
import assert from "node:assert/strict";
import { correlateInvestigationEvidence } from "../packages/mcp/dist/log-evidence-correlator.js";
import { INITIAL_SLS_TARGETS } from "../packages/mcp/dist/sls-target-registry.js";

const target = INITIAL_SLS_TARGETS.find((item) => item.targetId === "fpms-uat");
const raw = { _time_: "2026-07-01T08:00:00+08:00", trace_id: "trace-1", span_id: "span-1", msg: "Turnstile rejected", content: null };

test("normalizes SLS rows with target provenance and keeps gaps/no-overclaim explicit", async () => {
  const result = {
    status: "success", sessionId: "s1", request: { question: "why", timeRange: {}, clues: {} },
    targets: [{ target, queryStatus: "success", startedAt: "", completedAt: "", completedStepIds: [], pendingStepIds: [], attempts: 1, rows: [raw, raw], truncated: false, warnings: [] }], warnings: [],
  };
  const packet = await correlateInvestigationEvidence(result, {
    collectedAt: "2026-07-01T00:00:00Z", facts: [{ factId: "kf1", source: "knowledge", statement: "Verify route exists", targetIds: [target.targetId], evidenceIds: ["ke1"] }], gaps: [{ gapId: "kg1", code: "no_static_edge", message: "DI edge not static", targetIds: [target.targetId], evidenceIds: [] }], targetHints: [], evidence: [{ evidenceId: "ke1", source: "knowledge", locator: "node:verify" }],
  }, {});
  assert.equal(packet.targetPackets[0].slsFacts[0].provenance.targetId, "fpms-uat");
  assert.equal(packet.targetPackets[0].slsFacts[0].provenance.timezone, "Asia/Kuala_Lumpur");
  assert.equal(packet.targetPackets[0].slsFacts[0].traceId, raw.trace_id);
  assert.equal(packet.targetPackets[0].observations.length, 1);
  assert.ok(packet.targetPackets[0].codeFacts.every((fact) => fact.evidenceIds.length > 0));
  assert.ok(packet.targetPackets[0].slsFacts.every((fact) => fact.evidenceIds.length > 0));
  assert.ok(packet.targetPackets[0].gaps.some((gap) => gap.code === "no_static_edge") === true);
  assert.ok(!packet.targetPackets[0].slsFacts.some((fact) => /backend did not receive/i.test(fact.statement)));
});

test("empty successful target is no_match evidence, not proof of absence", async () => {
  const result = { status: "no_match", sessionId: "s2", request: { question: "x" }, targets: [{ target, queryStatus: "no_match", startedAt: "", completedAt: "", completedStepIds: [], pendingStepIds: [], attempts: 1, rows: [], truncated: false, warnings: [] }], warnings: [] };
  const packet = await correlateInvestigationEvidence(result, { collectedAt: "", facts: [], gaps: [], targetHints: [], evidence: [] }, {});
  assert.ok(packet.gaps.some((gap) => gap.code === "no_matching_rows"));
  assert.ok(!packet.slsFacts.some((fact) => /did not happen|never received/i.test(fact.statement)));
});

test("correlation preserves the exact runtime revision returned by the injected resolver", async () => {
  const result = {
    status: "success", sessionId: "s3", request: { question: "which revision", timeRange: {}, clues: {} },
    targets: [{ target, queryStatus: "success", startedAt: "", completedAt: "", completedStepIds: [], pendingStepIds: [], attempts: 1, rows: [raw], truncated: false, warnings: [] }], warnings: [],
  };
  const packet = await correlateInvestigationEvidence(result, { collectedAt: "", facts: [], gaps: [], targetHints: [], evidence: [] }, {
    codeVersionResolver: { resolve: async () => [{ repoId: "repo-fpms", repo: "fpms", branch: "main", commitSha: "abc123", snapshotId: "snapshot-1", trust: "exact_commit", evidenceId: "revision_1" }] },
  });
  const revisionFact = packet.targetPackets[0].codeFacts.find((fact) => fact.claimId === "revision_1");
  assert.ok(revisionFact);
  assert.deepEqual(packet.targetPackets[0].evidence.find((item) => item.evidenceId === "revision_1"), {
    evidenceId: "revision_1", source: "knowledge", targetId: target.targetId, repoId: "repo-fpms", repo: "fpms", branch: "main", commitSha: "abc123", snapshotId: "snapshot-1", trust: "exact_commit",
  });
});
