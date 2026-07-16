import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateInvestigationRequest,
  selectInvestigationTargets,
  aggregateInvestigationStatus,
  FileInvestigationStateStore,
  DEFAULT_INVESTIGATION_BUDGETS,
} from "../packages/mcp/dist/log-investigation-contract.js";
import { INITIAL_SLS_TARGETS } from "../packages/mcp/dist/sls-target-registry.js";

const base = {
  question: "why did free spin verification fail",
  scope: "auto",
  timeRange: { from: "2026-07-01T00:00:00Z", to: "2026-07-01T01:00:00Z", timezone: "UTC" },
  clues: { traceIds: ["trace-1"] },
};

test("validates investigation questions, time range, clues, scope and defaults", () => {
  assert.throws(() => validateInvestigationRequest({ ...base, question: "" }), /question/i);
  assert.throws(() => validateInvestigationRequest({ ...base, clues: {} }), /clue/i);
  assert.throws(() => validateInvestigationRequest({ ...base, scope: "targets", targetIds: [] }), /target/i);
  assert.equal(validateInvestigationRequest(base).budgets.maxTargets, DEFAULT_INVESTIGATION_BUDGETS.maxTargets);
  assert.equal(selectInvestigationTargets(validateInvestigationRequest({ ...base, scope: "all" }), INITIAL_SLS_TARGETS).some((target) => target.environment === "prod"), true);
  assert.equal(selectInvestigationTargets(validateInvestigationRequest({ ...base, scope: "auto", slsUrls: ["https://sls.console.alibabacloud.com/lognext/project/platform-prod-aliyun-logs/logsearch/platform-fpms-prod?slsRegion=ap-southeast-1"] }), INITIAL_SLS_TARGETS)[0].targetId, "fpms-prod");
  assert.equal(aggregateInvestigationStatus(["success", "timeout"]), "partial");
  assert.equal(aggregateInvestigationStatus(["no_match", "no_match"]), "no_match");
});

test("file continuation state is hashed, bounded and does not echo raw rows", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-investigation-state-"));
  const store = new FileInvestigationStateStore(root, { ttlMs: 60_000, maxBytes: 1024 * 1024 });
  const state = {
    version: 1,
    request: validateInvestigationRequest(base),
    targets: [{ target: INITIAL_SLS_TARGETS[0], rows: [{ secret: "raw-row" }], completedStepIds: [], pendingStepIds: ["step-1"], attempts: 1, truncated: false, warnings: [] }],
    knowledgeEvidenceIds: [],
    startedAt: new Date().toISOString(),
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const continuation = store.create(state);
  assert.equal(continuation.pendingStepIds[0], "step-1");
  assert.equal(JSON.stringify(continuation).includes("raw-row"), false);
  const loaded = store.load(continuation);
  assert.equal(loaded.targets[0].rows[0].secret, "raw-row");
  const file = join(root, readdirSync(root)[0]);
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw.replace("raw-row", "tampered"));
  assert.throws(() => store.load(continuation), /hash|integrity/i);
});
