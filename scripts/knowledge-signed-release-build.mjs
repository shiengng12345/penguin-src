#!/usr/bin/env node
/*
 * Signed release gate. The release environment injects
 * TAURI_SIGNING_PRIVATE_KEY; this script never prints or persists it.
 * Local validation should use the unsigned Tauri command instead.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const bundleRoot = join(root, "src-tauri", "target", "release", "bundle");
const result = {
  command: "pnpm tauri build",
  signingKeyPresent: Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY),
  bundleRoot,
};

function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

if (!result.signingKeyPresent) {
  result.ok = false;
  result.error = { code: "TAURI_SIGNING_KEY_REQUIRED", message: "TAURI_SIGNING_PRIVATE_KEY is required only in the release environment" };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} else {
  const build = spawnSync("pnpm", ["tauri", "build"], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = filesUnder(bundleRoot);
  const signatures = files.filter((path) => path.endsWith(".sig"));
  const updaterArchives = files.filter((path) => /\.(?:tar\.gz|zip)$/u.test(path));
  result.exitCode = build.status ?? 1;
  result.artifacts = {
    signatures: signatures.map((path) => path.replace(`${root}/`, "")),
    updaterArchives: updaterArchives.map((path) => path.replace(`${root}/`, "")),
  };
  result.outputTail = `${build.stdout ?? ""}${build.stderr ?? ""}`.trim().split("\n").slice(-30).join("\n");
  result.ok = result.exitCode === 0 && signatures.length > 0 && updaterArchives.length > 0;
  if (!result.ok) {
    result.error = {
      code: result.exitCode === 0 ? "TAURI_UPDATER_ARTIFACTS_MISSING" : "TAURI_SIGNED_BUILD_FAILED",
      message: result.exitCode === 0 ? "signed build completed without updater signature/archive artifacts" : "signed pnpm tauri build failed",
    };
    process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}
