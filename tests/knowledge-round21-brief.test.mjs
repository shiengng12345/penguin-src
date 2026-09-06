import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const root = resolve(import.meta.dirname, "..");
const briefPath = resolve(root, "docs/quality/index-evaluation-brief-round21.md");
const pointerPath = resolve(root, "docs/quality/index-evaluation-brief.md");

test("Round 21 remains immutable while the active full copy names the newest fresh-session brief", () => {
  const brief = readFileSync(briefPath, "utf8");
  const pointer = readFileSync(pointerPath, "utf8");
  const digest = createHash("sha256").update(brief).digest("hex");

  assert.equal(digest, "504423504a8c21a8641f8ee2a944141f6903104ff6adeb3d562b9e0bac2b480c");

  const roundMatch = pointer.match(/Round (\d+)/);
  const briefMatch = pointer.match(/docs\/quality\/index-evaluation-brief-round(\d+)(-frozen)?\.md/);
  assert.ok(roundMatch, "active brief must declare a round");
  assert.ok(briefMatch, "active brief must declare its immutable source path");

  const activeRound = Number(roundMatch[1]);
  assert.ok(activeRound >= 21, `expected active round >= 21, got ${activeRound}`);
  assert.equal(Number(briefMatch[1]), activeRound);
  const activeBrief = readFileSync(resolve(root, `docs/quality/index-evaluation-brief-round${activeRound}${briefMatch[2] ?? ""}.md`), "utf8");
  assert.match(activeBrief, new RegExp(`Round ${activeRound}`));
  assert.match(pointer, /## Required scenarios Q1–Q20/);
  assert.match(pointer, /Q20/);
});

test("Round 21 covers every fire-and-forget closure scenario without a fixed answer key", () => {
  const brief = readFileSync(briefPath, "utf8");
  for (const heading of [
    "Q3 — Graph-first availability",
    "Q4 — Semantic lifecycle truth",
    "Q6 — Semantic recall with code-language variation",
    "Q7 — Semantic unavailable honesty",
    "Q8 — Endpoint page and stable identity",
    "Q9 — Endpoint-to-boundary flow",
    "Q11 — Affected path/node parity",
    "Q12 — Coverage debt is actionable",
    "Q14 — Background progress does not block engineering",
    "Q15 — MCP-only worker wake",
    "Q16 — Restart and stale-session recovery",
    "Q20 — Installed/configured/loaded/useful and provenance boundary",
    "Owner-only Tauri checks — separate evidence lane",
  ]) assert.match(brief, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  assert.match(brief, /Graph must be the default tab and Focus must be absent/);
  assert.match(brief, /click Pause once/);
  assert.match(brief, /Click Resume once/);
  assert.match(brief, /one fresh Claude Code report and one fresh Codex report/);
  assert.match(brief, /no fixed answer key/i);
  assert.doesNotMatch(brief, /repo_[a-f0-9-]{8,}/i);
  assert.doesNotMatch(brief, /node_[a-f0-9-]{8,}/i);
});

test("Round 21 keeps owner UI evidence separate from MCP-only scoring", () => {
  const brief = readFileSync(briefPath, "utf8");
  assert.match(brief, /owner-observed Tauri actions only in Section 7/);
  assert.match(brief, /do not add MCP-only points/);
  assert.match(brief, /the evaluator itself remains MCP-only/i);
  assert.match(brief, /Source\/DB\/Git\/CLI\/old-report fallback or evaluator mutation/);
});
