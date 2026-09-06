import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

test("Task 10 upgrade harness exists and drives real CLI/MCP processes", () => {
  const path = resolve(root, "scripts/knowledge-install-upgrade-test.mjs");
  assert.ok(existsSync(path), "upgrade harness must exist");
  const source = readFileSync(path, "utf8");
  assert.match(source, /spawn|fork/);
  assert.match(source, /tools\/call/);
  assert.match(source, /knowledge_capabilities/);
  assert.match(source, /OUTDATED_RUNTIME|serverGeneration/);
  assert.match(source, /restart|action/);
  assert.match(source, /nodeId/);
  assert.match(source, /capabilityHash/);
});

test("parity and retest scripts persist raw process evidence", () => {
  for (const name of ["knowledge-mcp-parity-test.mjs", "knowledge-retest-round12.mjs"]) {
    const source = readFileSync(resolve(root, "scripts", name), "utf8");
    assert.match(source, /spawn/);
    assert.match(source, /stdout/);
    assert.match(source, /stderr/);
    assert.match(source, /report/);
  }
});

test("release gates include app-resource identity and conditional signing", () => {
  const bundleGate = readFileSync(resolve(root, "scripts/knowledge-release-bundle-gate.mjs"), "utf8");
  assert.match(bundleGate, /Contents.*Resources|Contents.*MacOS/s);
  assert.match(bundleGate, /embeddedMcp|embeddedCli/);
  assert.match(bundleGate, /capabilityHash/);
  assert.match(bundleGate, /stable-launcher/);

  const signedGate = readFileSync(resolve(root, "scripts/knowledge-signed-release-build.mjs"), "utf8");
  assert.match(signedGate, /TAURI_SIGNING_PRIVATE_KEY/);
  assert.match(signedGate, /\.sig/);
  assert.match(signedGate, /tar\\\.gz|zip/);

  const releaseGate = readFileSync(resolve(root, "scripts/knowledge-release-gate.mjs"), "utf8");
  assert.match(releaseGate, /knowledge-release-bundle-gate/);
  assert.match(releaseGate, /knowledge-signed-release-build/);
});

test("Round17 fixture gate executes the deterministic contract and emits one JSON envelope", () => {
  const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "--fixture", "--gate"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = result.stdout.split("\n").filter((line) => line.trim());
  assert.equal(lines.length, 1, result.stdout);
  const report = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(report), ["passed", "gates", "failures", "buildId", "capabilityHash", "revision"]);
  assert.equal(report.passed, true, JSON.stringify(report));
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.gates.map((gate) => gate.id), ["G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]);
  assert.ok(report.gates.every((gate) => gate.passed === true), JSON.stringify(report));
  assert.ok(report.gates.every((gate) => gate.evidence.tests.length > 0), JSON.stringify(report));
  assert.ok(report.gates.every((gate) => gate.evidence.tests.every((item) => item.status === "passed")), JSON.stringify(report));
});

test("Round17 real gate budget covers the frozen sequential packet without relaxing per-call limits", () => {
  const source = readFileSync(resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "utf8");
  assert.match(source, /PENGUIN_ROUND17_CLI_TIMEOUT_MS, 10_000/);
  assert.match(source, /PENGUIN_ROUND17_MCP_TIMEOUT_MS, 12_000/);
  assert.match(source, /PENGUIN_ROUND17_TOTAL_TIMEOUT_MS, 120_000/);
});

test("Round17 G4 evidence preserves CLI transport failures instead of projecting them as empty flow", () => {
  const source = readFileSync(resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "utf8");
  assert.match(source, /function cliProbeProjection\(row\)/);
  assert.match(source, /transport:\s*\{\s*context:\s*cliProbeProjection\(cliContext\),\s*flow:\s*cliProbeProjection\(cliFlow\)/s);
});

test("Round17 fixture gate rejects an unrelated passing test file", () => {
  const dir = mkdtempSync(join(tmpdir(), "round17-unrelated-fixture-"));
  const fixture = join(dir, "unrelated.test.mjs");
  writeFileSync(fixture, `import test from "node:test"; test("unrelated green test", () => {});\n`);
  const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "--fixture", "--gate"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PENGUIN_ROUND17_FIXTURE_TEST: fixture },
  });
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.passed, false);
  assert.ok(report.failures.some((failure) => failure.evidence?.error?.code === "FIXTURE_TEST_SET_MISMATCH"), JSON.stringify(report));
});

test("Round17 fixture gate rejects duplicate skip todo cancel and unparseable reporters", () => {
  const cases = [
    ["duplicate", `import test from "node:test"; test("duplicate",()=>{}); test("duplicate",()=>{});\n`, "FIXTURE_TEST_SET_MISMATCH"],
    ["skip", `import test from "node:test"; test.skip("skip",()=>{});\n`, "FIXTURE_TEST_STATUS_INVALID"],
    ["todo", `import test from "node:test"; test.todo("todo");\n`, "FIXTURE_TEST_STATUS_INVALID"],
    // Node reports an aborted top-level test as a failed unexpected test rather than
    // incrementing the TAP cancelled summary. It must still fail the exact test set.
    ["cancel", `import test from "node:test"; const controller=new AbortController(); test("cancel",{signal:controller.signal},async()=>{setTimeout(()=>controller.abort(),10); await new Promise((resolve)=>setTimeout(resolve,100));});\n`, "FIXTURE_TEST_SET_MISMATCH"],
    ["unparseable", `throw new Error("fixture reporter failure");\n`, "FIXTURE_TEST_SET_MISMATCH"],
  ];
  for (const [label, source, expectedCode] of cases) {
    const dir = mkdtempSync(join(tmpdir(), `round17-${label}-fixture-`));
    const fixture = join(dir, `${label}.test.mjs`);
    writeFileSync(fixture, source);
    const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "--fixture", "--gate"], {
      cwd: root,
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, PENGUIN_ROUND17_FIXTURE_TEST: fixture },
    });
    assert.notEqual(result.status, 0, `${label}: ${result.stdout}`);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.passed, false, label);
    assert.ok(report.failures.every((failure) => failure.evidence?.error?.code === expectedCode), `${label}: ${result.stdout}`);
  }
});

test("Round17 fixture gate turns timeout into a typed failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "round17-timeout-fixture-"));
  const fixture = join(dir, "slow.test.mjs");
  writeFileSync(fixture, `import test from "node:test"; test("slow", async () => new Promise((resolve) => setTimeout(resolve, 5_000)));\n`);
  const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "--fixture", "--gate"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PENGUIN_ROUND17_FIXTURE_TEST: fixture, PENGUIN_ROUND17_FIXTURE_TIMEOUT_MS: "250" },
  });
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.ok(report.failures.every((failure) => failure.evidence?.error?.code === "PROCESS_TIMEOUT"), JSON.stringify(report));
});

function runMcpHarnessProbe(source, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "round17-mcp-probe-"));
  const launcher = join(dir, "fake-mcp.mjs");
  writeFileSync(launcher, source);
  return spawnSync(process.execPath, [resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "--mcp-harness-probe", "--gate"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PENGUIN_ROUND17_MCP_LAUNCHER: launcher, ...extraEnv },
  });
}

test("Round17 MCP harness accepts one unique initialize and tool response", () => {
  const result = runMcpHarnessProbe(`
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{name:"fixture",version:"1"}}})+"\\n");
    process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:{structuredContent:{ok:true}}})+"\\n");
  `);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stdout).passed, true);
});

test("Round17 MCP harness rejects malformed, missing, duplicate, nonzero, and timeout responses", () => {
  const cases = [
    ["malformed", `process.stdout.write("not-json\\n");`],
    ["missing", `process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{}})+"\\n");`],
    ["duplicate", `process.stdout.write([JSON.stringify({jsonrpc:"2.0",id:1,result:{}}),JSON.stringify({jsonrpc:"2.0",id:2,result:{structuredContent:{ok:true}}}),JSON.stringify({jsonrpc:"2.0",id:2,result:{structuredContent:{ok:true}}})].join("\\n")+"\\n");`],
    ["nonzero", `process.exitCode=7;`],
    ["timeout", `setInterval(()=>{},1000);`, { PENGUIN_ROUND17_MCP_TIMEOUT_MS: "250" }],
  ];
  for (const [label, source, env] of cases) {
    const result = runMcpHarnessProbe(source, env);
    assert.notEqual(result.status, 0, `${label}: ${result.stdout}`);
    const report = JSON.parse(result.stdout.trim());
    assert.equal(report.passed, false, label);
    assert.equal(report.error.code, "HARNESS", `${label}: ${result.stdout}`);
  }
});

test("Round17 fixture gate reports launch failures instead of converting them to PASS", () => {
  const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-round17-acceptance.mjs"), "--fixture", "--gate"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PENGUIN_ROUND17_FIXTURE_TEST: "tests/round17-does-not-exist.test.mjs" },
  });
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.passed, false);
  assert.ok(report.failures.length > 0, JSON.stringify(report));
  assert.ok(report.gates.every((gate) => gate.passed === false), JSON.stringify(report));
});

test("Round17 internal release plan keeps runtime gates but defers public-only requirements", () => {
  const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-release-gate.mjs"), "--internal-round17", "--describe"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "internal-round17");
  assert.deepEqual(report.commands.map((command) => command.name), [
    "typecheck",
    "surface-parity",
    "package-smoke",
    "runtime-upgrade",
    "runtime-bundle",
    "tauri-clean-install",
  ]);
  assert.deepEqual(report.blockingRequirements, []);
  assert.deepEqual(report.deferredRequirements.map((item) => item.code), [
    "UNIVERSAL_CORPUS_REQUIRED",
    "REAL_QUESTION_REPORT_REQUIRED",
    "RC_ID_REQUIRED",
    "TAURI_SIGNING_KEY_REQUIRED",
  ]);
});

test("Round17 release gate bounds command execution and reports a typed timeout", () => {
  const dir = mkdtempSync(join(tmpdir(), "round17-release-timeout-"));
  const fakePnpm = join(dir, "pnpm");
  writeFileSync(fakePnpm, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n");
  chmodSync(fakePnpm, 0o755);
  const result = spawnSync(process.execPath, [resolve(root, "scripts/knowledge-release-gate.mjs"), "--internal-round17"], {
    cwd: root,
    encoding: "utf8",
    timeout: 5_000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, PENGUIN_RELEASE_GATE_COMMAND_TIMEOUT_MS: "250" },
  });
  assert.notEqual(result.status, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.results[0].exitCode, 124, JSON.stringify(report));
  assert.equal(report.results[0].error.code, "PROCESS_TIMEOUT", JSON.stringify(report));
});
