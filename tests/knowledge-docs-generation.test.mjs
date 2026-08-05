import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { readFileSync } from "node:fs";

test("canonical knowledge docs have no generated drift", () => {
  const output = execFileSync(process.execPath, ["scripts/knowledge-docs-generate.mjs", "--check"], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.drift.length, 0);
  assert.match(report.capabilityHash, /^[a-f0-9]{64}$/);
});

test("schema reference is generated from migration metadata", () => {
  const source = readFileSync("docs/knowledge-v2/schema-reference.md", "utf8");
  assert.match(source, /Current schema version:\*\*\s*14/);
  assert.match(source, /source-snapshots/);
  assert.match(source, /semantic_chunks/);
  assert.doesNotMatch(source, /TODO|placeholder/i);
});

test("canonical CLI and MCP example output matches an executed snapshot", () => {
  const output = execFileSync(process.execPath, ["scripts/knowledge-example-snapshot.mjs"], { encoding: "utf8" });
  const report = JSON.parse(output);
  assert.equal(report.ok, true);
  assert.match(report.snapshot, /tests\/snapshots\/knowledge-capabilities\.json$/);
});
