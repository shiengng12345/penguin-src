import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const briefPath = resolve(root, "docs/quality/index-evaluation-brief-round23.md");
const pointerPath = resolve(root, "docs/quality/index-evaluation-brief.md");
const expectedDigest = "a187747c6f010687573fc0e085048e99a2fa49b6afa13e739c94baebc8122bfe";

test("Round 23 remains immutable after newer active fresh-session briefs", () => {
  const brief = readFileSync(briefPath, "utf8");
  const pointer = readFileSync(pointerPath, "utf8");
  const digest = createHash("sha256").update(brief).digest("hex");

  assert.equal(digest, expectedDigest);
  const activeRound = Number(pointer.match(/Round (\d+)/)?.[1] ?? 0);
  assert.ok(activeRound >= 23, `expected active round >= 23, got ${activeRound}`);
  assert.match(pointer, new RegExp(`index-evaluation-brief-round${activeRound}(?:-frozen)?\\.md`));
  assert.match(pointer, /## Required scenarios Q1–Q20/);
});

test("Round 23 covers the complete MCP-only closure surface without fixed identities", () => {
  const brief = readFileSync(briefPath, "utf8");
  for (const text of [
    "Q1 — Fresh-process identity chain",
    "Q5 — Paraphrased semantic consistency",
    "Q8 — Stable node round-trip",
    "Q9 — Endpoint inventory pagination",
    "Q11 — Affected file/node parity",
    "Q13 — Coverage debt actionability",
    "Q15 — Semantic lifecycle integrity",
    "Q17 — Three-family continuation handoff",
    "Q18 — Typed negative matrix",
    "Q19 — Compactness and duplication",
    "Q20 — New-user onboarding",
    "Owner-only Tauri evidence lane",
    "one from a genuinely fresh Claude Code session",
    "one from a genuinely fresh Codex session",
  ]) assert.match(brief, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(brief, /Graph and lexical search must remain useful/);
  assert.match(brief, /Each report must score 95–100/);
  assert.doesNotMatch(brief, /repo_[a-f0-9-]{8,}/i);
  assert.doesNotMatch(brief, /node_[a-f0-9-]{8,}/i);
});
