import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const frozenPath = resolve(root, "docs/quality/index-evaluation-brief-round27-frozen.md");
const activePath = resolve(root, "docs/quality/index-evaluation-brief.md");
const expectedRubricHash = "91014055cdb03d3a8f78f4dbeabb9711e2f2b4fff0d0715f01fda41048f1e8a8";

function extractRubric(document) {
  const match = document.match(
    /<!-- BEGIN ROUND27 IMMUTABLE RUBRIC -->\n([\s\S]*?)\n<!-- END ROUND27 IMMUTABLE RUBRIC -->/,
  );
  assert.ok(match, "Round 27 immutable rubric markers must be present");
  return match[1].replace(/\r\n/g, "\n");
}

function embeddedHash(document) {
  const match = document.match(/Rubric contract hash \(SHA-256\): `([a-f0-9]{64})`/);
  assert.ok(match, "Round 27 must embed a SHA-256 rubric hash");
  return match[1];
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("Round 27 active and frozen briefs carry the exact immutable rubric hash", () => {
  const frozen = readFileSync(frozenPath, "utf8");
  const active = readFileSync(activePath, "utf8");
  const frozenRubric = extractRubric(frozen);
  const activeRubric = extractRubric(active);

  assert.equal(activeRubric, frozenRubric);
  assert.equal(sha256(frozenRubric), expectedRubricHash);
  assert.equal(embeddedHash(frozen), expectedRubricHash);
  assert.equal(embeddedHash(active), expectedRubricHash);
});

test("Round 27 freezes question IDs, edge gates, weights, hard gates, and report fields", () => {
  const brief = readFileSync(frozenPath, "utf8");
  const rubric = extractRubric(brief);

  assert.deepEqual(
    [...rubric.matchAll(/^### Q(\d+) —/gm)].map((match) => Number(match[1])),
    Array.from({ length: 20 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    [...rubric.matchAll(/^### B(\d+) —/gm)].map((match) => Number(match[1])),
    Array.from({ length: 8 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    [...rubric.matchAll(/^- E(\d+):/gm)].map((match) => Number(match[1])),
    Array.from({ length: 19 }, (_, index) => index + 1),
  );

  const weights = [...rubric.matchAll(/^- ([^:\n]+): (\d+)$/gm)].map((match) => [
    match[1],
    Number(match[2]),
  ]);
  assert.deepEqual(weights, [
    ["Runtime identity, installed MCP parity, and reliability", 10],
    ["Discoverability, schemas, annotations, onboarding, remediation", 14],
    ["Exact/lexical/graph/context/flow usefulness and latency", 20],
    ["Semantic readiness, identity, hybrid honesty, lifecycle", 16],
    ["Stable identities, pagination, cursor correctness, affected parity", 20],
    ["File reconciliation, coverage debt, cache hygiene, negative-proof honesty", 15],
    ["Compactness and handoff usability", 5],
  ]);
  assert.equal(weights.reduce((total, [, weight]) => total + weight, 0), 100);

  for (const required of [
    "MCP is unavailable or unloaded in the fresh OS process",
    "any of the four Q4 calls exceeds the 30-second hard budget",
    "Graph/Lexical blocks on semantic work",
    "the evaluator uses source, DB, Git, terminal, CLI, old-report, or another-index fallback",
    "rubric contract hash",
    "Q1–Q20 and B1–B8 separately",
    "every required scenario and E1–E19",
    "category scores and total 1–100",
    "final `GO`, `CONDITIONAL GO`, or `NO-GO`",
  ]) {
    assert.match(rubric, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  }
});

test("Round 27 remains fresh-process MCP-only and forbids previous-report fallback", () => {
  const brief = readFileSync(frozenPath, "utf8");

  assert.match(brief, /Penguin MCP as the only product and data path/i);
  assert.match(brief, /must not read any previous evaluation report/i);
  assert.match(brief, /must score every required scenario/i);
  assert.match(brief, /Both independent reports must record the exact embedded rubric contract hash/i);
  assert.match(brief, /index-evaluation-codex-round27\.md/);
  assert.match(brief, /index-evaluation-claude-opus-5-round27\.md/);
});
