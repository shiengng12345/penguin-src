import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";

const root = new URL("..", import.meta.url).pathname;
const cliBundle = join(root, "packages/knowledge-cli/bundle");
const mcpBundle = join(root, "packages/mcp/bundle");
const cliLauncher = join(root, "scripts/knowledge-cli-launcher.mjs");
const mcpLauncher = join(root, "scripts/knowledge-mcp-launcher.mjs");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

const TEST_CAPABILITY_HASH = sha256("penguin-test-capability");
const TEST_MODEL_HASH = sha256("penguin-test-model");

function createManifest(buildId, opts = {}) {
  return {
    schemaVersion: 1,
    ready: opts.ready ?? true,
    buildId,
    appVersion: opts.appVersion ?? buildId,
    capabilityHash: opts.capabilityHash ?? TEST_CAPABILITY_HASH,
    modelHash: opts.modelHash ?? TEST_MODEL_HASH,
    contractSchemaVersion: opts.contractSchemaVersion ?? 18,
    contractVersion: opts.contractVersion ?? "2",
    platform: opts.platform ?? process.platform,
    architecture: opts.architecture ?? process.arch,
    nativeDependencies: opts.nativeDependencies ?? [],
    signing: opts.signing ?? { status: "unknown" },
    cliEntry: "penguin.mjs",
    mcpEntry: "mcp/dist/index.js",
    nodePath: "node",
    wasmPath: "wasm",
    fileHashes: opts.fileHashes ?? {},
    createdAt: opts.createdAt ?? new Date().toISOString(),
  };
}

function installRuntime(runtimeRoot, buildId, opts = {}) {
  const generationDir = join(runtimeRoot, buildId);
  mkdirSync(generationDir, { recursive: true });

  // Copy Node binary
  const nodeSource = join(cliBundle, "node");
  const nodeDest = join(generationDir, "node");
  if (existsSync(nodeSource)) {
    cpSync(nodeSource, nodeDest);
    chmodSync(nodeDest, 0o755);
  } else {
    symlinkSync(process.execPath, nodeDest);
  }

  // Copy CLI entry
  if (!opts.skipCli) {
    cpSync(join(cliBundle, "penguin.mjs"), join(generationDir, "penguin.mjs"));
  }

  // Copy WASM
  if (!opts.skipWasm) {
    cpSync(join(cliBundle, "wasm"), join(generationDir, "wasm"), { recursive: true });
  }

  // Copy MCP bundle
  if (!opts.skipMcp) {
    cpSync(mcpBundle, join(generationDir, "mcp"), { recursive: true });
  }

  // Compute file hashes for native dependencies
  const fileHashes = {};
  if (existsSync(nodeDest)) {
    fileHashes["node"] = opts.corruptHash ? "corrupt-hash" : sha256(readFileSync(nodeDest));
  }

  // Write manifest
  const nativeDependencies = opts.nativeDependencies ?? (fileHashes.node
    ? [{ name: "bundled-node", version: process.versions.node, path: "node", sha256: fileHashes.node, status: "ready" }]
    : []);
  const manifest = createManifest(buildId, { ...opts, fileHashes, nativeDependencies });
  writeFileSync(join(generationDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Mark as ready
  writeFileSync(join(generationDir, ".ready"), buildId);

  return generationDir;
}

function activateRuntime(runtimeRoot, buildId) {
  const current = join(runtimeRoot, "current");
  const temp = join(runtimeRoot, `.current-${buildId}`);

  // Remove existing temp if present
  try {
    unlinkSync(temp);
  } catch {
    // Ignore if doesn't exist
  }

  symlinkSync(join(runtimeRoot, buildId), temp);
  try {
    unlinkSync(current);
  } catch {
    // Ignore if doesn't exist
  }
  renameSync(temp, current);

  // Write root-level manifest
  const generationManifest = JSON.parse(
    readFileSync(join(runtimeRoot, buildId, "manifest.json"), "utf8"),
  );
  writeFileSync(join(runtimeRoot, "manifest.json"), JSON.stringify(generationManifest));
}

function runCliVersion(runtimeRoot) {
  const result = spawnSync(process.execPath, [cliLauncher, "capabilities", "--json"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimeRoot },
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0) {
    return { ok: false, error: result.stderr || result.stdout, status: result.status };
  }
  try {
    const lines = result.stdout.split("\n").filter(Boolean);
    const payload = JSON.parse(lines[lines.length - 1]);
    return { ok: true, buildId: payload.buildId, capabilityHash: payload.capabilityHash };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function runCliJson(runtimeRoot, args) {
  const result = spawnSync(process.execPath, [cliLauncher, ...args], {
    env: {
      ...process.env,
      PENGUIN_RUNTIME_ROOT: runtimeRoot,
      PENGUIN_KNOWLEDGE_DB: join(runtimeRoot, "knowledge.db"),
      PENGUIN_KNOWLEDGE_LEDGER: join(runtimeRoot, "ledger.jsonl"),
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  const lines = result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  const payload = lines.length ? JSON.parse(lines.at(-1)) : null;
  return { result, payload };
}

function startMcpSession(runtimeRoot, timeoutMs = 10_000) {
  const child = spawn(process.execPath, [mcpLauncher], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimeRoot },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  const messages = [];
  let buffer = "";
  let nextId = 1;
  const pending = new Map();

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      lines.push(line);
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          messages.push(message);
          const p = pending.get(message.id);
          if (p) {
            pending.delete(message.id);
            clearTimeout(p.timer);
            p.resolve(message);
          }
        }
      } catch {
        // Ignore non-JSON lines
      }
    }
  });

  const request = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request ${method} timed out`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  };

  return {
    child,
    request,
    async initialize() {
      const response = await request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "install-upgrade-test", version: "1" },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      return response;
    },
    async callTool(name, args = {}) {
      return request("tools/call", { name, arguments: args });
    },
    close() {
      if (!child.killed) child.kill("SIGTERM");
    },
  };
}

function parseToolResult(response) {
  const text = response?.result?.content?.find((item) => item.type === "text")?.text;
  return text ? JSON.parse(text) : null;
}

test("fresh install creates usable runtime from first generation", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-fresh-install-"));
  try {
    assert.equal(existsSync(join(runtimeRoot, "current")), false);

    installRuntime(runtimeRoot, "build-fresh");
    activateRuntime(runtimeRoot, "build-fresh");

    assert.equal(existsSync(join(runtimeRoot, "current")), true);
    assert.equal(
      realpathSync(join(runtimeRoot, "current")),
      realpathSync(join(runtimeRoot, "build-fresh")),
    );

    const cli = runCliVersion(runtimeRoot);
    assert.equal(cli.ok, true, cli.error);
    assert.equal(cli.buildId, "build-fresh");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("upgrade retains old generation and activates new one", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-upgrade-retain-"));
  try {
    installRuntime(runtimeRoot, "build-old");
    activateRuntime(runtimeRoot, "build-old");

    assert.equal(runCliVersion(runtimeRoot).buildId, "build-old");

    installRuntime(runtimeRoot, "build-new");
    assert.equal(existsSync(join(runtimeRoot, "build-old")), true, "old generation must be retained");
    assert.equal(existsSync(join(runtimeRoot, "build-new")), true, "new generation must exist");

    activateRuntime(runtimeRoot, "build-new");
    assert.equal(runCliVersion(runtimeRoot).buildId, "build-new");
    assert.equal(existsSync(join(runtimeRoot, "build-old")), true, "old generation still retained after activation");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("failed activation leaves old current usable", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-failed-activation-"));
  try {
    installRuntime(runtimeRoot, "build-stable");
    activateRuntime(runtimeRoot, "build-stable");
    assert.equal(runCliVersion(runtimeRoot).buildId, "build-stable");

    // Install broken generation (missing CLI entry)
    installRuntime(runtimeRoot, "build-broken", { skipCli: true });

    // Attempt to activate broken generation
    const current = join(runtimeRoot, "current");
    const temp = join(runtimeRoot, ".current-build-broken");
    symlinkSync(join(runtimeRoot, "build-broken"), temp);
    try {
      unlinkSync(current);
    } catch {
      // Ignore
    }
    renameSync(temp, current);

    // Launcher should fail
    const result = runCliVersion(runtimeRoot);
    assert.equal(result.ok, false);
    assert.match(result.error, /RUNTIME_NOT_INSTALLED|missing|incomplete/i);

    // Restore stable generation
    const restore = join(runtimeRoot, ".current-restore");
    symlinkSync(join(runtimeRoot, "build-stable"), restore);
    try {
      unlinkSync(current);
    } catch {
      // Ignore
    }
    renameSync(restore, current);

    // Should work again
    assert.equal(runCliVersion(runtimeRoot).buildId, "build-stable");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("stable launcher resolves current runtime correctly", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-launcher-resolve-"));
  try {
    installRuntime(runtimeRoot, "build-launcher-test");
    activateRuntime(runtimeRoot, "build-launcher-test");

    // Test CLI launcher
    const cliResult = spawnSync(process.execPath, [cliLauncher, "capabilities", "--json"], {
      env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimeRoot },
      encoding: "utf8",
    });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    const cliPayload = JSON.parse(cliResult.stdout.split("\n").filter(Boolean).pop());
    assert.equal(cliPayload.buildId, "build-launcher-test");

    // Verify current symlink is followed
    const actualPath = realpathSync(join(runtimeRoot, "current"));
    assert.equal(actualPath, realpathSync(join(runtimeRoot, "build-launcher-test")));
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("missing native artifact fails with clear error", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-missing-artifact-"));
  try {
    // Install runtime but delete the node binary after
    installRuntime(runtimeRoot, "build-no-node");
    unlinkSync(join(runtimeRoot, "build-no-node", "node"));
    activateRuntime(runtimeRoot, "build-no-node");

    const result = runCliVersion(runtimeRoot);
    assert.equal(result.ok, false);
    assert.match(result.error, /RUNTIME_NOT_INSTALLED|missing|incomplete/i);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("hash mismatch is detectable via manifest", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-hash-mismatch-"));
  try {
    // Install with corrupt hash in manifest
    installRuntime(runtimeRoot, "build-hash-test", { corruptHash: true });
    activateRuntime(runtimeRoot, "build-hash-test");

    const manifestPath = join(runtimeRoot, "build-hash-test", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const nodePath = join(runtimeRoot, "build-hash-test", "node");
    const actualHash = sha256(readFileSync(nodePath));

    assert.notEqual(
      manifest.fileHashes.node,
      actualHash,
      "manifest should contain mismatched hash",
    );

    // Launcher still works (hash verification would be runtime manager's job)
    // but the manifest exposes the mismatch
    assert.equal(manifest.fileHashes.node, "corrupt-hash");
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("restart-required detection in long-lived MCP process", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-restart-required-"));
  try {
    installRuntime(runtimeRoot, "build-old-mcp");
    activateRuntime(runtimeRoot, "build-old-mcp");

    const session = startMcpSession(runtimeRoot);
    try {
      await session.initialize();
      const firstHealth = await session.callTool("mcp_health");
      const firstResult = parseToolResult(firstHealth);

      assert.equal(firstResult.status, "ok");
      assert.equal(firstResult.serverGeneration.runningBuildId, "build-old-mcp");
      assert.equal(firstResult.serverGeneration.outdated, false);
      assert.equal(firstResult.buildId, "build-old-mcp");
      assert.equal(firstResult.runtimeRoot, runtimeRoot);
      assert.equal(firstResult.schemaVersion, 18);
      assert.equal(firstResult.contractVersion, "2");
      assert.equal(firstResult.generation.runningBuildId, "build-old-mcp");
      assert.equal(firstResult.generation.availableBuildId, "build-old-mcp");
      assert.ok(Array.isArray(firstResult.nativeDependencies));
      assert.equal(firstResult.signing.status, "unknown");

      // Upgrade to new generation
      installRuntime(runtimeRoot, "build-new-mcp");
      activateRuntime(runtimeRoot, "build-new-mcp");

      // Old session should detect it's outdated
      const secondHealth = await session.callTool("mcp_health");
      const secondResult = parseToolResult(secondHealth);

      assert.equal(secondResult.status, "outdated");
      assert.equal(secondResult.runtimeOutdated, true);
      assert.equal(secondResult.serverGeneration.runningBuildId, "build-old-mcp");
      assert.equal(secondResult.serverGeneration.availableBuildId, "build-new-mcp");
      assert.equal(secondResult.serverGeneration.outdated, true);
      assert.match(String(secondResult.serverGeneration.action), /restart/i);
    } finally {
      session.close();
    }
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("malformed manifest prevents activation", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-malformed-manifest-"));
  try {
    const generationDir = join(runtimeRoot, "build-malformed");
    mkdirSync(generationDir, { recursive: true });

    // Copy runtime files
    symlinkSync(process.execPath, join(generationDir, "node"));
    cpSync(join(cliBundle, "penguin.mjs"), join(generationDir, "penguin.mjs"));

    // Write invalid manifest
    writeFileSync(
      join(generationDir, "manifest.json"),
      JSON.stringify({ buildId: "build-malformed", ready: false }),
    );

    const current = join(runtimeRoot, "current");
    const temp = join(runtimeRoot, ".current-malformed");
    symlinkSync(generationDir, temp);
    renameSync(temp, current);
    writeFileSync(
      join(runtimeRoot, "manifest.json"),
      JSON.stringify({ buildId: "build-malformed", ready: false }),
    );

    const result = runCliVersion(runtimeRoot);
    assert.equal(result.ok, false);
    assert.match(result.error, /RUNTIME_MANIFEST_INVALID|schemaVersion|ready/i);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("generation identity fields are exposed", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-identity-"));
  try {
    installRuntime(runtimeRoot, "build-identity", {
      appVersion: "1.16.0",
      capabilityHash: TEST_CAPABILITY_HASH,
      contractSchemaVersion: 18,
    });
    activateRuntime(runtimeRoot, "build-identity");

    const cli = runCliVersion(runtimeRoot);
    assert.equal(cli.ok, true, cli.error);
    assert.equal(cli.buildId, "build-identity");
    // CLI computes the actual capability hash from CAPABILITIES, not from manifest
    assert.ok(cli.capabilityHash && cli.capabilityHash.length > 0, "CLI must expose capability hash");

    const manifest = JSON.parse(
      readFileSync(join(runtimeRoot, "build-identity", "manifest.json"), "utf8"),
    );
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.ready, true);
    assert.equal(manifest.buildId, "build-identity");
    assert.equal(manifest.appVersion, "1.16.0");
    assert.equal(manifest.capabilityHash, TEST_CAPABILITY_HASH);
    assert.equal(manifest.modelHash, TEST_MODEL_HASH);
    assert.equal(manifest.contractSchemaVersion, 18);
    assert.ok(manifest.fileHashes);
    assert.ok(manifest.createdAt);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});

test("version and doctor expose the same complete runtime identity before a knowledge DB exists", () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "penguin-runtime-identity-"));
  try {
    installRuntime(runtimeRoot, "build-identity-cli", {
      appVersion: "1.16.0",
      capabilityHash: TEST_CAPABILITY_HASH,
      contractSchemaVersion: 18,
    });
    activateRuntime(runtimeRoot, "build-identity-cli");

    const version = runCliJson(runtimeRoot, ["version", "--json"]);
    assert.equal(version.result.status, 0, version.result.stderr);
    assert.equal(version.payload.buildId, "build-identity-cli");
    assert.equal(version.payload.capabilityHash, TEST_CAPABILITY_HASH);
    assert.equal(version.payload.modelHash, TEST_MODEL_HASH);
    assert.equal(version.payload.schemaVersion, 18);
    assert.equal(version.payload.contractVersion, "2");
    assert.equal(version.payload.runtimeRoot, runtimeRoot);
    assert.equal(version.payload.platform, process.platform);
    assert.equal(version.payload.architecture, process.arch);
    assert.equal(version.payload.signing.status, "unknown");
    assert.equal(version.payload.generation.outdated, false);
    assert.ok(Array.isArray(version.payload.nativeDependencies));

    const doctor = runCliJson(runtimeRoot, ["doctor", "--json"]);
    assert.equal(doctor.result.status, 3, "doctor must report the missing DB without hiding runtime identity");
    assert.deepEqual(doctor.payload.runtime.generation, version.payload.generation);
    assert.equal(doctor.payload.runtime.buildId, version.payload.buildId);
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
});
