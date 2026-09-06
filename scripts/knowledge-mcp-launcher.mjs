#!/usr/bin/env node
import { appendFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.env.PENGUIN_RUNTIME_ROOT ?? join(homedir(), ".penguin", "runtimes");

function validatedPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("OWNED_PROCESS_PID_INVALID");
  return pid;
}

function windowsTaskkillArgs(pid, force) {
  const target = validatedPid(pid);
  return ["/PID", String(target), "/T", ...(force ? ["/F"] : [])];
}

function posixProcessSnapshot() {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,lstart=,stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const records = new Map();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const state = match[5];
    records.set(pid, { pid, ppid, pgid: Number(match[3]), startIdentity: match[4], state, zombie: state.startsWith("Z") });
  }
  return records;
}

function verifiedDescendants(rootPid, records = posixProcessSnapshot()) {
  const root = validatedPid(rootPid);
  const children = new Map();
  for (const record of records.values()) {
    children.set(record.ppid, [...(children.get(record.ppid) ?? []), record.pid]);
  }
  const descendants = [];
  const visit = (pid, depth) => {
    for (const childPid of children.get(pid) ?? []) {
      if (childPid === root || descendants.some((entry) => entry.pid === childPid)) continue;
      const record = records.get(childPid);
      if (!record || record.zombie) continue;
      descendants.push({ ...record, depth });
      visit(childPid, depth + 1);
    }
  };
  visit(root, 1);
  return descendants.sort((left, right) => right.depth - left.depth || right.pid - left.pid);
}

export function sameProcessIdentity(expected, current) {
  return Boolean(expected && current
    && expected.pid === current.pid
    && expected.pgid === current.pgid
    && expected.startIdentity === current.startIdentity);
}

function processIsAlive(pid) {
  try {
    if (process.platform !== "win32") {
      const record = posixProcessSnapshot().get(pid);
      return Boolean(record && !record.zombie);
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH" && error?.status !== 1;
  }
}

function currentIdentity(expected) {
  const current = posixProcessSnapshot().get(expected.pid);
  return sameProcessIdentity(expected, current) && !current.zombie ? current : null;
}

function cleanupUnproven(code = "OWNED_PROCESS_TREE_CLEANUP_UNPROVEN") {
  return new Error(code);
}

function ownershipRegistry() {
  const path = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY;
  const token = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN;
  if (!path && !token) return null;
  if (!path || !token) throw cleanupUnproven();
  const stat = lstatSync(path);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || (uid != null && stat.uid !== uid)) {
    throw cleanupUnproven();
  }
  return { path, token, dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode & 0o777 };
}

function ownershipRecords(registry) {
  if (!registry) return [];
  const stat = lstatSync(registry.path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== registry.dev || stat.ino !== registry.ino
    || stat.uid !== registry.uid || (stat.mode & 0o777) !== registry.mode) throw cleanupUnproven();
  const content = readFileSync(registry.path, "utf8");
  if (content && !content.endsWith("\n")) throw cleanupUnproven();
  const records = [];
  for (const line of content.split(/\r?\n/u)) {
    if (!line) continue;
    let value;
    try { value = JSON.parse(line); }
    catch { throw cleanupUnproven(); }
    if (value?.version !== 1 || value?.token !== registry.token || typeof value.type !== "string") throw cleanupUnproven();
    if (value.controllerPid !== undefined && (!Number.isInteger(value.controllerPid) || value.controllerPid <= 1)) throw cleanupUnproven();
    if (value.type === "registry") {
      // Header record: token validation above binds all subsequent claims.
    } else if (value.type === "handoff") {
      if (!Number.isInteger(value.pid) || value.pid <= 1
        || !Number.isInteger(value.ppid) || value.ppid <= 1
        || !Number.isInteger(value.pgid) || value.pgid <= 1
        || typeof value.startIdentity !== "string" || !value.startIdentity) throw cleanupUnproven();
    } else if (value.type === "handoff-accepted") {
      if (!Number.isInteger(value.pid) || value.pid <= 1 || !Number.isInteger(value.pgid) || value.pgid <= 1
        || typeof value.startIdentity !== "string" || !value.startIdentity
        || typeof value.acceptanceId !== "string" || !value.acceptanceId) throw cleanupUnproven();
    } else if (value.type === "handoff-freeze" || value.type === "handoff-frozen") {
      if (!Number.isInteger(value.pid) || value.pid <= 1
        || typeof value.acceptanceId !== "string" || !value.acceptanceId
        || typeof value.freezeId !== "string" || !value.freezeId) throw cleanupUnproven();
      if (value.type === "handoff-frozen"
        && (!Number.isInteger(value.pgid) || value.pgid <= 1
          || typeof value.startIdentity !== "string" || !value.startIdentity)) throw cleanupUnproven();
    } else {
      throw cleanupUnproven();
    }
    records.push(value);
  }
  return records;
}

function handoffClaims(registry) {
  const records = new Map();
  for (const value of ownershipRecords(registry)) {
    if (value.type !== "handoff") continue;
    const record = { pid: value.pid, ppid: value.ppid, pgid: value.pgid, startIdentity: value.startIdentity,
      state: "handoff", zombie: false, controllerPid: value.controllerPid ?? null };
    const previous = records.get(record.pid);
    if (previous && !sameProcessIdentity(previous, record)) throw cleanupUnproven();
    records.set(record.pid, record);
  }
  return [...records.values()];
}

function appendOwnershipRecord(registry, record) {
  const before = lstatSync(registry.path);
  if (!before.isFile() || before.nlink !== 1 || before.dev !== registry.dev || before.ino !== registry.ino
    || before.uid !== registry.uid || (before.mode & 0o777) !== registry.mode) throw cleanupUnproven();
  appendFileSync(registry.path, `${JSON.stringify({ ...record, version: 1, token: registry.token })}\n`, { encoding: "utf8" });
  const after = lstatSync(registry.path);
  if (!after.isFile() || after.nlink !== 1 || after.dev !== registry.dev || after.ino !== registry.ino
    || after.uid !== registry.uid || (after.mode & 0o777) !== registry.mode) throw cleanupUnproven();
}

function isDescendant(rootPid, record, snapshot) {
  const seen = new Set();
  let cursor = record;
  while (cursor && cursor.pid !== rootPid && !seen.has(cursor.pid)) {
    seen.add(cursor.pid);
    cursor = snapshot.get(cursor.ppid);
  }
  return cursor?.pid === rootPid;
}

function observeOwnershipHandoffs(boundary) {
  if (!boundary.registry) return;
  const snapshot = posixProcessSnapshot();
  for (const claimed of handoffClaims(boundary.registry)) {
    if (claimed.controllerPid != null && claimed.controllerPid !== process.pid) continue;
    const accepted = boundary.handoffs.get(claimed.pid);
    if (accepted) {
      if (!sameProcessIdentity(accepted, claimed)) throw cleanupUnproven();
      continue;
    }
    const current = snapshot.get(claimed.pid);
    if (!current || !sameProcessIdentity(claimed, current) || !isDescendant(boundary.root.pid, current, snapshot)
      || current.pgid !== current.pid) throw cleanupUnproven("OWNERSHIP_HANDOFF_UNPROVEN");
    const acceptance = { ...current, acceptanceId: randomUUID(), freezeId: null };
    appendOwnershipRecord(boundary.registry, {
      type: "handoff-accepted", pid: current.pid, pgid: current.pgid,
      startIdentity: current.startIdentity, acceptanceId: acceptance.acceptanceId, controllerPid: process.pid,
    });
    boundary.handoffs.set(current.pid, acceptance);
  }
}

function rememberGroupMembers(boundary, snapshot) {
  for (const record of snapshot.values()) {
    if (!record.zombie && record.pgid === boundary.pgid) boundary.observed.set(record.pid, record);
  }
}

function verifyOwnedBoundary(boundary) {
  const snapshot = posixProcessSnapshot();
  const rootRecord = snapshot.get(boundary.root.pid);
  const launcherRecord = snapshot.get(process.pid);
  if (!sameProcessIdentity(boundary.root, rootRecord)
    || rootRecord.pgid !== boundary.root.pid
    || !launcherRecord
    || launcherRecord.pgid === rootRecord.pgid) {
    throw new Error("OWNED_PROCESS_GROUP_UNVERIFIED");
  }
  const escaped = verifiedDescendants(boundary.root.pid, snapshot)
    .filter((record) => record.pgid !== boundary.pgid);
  rememberGroupMembers(boundary, snapshot);
  for (const record of escaped) {
    const accepted = boundary.handoffs.get(record.pid);
    const acceptedGroup = [...boundary.handoffs.values()].find((candidate) => candidate.pgid === record.pgid);
    const sentinel = acceptedGroup ? snapshot.get(acceptedGroup.pid) : null;
    const groupIsPinned = Boolean(acceptedGroup
      && sameProcessIdentity(acceptedGroup, sentinel)
      && sentinel.pgid === sentinel.pid);
    if ((!accepted || !sameProcessIdentity(accepted, record)) && !groupIsPinned) throw cleanupUnproven();
  }
  return { snapshot, escaped };
}

async function createOwnedBoundary(child, registry) {
  const rootPid = validatedPid(child.pid);
  if (process.platform === "win32") return { root: { pid: rootPid }, pgid: null, observed: new Map(), registry, handoffs: new Map(), registryError: null };
  let rootRecord = null;
  const found = await waitUntil(() => {
    rootRecord = posixProcessSnapshot().get(rootPid) ?? null;
    return child.exitCode !== null || child.signalCode !== null || Boolean(rootRecord);
  }, 500);
  if (!found || !rootRecord || rootRecord.zombie) {
    // A short-lived runtime may have exited between the spawn and the first
    // observable process snapshot. There is no live tree left to own in that
    // case; let the child exit result decide the launch outcome instead of
    // turning a successful standalone invocation into a boundary error.
    if (child.exitCode !== null || child.signalCode !== null || !processIsAlive(rootPid)) return null;
    throw new Error("OWNED_PROCESS_GROUP_UNVERIFIED");
  }
  const launcherRecord = posixProcessSnapshot().get(process.pid);
  if (rootRecord.pgid !== rootPid || !launcherRecord || launcherRecord.pgid === rootRecord.pgid) {
    throw new Error("OWNED_PROCESS_GROUP_UNVERIFIED");
  }
  return { root: rootRecord, pgid: rootRecord.pgid, observed: new Map([[rootPid, rootRecord]]), registry, handoffs: new Map(), registryError: null };
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

async function freezeAcceptedHandoffs(boundary, timeoutMs) {
  if (boundary.handoffs.size === 0) return true;
  if (!boundary.registry) return false;
  for (const accepted of boundary.handoffs.values()) {
    accepted.freezeId ??= randomUUID();
    appendOwnershipRecord(boundary.registry, {
      type: "handoff-freeze", pid: accepted.pid,
      acceptanceId: accepted.acceptanceId, freezeId: accepted.freezeId, controllerPid: process.pid,
    });
  }
  return waitUntil(() => {
    const records = ownershipRecords(boundary.registry);
    const snapshot = posixProcessSnapshot();
    return [...boundary.handoffs.values()].every((accepted) => {
      const frozen = records.find((record) => record.type === "handoff-frozen"
        && record.pid === accepted.pid
        && record.acceptanceId === accepted.acceptanceId
        && record.freezeId === accepted.freezeId
        && record.pgid === accepted.pgid
        && record.startIdentity === accepted.startIdentity);
      const current = snapshot.get(accepted.pid);
      return Boolean(frozen && sameProcessIdentity(accepted, current)
        && current.pgid === current.pid && current.state.startsWith("T"));
    });
  }, timeoutMs);
}

async function freezeDirectProcessGroup(child, boundary, timeoutMs) {
  if (child.pid !== boundary.root.pid || child.exitCode !== null || child.signalCode !== null) return null;
  const before = posixProcessSnapshot();
  const root = before.get(boundary.root.pid);
  const caller = before.get(process.pid);
  if (!sameProcessIdentity(boundary.root, root) || root.ppid !== process.pid
    || root.pgid !== root.pid || !caller || caller.pgid === root.pgid) return null;
  if (!child.kill("SIGSTOP")) return null;
  const rootFrozen = await waitUntil(() => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    const current = posixProcessSnapshot().get(boundary.root.pid);
    return Boolean(sameProcessIdentity(boundary.root, current)
      && current.ppid === process.pid && current.pgid === current.pid && current.state.startsWith("T"));
  }, timeoutMs);
  if (!rootFrozen) return null;
  process.kill(-boundary.pgid, "SIGSTOP");
  const groupFrozen = await waitUntil(() => {
    const snapshot = posixProcessSnapshot();
    const members = [...snapshot.values()].filter((record) => record.pgid === boundary.pgid);
    const currentRoot = snapshot.get(boundary.root.pid);
    return members.length > 0
      && Boolean(sameProcessIdentity(boundary.root, currentRoot) && currentRoot.ppid === process.pid)
      && members.every((record) => record.state.startsWith("T"));
  }, timeoutMs);
  if (!groupFrozen) return null;
  observeOwnershipHandoffs(boundary);
  verifyOwnedBoundary(boundary);
  return posixProcessSnapshot();
}

function registerUpstreamDirectHandoff(registry, boundary) {
  if (!registry) return null;
  const controllerPid = Number(process.env.PENGUIN_RUNTIME_OWNERSHIP_CONTROLLER_PID);
  if (!Number.isInteger(controllerPid) || controllerPid <= 1 || controllerPid === process.pid) return null;
  appendOwnershipRecord(registry, {
    type: "handoff", controllerPid,
    pid: boundary.root.pid, ppid: boundary.root.ppid, pgid: boundary.root.pgid,
    startIdentity: boundary.root.startIdentity,
  });
  return { controllerPid, acceptanceId: null, freezeTask: null };
}

function pollUpstreamDirectHandoff(child, boundary, registry, upstream) {
  const records = ownershipRecords(registry);
  if (!upstream.acceptanceId) {
    const accepted = records.find((record) => record.type === "handoff-accepted"
      && record.controllerPid === upstream.controllerPid
      && record.pid === boundary.root.pid && record.pgid === boundary.root.pgid
      && record.startIdentity === boundary.root.startIdentity
      && typeof record.acceptanceId === "string");
    if (accepted) upstream.acceptanceId = accepted.acceptanceId;
  }
  if (!upstream.acceptanceId || upstream.freezeTask) return;
  const request = records.find((record) => record.type === "handoff-freeze"
    && record.controllerPid === upstream.controllerPid
    && record.pid === boundary.root.pid
    && record.acceptanceId === upstream.acceptanceId
    && typeof record.freezeId === "string");
  if (!request) return;
  upstream.freezeTask = (async () => {
    const frozen = await freezeDirectProcessGroup(child, boundary, 2_000);
    if (!frozen) throw cleanupUnproven();
    appendOwnershipRecord(registry, {
      type: "handoff-frozen", controllerPid: upstream.controllerPid,
      pid: boundary.root.pid, pgid: boundary.root.pgid, startIdentity: boundary.root.startIdentity,
      acceptanceId: upstream.acceptanceId, freezeId: request.freezeId,
    });
  })().catch((error) => { boundary.registryError ??= error; });
}

async function terminateOwnedProcessTree(child, options = {}) {
  const rootPid = validatedPid(child.pid);
  const signal = options.signal ?? "SIGTERM";
  const graceMs = Math.min(15_000, Math.max(50, Number(options.graceMs) || 7_500));
  const boundary = options.boundary;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", windowsTaskkillArgs(rootPid, false), { stdio: "ignore" }); } catch { /* proof below decides */ }
    if (!await waitUntil(() => !processIsAlive(rootPid), graceMs)) {
      try { execFileSync("taskkill", windowsTaskkillArgs(rootPid, true), { stdio: "ignore" }); } catch { /* explicit unverified result below */ }
      await waitUntil(() => !processIsAlive(rootPid), 2_000);
    }
    throw new Error("WINDOWS_PROCESS_TREE_CLEANUP_NOT_PROVEN");
  }
  if (!boundary) throw new Error("OWNED_PROCESS_GROUP_UNVERIFIED");
  let ownershipFailure = boundary.registryError;
  try { observeOwnershipHandoffs(boundary); }
  catch (error) { ownershipFailure = error; }
  if (ownershipFailure) throw cleanupUnproven(ownershipFailure.message);
  const { escaped } = verifyOwnedBoundary(boundary);
  for (const record of escaped) boundary.observed.set(record.pid, record);
  const freezeTimeoutMs = Math.min(2_000, Math.max(500, graceMs));
  if (!await freezeAcceptedHandoffs(boundary, freezeTimeoutMs)) throw cleanupUnproven();
  const frozenSnapshot = await freezeDirectProcessGroup(child, boundary, freezeTimeoutMs);
  if (!frozenSnapshot) throw cleanupUnproven();
  const directMembers = [...frozenSnapshot.values()].filter((record) => record.pgid === boundary.pgid);
  const directSentinel = directMembers.find((record) => record.pid !== boundary.root.pid) ?? null;
  process.kill(-boundary.pgid, signal);
  for (const record of directMembers) {
    if (record.pid === directSentinel?.pid) continue;
    if (record.pid === boundary.root.pid) child.kill("SIGCONT");
    else process.kill(record.pid, "SIGCONT");
  }
  await waitUntil(() => {
    const snapshot = posixProcessSnapshot();
    return ![...snapshot.values()].some((record) => record.pgid === boundary.pgid && record.pid !== directSentinel?.pid);
  }, graceMs);
  let snapshot = posixProcessSnapshot();
  if ([...snapshot.values()].some((record) => record.pgid === boundary.pgid)) {
    if (directSentinel) {
      const sentinel = snapshot.get(directSentinel.pid);
      if (!sameProcessIdentity(directSentinel, sentinel) || !sentinel.state.startsWith("T")) ownershipFailure ??= cleanupUnproven();
    } else {
      const refrozen = await freezeDirectProcessGroup(child, boundary, freezeTimeoutMs);
      if (!refrozen) ownershipFailure ??= cleanupUnproven();
      snapshot = refrozen ?? snapshot;
    }
    if (!ownershipFailure) process.kill(-boundary.pgid, "SIGKILL");
  }
  for (const accepted of boundary.handoffs.values()) {
    snapshot = posixProcessSnapshot();
    if (![...snapshot.values()].some((record) => record.pgid === accepted.pgid)) continue;
    const sentinel = snapshot.get(accepted.pid);
    if (!sameProcessIdentity(accepted, sentinel) || sentinel.pgid !== sentinel.pid || !sentinel.state.startsWith("T")) {
      ownershipFailure ??= cleanupUnproven();
      continue;
    }
    process.kill(-accepted.pgid, "SIGKILL");
  }
  const allExited = await waitUntil(
    () => {
      const snapshot = posixProcessSnapshot();
      return ![...snapshot.values()].some((record) => record.pgid === boundary.pgid)
        && [...boundary.handoffs.values()].every((record) => ![...snapshot.values()].some((current) => current.pgid === record.pgid));
    },
    2_000,
  );
  if (ownershipFailure) throw cleanupUnproven(ownershipFailure.message);
  if (!allExited) throw cleanupUnproven();
}


function fail(code, message) {
  process.stderr.write(`${code}: ${message}\n`);
  process.exit(78);
}

function resolveRuntime() {
  const currentLink = resolve(root, "current");
  if (!existsSync(currentLink)) fail("RUNTIME_NOT_INSTALLED", `missing active runtime ${currentLink}`);
  let current;
  try { current = realpathSync(currentLink); }
  catch (error) { fail("RUNTIME_NOT_INSTALLED", `cannot resolve active runtime ${currentLink}: ${error.message}`); }
  const generationManifestPath = join(current, "manifest.json");
  // Current generations carry an immutable manifest. Keep a narrowly scoped
  // compatibility read for the older owner-managed layout, where only the
  // root manifest existed. It is accepted only when it names the already
  // selected `current` generation, so it cannot select or repair another build.
  const legacyManifestPath = join(root, "manifest.json");
  const manifestPath = existsSync(generationManifestPath)
    ? generationManifestPath
    : existsSync(legacyManifestPath)
      ? legacyManifestPath
      : null;
  if (!manifestPath) fail("RUNTIME_NOT_INSTALLED", `missing ${generationManifestPath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail("RUNTIME_MANIFEST_INVALID", `cannot parse ${manifestPath}: ${error.message}`);
  }
  if (
    manifest.schemaVersion !== 1
    || manifest.ready !== true
    || typeof manifest.buildId !== "string" || !manifest.buildId
    || typeof manifest.appVersion !== "string" || !manifest.appVersion
    || !/^[a-f0-9]{64}$/i.test(manifest.capabilityHash ?? "")
    || !Number.isInteger(manifest.contractSchemaVersion) || manifest.contractSchemaVersion <= 0
    || typeof manifest.contractVersion !== "string" || !manifest.contractVersion
    || !/^[a-f0-9]{64}$/i.test(manifest.modelHash ?? "")
  ) {
    fail("RUNTIME_MANIFEST_INVALID", "manifest identity requires schemaVersion=1, ready=true, buildId, appVersion, capabilityHash, contractSchemaVersion, contractVersion, and modelHash");
  }
  if (manifestPath === legacyManifestPath && manifest.buildId !== basename(current)) {
    fail("RUNTIME_MANIFEST_INVALID", "legacy manifest buildId does not match the active generation");
  }
  const relative = (value, fallback) => {
    const candidate = value ?? fallback;
    if (typeof candidate !== "string" || isAbsolute(candidate)) {
      fail("RUNTIME_MANIFEST_INVALID", `${fallback} must be a relative runtime path`);
    }
    const resolved = resolve(current, candidate);
    if (resolved !== current && !resolved.startsWith(`${current}/`)) {
      fail("RUNTIME_MANIFEST_INVALID", `${candidate} escapes active runtime`);
    }
    try {
      const pinned = realpathSync(resolved);
      if (pinned !== current && !pinned.startsWith(`${current}/`)) {
        fail("RUNTIME_MANIFEST_INVALID", `${candidate} escapes active runtime`);
      }
      return pinned;
    } catch (error) {
      fail("RUNTIME_NOT_INSTALLED", `runtime ${manifest.buildId} is incomplete: ${error.message}`);
    }
  };
  const node = relative(manifest.nodePath, "node");
  const mcp = relative(manifest.mcpEntry, "mcp/dist/index.js");
  const wasm = relative(manifest.wasmPath, "wasm");
  if (!existsSync(node) || !existsSync(mcp)) fail("RUNTIME_NOT_INSTALLED", `runtime ${manifest.buildId} is incomplete`);
  return { manifest, node, mcp, wasm };
}

async function main() {
const runtime = resolveRuntime();
process.env.PENGUIN_BUILD_ID = runtime.manifest.buildId;
process.env.PENGUIN_APP_VERSION = runtime.manifest.appVersion;
process.env.PENGUIN_CAPABILITY_HASH = runtime.manifest.capabilityHash;
process.env.PENGUIN_SCHEMA_VERSION = String(runtime.manifest.contractSchemaVersion);
process.env.PENGUIN_CONTRACT_VERSION = runtime.manifest.contractVersion;
process.env.PENGUIN_MODEL_HASH = runtime.manifest.modelHash;
if (existsSync(runtime.wasm)) process.env.PENGUIN_WASM_DIR = runtime.wasm;
process.env.PENGUIN_RUNTIME_PROCESS_BOUNDARY = "launcher-owned-process-group";
const configuredGrace = Number.parseInt(process.env.PENGUIN_LAUNCHER_TERMINATION_GRACE_MS ?? "7500", 10);
const terminationGraceMs = Number.isFinite(configuredGrace) ? Math.min(15_000, Math.max(50, configuredGrace)) : 7_500;
const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
let child = null;
let boundary = null;
let termination = null;
let pendingSignal = null;
let ownershipMonitor = null;
const forwardSignal = (signal) => {
  if (termination || (child && (child.exitCode !== null || child.signalCode !== null))) return;
  if (!child || !boundary) { pendingSignal ??= signal; return; }
  termination = terminateOwnedProcessTree(child, { signal, graceMs: terminationGraceMs, boundary });
};
const signalHandlers = new Map(signals.map((signal) => [signal, () => forwardSignal(signal)]));
for (const [signal, handler] of signalHandlers) process.on(signal, handler);
try {
  const registry = ownershipRegistry();
  const childEnv = { ...process.env, PENGUIN_RUNTIME_OWNERSHIP_CONTROLLER_PID: String(process.pid) };
  child = spawn(runtime.node, [runtime.mcp, ...process.argv.slice(2)], {
    cwd: process.cwd(), env: childEnv, stdio: "inherit", detached: process.platform !== "win32",
  });
  const resultPromise = new Promise((resolveResult) => {
    child.once("error", (error) => resolveResult({ error }));
    child.once("exit", (status, signal) => resolveResult({ status, signal }));
  });
  boundary = await createOwnedBoundary(child, registry);
  const upstreamHandoff = boundary ? registerUpstreamDirectHandoff(registry, boundary) : null;
  if (boundary?.registry) {
    ownershipMonitor = setInterval(() => {
      try {
        observeOwnershipHandoffs(boundary);
        if (upstreamHandoff) pollUpstreamDirectHandoff(child, boundary, registry, upstreamHandoff);
      }
      catch (error) { boundary.registryError ??= error; }
    }, 10);
    ownershipMonitor.unref();
  }
  if (pendingSignal) forwardSignal(pendingSignal);
  const result = await resultPromise;
  let terminationError = null;
  if (termination) {
    try { await termination; }
    catch (error) { terminationError = error; }
  }
  if (terminationError) fail("RUNTIME_TERMINATION_FAILED", terminationError.message);
  if (result.error) fail("RUNTIME_LAUNCH_FAILED", result.error.message);
  if (typeof result.status === "number") process.exitCode = result.status;
  else if (result.signal) process.exitCode = 1;
} finally {
  if (ownershipMonitor) clearInterval(ownershipMonitor);
  for (const [signal, handler] of signalHandlers) process.off(signal, handler);
}
}

// macOS may expose /var as a symlink to /private/var.  Compare canonical
// inodes so a copied installed launcher still enters its main path when the
// caller invokes it through either spelling.
let isMain = false;
try {
  isMain = Boolean(process.argv[1])
    && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch { /* imported as a module or entry path disappeared */ }
if (isMain) await main();
