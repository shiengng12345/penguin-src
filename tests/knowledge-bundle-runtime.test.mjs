import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { test } from "node:test";

test("self-contained CLI and MCP bundles include the RE2 WASM runtime", () => {
  const cliRoot = "packages/knowledge-cli/bundle";
  const mcpRoot = "packages/mcp/bundle";
  assert.equal(existsSync(`${cliRoot}/node`), true);
  assert.equal(existsSync(`${cliRoot}/node_modules/re2-wasm/package.json`), true);
  assert.equal(existsSync(`${mcpRoot}/node_modules/re2-wasm/package.json`), true);
  const probe = spawnSync(resolve(cliRoot, "node"), ["-e", "const {RE2}=require('re2-wasm'); if (!new RE2('needle','u').test('needle')) process.exit(2)"], {
    cwd: resolve(cliRoot),
    encoding: "utf8",
  });
  assert.equal(probe.status, 0, probe.stderr);
});
