import assert from "node:assert/strict";
import {
  copyFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

// The MCP package builds as a single esbuild bundle, so this module has no
// standalone dist entry — transpile the source the same way mcp-app-db does.
const source = await readFile(
  new URL("../packages/mcp/src/generation-watch.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
});
const {
  checkGeneration,
  createGenerationState,
  generationMeta,
  generationAction,
  generationNotice,
  acquireGenerationLease,
  releaseGenerationLease,
  readGenerationManifest,
} = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

// A stdio MCP server outlives the app update that replaces its code. These
// tests pin the detection contract: the manifest is the READY marker, the
// check is sticky, and a server that started without a manifest never
// claims to be outdated just because one appeared.

function scratchManifest(body) {
  const dir = mkdtempSync(join(tmpdir(), "pgv-gen-"));
  const path = join(dir, "manifest.json");
  if (body !== undefined) writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

function bump(path, body) {
  writeFileSync(path, JSON.stringify(body));
  // Force a visibly different mtime — same-millisecond writes would look
  // unchanged to the stat-first fast path.
  const future = new Date(Date.now() + 5_000);
  utimesSync(path, future, future);
}

test("missing or malformed manifest reads as no information, never as an update", () => {
  assert.equal(readGenerationManifest(join(tmpdir(), "definitely-absent-manifest.json")), null);
  assert.equal(readGenerationManifest(scratchManifest("{ half-written")), null);
  assert.equal(readGenerationManifest(scratchManifest({ appVersion: "1.16.2" })), null, "buildId is required");
});

test("same buildId across calls stays current", () => {
  const path = scratchManifest({ buildId: "aaa", appVersion: "1.16.2" });
  const state = createGenerationState(path);
  assert.equal(state.startupBuildId, "aaa");
  const mtime = { value: -1 };
  checkGeneration(state, path, mtime);
  bump(path, { buildId: "aaa", appVersion: "1.16.2" });
  checkGeneration(state, path, mtime);
  assert.equal(state.outdated, false);
  assert.equal(generationNotice(state), null);
  assert.equal(generationMeta(state), null);
});

test("a newer buildId marks the process outdated, stickily", () => {
  const path = scratchManifest({ buildId: "aaa", appVersion: "1.16.1" });
  const state = createGenerationState(path);
  const mtime = { value: -1 };
  bump(path, { buildId: "bbb", appVersion: "1.16.2" });
  checkGeneration(state, path, mtime);
  assert.equal(state.outdated, true);
  assert.equal(state.currentBuildId, "bbb");
  assert.match(generationNotice(state), /app 1\.16\.2/);
  assert.match(generationNotice(state), /restart/i);
  assert.deepEqual(generationMeta(state), {
    "penguin/serverOutdated": true,
    "penguin/runningBuildId": "aaa",
    "penguin/availableBuildId": "bbb",
    "penguin/availableAppVersion": "1.16.2",
  });

  // Sticky: reverting the manifest does not un-outdate a process whose code
  // on disk already changed under it.
  bump(path, { buildId: "aaa", appVersion: "1.16.1" });
  checkGeneration(state, path, mtime);
  assert.equal(state.outdated, true);
});

test("a server started without a manifest never self-reports outdated", () => {
  const path = scratchManifest();
  const state = createGenerationState(path);
  assert.equal(state.startupBuildId, null);
  const mtime = { value: -1 };
  bump(path, { buildId: "first-ever", appVersion: "1.16.2" });
  checkGeneration(state, path, mtime);
  // The first manifest may well describe the build this process is running.
  assert.equal(state.outdated, false);
  assert.equal(state.currentBuildId, "first-ever");
});

test("unchanged mtime short-circuits before re-reading the file", () => {
  const path = scratchManifest({ buildId: "aaa" });
  const state = createGenerationState(path);
  const mtime = { value: -1 };
  checkGeneration(state, path, mtime);
  const seen = mtime.value;
  assert.notEqual(seen, -1, "first call records the mtime");
  // Rewrite the content while restoring the exact mtime the checker recorded:
  // a stat-first implementation must skip the read and stay current, while a
  // read-every-call one would see "bbb" and flip to outdated.
  writeFileSync(path, JSON.stringify({ buildId: "bbb" }));
  utimesSync(path, seen / 1000, seen / 1000);
  checkGeneration(state, path, mtime);
  assert.equal(state.outdated, false);
  assert.equal(state.currentBuildId, "aaa");
});

test("notice is emitted for delivery-once bookkeeping by the caller", () => {
  const path = scratchManifest({ buildId: "aaa" });
  const state = createGenerationState(path);
  const mtime = { value: -1 };
  bump(path, { buildId: "ccc" });
  checkGeneration(state, path, mtime);
  assert.equal(state.noticeDelivered, false);
  assert.ok(generationNotice(state));
  state.noticeDelivered = true;
  // The helper stays pure — suppression is the caller's decision.
  assert.ok(generationNotice(state));
});

test("outdated state has a stable restart action for clients that ignore _meta", () => {
  const path = scratchManifest({ buildId: "aaa" });
  const state = createGenerationState(path);
  const mtime = { value: -1 };
  bump(path, { buildId: "bbb", appVersion: "1.16.2" });
  checkGeneration(state, path, mtime);
  assert.deepEqual(generationAction(state), {
    code: "OUTDATED_RUNTIME",
    message: generationNotice(state),
    action: "restart_mcp_session",
    runningBuildId: "aaa",
    availableBuildId: "bbb",
  });
});

test("generation lease is acquired and released without blocking legacy layouts", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgv-lease-"));
  const manifest = join(dir, "manifest.json");
  const generation = join(dir, "generations", "aaa");
  writeFileSync(manifest, JSON.stringify({ buildId: "aaa" }));
  const lease = acquireGenerationLease(manifest, "aaa", 4242);
  assert.ok(lease);
  assert.equal(existsSync(lease), true);
  releaseGenerationLease(lease);
  assert.equal(existsSync(lease), false);
  assert.equal(acquireGenerationLease(manifest, null, 4242), null);
  assert.equal(existsSync(generation), true, "lease acquisition creates the generation path only as needed");
});

function writeVersionedRuntime(runtimeRoot, buildId, appVersion) {
  const generation = join(runtimeRoot, buildId);
  const mcpDist = join(generation, "mcp", "dist");
  mkdirSync(mcpDist, { recursive: true });
  // The runtime manifest is a complete generation contract.  The MCP
  // launcher validates the shared parser payload even for a health-only
  // session, so keep this fixture honest instead of testing an impossible
  // partially-installed generation.
  mkdirSync(join(generation, "wasm"), { recursive: true });
  writeFileSync(join(generation, "wasm", "tree-sitter.wasm"), "fixture-wasm");
  copyFileSync(new URL("../packages/mcp/dist/index.js", import.meta.url), join(mcpDist, "index.js"));
  writeFileSync(join(generation, "package.json"), JSON.stringify({ type: "module" }));
  // Keep the node entry physically inside the generation.  A symlink to the
  // developer's system Node would violate the launcher boundary contract;
  // this tiny in-generation shim still runs the same test interpreter.
  writeFileSync(join(generation, "node"), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  chmodSync(join(generation, "node"), 0o755);
  writeFileSync(
    join(generation, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      ready: true,
      buildId,
      appVersion,
      capabilityHash: "a".repeat(64),
      contractSchemaVersion: 18,
      contractVersion: "2",
      modelHash: "b".repeat(64),
      nodePath: "node",
      mcpEntry: "mcp/dist/index.js",
      wasmPath: "wasm",
    }),
  );
  return generation;
}

function installTemporaryStableLauncher(home, launcher) {
  const bin = join(home, ".penguin", "bin");
  mkdirSync(bin, { recursive: true });
  const target = join(bin, "penguin-mcp-launcher.mjs");
  copyFileSync(fileURLToPath(launcher), target);
  chmodSync(target, 0o755);

  const wrapper = join(bin, "penguin-mcp");
  writeFileSync(
    wrapper,
    '#!/bin/sh\n# Auto-generated by Penguin.app.\nexport PENGUIN_RUNTIME_ROOT="$HOME/.penguin/runtimes"\nexec "$HOME/.penguin/bin/penguin-mcp-launcher.mjs" "$@"\n',
  );
  chmodSync(wrapper, 0o755);
  return wrapper;
}

function waitForHealth(child, id) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const onData = (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split("\n").slice(0, -1)) {
        try {
          const frame = JSON.parse(line);
          if (frame.id === id) {
            child.stdout.off("data", onData);
            resolve(JSON.parse(frame.result.content[0].text));
            return;
          }
        } catch {
          // Ignore non-JSON stdout; the next complete frame is authoritative.
        }
      }
      buffer = buffer.split("\n").at(-1) ?? "";
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`MCP launcher exited before health response: ${code}; ${stderr}`)));
  });
}

test("real stable wrapper passes its temporary HOME runtime root to the MCP session", async () => {
  const home = mkdtempSync(join(tmpdir(), "pgv-launcher-e2e-"));
  const launcher = new URL("../scripts/knowledge-mcp-launcher.mjs", import.meta.url);
  try {
    const runtimeRoot = join(home, ".penguin", "runtimes");
    const stableLauncher = installTemporaryStableLauncher(home, launcher);
    mkdirSync(runtimeRoot, { recursive: true });
    const first = writeVersionedRuntime(runtimeRoot, "build-old", "1.16.1");
    symlinkSync(first, join(runtimeRoot, "current"));
    writeFileSync(join(runtimeRoot, "manifest.json"), readFileSync(join(first, "manifest.json")));

    // Model a real client invoking ~/.penguin/bin/penguin-mcp. Do not allow a
    // caller-provided runtime root to make this test pass accidentally.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== "PENGUIN_RUNTIME_ROOT"),
    );
    env.HOME = home;
    const child = spawn(stableLauncher, [], {
      cwd: process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "round1", version: "1" } } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mcp_health", arguments: {} } })}\n`);
      const currentHealth = await waitForHealth(child, 2);
      assert.equal(currentHealth.serverGeneration.runningBuildId, "build-old");
      assert.equal(currentHealth.serverGeneration.availableBuildId, "build-old");
      assert.equal(currentHealth.serverGeneration.outdated, false);

      const second = writeVersionedRuntime(runtimeRoot, "build-new", "1.16.2");
      unlinkSync(join(runtimeRoot, "current"));
      symlinkSync(second, join(runtimeRoot, "current"));
      writeFileSync(join(runtimeRoot, "manifest.json"), readFileSync(join(second, "manifest.json")));

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_health", arguments: {} } })}\n`);
      const outdatedHealth = await waitForHealth(child, 3);
      assert.equal(outdatedHealth.status, "outdated");
      assert.equal(outdatedHealth.runtimeOutdated, true);
      assert.equal(outdatedHealth.serverGeneration.runningBuildId, "build-old");
      assert.equal(outdatedHealth.serverGeneration.availableBuildId, "build-new");
      assert.equal(outdatedHealth.serverGeneration.outdated, true);
      assert.match(outdatedHealth.serverGeneration.action, /restart/i);
    } finally {
      child.kill();
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("upgrade replay report proves the fresh launcher moved to runtime B", () => {
  const dir = mkdtempSync(join(tmpdir(), "pgv-upgrade-report-"));
  const reportPath = join(dir, "upgrade-report.md");
  try {
    const result = spawnSync(process.execPath, ["scripts/knowledge-install-upgrade-test.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PENGUIN_INSTALL_UPGRADE_REPORT: reportPath,
      },
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });

    assert.equal(
      result.status,
      0,
      `upgrade replay script failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const report = readFileSync(reportPath, "utf8");
    const match = report.match(/```json\n([\s\S]*?)\n```/u);
    assert.ok(match, `upgrade report did not contain a JSON evidence block:\n${report}`);
    const evidence = JSON.parse(match[1]);
    const session = evidence.sessions[0];

    assert.equal(session.old.afterUpgrade.availableBuildId, "runtime-B");
    assert.equal(session.old.outdatedContract.action, "restart_mcp_session");
    assert.equal(session.fresh.runningBuildId, "runtime-B");
    assert.equal(session.fresh.cli.buildId, "runtime-B");
    assert.equal(session.fresh.mcp.buildId, "runtime-B");
    assert.equal(session.fresh.cli.capabilityHash, session.fresh.mcp.capabilityHash);
    assert.equal(basename(session.old.selectedRuntimePath), "runtime-A");
    assert.equal(basename(session.fresh.selectedRuntimePath), "runtime-B");
    assert.notEqual(session.fresh.selectedRuntimePath, session.old.selectedRuntimePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
