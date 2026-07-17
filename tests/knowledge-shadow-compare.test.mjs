import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("shadow compare emits a reproducible gap for an external-only correct answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "penguin-shadow-"));
  try {
    const penguin = join(dir, "penguin.jsonl");
    const external = join(dir, "external.jsonl");
    writeFileSync(penguin, `${JSON.stringify({ id: "shared", locators: ["a"] })}\n`);
    writeFileSync(external, [
      { id: "shared", locators: ["a"] },
      { id: "external-only", locators: ["src/auth.ts:42"] },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n");

    const result = spawnSync(process.execPath, ["scripts/knowledge-shadow-compare.mjs", penguin, external], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.externalOnlyCorrect, 1);
    assert.deepEqual(report.gaps, [{
      code: "external_only_correct",
      id: "external-only",
      reproduction: "replay shadow case external-only with the frozen corpus and compare normalized locators",
    }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
