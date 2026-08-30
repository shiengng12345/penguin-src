import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
