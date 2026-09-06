import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  assertBundleFreshness,
  assertBundleIdentityMatch,
  assertEmbeddedModelIdentity,
} from "../scripts/knowledge-release-bundle-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const app = join(root, "src-tauri/target/release/bundle/macos/Penguin.app");

test("assertBundleFreshness fails a stale installed-app bundle against the current workspace release bundle, and passes once identical", () => {
  const appDir = mkdtempSync(join(tmpdir(), "penguin-bundle-app-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "penguin-bundle-workspace-"));
  try {
    mkdirSync(join(appDir, "dist"), { recursive: true });
    mkdirSync(join(workspaceDir, "dist"), { recursive: true });
    writeFileSync(join(appDir, "dist/index.js"), "console.log('old build');\n");
    writeFileSync(join(workspaceDir, "dist/index.js"), "console.log('new build');\n");

    assert.throws(
      () =>
        assertBundleFreshness({
          appDir,
          appLabel: "installed app MCP bundle",
          workspaceDir,
          workspaceLabel: "workspace release bundle (packages/mcp/bundle)",
          relativeFiles: ["dist/index.js"],
        }),
      (error) => {
        assert.match(error.message, /RELEASE_BUNDLE_STALE/);
        assert.match(error.message, /installed app MCP bundle/);
        assert.match(error.message, /workspace release bundle \(packages\/mcp\/bundle\)/);
        assert.match(error.message, /dist\/index\.js/);
        assert.match(error.message, /pnpm tauri build/);
        return true;
      },
    );

    // Identical content (the post-remediation state after `pnpm tauri build`) must not be flagged stale.
    writeFileSync(join(appDir, "dist/index.js"), "console.log('new build');\n");
    assert.doesNotThrow(() =>
      assertBundleFreshness({
        appDir,
        appLabel: "installed app MCP bundle",
        workspaceDir,
        workspaceLabel: "workspace release bundle (packages/mcp/bundle)",
        relativeFiles: ["dist/index.js"],
      }),
    );
  } finally {
    rmSync(appDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("app-vs-workspace bundle identity fails closed on altered runtime inputs that the declared entry files alone would miss", () => {
  const appDir = mkdtempSync(join(tmpdir(), "penguin-identity-app-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "penguin-identity-workspace-"));
  const modelManifest = "models/nomic-embed-text-v1.5/manifest.json";
  const identityArgs = {
    appDir,
    appLabel: "installed app MCP bundle",
    workspaceDir,
    workspaceLabel: "workspace release bundle (packages/mcp/bundle)",
    entryFiles: ["dist/index.js"],
    treeDirs: ["dist"],
  };
  try {
    for (const dir of [appDir, workspaceDir]) {
      mkdirSync(join(dir, "dist"), { recursive: true });
      mkdirSync(join(dir, "models/nomic-embed-text-v1.5"), { recursive: true });
      // The declared entry file is byte-identical on both sides, so an
      // entry-file-only manifest cannot tell the two trees apart.
      writeFileSync(join(dir, "dist/index.js"), "export const entry = 1;\n");
    }
    writeFileSync(join(appDir, "dist/knowledge-notes.js"), "export const notes = 'old build';\n");
    writeFileSync(join(workspaceDir, "dist/knowledge-notes.js"), "export const notes = 'new build';\n");

    assert.throws(
      () => assertBundleIdentityMatch(identityArgs),
      (error) => {
        assert.match(error.message, /RELEASE_BUNDLE_STALE/);
        assert.match(error.message, /installed app MCP bundle/);
        assert.match(error.message, new RegExp(appDir.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
        assert.match(error.message, new RegExp(workspaceDir.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
        assert.match(error.message, /dist\/knowledge-notes\.js/);
        assert.match(error.message, /pnpm tauri build/);
        assert.match(error.message, /rerun the gate/);
        return true;
      },
    );

    // Post-`pnpm tauri build` state: identical runtime inputs must pass, and
    // the aggregate runtime-input identity must be equal on both sides.
    writeFileSync(join(appDir, "dist/knowledge-notes.js"), "export const notes = 'new build';\n");
    const matched = assertBundleIdentityMatch(identityArgs);
    assert.equal(matched.match, true);
    assert.equal(matched.appIdentity.runtimeInputDigest, matched.workspaceIdentity.runtimeInputDigest);
    assert.match(matched.workspaceIdentity.runtimeInputDigest, /^[a-f0-9]{64}$/);
    assert.equal(matched.workspaceIdentity.fileCount, 2);

    // Model identity is a separate deterministic input: a stale embedded model
    // manifest must fail closed with both paths and the same remediation.
    writeFileSync(join(appDir, modelManifest), '{"modelId":"old"}\n');
    writeFileSync(join(workspaceDir, modelManifest), '{"modelId":"new"}\n');
    assert.throws(
      () => assertEmbeddedModelIdentity({ appDir, workspaceDir, manifestRelativePath: modelManifest }),
      (error) => {
        assert.match(error.message, /RELEASE_BUNDLE_STALE/);
        assert.match(error.message, /embedding-model manifest/);
        assert.match(error.message, /pnpm tauri build/);
        return true;
      },
    );
    writeFileSync(join(appDir, modelManifest), '{"modelId":"new"}\n');
    const model = assertEmbeddedModelIdentity({ appDir, workspaceDir, manifestRelativePath: modelManifest });
    assert.equal(model.expectedModelHash, model.appModelHash);
    assert.match(model.expectedModelHash, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(appDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("built Tauri app passes the clean-install runtime identity gate", { skip: !existsSync(app) }, () => {
  const result = spawnSync(process.execPath, [join(root, "scripts/knowledge-release-bundle-gate.mjs")], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.checks.embeddedMcp.health.capabilityHash, report.expectedCapabilityHash);
  assert.equal(report.checks.launcherMcp.health.capabilityHash, report.expectedCapabilityHash);
  assert.equal(report.checks.embeddedMcp.health.runningBuildId, report.checks.launcherMcp.health.runningBuildId);
  const nativeNames = report.checks.tauriStartup.nativeDependencies.map((dependency) => dependency.name).sort();
  assert.deepEqual(nativeNames, [
    "better-sqlite3",
    "bundled-node",
    "embedding-model",
    "embedding-model-manifest",
    "embedding-tokenizer",
    "onnxruntime-node",
    "sharp",
    "sqlite-vec",
  ]);
  assert.ok(report.checks.tauriStartup.nativeDependencies.every((dependency) => dependency.status === "ready" && /^[a-f0-9]{64}$/.test(dependency.sha256)));
});
