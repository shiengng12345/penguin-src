import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { canonicalInputSchema } from "../packages/knowledge-contracts/dist/index.js";

test("CLI and MCP canonical surfaces expose the complete manifest", () => {
  const result = spawnSync(process.execPath, ["scripts/knowledge-surface-parity.mjs", "--gate"], { encoding: "utf8" });
  const report = JSON.parse(result.stdout);
  assert.equal(report.capabilityCount, 101);
  assert.equal(report.missingCli.length, 0);
  assert.equal(report.missingMcp.length, 0);
  assert.equal(result.status, 0);
  assert.equal(report.cliUnimplemented.length, 0);
  assert.equal(report.mcpUnimplemented.length, 0);
  assert.equal(report.mismatchCount, 0);
});

test("endpoint surface advertises every unified inventory selector", () => {
  const schema = canonicalInputSchema("knowledge.endpoints");
  assert.ok(schema);
  assert.deepEqual(
    Object.keys(schema.properties).sort(),
    [
    "branch", "commit_sha", "compact", "cursor", "handled_only", "limit", "method", "provenance_kind",
      "path", "protocol", "repo", "service", "snapshot_id",
    ].sort(),
  );
});
