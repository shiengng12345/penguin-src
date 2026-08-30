#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.env.PENGUIN_RUNTIME_ROOT ?? join(homedir(), ".penguin", "runtimes");

function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(78);
}

function resolveRuntime() {
  const current = resolve(root, "current");
  const manifestPath = existsSync(join(current, "manifest.json")) ? join(current, "manifest.json") : join(root, "manifest.json");
  if (!existsSync(manifestPath)) fail("RUNTIME_NOT_INSTALLED", `missing ${manifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail("RUNTIME_MANIFEST_INVALID", `cannot parse ${manifestPath}: ${error.message}`);
  }
  if (manifest.schemaVersion !== 1 || manifest.ready !== true || typeof manifest.buildId !== "string") {
    fail("RUNTIME_MANIFEST_INVALID", "manifest must contain schemaVersion=1, ready=true, and buildId");
  }
  if (!existsSync(current)) fail("RUNTIME_NOT_INSTALLED", `missing active runtime ${current}`);
  const relative = (value, fallback) => {
    const candidate = value ?? fallback;
    if (typeof candidate !== "string" || isAbsolute(candidate)) {
      fail("RUNTIME_MANIFEST_INVALID", `${fallback} must be a relative runtime path`);
    }
    const resolved = resolve(current, candidate);
    if (resolved !== current && !resolved.startsWith(`${current}/`)) {
      fail("RUNTIME_MANIFEST_INVALID", `${candidate} escapes active runtime`);
    }
    return resolved;
  };
  const node = relative(manifest.nodePath, "node");
  const cli = relative(manifest.cliEntry, "penguin.mjs");
  const wasm = relative(manifest.wasmPath, "wasm");
  if (!existsSync(node) || !existsSync(cli)) fail("RUNTIME_NOT_INSTALLED", `runtime ${manifest.buildId} is incomplete`);
  return { manifest, node, cli, wasm };
}

const runtime = resolveRuntime();
if (existsSync(runtime.wasm)) process.env.PENGUIN_WASM_DIR = runtime.wasm;
const result = spawnSync(runtime.node, [runtime.cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (result.error) fail("RUNTIME_LAUNCH_FAILED", result.error.message);
if (typeof result.status === "number") process.exitCode = result.status;
else if (result.signal) process.exitCode = 1;
