#!/usr/bin/env node
/*
 * Clean-install release gate for the Tauri knowledge runtime.
 *
 * This deliberately reads only the built .app resources, launches the
 * embedded MCP with its vendored Node binary, and then launches the same
 * files through the stable runtime launcher under a temporary HOME. It is
 * stronger than checking tauri.conf.json or the workspace bundle: a release
 * can only pass when the artifact that users install and the runtime clients
 * select expose the same protocol identity.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CAPABILITIES, capabilityHash } from "../packages/knowledge-contracts/dist/index.js";
import { McpSession, extractCliJson, mcpStructured, runCli } from "./knowledge-process-utils.mjs";

// The exact set of release-bundle entry files that identify the runtime a
// user would get from a fresh `pnpm tauri build`. These are the same files
// tauri.conf.json's `bundle.resources` copies verbatim into the app's
// Resources directory (see scripts/vendor-knowledge-runtime.mjs and
// scripts/bundle-knowledge-cli.mjs) — content-hashing them (never mtime)
// tells us whether the installed app still matches the workspace bundle it
// was supposedly built from.
export const MCP_BUNDLE_ENTRY_FILES = [
  "package.json",
  "dist/index.js",
  "dist/knowledge-worker.js",
  "dist/knowledge-tools.js",
  "dist/knowledge-tool-defs.js",
  "dist/result-text.js",
];
export const CLI_BUNDLE_ENTRY_FILES = [
  "penguin.mjs",
  "query-worker.js",
  "parse-worker.js",
  "lease-watchdog.js",
];

export function computeBundleManifest(baseDir, relativeFiles) {
  return relativeFiles.map((file) => {
    const filePath = join(baseDir, file);
    if (!existsSync(filePath)) {
      throw new Error(`RELEASE_BUNDLE_FILE_MISSING: expected ${file} under ${baseDir}`);
    }
    return { file, sha256: createHash("sha256").update(readFileSync(filePath)).digest("hex") };
  });
}

function collectTreeFiles(baseDir, treeDir, relativeFiles = []) {
  const absoluteDir = join(baseDir, treeDir);
  if (!existsSync(absoluteDir)) {
    throw new Error(`RELEASE_BUNDLE_FILE_MISSING: expected directory ${treeDir} under ${baseDir}`);
  }
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const relativePath = join(treeDir, entry.name);
    if (entry.isDirectory()) collectTreeFiles(baseDir, relativePath, relativeFiles);
    else if (entry.isFile()) relativeFiles.push(relativePath);
  }
  return relativeFiles;
}

function runtimeInputFiles(baseDir, entryFiles, treeDirs) {
  const files = new Set(entryFiles);
  for (const treeDir of treeDirs) {
    for (const file of collectTreeFiles(baseDir, treeDir)) files.add(file);
  }
  return [...files].sort();
}

function identityDigest(manifest) {
  return createHash("sha256")
    .update(manifest.map(({ file, sha256 }) => `${file}\0${sha256}\n`).join(""))
    .digest("hex");
}

/**
 * Compare the complete selected runtime-input tree, not only the handful of
 * entry points used to launch it. This catches a stale generated module,
 * source map, wasm asset, or model-adjacent runtime file before an installed
 * app is allowed to claim parity with the workspace.
 */
export function assertBundleIdentityMatch({ appDir, appLabel, workspaceDir, workspaceLabel, entryFiles = [], treeDirs = [] }) {
  const relativeFiles = runtimeInputFiles(appDir, entryFiles, treeDirs);
  const workspaceFiles = runtimeInputFiles(workspaceDir, entryFiles, treeDirs);
  const allFiles = [...new Set([...relativeFiles, ...workspaceFiles])].sort();
  const appManifest = computeBundleManifest(appDir, allFiles);
  const workspaceManifest = computeBundleManifest(workspaceDir, allFiles);
  const stale = allFiles.filter((_, index) => appManifest[index].sha256 !== workspaceManifest[index].sha256);
  const appIdentity = { runtimeInputDigest: identityDigest(appManifest), fileCount: appManifest.length, manifest: appManifest };
  const workspaceIdentity = { runtimeInputDigest: identityDigest(workspaceManifest), fileCount: workspaceManifest.length, manifest: workspaceManifest };
  if (stale.length > 0) {
    throw new Error(
      `RELEASE_BUNDLE_STALE: ${appLabel} (${appDir}) does not match the current ${workspaceLabel} (${workspaceDir}) ` +
        `for: ${stale.join(", ")}. The installed app was built from an older source tree. ` +
        "Rebuild it with `pnpm tauri build`, then rerun the gate.",
    );
  }
  return { match: true, appIdentity, workspaceIdentity };
}

export function assertEmbeddedModelIdentity({ appDir, workspaceDir, manifestRelativePath }) {
  const appPath = join(appDir, manifestRelativePath);
  const workspacePath = join(workspaceDir, manifestRelativePath);
  if (!existsSync(appPath) || !existsSync(workspacePath)) {
    throw new Error(
      `RELEASE_BUNDLE_STALE: embedding-model manifest is missing from installed app or workspace ` +
        `(${appPath}; ${workspacePath}). Rebuild it with ` +
        "`pnpm tauri build`, then rerun the gate.",
    );
  }
  const appModelHash = createHash("sha256").update(readFileSync(appPath)).digest("hex");
  const expectedModelHash = createHash("sha256").update(readFileSync(workspacePath)).digest("hex");
  if (appModelHash !== expectedModelHash) {
    throw new Error(
      `RELEASE_BUNDLE_STALE: embedding-model manifest (${appPath}) does not match workspace ` +
        `manifest (${workspacePath}). Rebuild it with ` +
        "`pnpm tauri build`, then rerun the gate.",
    );
  }
  return { expectedModelHash, appModelHash };
}

// Pre-probe guard: prove the app's embedded bundle is byte-identical to the
// current workspace release bundle before we ever spawn the app. A stale app
// (rebuilt workspace, un-rebuilt Tauri bundle) must fail here with an
// actionable, named remediation rather than silently probing a stale binary.
export function assertBundleFreshness({ appDir, appLabel, workspaceDir, workspaceLabel, relativeFiles }) {
  const appManifest = computeBundleManifest(appDir, relativeFiles);
  const workspaceManifest = computeBundleManifest(workspaceDir, relativeFiles);
  const stale = relativeFiles.filter((_, index) => appManifest[index].sha256 !== workspaceManifest[index].sha256);
  if (stale.length > 0) {
    throw new Error(
      `RELEASE_BUNDLE_STALE: ${appLabel} (${appDir}) does not match the current ${workspaceLabel} (${workspaceDir}) ` +
        `for: ${stale.join(", ")}. The installed app was built from an older source tree. ` +
        "Rebuild it with `pnpm tauri build`, then rerun the gate.",
    );
  }
  return { appManifest, workspaceManifest };
}

const root = resolve(import.meta.dirname, "..");
const appPath = resolve(process.env.PENGUIN_APP_PATH ?? join(root, "src-tauri/target/release/bundle/macos/Penguin.app"));
const resources = join(appPath, "Contents", "Resources");
const appVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const expectedCapabilityHash = capabilityHash(CAPABILITIES);
const expectedRuntimeDependencies = [
  "better-sqlite3",
  "bundled-node",
  "embedding-model",
  "embedding-model-manifest",
  "embedding-tokenizer",
  "onnxruntime-node",
  "sharp",
  "sqlite-vec",
];
let buildId = process.env.PENGUIN_RELEASE_BUILD_ID ?? `${appVersion}-knowledge-${expectedCapabilityHash.slice(0, 12)}`;
let expectedModelHash = process.env.PENGUIN_RELEASE_MODEL_HASH ?? null;
const launcher = resolve(root, "scripts/knowledge-mcp-launcher.mjs");
const timeoutMs = Number(process.env.PENGUIN_RELEASE_BUNDLE_TIMEOUT_MS ?? 15_000);

function requiredDir(candidates, required) {
  for (const candidate of candidates) {
    if (required.every((entry) => existsSync(join(candidate, entry)))) return candidate;
  }
  throw new Error(`RELEASE_RESOURCE_MISSING: expected ${required.join(", ")} under ${candidates.join(" or ")}`);
}

function parseInstructions(response) {
  const raw = response?.result?.instructions;
  assert.equal(typeof raw, "string", "MCP initialize must expose contract instructions");
  return JSON.parse(raw);
}

async function probeMcp({ node, server, env, label }) {
  const session = new McpSession({ node, server, cwd: root, env, label, timeoutMs });
  try {
    const initialized = await session.initialize();
    const instructions = parseInstructions(initialized);
    const tools = await session.request("tools/list");
    const healthResponse = await session.callTool("mcp_health");
    const capabilitiesResponse = await session.callTool("knowledge_capabilities", { compact: true });
    const health = mcpStructured(healthResponse);
    const capabilities = mcpStructured(capabilitiesResponse);
    assert.equal(initialized.result?.serverInfo?.name, "penguin-mcp");
    assert.equal(initialized.result?.serverInfo?.version, buildId);
    assert.equal(instructions.capabilityHash, expectedCapabilityHash);
    assert.equal(instructions.schemaVersion, 18);
    assert.equal(instructions.modelHash, expectedModelHash);
    assert.equal(health.contract?.capabilityHash, expectedCapabilityHash);
    assert.equal(health.contract?.schemaVersion, 18);
    assert.equal(health.contract?.modelHash, expectedModelHash);
    assert.equal(health.serverGeneration?.runningBuildId, buildId);
    assert.equal(health.serverGeneration?.outdated, false);
    assert.equal(capabilities.capabilityHash, expectedCapabilityHash);
    assert.equal(capabilities.buildId, buildId);
    assert.equal(capabilities.modelHash, expectedModelHash);
    assert.equal(capabilities.compact, true);
    assert.ok(Array.isArray(tools.result?.tools) && tools.result.tools.length > 0, "tools/list must be non-empty");
    return {
      label,
      serverInfo: initialized.result.serverInfo,
      instructions,
      health: {
        status: health.status,
        runningBuildId: health.serverGeneration?.runningBuildId,
        availableBuildId: health.serverGeneration?.availableBuildId,
        capabilityHash: health.contract?.capabilityHash,
      },
      capabilityHash: capabilities.capabilityHash,
      modelHash: capabilities.modelHash,
      capabilityCount: capabilities.capabilityCount,
      toolCount: tools.result.tools.length,
    };
  } finally {
    session.close();
  }
}

function probeCli({ node, bundle, command, commandArgs = ["capabilities", "--json"], env, label }) {
  const result = runCli({ node, bundle, command, args: commandArgs, cwd: root, env, timeoutMs });
  assert.equal(result.exitCode, 0, `${label} CLI capability probe failed: ${result.stderr}`);
  const payload = extractCliJson(result);
  assert.equal(payload.capabilityHash, expectedCapabilityHash);
  assert.equal(payload.buildId, buildId);
  assert.equal(payload.schemaVersion, "18");
  assert.equal(payload.modelHash, expectedModelHash);
  return {
    label,
    buildId: payload.buildId,
    capabilityHash: payload.capabilityHash,
    schemaVersion: payload.schemaVersion,
    modelHash: payload.modelHash,
  };
}

async function launchTauriAndReadRuntime(tempHome) {
  const binary = join(appPath, "Contents", "MacOS", "penguin");
  assert.ok(existsSync(binary), `Tauri executable does not exist: ${binary}`);
  const runtimeRoot = join(tempHome, ".penguin", "runtimes");
  const manifestPath = join(runtimeRoot, "manifest.json");
  const child = spawn(binary, [], {
    cwd: root,
    env: { ...process.env, HOME: tempHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-8_000); });
  const started = Date.now();
  try {
    const manifest = await new Promise((resolveManifest, rejectManifest) => {
      const deadline = setTimeout(() => rejectManifest(new Error(`TAURI_STARTUP_TIMEOUT: runtime manifest was not published within 20s\n${stderr}`)), 20_000);
      const poll = () => {
        if (existsSync(manifestPath)) {
          try {
            const candidate = JSON.parse(readFileSync(manifestPath, "utf8"));
            if (candidate.ready === true && typeof candidate.buildId === "string" && existsSync(join(runtimeRoot, "current"))) {
              clearTimeout(deadline);
              resolveManifest(candidate);
              return;
            }
          } catch {
            // The Rust side publishes the manifest atomically; retry while it
            // is being staged rather than treating a transient read as proof
            // that the installed app is broken.
          }
        }
        if (child.exitCode !== null) {
          clearTimeout(deadline);
          rejectManifest(new Error(`TAURI_STARTUP_FAILED: app exited with ${child.exitCode}\n${stderr}`));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
    return { manifest, runtimeRoot, elapsedMs: Date.now() - started };
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
          resolveExit();
        }, 2_000);
        child.once("exit", () => { clearTimeout(timer); resolveExit(); });
      });
    }
  }
}

export async function runReleaseBundleGate() {
  const report = {
  appPath,
  resources,
  appVersion,
  buildId,
  expectedCapabilityHash,
  checks: {},
};
let tempHome;
  try {
  assert.ok(existsSync(appPath), `Tauri app does not exist: ${appPath}`);
  const mcpBundle = requiredDir([
    join(resources, "_up_/packages/mcp/bundle"),
    join(resources, "packages/mcp/bundle"),
  ], ["package.json", "dist/index.js"]);
  const cliBundle = requiredDir([
    join(resources, "_up_/packages/knowledge-cli/bundle"),
    join(resources, "packages/knowledge-cli/bundle"),
  ], ["node", "penguin.mjs", "wasm"]);
  const mcpEntry = join(mcpBundle, "dist/index.js");
  const cliNode = join(cliBundle, "node");
  const mcpNode = cliNode;
  const cliEntry = join(cliBundle, "penguin.mjs");

  report.checks.bundleFreshness = {
    mcp: assertBundleFreshness({
      appDir: mcpBundle,
      appLabel: "installed app MCP bundle",
      workspaceDir: join(root, "packages/mcp/bundle"),
      workspaceLabel: "workspace release bundle (packages/mcp/bundle)",
      relativeFiles: MCP_BUNDLE_ENTRY_FILES,
    }),
    cli: assertBundleFreshness({
      appDir: cliBundle,
      appLabel: "installed app CLI bundle",
      workspaceDir: join(root, "packages/knowledge-cli/bundle"),
      workspaceLabel: "workspace release bundle (packages/knowledge-cli/bundle)",
      relativeFiles: CLI_BUNDLE_ENTRY_FILES,
    }),
  };
  report.checks.bundleIdentity = {
    mcp: assertBundleIdentityMatch({
      appDir: mcpBundle,
      appLabel: "installed app MCP bundle",
      workspaceDir: join(root, "packages/mcp/bundle"),
      workspaceLabel: "workspace release bundle (packages/mcp/bundle)",
      entryFiles: MCP_BUNDLE_ENTRY_FILES,
      // The packaged MCP bundle intentionally shares the CLI bundle's
      // vendored Node/native dependency tree at runtime; Tauri resources only
      // contain MCP's package marker and dist tree.
      treeDirs: ["dist"],
    }),
    cli: assertBundleIdentityMatch({
      appDir: cliBundle,
      appLabel: "installed app CLI bundle",
      workspaceDir: join(root, "packages/knowledge-cli/bundle"),
      workspaceLabel: "workspace release bundle (packages/knowledge-cli/bundle)",
      entryFiles: CLI_BUNDLE_ENTRY_FILES,
      treeDirs: ["wasm", "models", "node_modules"],
    }),
    model: assertEmbeddedModelIdentity({
      appDir: cliBundle,
      workspaceDir: join(root, "packages/knowledge-cli/bundle"),
      manifestRelativePath: "models/nomic-embed-text-v1.5/manifest.json",
    }),
  };

  tempHome = mkdtempSync(join(tmpdir(), "penguin-release-bundle-gate-"));
  const startup = await launchTauriAndReadRuntime(tempHome);
  if (process.env.PENGUIN_RELEASE_BUILD_ID) assert.equal(startup.manifest.buildId, buildId);
  else buildId = startup.manifest.buildId;
  report.buildId = buildId;
  assert.equal(startup.manifest.capabilityHash, expectedCapabilityHash);
  assert.equal(startup.manifest.contractSchemaVersion, 18);
  assert.match(startup.manifest.modelHash, /^[a-f0-9]{64}$/u);
  expectedModelHash = startup.manifest.modelHash;
  const nativeDependencies = Array.isArray(startup.manifest.nativeDependencies)
    ? startup.manifest.nativeDependencies
    : [];
  assert.deepEqual(
    nativeDependencies.map((dependency) => dependency.name).sort(),
    expectedRuntimeDependencies,
    "installed runtime must publish one complete native/model identity",
  );
  assert.ok(
    nativeDependencies.every((dependency) => dependency.status === "ready" && /^[a-f0-9]{64}$/u.test(dependency.sha256)),
    "every native library and model asset must be present and hash-verified",
  );
  assert.equal(
    nativeDependencies.find((dependency) => dependency.name === "embedding-model-manifest")?.sha256,
    expectedModelHash,
    "runtime modelHash must identify the bundled model manifest",
  );
  report.checks.tauriStartup = {
    elapsedMs: startup.elapsedMs,
    manifestBuildId: startup.manifest.buildId,
    capabilityHash: startup.manifest.capabilityHash,
    modelHash: startup.manifest.modelHash,
    currentRuntime: join(startup.runtimeRoot, "current"),
    nativeDependencies,
  };
  const runtimeRoot = startup.runtimeRoot;
  const env = { ...process.env, HOME: tempHome, PENGUIN_RUNTIME_ROOT: runtimeRoot, PENGUIN_BUILD_ID: buildId, PENGUIN_CAPABILITY_HASH: expectedCapabilityHash, PENGUIN_SCHEMA_VERSION: "18", PENGUIN_MODEL_HASH: expectedModelHash, PENGUIN_WASM_DIR: join(cliBundle, "wasm"), NODE_PATH: join(cliBundle, "node_modules") };

  report.checks.embeddedCli = probeCli({ node: cliNode, bundle: cliEntry, env, label: "tauri-app-embedded-cli" });
  report.checks.embeddedMcp = await probeMcp({ node: mcpNode, server: mcpEntry, env, label: "tauri-app-embedded-mcp" });

  const launcherEnv = { ...process.env, HOME: tempHome, PENGUIN_RUNTIME_ROOT: runtimeRoot };
  report.checks.launcherCli = probeCli({ node: process.execPath, bundle: cliEntry, command: process.execPath, commandArgs: [resolve(root, "scripts/knowledge-cli-launcher.mjs"), "capabilities", "--json"], env: launcherEnv, label: "stable-launcher-cli" });
  report.checks.launcherMcp = await probeMcp({ node: process.execPath, server: launcher, env: launcherEnv, label: "stable-launcher-mcp" });

  assert.deepEqual(
    { ...report.checks.embeddedCli, label: undefined },
    { ...report.checks.launcherCli, label: undefined },
  );
  assert.equal(report.checks.embeddedMcp.capabilityHash, report.checks.launcherMcp.capabilityHash);
  assert.equal(report.checks.embeddedMcp.modelHash, report.checks.launcherMcp.modelHash);
  assert.equal(report.checks.embeddedMcp.health.capabilityHash, report.checks.launcherMcp.health.capabilityHash);
  assert.equal(report.checks.embeddedMcp.health.runningBuildId, report.checks.launcherMcp.health.runningBuildId);
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = String(error?.stack ?? error);
  process.exitCode = 1;
} finally {
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
}
  console.log(JSON.stringify(report, null, 2));
  return report;
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === import.meta.filename;
if (isMainModule) {
  await runReleaseBundleGate();
}
