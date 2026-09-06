import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const immutablePath = resolve(root, "docs/quality/index-evaluation-brief-round26.md");
const activePath = resolve(root, "docs/quality/index-evaluation-brief.md");

test("Round 26 remains an immutable complete historical brief", () => {
  const immutable = readFileSync(immutablePath, "utf8");

  assert.match(immutable, /Round 26/);
  assert.match(immutable, /## Required scenarios Q1–Q20/);
  assert.match(immutable, /## Bonus scenarios B1–B8/);
  for (let number = 1; number <= 20; number += 1) {
    assert.match(immutable, new RegExp(`### Q${number} —`));
  }
  for (let number = 1; number <= 8; number += 1) {
    assert.match(immutable, new RegExp(`### B${number} —`));
  }
});

test("the active evaluation brief advances beyond historical Round 26", () => {
  const active = readFileSync(activePath, "utf8");

  assert.match(active, /Round 27 \(Active Full Copy\)/);
  assert.match(active, /Canonical immutable copy: `docs\/quality\/index-evaluation-brief-round27-frozen\.md`/);
  assert.doesNotMatch(active, /Round 26 \(Active Full Copy\)/);
});

test("Round 26 directly retests every Round 25 closure defect without mutating owner state", () => {
  const brief = readFileSync(immutablePath, "utf8");

  for (const required of [
    "same 4–6 word query",
    "Largest Repo",
    "Second Repo",
    "30-second hard budget",
    "source-only",
    "mutation_preflight",
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
    "MUTATION_PREFLIGHT_INVALID",
    "ROOT_PATH_OUT_OF_SCOPE",
    "wrong-family",
    "tampered",
    "remediation",
    "95–100",
  ]) assert.match(brief, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));

  assert.match(brief, /NEVER call `knowledge_repository_register`, `knowledge_index`, or `knowledge_rebuild`/);
  assert.match(brief, /docs\/quality\/index-evaluation-codex-round26\.md/);
  assert.match(brief, /docs\/quality\/index-evaluation-claude-opus-5-round26\.md/);
  assert.doesNotMatch(brief, /repo_[a-f0-9-]{8,}/i);
  assert.doesNotMatch(brief, /node_[a-f0-9-]{8,}/i);
});

test("Round 26 remains MCP-only and keeps owner Tauri evidence separate", () => {
  const brief = readFileSync(immutablePath, "utf8");

  assert.match(brief, /Penguin MCP as the only product and data path/i);
  assert.match(brief, /Do not inspect source, Git, SQLite, plans, bundles, terminal output, old reports, or Penguin CLI/i);
  assert.match(brief, /Owner-only Tauri evidence.*not MCP-scored/is);
  assert.match(brief, /Both independent reports must score 95–100/);
});
