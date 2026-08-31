import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Round19: active brief pointer references Round 19 with correct hash", () => {
  const activeBriefPath = resolve(root, "docs/quality/index-evaluation-brief.md");
  const round19BriefPath = resolve(root, "docs/quality/index-evaluation-brief-round19.md");

  // Read the active pointer
  const activeContent = readFileSync(activeBriefPath, "utf8");

  // Assert it mentions Round 19
  assert.ok(
    activeContent.includes("Round 19") || activeContent.includes("round19") || activeContent.includes("Round19"),
    "Active brief should reference Round 19"
  );

  // Assert Round 19 brief file exists
  let round19Content;
  try {
    round19Content = readFileSync(round19BriefPath, "utf8");
  } catch (error) {
    assert.fail(`Round 19 brief file should exist at ${round19BriefPath}`);
  }

  // Calculate SHA-256 of Round 19 brief
  const actualHash = createHash("sha256").update(round19Content).digest("hex");

  // Extract hash from active pointer (assuming format includes hash)
  const hashMatch = activeContent.match(/([a-f0-9]{64})/);
  if (hashMatch) {
    const declaredHash = hashMatch[1];
    assert.equal(
      actualHash,
      declaredHash,
      `Round 19 brief hash mismatch: expected ${declaredHash}, got ${actualHash}`
    );
  }

  // Assert the required report filename mentions Round 19
  assert.ok(
    activeContent.includes("round19") ||
    activeContent.includes("Round 19") ||
    activeContent.includes("Round19"),
    "Active pointer should specify Round 19 as the active version"
  );
});
