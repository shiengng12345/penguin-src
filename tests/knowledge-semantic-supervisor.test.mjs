import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { KnowledgeStore, embeddingSpaceIdentity } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { ensureSemanticWorker, runSemanticWorker } from "../packages/knowledge-cli/dist/index.js";

const runtimeIdentity = (overrides = {}) => ({
  buildId: "build-a",
  capabilityHash: "a".repeat(64),
  schemaVersion: 18,
  modelHash: "b".repeat(64),
  ...overrides,
});

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    const state = execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch {
    return false;
  }
}

function processIdentity(pid) {
  const row = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,stat=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/u.exec(row);
  assert.ok(match && !match[5].startsWith("Z"), `process identity unavailable: ${row}`);
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startIdentity: match[4] };
}

async function waitForFile(path, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForProcessExit(pid, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (processIsRunning(pid)) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "penguin-worker-repo-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const fileCount = options.fileCount ?? 1;
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(join(root, "src", `worker-${index}.ts`), `export const backgroundSemanticWorker${index} = 'durable-${index}';\n`);
  }
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Penguin Test",
    GIT_AUTHOR_EMAIL: "penguin@example.invalid",
    GIT_COMMITTER_NAME: "Penguin Test",
    GIT_COMMITTER_EMAIL: "penguin@example.invalid",
  };
  execFileSync("git", ["init", "-q", "-b", "main", root], { env });
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env });
  const directory = mkdtempSync(join(tmpdir(), "penguin-worker-db-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const space = embeddingSpaceIdentity({
    providerId: "fixture",
    modelId: "worker",
    weightsDigest: "1".repeat(64),
    tokenizerDigest: "2".repeat(64),
    dimensions: 2,
    pooling: "mean",
    normalization: "none",
    chunkerVersion: "semantic-chunker-v1",
  });
  const report = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: true, space } });
  const provider = {
    id: "fixture",
    modelId: "worker",
    modelHash: space.identityHash,
    dimensions: 2,
    maxTokens: 128,
    async embedDocuments(values) { return values.map(() => new Float32Array([1, 0])); },
    async embed(values) { return values.map(() => new Float32Array([1, 0])); },
  };
  return { root, directory, dbPath, ledgerPath, store, space, report, provider };
}

test("two worker starts produce one lease owner and one clean no-op loser", async () => {
  const value = await fixture();
  let releaseProvider;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const blockedProvider = {
    ...value.provider,
    async embedDocuments(values) {
      providerStarted();
      await new Promise((resolve) => { releaseProvider = resolve; });
      return values.map(() => new Float32Array([1, 0]));
    },
  };
  const first = runSemanticWorker({ store: value.store, ownerId: "worker-a", buildId: "build-a", providerFactory: async () => blockedProvider });
  await started;
  const secondStore = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
  const second = await runSemanticWorker({ store: secondStore, ownerId: "worker-b", buildId: "build-a", providerFactory: async () => value.provider });
  assert.equal(second.status, "already_running");
  releaseProvider();
  assert.equal((await first).status, "drained");
  assert.equal(value.store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(value.report.semantic.generationId).status, "active");
  secondStore.close();
  value.store.close();
});

test("an already_running worker terminal return removes only its own ownership registry", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const sentinel = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const registry = join(value.directory, "already-running.owners");
  const token = "already-running-registry-token";
  writeFileSync(registry, `${JSON.stringify({ type: "registry", version: 1, token })}\n`);
  chmodSync(registry, 0o600);
  const registryStat = statSync(registry);
  const keys = [
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY",
    "PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_DEV",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_INO",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_UID",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_MODE",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  try {
    const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
    const ownerIdentity = processIdentity(sentinel.pid);
    const timestamp = new Date().toISOString();
    value.store.db.prepare(`
      INSERT INTO semantic_worker_leases(lock_name,owner_id,owner_pid,build_id,heartbeat_at,lease_expires_at)
      VALUES ('semantic-drain','incumbent-owner',?,?,?,?)
    `).run(sentinel.pid, identity.buildId, timestamp, new Date(Date.now() + 90_000).toISOString());
    value.store.db.prepare("INSERT INTO meta(key,value) VALUES ('semantic_worker_runtime',?)").run(JSON.stringify({
      status: "running", reason: null, remediation: null, identity,
      ownerId: "incumbent-owner", ownerPid: sentinel.pid, startToken: "incumbent-token",
      ownerProcessIdentity: ownerIdentity, updatedAt: timestamp,
    }));
    Object.assign(process.env, {
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY: registry,
      PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN: token,
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_DEV: String(registryStat.dev),
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_INO: String(registryStat.ino),
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_UID: String(registryStat.uid),
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_MODE: String(registryStat.mode & 0o777),
    });
    const result = await runSemanticWorker({
      store: value.store,
      ownerId: "losing-owner",
      runtimeIdentity: identity,
      expectedRuntimeIdentity: identity,
      providerFactory: async () => value.provider,
    });
    assert.equal(result.status, "already_running");
    assert.equal(existsSync(registry), false, "terminal no-op must not leak its own registry");
  } finally {
    for (const key of keys) {
      const oldValue = previous.get(key);
      if (oldValue === undefined) delete process.env[key];
      else process.env[key] = oldValue;
    }
    rmSync(registry, { force: true });
    if (processIsRunning(sentinel.pid)) process.kill(sentinel.pid, "SIGKILL");
    value.store.close();
  }
});

test("terminal worker cleanup preserves a replacement at its former ownership registry path", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const registry = join(value.directory, "replaceable.owners");
  const movedRegistry = `${registry}.moved`;
  const token = "replaceable-registry-token";
  writeFileSync(registry, `${JSON.stringify({ type: "registry", version: 1, token })}\n`);
  chmodSync(registry, 0o600);
  const registryStat = statSync(registry);
  const ownedRegistryBytes = readFileSync(registry);
  const keys = [
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY",
    "PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_DEV",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_INO",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_UID",
    "PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_MODE",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  let providerStarted;
  let releaseProvider;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const blockedProvider = {
    ...value.provider,
    async embedDocuments(values) {
      providerStarted();
      await new Promise((resolve) => { releaseProvider = resolve; });
      return values.map(() => new Float32Array([1, 0]));
    },
  };
  try {
    Object.assign(process.env, {
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY: registry,
      PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN: token,
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_DEV: String(registryStat.dev),
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_INO: String(registryStat.ino),
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_UID: String(registryStat.uid),
      PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY_MODE: String(registryStat.mode & 0o777),
    });
    const worker = runSemanticWorker({
      store: value.store,
      ownerId: "registry-owner",
      runtimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      providerFactory: async () => blockedProvider,
      onBeforeOwnershipRegistryQuarantine(path) {
        assert.equal(path, registry);
        renameSync(registry, movedRegistry);
        writeFileSync(registry, "foreign replacement\n");
        chmodSync(registry, 0o600);
      },
    });
    await started;
    releaseProvider();
    assert.equal((await worker).status, "drained");
    assert.equal(readFileSync(registry, "utf8"), "foreign replacement\n", "cleanup must not delete a different inode at the owned path");
    assert.deepEqual(readFileSync(movedRegistry), ownedRegistryBytes, "the displaced owned registry must not be silently deleted");
  } finally {
    releaseProvider?.();
    for (const key of keys) {
      const oldValue = previous.get(key);
      if (oldValue === undefined) delete process.env[key];
      else process.env[key] = oldValue;
    }
    rmSync(registry, { force: true });
    rmSync(movedRegistry, { force: true });
    value.store.close();
  }
});

test("early registry setup cleanup quarantines atomically and preserves a final-window replacement", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const logPath = join(value.directory, "early-registry-cleanup.log");
  let registryPath = null;
  let displacedPath = null;
  let ownedRegistryBytes = null;

  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: join(value.directory, "must-not-launch"),
      logPath,
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      onOwnershipRegistryCreated(path) {
        registryPath = path;
        displacedPath = `${path}.displaced`;
        ownedRegistryBytes = readFileSync(path);
        throw new Error("force setup failure after registry creation");
      },
      onBeforeOwnershipRegistryQuarantine(path) {
        assert.equal(path, registryPath);
        renameSync(path, displacedPath);
        writeFileSync(path, "foreign early replacement\n");
        chmodSync(path, 0o600);
      },
    });

    assert.equal(result.status, "start_failed");
    assert.equal(result.reason, "SEMANTIC_WORKER_OWNERSHIP_REGISTRY_FAILED");
    assert.ok(registryPath);
    assert.equal(readFileSync(registryPath, "utf8"), "foreign early replacement\n");
    assert.deepEqual(readFileSync(displacedPath), ownedRegistryBytes, "early setup must preserve its displaced owned artifact");
  } finally {
    if (registryPath) rmSync(registryPath, { force: true });
    if (displacedPath) rmSync(displacedPath, { force: true });
    value.store.close();
  }
});

test("a loser worker cannot overwrite the live lease owner's runtime identity", async () => {
  const value = await fixture();
  let releaseProvider;
  let providerStarted;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const blockedProvider = {
    ...value.provider,
    async embedDocuments(values) {
      providerStarted();
      await new Promise((resolve) => { releaseProvider = resolve; });
      return values.map(() => new Float32Array([1, 0]));
    },
  };
  const oldIdentity = runtimeIdentity({ buildId: "old-build", modelHash: value.provider.modelHash });
  const newIdentity = runtimeIdentity({ buildId: "new-build", modelHash: value.provider.modelHash });
  const first = runSemanticWorker({ store: value.store, ownerId: "old-owner", runtimeIdentity: oldIdentity, expectedRuntimeIdentity: oldIdentity, providerFactory: async () => blockedProvider });
  await started;
  const secondStore = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
  const second = await runSemanticWorker({ store: secondStore, ownerId: "new-loser", runtimeIdentity: newIdentity, expectedRuntimeIdentity: newIdentity, providerFactory: async () => value.provider });
  assert.equal(second.status, "already_running");
  const lease = secondStore.db.prepare("SELECT build_id AS buildId,owner_id AS ownerId FROM semantic_worker_leases").get();
  assert.deepEqual(lease, { buildId: "old-build", ownerId: "old-owner" });
  const persisted = JSON.parse(secondStore.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value);
  assert.equal(persisted.identity.buildId, "old-build");
  const ensured = ensureSemanticWorker({ store: secondStore, expectedRuntimeIdentity: newIdentity, launcherPath: join(value.directory, "missing") });
  assert.equal(ensured.status, "version_mismatch");
  releaseProvider();
  await first;
  secondStore.close();
  value.store.close();
});

test("a stale runtime mismatch cannot overwrite a fully validated live winner", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const winner = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const winnerIdentity = runtimeIdentity({ buildId: "winner-b", modelHash: value.provider.modelHash });
    const staleIdentity = runtimeIdentity({ buildId: "stale-a", modelHash: value.provider.modelHash });
    const timestamp = new Date().toISOString();
    const winnerState = JSON.stringify({
      status: "running", reason: null, remediation: null, identity: winnerIdentity,
      ownerId: "winner-owner", ownerPid: winner.pid, startToken: "winner-token",
      ownerProcessIdentity: processIdentity(winner.pid), updatedAt: timestamp,
    });
    value.store.db.prepare(`
      INSERT INTO semantic_worker_leases(lock_name,owner_id,owner_pid,build_id,heartbeat_at,lease_expires_at)
      VALUES ('semantic-drain','winner-owner',?,?,?,?)
    `).run(winner.pid, winnerIdentity.buildId, timestamp, new Date(Date.now() + 90_000).toISOString());
    value.store.db.prepare("INSERT INTO meta(key,value) VALUES ('semantic_worker_runtime',?)").run(winnerState);

    const result = await runSemanticWorker({
      store: value.store,
      ownerId: "stale-owner",
      runtimeIdentity: staleIdentity,
      expectedRuntimeIdentity: winnerIdentity,
      providerFactory: async () => value.provider,
    });

    assert.equal(result.status, "already_running");
    assert.equal(result.reason, null);
    assert.equal(
      value.store.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value,
      winnerState,
      "stale mismatch must leave the winner runtime byte-equivalent",
    );
    assert.deepEqual(
      value.store.db.prepare("SELECT owner_id AS ownerId,owner_pid AS ownerPid,build_id AS buildId FROM semantic_worker_leases WHERE lock_name='semantic-drain'").get(),
      { ownerId: "winner-owner", ownerPid: winner.pid, buildId: "winner-b" },
    );
  } finally {
    if (processIsRunning(winner.pid)) process.kill(winner.pid, "SIGKILL");
    value.store.close();
  }
});

test("an unexpired lease with missing, unassociated, or incomparable owner identity fails closed", async () => {
  if (process.platform === "win32") return;
  for (const variant of ["missing", "unassociated", "incomparable"]) {
    const value = await fixture();
    const sentinel = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    try {
      const ownerIdentity = processIdentity(sentinel.pid);
      const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
      const leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
      value.store.db.prepare(`
        INSERT INTO semantic_worker_leases(lock_name,owner_id,owner_pid,build_id,heartbeat_at,lease_expires_at)
        VALUES ('semantic-drain','uncertain-owner',?,?,?,?)
      `).run(sentinel.pid, identity.buildId, new Date().toISOString(), leaseExpiresAt);
      value.store.db.prepare("INSERT INTO meta(key,value) VALUES ('semantic_worker_runtime',?)").run(JSON.stringify({
        status: "running", reason: null, remediation: null, identity,
        ownerId: variant === "unassociated" ? "different-owner" : "uncertain-owner",
        ownerPid: sentinel.pid,
        startToken: "uncertain-token",
        ...(variant === "missing" ? {} : {
          ownerProcessIdentity: variant === "incomparable" ? { ...ownerIdentity, startIdentity: "" } : ownerIdentity,
        }),
        updatedAt: new Date().toISOString(),
      }));

      const result = await runSemanticWorker({
        store: value.store,
        ownerId: `replacement-${variant}`,
        runtimeIdentity: identity,
        expectedRuntimeIdentity: identity,
        providerFactory: async () => value.provider,
      });

      assert.equal(result.status, "stalled", variant);
      assert.equal(result.reason, "WORKER_OWNER_IDENTITY_UNPROVEN", variant);
      assert.equal(value.store.db.prepare("SELECT owner_id AS ownerId FROM semantic_worker_leases WHERE lock_name='semantic-drain'").get().ownerId, "uncertain-owner");
      assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running'").get().n, 0);
    } finally {
      if (processIsRunning(sentinel.pid)) process.kill(sentinel.pid, "SIGKILL");
      value.store.close();
    }
  }
});

test("supervisor does not accept an unexpired live PID without a fully associated persisted identity", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-uncertain-owner-"));
  const launcher = join(processDir, "must-not-launch.sh");
  const launched = join(processDir, "launched");
  const sentinel = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  writeFileSync(launcher, `#!/bin/sh\nprintf launched > ${JSON.stringify(launched)}\n`);
  chmodSync(launcher, 0o755);
  try {
    const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
    const leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
    value.store.db.prepare(`
      INSERT INTO semantic_worker_leases(lock_name,owner_id,owner_pid,build_id,heartbeat_at,lease_expires_at)
      VALUES ('semantic-drain','shortcut-owner',?,?,?,?)
    `).run(sentinel.pid, identity.buildId, new Date().toISOString(), leaseExpiresAt);
    const winnerState = JSON.stringify({
      status: "running", reason: null, remediation: null, identity,
      ownerId: "shortcut-owner", ownerPid: sentinel.pid, startToken: "shortcut-token",
      ownerProcessIdentity: null, updatedAt: new Date().toISOString(),
    });
    value.store.db.prepare("INSERT INTO meta(key,value) VALUES ('semantic_worker_runtime',?)").run(winnerState);

    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: identity,
    });

    assert.equal(result.status, "start_failed");
    assert.equal(result.reason, "SEMANTIC_WORKER_OWNER_IDENTITY_UNPROVEN");
    assert.equal(existsSync(launched), false, "unknown ownership must wait for lease expiry instead of spawning");
    assert.equal(value.store.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value, winnerState, "fail-closed shortcut must not overwrite the existing runtime");
  } finally {
    if (processIsRunning(sentinel.pid)) process.kill(sentinel.pid, "SIGKILL");
    value.store.close();
  }
});

test("version mismatch fails closed before claiming jobs", async () => {
  const value = await fixture();
  const result = await runSemanticWorker({
    store: value.store,
    ownerId: "old-worker",
    runtimeIdentity: runtimeIdentity({ buildId: "old-build" }),
    expectedRuntimeIdentity: runtimeIdentity({ buildId: "new-build" }),
    providerFactory: async () => value.provider,
  });
  assert.equal(result.status, "version_mismatch");
  assert.equal(result.reason, "VERSION_MISMATCH");
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running'").get().n, 0);
  assert.ok(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='pending'").get().n > 0);
  const persisted = JSON.parse(value.store.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value);
  assert.equal(persisted.status, "version_mismatch");
  assert.match(persisted.remediation, /restart/i);
  value.store.close();
});

test("capability, schema, and model mismatches each fail closed before claiming jobs", async () => {
  for (const changed of [
    { capabilityHash: "c".repeat(64) },
    { schemaVersion: 17 },
    { modelHash: "d".repeat(64) },
  ]) {
    const value = await fixture();
    const result = await runSemanticWorker({
      store: value.store,
      ownerId: `mismatch-${Object.keys(changed)[0]}`,
      runtimeIdentity: runtimeIdentity(changed),
      expectedRuntimeIdentity: runtimeIdentity(),
      providerFactory: async () => value.provider,
    });
    assert.equal(result.status, "version_mismatch");
    assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running'").get().n, 0);
    value.store.close();
  }
});

test("model identity mismatch exits instead of spinning on an unclaimable queue", async () => {
  const value = await fixture();
  const wrongProvider = { ...value.provider, modelHash: "f".repeat(64) };
  const startedAt = Date.now();
  const result = await runSemanticWorker({
    store: value.store,
    ownerId: "wrong-model-worker",
    buildId: "build-a",
    providerFactory: async () => wrongProvider,
  });
  assert.equal(result.status, "version_mismatch");
  assert.equal(result.reason, "MODEL_IDENTITY_MISMATCH");
  assert.ok(Date.now() - startedAt < 1_000, "mismatch exits promptly");
  assert.equal(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running'").get().n, 0);
  assert.ok(value.store.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='pending'").get().n > 0);
  value.store.close();
});

test("supervisor detaches a short-lived worker from the caller", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-process-"));
  const pidFile = join(processDir, "pid");
  const helper = join(processDir, "worker.mjs");
  const launcher = join(processDir, "launcher.sh");
  const logPath = join(processDir, "worker.log");
  writeFileSync(helper, `
    import { writeFileSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });
    const provider = { id: "fixture", modelId: "worker", modelHash: process.env.TEST_MODEL_HASH, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 1500)); return values.map(() => new Float32Array([1,0])); },
      async embed(values) { return this.embedDocuments(values); } };
    await runSemanticWorker({ store, runtimeIdentity: JSON.parse(process.env.TEST_RUNTIME_IDENTITY), expectedRuntimeIdentity: JSON.parse(process.env.TEST_RUNTIME_IDENTITY), providerFactory: async () => provider });
    store.close();
  `);
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${helper}"\n`);
  chmodSync(launcher, 0o755);
  const result = ensureSemanticWorker({
    store: value.store,
    launcherPath: launcher,
    cwd: value.root,
    logPath,
    expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
    env: {
      PENGUIN_KNOWLEDGE_DB: value.dbPath,
      PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath,
      TEST_MODEL_HASH: value.provider.modelHash,
      TEST_RUNTIME_IDENTITY: JSON.stringify(runtimeIdentity({ modelHash: value.provider.modelHash })),
    },
    readinessTimeoutMs: 2_000,
  });
  assert.equal(result.status, "started");
  const deadline = Date.now() + 5_000;
  while (!existsSync(pidFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(pidFile), true);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(pid, 0));
  process.kill(pid, "SIGTERM");
  value.store.close();
});

test("parent CLI process exits while the detached worker drains and then exits", async () => {
  const value = await fixture();
  value.store.close();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-parent-exit-"));
  const workerPidFile = join(processDir, "worker.pid");
  const doneFile = join(processDir, "done.json");
  const helper = join(processDir, "worker.mjs");
  const launcher = join(processDir, "launcher.sh");
  const parent = join(processDir, "parent.mjs");
  const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
  writeFileSync(helper, `
    import { writeFileSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });
    const provider = { id: "fixture", modelId: "worker", modelHash: ${JSON.stringify(value.provider.modelHash)}, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) { writeFileSync(${JSON.stringify(workerPidFile)}, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 700)); return values.map(() => new Float32Array([1,0])); },
      async embed(values) { return this.embedDocuments(values); } };
    const result = await runSemanticWorker({ store, runtimeIdentity: ${JSON.stringify(identity)}, expectedRuntimeIdentity: ${JSON.stringify(identity)}, providerFactory: async () => provider });
    writeFileSync(${JSON.stringify(doneFile)}, JSON.stringify(result)); store.close();
  `);
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${helper}"\n`);
  chmodSync(launcher, 0o755);
  writeFileSync(parent, `
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { ensureSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });
    const result = ensureSemanticWorker({ store, launcherPath: ${JSON.stringify(launcher)}, logPath: ${JSON.stringify(join(processDir, "worker.log"))}, expectedRuntimeIdentity: ${JSON.stringify(identity)}, env: process.env, readinessTimeoutMs: 2000 });
    process.stdout.write(JSON.stringify(result)); store.close();
  `);
  const parentProcess = spawn(process.execPath, [parent], {
    env: { ...process.env, PENGUIN_KNOWLEDGE_DB: value.dbPath, PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let parentOut = "";
  parentProcess.stdout.on("data", (chunk) => { parentOut += chunk; });
  const parentExit = await new Promise((resolve) => parentProcess.once("exit", resolve));
  assert.equal(parentExit, 0);
  assert.equal(JSON.parse(parentOut).status, "started", parentOut);
  const workerStartDeadline = Date.now() + 5_000;
  while (!existsSync(workerPidFile) && Date.now() < workerStartDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(existsSync(workerPidFile), true, "detached worker reaches provider after parent exits");
  const workerPid = Number(readFileSync(workerPidFile, "utf8"));
  assert.doesNotThrow(() => process.kill(workerPid, 0), "worker survives parent exit");
  const deadline = Date.now() + 5_000;
  while (!existsSync(doneFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(existsSync(doneFile), true);
  assert.equal(JSON.parse(readFileSync(doneFile, "utf8")).status, "drained");
  const verify = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
  assert.equal(verify.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(value.report.semantic.generationId).status, "active");
  verify.close();
});

test("supervisor fails closed when the stable launcher never becomes ready", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-not-ready-"));
  const launcher = join(processDir, "launcher.sh");
  const logPath = join(processDir, "worker.log");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);
  const result = ensureSemanticWorker({
    store: value.store,
    launcherPath: launcher,
    logPath,
    expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
    readinessTimeoutMs: 250,
  });
  assert.equal(result.status, "start_failed");
  assert.equal(result.reason, "SEMANTIC_WORKER_READINESS_TIMEOUT");
  value.store.close();
});

test("a losing supervisor rereads a live competing lease and returns already_running instead of start_failed", async () => {
  const value = await fixture();
  value.store.close();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-supervisor-race-"));
  const winner = join(processDir, "winner.mjs");
  const loserLauncher = join(processDir, "loser-launcher.sh");
  const loserArmedFile = join(processDir, "loser-armed");
  const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
  writeFileSync(winner, `
    import { existsSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    process.env.PENGUIN_WORKER_START_TOKEN = "independent-winner";
    const deadline = Date.now() + 5_000;
    while (!existsSync(process.env.TEST_LOSER_ARMED)) {
      if (Date.now() >= deadline) process.exit(91);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });
    const identity = JSON.parse(process.env.TEST_RUNTIME_IDENTITY);
    const provider = { id: "fixture", modelId: "worker", modelHash: identity.modelHash, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) { await new Promise((resolve) => setTimeout(resolve, 60_000)); return values.map(() => new Float32Array([1,0])); },
      async embed(values) { return this.embedDocuments(values); } };
    await runSemanticWorker({ store, runtimeIdentity: identity, expectedRuntimeIdentity: identity, providerFactory: async () => provider });
  `);
  writeFileSync(loserLauncher, [
    "#!/bin/sh",
    'printf armed > "$TEST_LOSER_ARMED"',
    "trap '' TERM HUP INT",
    "while :; do sleep 1; done",
  ].join("\n"));
  chmodSync(loserLauncher, 0o755);
  const environment = {
    ...process.env,
    PENGUIN_KNOWLEDGE_DB: value.dbPath,
    PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath,
    TEST_RUNTIME_IDENTITY: JSON.stringify(identity),
    TEST_LOSER_ARMED: loserArmedFile,
  };
  const winnerProcess = spawn(process.execPath, [winner], { env: environment, stdio: ["ignore", "ignore", "ignore"] });
  const store = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
  let result;
  try {
    result = ensureSemanticWorker({
      store, launcherPath: loserLauncher, cwd: value.root, logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: identity, readinessTimeoutMs: 1_000,
      env: { TEST_LOSER_ARMED: loserArmedFile },
    });
    assert.equal(result.status, "already_running");
    assert.ok(result.pid && result.pid > 1);
  } finally {
    if (result?.pid && processIsRunning(result.pid)) process.kill(result.pid, "SIGKILL");
    if (processIsRunning(winnerProcess.pid)) process.kill(winnerProcess.pid, "SIGKILL");
    store.close();
  }
});

test("a competing live owner is only accepted after the loser spawn is cleaned", async () => {
  const value = await fixture();
  value.store.close();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-supervisor-handoff-"));
  const winner = join(processDir, "winner.mjs");
  const loserSupervisor = join(processDir, "loser-supervisor.mjs");
  const loserLauncher = join(processDir, "loser-launcher.sh");
  const winnerGoFile = join(processDir, "winner-go");
  const winnerRunningFile = join(processDir, "winner-running");
  const loserArmedFile = join(processDir, "loser-armed");
  const loserPidFile = join(processDir, "loser.pid");
  const loserResultFile = join(processDir, "loser-result.json");
  const winnerStateFile = join(processDir, "winner-state.json");
  const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
  writeFileSync(join(processDir, "fixture-context.json"), JSON.stringify({
    dbPath: value.dbPath,
    ledgerPath: value.ledgerPath,
    identity,
  }));
  const coreModule = JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href);
  const cliModule = JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href);
  writeFileSync(winner, [
    'import { existsSync, writeFileSync } from "node:fs";',
    "import { KnowledgeStore } from " + coreModule + ";",
    "import { runSemanticWorker } from " + cliModule + ";",
    'process.env.PENGUIN_WORKER_START_TOKEN = "independent-winner";',
    "const deadline = Date.now() + 5_000;",
    "while (!existsSync(process.env.TEST_WINNER_GO)) {",
    "  if (Date.now() >= deadline) process.exit(91);",
    "  await new Promise((resolve) => setTimeout(resolve, 10));",
    "}",
    "const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });",
    "const identity = JSON.parse(process.env.TEST_RUNTIME_IDENTITY);",
    'const provider = { id: "fixture", modelId: "worker", modelHash: identity.modelHash, dimensions: 2, maxTokens: 128,',
    "  async embedDocuments(values) { writeFileSync(process.env.TEST_WINNER_RUNNING, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 60_000)); return values.map(() => new Float32Array([1,0])); },",
    "  async embed(values) { return this.embedDocuments(values); } };",
    "await runSemanticWorker({ store, runtimeIdentity: identity, expectedRuntimeIdentity: identity, providerFactory: async () => provider });",
  ].join("\n"));
  writeFileSync(loserLauncher, [
    "#!/bin/sh",
    'printf "%s" "$$" > "$PENGUIN_TEST_LOSER_PID"',
    'printf armed > "$PENGUIN_TEST_LOSER_ARMED"',
    "trap '' TERM HUP INT",
    "while :; do sleep 1; done",
  ].join("\n"));
  chmodSync(loserLauncher, 0o755);
  writeFileSync(loserSupervisor, [
    'import { writeFileSync } from "node:fs";',
    "import { KnowledgeStore } from " + coreModule + ";",
    "import { ensureSemanticWorker } from " + cliModule + ";",
    "const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });",
    "const result = ensureSemanticWorker({",
    "  store, launcherPath: process.env.TEST_LOSER_LAUNCHER, cwd: process.env.TEST_WORKSPACE_ROOT,",
    "  logPath: process.env.TEST_LOSER_LOG, expectedRuntimeIdentity: JSON.parse(process.env.TEST_RUNTIME_IDENTITY), readinessTimeoutMs: 3_000,",
    "  env: { PENGUIN_TEST_LOSER_ARMED: process.env.TEST_LOSER_ARMED, PENGUIN_TEST_LOSER_PID: process.env.TEST_LOSER_PID },",
    "});",
    "writeFileSync(process.env.TEST_LOSER_RESULT, JSON.stringify(result));",
    "store.close();",
  ].join("\n"));
  const environment = {
    ...process.env,
    PENGUIN_KNOWLEDGE_DB: value.dbPath,
    PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath,
    TEST_RUNTIME_IDENTITY: JSON.stringify(identity),
    TEST_WINNER_GO: winnerGoFile,
    TEST_WINNER_RUNNING: winnerRunningFile,
    TEST_LOSER_LAUNCHER: loserLauncher,
    TEST_WORKSPACE_ROOT: value.root,
    TEST_LOSER_LOG: join(processDir, "worker.log"),
    TEST_LOSER_ARMED: loserArmedFile,
    TEST_LOSER_PID: loserPidFile,
    TEST_LOSER_RESULT: loserResultFile,
  };
  const winnerProcess = spawn(process.execPath, [winner], { env: environment, stdio: ["ignore", "ignore", "ignore"] });
  const loserProcess = spawn(process.execPath, [loserSupervisor], { env: environment, stdio: ["ignore", "ignore", "ignore"] });
  let winnerPid = null;
  let loserPid = null;
  try {
    await waitForFile(loserArmedFile, "losing supervisor never launched its explicit armed protocol", 5_000);
    loserPid = Number(readFileSync(loserPidFile, "utf8"));
    writeFileSync(winnerGoFile, "go");
    await waitForFile(winnerRunningFile, "competing worker never published its running protocol", 5_000);
    winnerPid = Number(readFileSync(winnerRunningFile, "utf8"));
    const winnerStore = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
    writeFileSync(winnerStateFile, JSON.stringify({
      runtime: winnerStore.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get()?.value ?? null,
      lease: winnerStore.db.prepare("SELECT owner_id, owner_pid, heartbeat_at, lease_expires_at FROM semantic_worker_leases WHERE lock_name='semantic-drain'").get() ?? null,
      winnerPid,
      winnerAlive: processIsRunning(winnerPid),
    }));
    winnerStore.close();
    await waitForFile(loserResultFile, "losing supervisor never reread the competing live lease", 5_000);
    const result = JSON.parse(readFileSync(loserResultFile, "utf8"));
    assert.equal(result.status, "already_running");
    assert.equal(result.pid, winnerPid, "already_running names the validated competing owner PID");
    const verify = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
    const runtime = JSON.parse(verify.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value);
    const lease = verify.db.prepare("SELECT owner_id AS ownerId, owner_pid AS ownerPid FROM semantic_worker_leases WHERE lock_name='semantic-drain'").get();
    verify.close();
    assert.deepEqual(runtime.identity, identity, "competing owner must match build, capability, schema, and model");
    assert.equal(runtime.ownerPid, winnerPid);
    assert.equal(runtime.ownerProcessIdentity?.pid, winnerPid, "runtime records the competing owner birth identity");
    assert.equal(lease.ownerPid, winnerPid);
    await waitForProcessExit(loserPid, "loser spawn must be cleaned before already_running is returned");
  } finally {
    for (const pid of [loserPid, winnerPid, loserProcess.pid, winnerProcess.pid]) {
      if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
  }
});

test("a winner published during loser cleanup is revalidated after cleanup before already_running", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-post-cleanup-winner-"));
  const winner = join(processDir, "winner.mjs");
  const launcher = join(processDir, "loser-launcher.sh");
  const cleanupStartedFile = join(processDir, "cleanup-started");
  const winnerRunningFile = join(processDir, "winner-running");
  const launcherPidFile = join(processDir, "launcher.pid");
  const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
  writeFileSync(winner, `
    import { existsSync, writeFileSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    while (!existsSync(process.env.TEST_CLEANUP_STARTED)) await new Promise((resolve) => setTimeout(resolve, 10));
    process.env.PENGUIN_WORKER_START_TOKEN = "post-cleanup-winner";
    const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });
    const identity = JSON.parse(process.env.TEST_RUNTIME_IDENTITY);
    const provider = { id: "fixture", modelId: "worker", modelHash: identity.modelHash, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) { writeFileSync(process.env.TEST_WINNER_RUNNING, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 60_000)); return values.map(() => new Float32Array([1,0])); },
      async embed(values) { return this.embedDocuments(values); } };
    await runSemanticWorker({ store, runtimeIdentity: identity, expectedRuntimeIdentity: identity, providerFactory: async () => provider });
  `);
  writeFileSync(launcher, [
    "#!/bin/sh",
    'printf "%s" "$$" > "$TEST_LAUNCHER_PID"',
    'trap \'printf cleanup > "$TEST_CLEANUP_STARTED"; while [ ! -f "$TEST_WINNER_RUNNING" ]; do :; done; exit 0\' TERM',
    "trap '' HUP INT",
    "while :; do sleep 1; done",
  ].join("\n"));
  chmodSync(launcher, 0o755);
  const environment = {
    ...process.env,
    PENGUIN_KNOWLEDGE_DB: value.dbPath,
    PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath,
    TEST_RUNTIME_IDENTITY: JSON.stringify(identity),
    TEST_CLEANUP_STARTED: cleanupStartedFile,
    TEST_WINNER_RUNNING: winnerRunningFile,
  };
  const winnerProcess = spawn(process.execPath, [winner], { env: environment, stdio: ["ignore", "ignore", "ignore"] });
  let launcherPid = null;
  let winnerPid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: identity,
      readinessTimeoutMs: 2_000,
      env: {
        TEST_LAUNCHER_PID: launcherPidFile,
        TEST_CLEANUP_STARTED: cleanupStartedFile,
        TEST_WINNER_RUNNING: winnerRunningFile,
      },
    });
    assert.equal(existsSync(cleanupStartedFile), true, "winner starts only after loser cleanup begins");
    assert.equal(existsSync(winnerRunningFile), true, "winner persisted running state before loser cleanup completed");
    launcherPid = Number(readFileSync(launcherPidFile, "utf8"));
    winnerPid = Number(readFileSync(winnerRunningFile, "utf8"));
    assert.equal(result.status, "already_running");
    assert.equal(result.pid, winnerPid);
    assert.equal(processIsRunning(launcherPid), false, "loser is gone before winner is returned");
    const persisted = JSON.parse(value.store.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value);
    assert.equal(persisted.status, "running");
    assert.equal(persisted.ownerPid, winnerPid, "timeout failure must not overwrite the post-cleanup winner");
  } finally {
    for (const pid of [launcherPid, winnerPid, winnerProcess.pid]) {
      if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
    value.store.close();
  }
});

test("cleanup-unproven fails closed without recording start failure over a newly valid winner", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-unproven-winner-"));
  const winner = join(processDir, "winner.mjs");
  const launcher = join(processDir, "launcher.mjs");
  const handoff = join(processDir, "handoff.mjs");
  const winnerGoFile = join(processDir, "winner-go");
  const winnerRunningFile = join(processDir, "winner-running");
  const winnerConfirmedFile = join(processDir, "winner-confirmed");
  const launcherPidFile = join(processDir, "launcher.pid");
  const handoffPidFile = join(processDir, "handoff.pid");
  const signalFile = join(processDir, "signaled");
  const logPath = join(processDir, "worker.log");
  const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
  writeFileSync(winner, `
    import { existsSync, writeFileSync } from "node:fs";
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    while (!existsSync(process.env.TEST_WINNER_GO)) await new Promise((resolve) => setTimeout(resolve, 10));
    process.env.PENGUIN_WORKER_START_TOKEN = "unproven-cleanup-winner";
    const store = KnowledgeStore.open({ dbPath: process.env.PENGUIN_KNOWLEDGE_DB, ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER });
    const identity = JSON.parse(process.env.TEST_RUNTIME_IDENTITY);
    const provider = { id: "fixture", modelId: "worker", modelHash: identity.modelHash, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) { writeFileSync(process.env.TEST_WINNER_RUNNING, String(process.pid)); await new Promise((resolve) => setTimeout(resolve, 60_000)); return values.map(() => new Float32Array([1,0])); },
      async embed(values) { return this.embedDocuments(values); } };
    await runSemanticWorker({ store, runtimeIdentity: identity, expectedRuntimeIdentity: identity, providerFactory: async () => provider });
  `);
  writeFileSync(handoff, `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const registry = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY;
    const token = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN;
    const row = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,stat=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
    const match = /^(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([A-Z][a-z]{2}\\s+[A-Z][a-z]{2}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+(\\S+)$/u.exec(row);
    if (!match || match[5].startsWith("Z")) process.exit(90);
    appendFileSync(registry, JSON.stringify({ type: "handoff", version: 1, token,
      pid: process.pid, ppid: Number(match[2]), pgid: Number(match[3]), startIdentity: match[4] }) + "\\n");
    let handled = false;
    setInterval(() => {
      if (handled) return;
      const records = readFileSync(registry, "utf8").trim().split(/\\r?\\n/u).filter(Boolean).map((line) => JSON.parse(line));
      const accepted = records.find((record) => record.type === "handoff-accepted" && record.pid === process.pid);
      const freeze = accepted && records.find((record) => record.type === "handoff-freeze"
        && record.pid === process.pid && record.acceptanceId === accepted.acceptanceId);
      if (!freeze) return;
      handled = true;
      writeFileSync(process.env.TEST_WINNER_GO, "go");
      const confirmed = setInterval(() => {
        if (!existsSync(process.env.TEST_WINNER_RUNNING)) return;
        clearInterval(confirmed);
        writeFileSync(process.env.TEST_WINNER_CONFIRMED, "confirmed");
      }, 10);
      // Deliberately withhold handoff-frozen: the controller must fail closed
      // without signaling or overwriting the concurrently published winner.
    }, 10);
    process.on("SIGTERM", () => writeFileSync(process.env.TEST_SIGNAL_FILE, "handoff-signaled"));
    setInterval(() => {}, 1000);
  `);
  writeFileSync(launcher, `#!/usr/bin/env node
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, [${JSON.stringify(handoff)}], { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid));
    writeFileSync(${JSON.stringify(handoffPidFile)}, String(child.pid));
    process.on("SIGTERM", () => writeFileSync(process.env.TEST_SIGNAL_FILE, "launcher-signaled"));
    setInterval(() => {}, 1000);
  `);
  chmodSync(launcher, 0o755);
  const environment = {
    ...process.env,
    PENGUIN_KNOWLEDGE_DB: value.dbPath,
    PENGUIN_KNOWLEDGE_LEDGER: value.ledgerPath,
    TEST_RUNTIME_IDENTITY: JSON.stringify(identity),
    TEST_WINNER_GO: winnerGoFile,
    TEST_WINNER_RUNNING: winnerRunningFile,
    TEST_WINNER_CONFIRMED: winnerConfirmedFile,
    TEST_SIGNAL_FILE: signalFile,
  };
  const winnerProcess = spawn(process.execPath, [winner], { env: environment, stdio: ["ignore", "ignore", "ignore"] });
  let launcherPid = null;
  let handoffPid = null;
  let winnerPid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath,
      expectedRuntimeIdentity: identity,
      readinessTimeoutMs: 2_000,
      env: environment,
    });
    launcherPid = Number(readFileSync(launcherPidFile, "utf8"));
    handoffPid = Number(readFileSync(handoffPidFile, "utf8"));
    await waitForFile(winnerConfirmedFile, "winner was not persisted during the failed freeze protocol", 2_000);
    winnerPid = Number(readFileSync(winnerRunningFile, "utf8"));
    assert.equal(result.status, "start_failed");
    assert.equal(result.reason, "SEMANTIC_WORKER_CLEANUP_UNPROVEN");
    assert.equal(existsSync(signalFile), false, "unproven handoff ownership must prevent all termination signals");
    const persisted = JSON.parse(value.store.db.prepare("SELECT value FROM meta WHERE key='semantic_worker_runtime'").get().value);
    assert.equal(persisted.status, "running");
    assert.equal(persisted.ownerPid, winnerPid, "cleanup-unproven must not overwrite a valid winner");
    assert.doesNotMatch(readFileSync(logPath, "utf8"), /"event":"worker_start_failed".*SEMANTIC_WORKER_CLEANUP_UNPROVEN/u);
  } finally {
    for (const pid of [launcherPid, handoffPid, winnerPid, winnerProcess.pid]) {
      if (pid && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
    value.store.close();
  }
});

test("supervisor requires the stable launcher and never falls back to system Node", async () => {
  const value = await fixture();
  const result = ensureSemanticWorker({
    store: value.store,
    launcherPath: join(value.directory, "missing-penguin"),
    expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
    readinessTimeoutMs: 50,
  });
  assert.equal(result.status, "start_failed");
  assert.equal(result.reason, "SEMANTIC_WORKER_LAUNCHER_NOT_FOUND");
  value.store.close();
});

test("an executable launcher with a missing interpreter returns start_failed without killing the caller", async () => {
  const value = await fixture();
  value.store.close();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-bad-shebang-"));
  const launcher = join(processDir, "penguin");
  const probe = join(processDir, "probe.mjs");
  writeFileSync(launcher, "#!/definitely/missing-interpreter\nexit 0\n");
  chmodSync(launcher, 0o755);
  writeFileSync(probe, `
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { ensureSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    const store = KnowledgeStore.open({ dbPath: ${JSON.stringify(value.dbPath)}, ledgerPath: ${JSON.stringify(value.ledgerPath)} });
    const result = ensureSemanticWorker({ store, launcherPath: ${JSON.stringify(launcher)}, expectedRuntimeIdentity: ${JSON.stringify(runtimeIdentity({ modelHash: value.provider.modelHash }))}, readinessTimeoutMs: 100 });
    process.stdout.write(JSON.stringify(result)); store.close();
  `);
  const child = spawn(process.execPath, [probe], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: 0, signal: null }, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.status, "start_failed");
  assert.equal(result.reason, "SEMANTIC_WORKER_LAUNCH_FAILED");
});

test("a worker killed mid-batch is reclaimed immediately without waiting for the 90s lease", async () => {
  const value = await fixture();
  const childSource = `
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorker } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/index.js", import.meta.url).href)};
    const [dbPath, ledgerPath, modelHash] = process.argv.slice(1);
    const store = KnowledgeStore.open({ dbPath, ledgerPath });
    const provider = {
      id: "fixture", modelId: "worker", modelHash, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) {
        process.stdout.write("CLAIMED\\n");
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return values.map(() => new Float32Array([1, 0]));
      },
      async embed(values) { return this.embedDocuments(values); },
    };
    await runSemanticWorker({ store, ownerId: "crash-worker", buildId: "build-a", providerFactory: async () => provider });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, value.dbPath, value.ledgerPath, value.provider.modelHash], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childStderr = "";
  child.stderr.on("data", (chunk) => { childStderr += chunk; });
  let claimed = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`child worker did not claim a batch\nstderr: ${childStderr}`)), 5_000);
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("CLAIMED")) return;
        clearTimeout(timer);
        claimed = true;
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`child worker exited before claim: ${code}\nstderr: ${childStderr}`));
      });
    });
  } finally {
    if (!claimed && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));

  const recoveryStartedAt = Date.now();
  const recovered = await runSemanticWorker({ store: value.store, ownerId: "recovery-worker", buildId: "build-a", providerFactory: async () => value.provider });
  assert.equal(recovered.status, "drained");
  assert.ok(Date.now() - recoveryStartedAt < 5_000, "dead owner recovery must not wait for the 90s lease");
  assert.equal(value.store.db.prepare("SELECT status FROM embedding_generations WHERE id=?").get(value.report.semantic.generationId).status, "active");
  const refs = value.store.db.prepare("SELECT COUNT(*) AS total,COUNT(DISTINCT chunk_id) AS uniqueChunks FROM semantic_embedding_refs WHERE generation_id=?").get(value.report.semantic.generationId);
  const generation = value.store.db.prepare("SELECT expected_chunks AS expected FROM embedding_generations WHERE id=?").get(value.report.semantic.generationId);
  assert.equal(refs.total, refs.uniqueChunks);
  assert.equal(refs.total, generation.expected);
  value.store.close();
});

test("a live reused owner PID with a different persisted birth identity is reclaimed immediately", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const sentinel = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const row = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,stat=", "-p", String(sentinel.pid)], { encoding: "utf8" }).trim();
    const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/u.exec(row);
    assert.ok(match && !match[5].startsWith("Z"), `sentinel identity unavailable: ${row}`);
    const staleIdentity = {
      pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]),
      startIdentity: `${match[4]}-reused`,
    };
    const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
    const future = new Date(Date.now() + 90_000).toISOString();
    value.store.db.prepare(`
      INSERT INTO semantic_worker_leases(lock_name,owner_id,owner_pid,build_id,heartbeat_at,lease_expires_at)
      VALUES ('semantic-drain','reused-owner',?,?,?,?)
    `).run(sentinel.pid, identity.buildId, new Date().toISOString(), future);
    value.store.db.prepare("INSERT INTO meta(key,value) VALUES ('semantic_worker_runtime',?)").run(JSON.stringify({
      status: "running", reason: null, remediation: null, identity,
      ownerId: "reused-owner", ownerPid: sentinel.pid, startToken: "reused-token",
      ownerProcessIdentity: staleIdentity, updatedAt: new Date().toISOString(),
    }));
    const startedAt = Date.now();
    const result = await runSemanticWorker({ store: value.store, ownerId: "recovery-worker", runtimeIdentity: identity, expectedRuntimeIdentity: identity, providerFactory: async () => value.provider });
    assert.equal(result.status, "drained");
    assert.ok(Date.now() - startedAt < 5_000, "reused live PID must not retain the 90s lease");
    assert.equal(value.store.db.prepare("SELECT owner_id AS ownerId FROM semantic_worker_leases WHERE lock_name='semantic-drain'").get().ownerId, "recovery-worker");
  } finally {
    if (processIsRunning(sentinel.pid)) process.kill(sentinel.pid, "SIGKILL");
    value.store.close();
  }
});

test("SIGTERM under a sustained default SQLite lock exits before launcher grace and leaves a dead-owner reclaim path", async () => {
  const value = await fixture();
  value.store.close();
  const childSource = `
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorkerWithProcessSignals } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/semantic-worker.js", import.meta.url).href)};
    const [dbPath, ledgerPath, modelHash] = process.argv.slice(1);
    const store = KnowledgeStore.open({ dbPath, ledgerPath });
    const provider = {
      id: "fixture", modelId: "worker", modelHash, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) { process.stdout.write("CLAIMED\\n"); await new Promise((resolve) => setTimeout(resolve, 60_000)); return values.map(() => new Float32Array([1, 0])); },
      async embed(values) { return this.embedDocuments(values); },
    };
    await runSemanticWorkerWithProcessSignals({ store, ownerId: "sustained-lock-worker", buildId: "build-a", providerFactory: async () => provider });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, value.dbPath, value.ledgerPath, value.provider.modelHash], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const locker = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("sustained-lock worker did not claim a batch")), 5_000);
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("CLAIMED")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`sustained-lock worker exited before signal: ${code}`)); });
    });
    locker.db.exec("BEGIN IMMEDIATE");
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("abort cleanup exceeded the 7.5s launcher grace")), 7_200);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    const startedAt = Date.now();
    assert.equal(child.kill("SIGTERM"), true);
    await exited;
    assert.ok(Date.now() - startedAt < 7_200, "worker leaves bounded dead-owner state before launcher force cleanup");
    locker.db.exec("COMMIT");
    const recovery = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
    try {
      const recovered = await runSemanticWorker({ store: recovery, ownerId: "after-sustained-lock", buildId: "build-a", providerFactory: async () => value.provider });
      assert.equal(recovered.status, "drained");
      assert.equal(recovery.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running'").get().n, 0);
    } finally {
      recovery.close();
    }
  } finally {
    try { locker.db.exec("ROLLBACK"); } catch { /* committed or never opened */ }
    locker.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  test(`real semantic worker ${signal} abort releases its lease and requeues owned work`, async () => {
    const value = await fixture();
    value.store.close();
    const signalLogPath = join(value.directory, `${signal.toLowerCase()}-worker.log`);
    const childSource = `
      import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
      import { runSemanticWorkerWithProcessSignals } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/semantic-worker.js", import.meta.url).href)};
      const [dbPath, ledgerPath, modelHash, logPath] = process.argv.slice(1);
      const store = KnowledgeStore.open({ dbPath, ledgerPath });
      const provider = {
        id: "fixture", modelId: "worker", modelHash, dimensions: 2, maxTokens: 128,
        async embedDocuments(values) {
          process.stdout.write("CLAIMED\\n");
          await new Promise((resolve) => setTimeout(resolve, 60_000));
          return values.map(() => new Float32Array([1, 0]));
        },
        async embed(values) { return this.embedDocuments(values); },
      };
      await runSemanticWorkerWithProcessSignals({ store, ownerId: "signal-worker", buildId: "build-a", providerFactory: async () => provider, log: { path: logPath } });
    `;
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, value.dbPath, value.ledgerPath, value.provider.modelHash, signalLogPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let childStderr = "";
    let childStdout = "";
    child.stderr.on("data", (chunk) => { childStderr += chunk; });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker did not claim a batch")), 5_000);
        child.stdout.on("data", (chunk) => {
          childStdout += chunk;
          if (!String(chunk).includes("CLAIMED")) return;
          clearTimeout(timer);
          resolve();
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`worker exited before signal: ${code}\n${childStderr}`));
        });
      });
      assert.equal(child.kill(signal), true, `${signal} was delivered to worker pid ${child.pid}`);
      const verify = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
      try {
        const deadline = Date.now() + 2_000;
        let lease;
        let running;
        do {
          lease = verify.db.prepare("SELECT lease_expires_at AS leaseExpiresAt FROM semantic_worker_leases WHERE owner_id='signal-worker'").get();
          running = verify.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running' AND lease_owner='signal-worker'").get().n;
          if (lease && lease.leaseExpiresAt <= new Date().toISOString() && running === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        } while (Date.now() < deadline);
        const signalLog = existsSync(signalLogPath) ? readFileSync(signalLogPath, "utf8") : "";
        assert.ok(lease && lease.leaseExpiresAt <= new Date().toISOString(), `worker lease becomes immediately reclaimable: ${JSON.stringify({ lease, running, signalLog, childStdout })}`);
        assert.equal(running, 0, "owned running jobs are no longer stranded");
        assert.ok(verify.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='pending'").get().n > 0, "aborted work is retryable");
      } finally {
        verify.close();
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
    }
  });
}

test("SIGTERM cleanup retries through an exact SQLite BEGIN IMMEDIATE lock", async () => {
  const value = await fixture();
  value.store.close();
  const childSource = `
    import { KnowledgeStore } from ${JSON.stringify(new URL("../packages/knowledge-core/dist/index.js", import.meta.url).href)};
    import { runSemanticWorkerWithProcessSignals } from ${JSON.stringify(new URL("../packages/knowledge-cli/dist/semantic-worker.js", import.meta.url).href)};
    const [dbPath, ledgerPath, modelHash] = process.argv.slice(1);
    const store = KnowledgeStore.open({ dbPath, ledgerPath });
    store.db.pragma("busy_timeout = 100");
    const provider = {
      id: "fixture", modelId: "worker", modelHash, dimensions: 2, maxTokens: 128,
      async embedDocuments(values) {
        process.stdout.write("CLAIMED\\n");
        await new Promise((resolve) => setTimeout(resolve, 60_000));
        return values.map(() => new Float32Array([1, 0]));
      },
      async embed(values) { return this.embedDocuments(values); },
    };
    await runSemanticWorkerWithProcessSignals({ store, ownerId: "locked-signal-worker", buildId: "build-a", providerFactory: async () => provider });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childSource, value.dbPath, value.ledgerPath, value.provider.modelHash], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const locker = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("locked worker did not claim a batch")), 5_000);
      child.stdout.on("data", (chunk) => {
        if (!String(chunk).includes("CLAIMED")) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`locked worker exited before signal: ${code}`));
      });
    });
    locker.db.exec("BEGIN IMMEDIATE");
    assert.equal(child.kill("SIGTERM"), true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    locker.db.exec("COMMIT");

    const verify = KnowledgeStore.open({ dbPath: value.dbPath, ledgerPath: value.ledgerPath });
    try {
      const deadline = Date.now() + 3_000;
      let lease;
      let running = 1;
      do {
        lease = verify.db.prepare("SELECT lease_expires_at AS leaseExpiresAt FROM semantic_worker_leases WHERE owner_id='locked-signal-worker'").get();
        running = verify.db.prepare("SELECT COUNT(*) AS n FROM embedding_jobs WHERE status='running' AND lease_owner='locked-signal-worker'").get().n;
        if (lease?.leaseExpiresAt <= new Date().toISOString() && running === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < deadline);
      assert.ok(lease?.leaseExpiresAt <= new Date().toISOString(), "lease must become immediately reclaimable after lock clears");
      assert.equal(running, 0, "locked abort cleanup must requeue owned running work");
    } finally {
      verify.close();
    }
  } finally {
    try { locker.db.exec("ROLLBACK"); } catch { /* transaction already committed */ }
    locker.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
  }
});

test("readiness timeout proves an ignored-TERM launcher and runtime tree exited before returning", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-timeout-tree-"));
  const launcher = join(processDir, "launcher.mjs");
  const launcherPidFile = join(processDir, "launcher.pid");
  const runtimePidFile = join(processDir, "runtime.pid");
  const treeReadyFile = join(processDir, "tree-ready");
  writeFileSync(launcher, `#!/usr/bin/env node
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    const runtime = spawn(process.execPath, ["--input-type=module", "--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid));
    writeFileSync(${JSON.stringify(runtimePidFile)}, String(runtime.pid));
    writeFileSync(${JSON.stringify(treeReadyFile)}, "tree-ready");
    setInterval(()=>{},1000);
  `);
  chmodSync(launcher, 0o755);
  let launcherPid = null;
  let runtimePid = null;
  const unrelated = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      // The fixture's tree-ready record is the protocol boundary: it proves
      // both PIDs exist before the supervisor starts the timeout cleanup.
      readinessTimeoutMs: 3_000,
    });
    assert.equal(result.status, "start_failed");
    await waitForFile(treeReadyFile, "ignored-TERM fixture never completed its tree-ready handshake");
    assert.equal(readFileSync(treeReadyFile, "utf8"), "tree-ready");
    launcherPid = Number(readFileSync(launcherPidFile, "utf8"));
    runtimePid = Number(readFileSync(runtimePidFile, "utf8"));
    assert.equal(processIsRunning(launcherPid), false, "launcher must be gone before start_failed");
    assert.equal(processIsRunning(runtimePid), false, "runtime descendant must be gone before start_failed");
    assert.equal(processIsRunning(unrelated.pid), true, "supervisor cleanup must preserve an unrelated process");
  } finally {
    for (const pid of [launcherPid, runtimePid, unrelated.pid]) {
      if (!Number.isInteger(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
    value.store.close();
  }
});

test("supervisor does not signal when a same-UID registry claim copies a real identity but has invalid ancestry", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-invalid-ancestry-"));
  const launcher = join(processDir, "launcher.mjs");
  const launcherPidFile = join(processDir, "launcher.pid");
  const readyFile = join(processDir, "ready");
  const signaledFile = join(processDir, "signaled");
  const sentinel = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  const copiedIdentity = processIdentity(sentinel.pid);
  writeFileSync(launcher, `#!/usr/bin/env node
    import { appendFileSync, writeFileSync } from "node:fs";
    const copiedIdentity = JSON.parse(process.env.TEST_COPIED_PROCESS_IDENTITY);
    appendFileSync(process.env.PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY, JSON.stringify({
      type: "handoff", version: 1, token: process.env.PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN, ...copiedIdentity,
    }) + "\\n");
    writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid));
    writeFileSync(${JSON.stringify(readyFile)}, "ready");
    process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(signaledFile)}, "signaled"); process.exit(0); });
    setInterval(() => {}, 1000);
  `);
  chmodSync(launcher, 0o755);
  let launcherPid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      readinessTimeoutMs: 2_000,
      env: { TEST_COPIED_PROCESS_IDENTITY: JSON.stringify(copiedIdentity) },
    });
    assert.equal(result.status, "start_failed");
    assert.equal(result.reason, "SEMANTIC_WORKER_CLEANUP_UNPROVEN");
    assert.equal(existsSync(readyFile), true, "fixture published the invalid-ancestry claim before cleanup");
    launcherPid = Number(readFileSync(launcherPidFile, "utf8"));
    assert.equal(existsSync(signaledFile), false, "cleanup-unproven must be decided before any termination signal");
    assert.equal(processIsRunning(launcherPid), true, "supervisor leaves its direct child untouched when the ownership set is unproven");
    assert.equal(processIsRunning(sentinel.pid), true, "copied unrelated identity must never be signaled");
  } finally {
    for (const pid of [launcherPid, sentinel.pid]) {
      if (pid != null && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
    value.store.close();
  }
});

test("supervisor cleans a real stable launcher only after accepting its pinned runtime handoff", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-stable-launcher-handoff-"));
  const runtimeRoot = join(processDir, "runtimes");
  const current = join(runtimeRoot, "current");
  const stableLauncher = join(processDir, "penguin");
  const runtimeStateFile = join(processDir, "runtime-state.json");
  writeFileSync(stableLauncher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(new URL("../scripts/knowledge-cli-launcher.mjs", import.meta.url).pathname)} "$@"\n`);
  chmodSync(stableLauncher, 0o755);
  mkdirSync(join(current, "wasm"), { recursive: true });
  writeFileSync(join(current, "penguin.mjs"), "");
  writeFileSync(join(current, "node"), `#!/bin/sh
    printf '{"runtimePid":%s,"launcherPid":%s}' "$$" "$PPID" > ${JSON.stringify(runtimeStateFile)}
    trap '' TERM HUP INT
    while :; do sleep 1; done
  `);
  chmodSync(join(current, "node"), 0o755);
  const identity = runtimeIdentity({ modelHash: value.provider.modelHash });
  writeFileSync(join(current, "manifest.json"), JSON.stringify({
    schemaVersion: 1, ready: true, buildId: identity.buildId, appVersion: "1.0.0",
    capabilityHash: identity.capabilityHash, contractSchemaVersion: identity.schemaVersion,
    contractVersion: "2", modelHash: identity.modelHash,
    nodePath: "node", cliEntry: "penguin.mjs", wasmPath: "wasm",
  }));
  const unrelated = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  let runtimePid = null;
  let launcherPid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: stableLauncher,
      cwd: value.root,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: identity,
      readinessTimeoutMs: 2_000,
      env: {
        PENGUIN_RUNTIME_ROOT: runtimeRoot,
        PENGUIN_LAUNCHER_TERMINATION_GRACE_MS: "150",
      },
    });
    assert.equal(existsSync(runtimeStateFile), true, "real stable launcher published its runtime ownership boundary");
    ({ runtimePid, launcherPid } = JSON.parse(readFileSync(runtimeStateFile, "utf8")));
    assert.equal(result.status, "start_failed");
    assert.equal(result.reason, "SEMANTIC_WORKER_READINESS_TIMEOUT");
    assert.equal(processIsRunning(launcherPid), false, "stable launcher is gone before supervisor returns");
    assert.equal(processIsRunning(runtimePid), false, "launcher runtime handoff is gone before supervisor returns");
    assert.equal(processIsRunning(unrelated.pid), true, "nested cleanup preserves an unrelated process");
  } finally {
    for (const pid of [runtimePid, launcherPid, unrelated.pid]) {
      if (pid != null && processIsRunning(pid)) process.kill(pid, "SIGKILL");
    }
    value.store.close();
  }
});

test("readiness cleanup catches a descendant spawned after launcher receives TERM", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-late-descendant-"));
  const launcher = join(processDir, "launcher.mjs");
  const armedFile = join(processDir, "launcher-armed");
  const runtimePidFile = join(processDir, "late-runtime.pid");
  const runtimeReadyFile = join(processDir, "late-runtime-ready");
  const cleanupCompleteFile = join(processDir, "cleanup-complete");
  writeFileSync(launcher, `#!/usr/bin/env node
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    let spawned = false;
    process.on("SIGTERM", () => {
      if (spawned) return;
      spawned = true;
      const runtime = spawn(process.execPath, ["--input-type=module", "--eval", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
      writeFileSync(${JSON.stringify(runtimePidFile)}, String(runtime.pid));
      writeFileSync(${JSON.stringify(runtimeReadyFile)}, "runtime-ready");
    });
    writeFileSync(${JSON.stringify(armedFile)}, "armed");
    setInterval(()=>{},1000);
  `);
  chmodSync(launcher, 0o755);
  let runtimePid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      readinessTimeoutMs: 2_000,
    });
    assert.equal(result.status, "start_failed");
    await waitForFile(armedFile, "late-descendant launcher never armed its TERM protocol");
    assert.equal(readFileSync(armedFile, "utf8"), "armed");
    await waitForFile(runtimeReadyFile, "TERM handler never completed the late runtime PID protocol");
    assert.equal(readFileSync(runtimeReadyFile, "utf8"), "runtime-ready");
    runtimePid = Number(readFileSync(runtimePidFile, "utf8"));
    assert.equal(processIsRunning(runtimePid), false, "late owned runtime is gone before start_failed");
    writeFileSync(cleanupCompleteFile, "cleanup-complete");
    assert.equal(readFileSync(cleanupCompleteFile, "utf8"), "cleanup-complete");
  } finally {
    if (runtimePid != null && processIsRunning(runtimePid)) process.kill(runtimePid, "SIGKILL");
    value.store.close();
  }
});

test("readiness cleanup kills a registered self-detached PPID 1 descendant", async () => {
  if (process.platform === "win32") return;
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-detached-registry-"));
  const launcher = join(processDir, "launcher.mjs");
  const intermediate = join(processDir, "intermediate.mjs");
  const grandchild = join(processDir, "grandchild.mjs");
  const grandchildPidFile = join(processDir, "grandchild.pid");
  const registrationFile = join(processDir, "registered");
  const reparentedFile = join(processDir, "reparented-to-pid-1");
  const grandchildReadyFile = join(processDir, "grandchild-ready");
  const freezeReadyFile = join(processDir, "freeze-ready");
  const intermediateReadyFile = join(processDir, "intermediate-ready");
  const treeReadyFile = join(processDir, "tree-ready");
  const cleanupCompleteFile = join(processDir, "cleanup-complete");
  writeFileSync(grandchild, `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    const registry = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY;
    const token = process.env.PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN;
    if (!registry || !token) {
      writeFileSync(${JSON.stringify(registrationFile)}, "missing");
      process.exit(89);
    }
    const row = execFileSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,stat=", "-p", String(process.pid)], { encoding: "utf8" }).trim();
    const match = /^(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+([A-Z][a-z]{2}\\s+[A-Z][a-z]{2}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4})\\s+(\\S+)$/u.exec(row);
    if (!match || match[5].startsWith("Z")) process.exit(90);
    appendFileSync(registry, JSON.stringify({ type: "handoff", version: 1, token, pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startIdentity: match[4] }) + "\\n");
    writeFileSync(${JSON.stringify(registrationFile)}, "registered");
    const acceptanceDeadline = Date.now() + 5_000;
    let acceptance = null;
    while (!acceptance) {
      if (Date.now() >= acceptanceDeadline) process.exit(92);
      const records = readFileSync(registry, "utf8").trim().split(/\\r?\\n/u).filter(Boolean).map((line) => JSON.parse(line));
      acceptance = records.find((record) => record.type === "handoff-accepted" && record.version === 1
        && record.token === token && record.pid === process.pid && typeof record.acceptanceId === "string");
      if (!acceptance) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(${JSON.stringify(grandchildReadyFile)}, "grandchild-ready");
    const freezeMonitor = setInterval(() => {
      const records = readFileSync(registry, "utf8").trim().split(/\\r?\\n/u).filter(Boolean).map((line) => JSON.parse(line));
      const request = records.find((record) => record.type === "handoff-freeze" && record.version === 1
        && record.token === token && record.pid === process.pid && record.acceptanceId === acceptance.acceptanceId);
      if (!request) return;
      clearInterval(freezeMonitor);
      appendFileSync(registry, JSON.stringify({ type: "handoff-frozen", version: 1, token, pid: process.pid,
        pgid: Number(match[3]), startIdentity: match[4], acceptanceId: acceptance.acceptanceId, freezeId: request.freezeId }) + "\\n");
      writeFileSync(${JSON.stringify(freezeReadyFile)}, "freeze-ready");
      process.kill(process.pid, "SIGSTOP");
    }, 10);
    const reparented = setInterval(() => {
      const ppid = Number(execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
      if (ppid === 1) {
        clearInterval(reparented);
        writeFileSync(${JSON.stringify(reparentedFile)}, "1");
      }
    }, 10);
    process.on("SIGTERM", () => {});
    process.on("SIGHUP", () => {});
    setInterval(() => {}, 1000);
  `);
  writeFileSync(intermediate, `
    import { spawn } from "node:child_process";
    import { existsSync, writeFileSync } from "node:fs";
    const child = spawn(process.execPath, [${JSON.stringify(grandchild)}], { detached: true, stdio: "ignore" });
    writeFileSync(${JSON.stringify(grandchildPidFile)}, String(child.pid));
    child.unref();
    const deadline = Date.now() + 5_000;
    while (!existsSync(${JSON.stringify(grandchildReadyFile)})) {
      if (Date.now() >= deadline) process.exit(91);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(${JSON.stringify(intermediateReadyFile)}, "intermediate-ready");
    process.exit(0);
  `);
  writeFileSync(launcher, `#!/usr/bin/env node
    import { spawn } from "node:child_process";
    import { existsSync, writeFileSync } from "node:fs";
    spawn(process.execPath, [${JSON.stringify(intermediate)}], { stdio: "ignore" });
    const deadline = Date.now() + 5_000;
    while (!existsSync(${JSON.stringify(intermediateReadyFile)})) {
      if (Date.now() >= deadline) process.exit(92);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    writeFileSync(${JSON.stringify(treeReadyFile)}, "tree-ready");
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `);
  chmodSync(launcher, 0o755);
  let grandchildPid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath: join(processDir, "worker.log"),
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      readinessTimeoutMs: 2_000,
    });
    assert.equal(result.status, "start_failed");
    await waitForFile(treeReadyFile, "registered detached fixture never completed its tree-ready protocol");
    assert.equal(readFileSync(treeReadyFile, "utf8"), "tree-ready");
    assert.equal(readFileSync(grandchildReadyFile, "utf8"), "grandchild-ready");
    assert.equal(readFileSync(intermediateReadyFile, "utf8"), "intermediate-ready");
    grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
    assert.equal(readFileSync(registrationFile, "utf8"), "registered", "child must register before it detaches");
    assert.equal(existsSync(reparentedFile), true, "registered descendant observed its PPID become 1 before cleanup");
    assert.equal(readFileSync(freezeReadyFile, "utf8"), "freeze-ready", "supervisor must request and verify a self-freeze before signaling the handoff PGID");
    assert.equal(processIsRunning(grandchildPid), false, "readiness cleanup must remove the registered detached descendant before return");
    writeFileSync(cleanupCompleteFile, "cleanup-complete");
    assert.equal(readFileSync(cleanupCompleteFile, "utf8"), "cleanup-complete");
  } finally {
    if (grandchildPid != null && processIsRunning(grandchildPid)) process.kill(grandchildPid, "SIGKILL");
    value.store.close();
  }
});

test("worker folds and safely truncates its WAL after a complete drain", async () => {
  const value = await fixture();
  const result = await runSemanticWorker({ store: value.store, ownerId: "wal-worker", buildId: "build-a", providerFactory: async () => value.provider });
  assert.equal(result.status, "drained");
  const walPath = `${value.dbPath}-wal`;
  assert.ok(!existsSync(walPath) || statSync(walPath).size <= 32 * 1024, `final WAL ${existsSync(walPath) ? statSync(walPath).size : 0}`);
  value.store.close();
});

test("supervisor bounds an oversized worker log before spawning", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-log-"));
  const launcher = join(processDir, "launcher.sh");
  const logPath = join(processDir, "worker.log");
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);
  writeFileSync(logPath, Buffer.alloc(5 * 1024 * 1024 + 1, 120));
  const result = ensureSemanticWorker({ store: value.store, launcherPath: launcher, cwd: value.root, logPath, expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }), readinessTimeoutMs: 100 });
  assert.equal(result.status, "start_failed");
  assert.equal(existsSync(`${logPath}.1`), true);
  assert.ok(statSync(`${logPath}.1`).size <= 5 * 1024 * 1024);
  value.store.close();
});

test("supervisor removes stale histories and bounds every retained log segment", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-stale-log-"));
  const launcher = join(processDir, "launcher.sh");
  const logPath = join(processDir, "worker.log");
  const maxBytes = 512;
  const historyCount = 2;
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);
  for (const path of [logPath, `${logPath}.1`, `${logPath}.2`, `${logPath}.3`, `${logPath}.9`]) {
    writeFileSync(path, Buffer.alloc(maxBytes * 3, 120));
  }

  const result = ensureSemanticWorker({
    store: value.store,
    launcherPath: launcher,
    cwd: value.root,
    logPath,
    log: { maxBytes, historyCount },
    expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
    readinessTimeoutMs: 100,
  });

  assert.equal(result.status, "start_failed");
  assert.equal(existsSync(`${logPath}.3`), false);
  assert.equal(existsSync(`${logPath}.9`), false);
  const retained = [logPath, `${logPath}.1`, `${logPath}.2`].filter(existsSync);
  assert.ok(retained.every((path) => statSync(path).size <= maxBytes));
  assert.ok(retained.reduce((total, path) => total + statSync(path).size, 0) <= maxBytes * (historyCount + 1));
  value.store.close();
});

test("concurrent diagnostic writers rotate one bounded log without TOCTOU crashes", async () => {
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-concurrent-log-"));
  const logPath = join(processDir, "worker.log");
  const gatePath = join(processDir, "go");
  const maxBytes = 512;
  const historyCount = 2;
  const moduleUrl = new URL("../packages/knowledge-cli/dist/semantic-worker.js", import.meta.url).href;
  const workerSource = `
    import { existsSync } from "node:fs";
    import { appendSemanticWorkerDiagnostic } from ${JSON.stringify(moduleUrl)};
    const [logPath, gatePath, workerId] = process.argv.slice(1);
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(gatePath)) Atomics.wait(waiter, 0, 0, 2);
    for (let index = 0; index < 80; index += 1) {
      if (!appendSemanticWorkerDiagnostic({ path: logPath, maxBytes: ${maxBytes}, historyCount: ${historyCount} }, { event: "concurrent_probe", workerId, index })) process.exit(9);
    }
  `;
  const children = Array.from({ length: 6 }, (_, index) => spawn(
    process.execPath,
    ["--input-type=module", "--eval", workerSource, logPath, gatePath, String(index)],
    { stdio: ["ignore", "ignore", "pipe"] },
  ));
  writeFileSync(gatePath, "go");
  const exits = await Promise.all(children.map((child) => new Promise((resolve) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("exit", (code, signal) => resolve({ code, signal, stderr }));
  })));
  assert.deepEqual(exits.map(({ code, signal }) => ({ code, signal })), Array.from({ length: 6 }, () => ({ code: 0, signal: null })), exits.map((row) => row.stderr).join("\n"));
  assert.equal(existsSync(`${logPath}.3`), false);
  assert.equal(existsSync(`${logPath}.lock`), false);
  const retained = [logPath, `${logPath}.1`, `${logPath}.2`].filter(existsSync);
  assert.ok(retained.every((path) => statSync(path).size <= maxBytes));
  assert.ok(retained.reduce((total, path) => total + statSync(path).size, 0) <= maxBytes * (historyCount + 1));
});

test("launcher stderr becomes a bounded sanitized readiness diagnostic", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-bootstrap-stderr-"));
  const launcher = join(processDir, "launcher.sh");
  const logPath = join(processDir, "worker.log");
  writeFileSync(launcher, "#!/bin/sh\necho 'fatal token=TOP-SECRET /private/operator/path' >&2\nexit 23\n");
  chmodSync(launcher, 0o755);

  const result = ensureSemanticWorker({
    store: value.store,
    launcherPath: launcher,
    cwd: value.root,
    logPath,
    log: { maxBytes: 1_024, historyCount: 2 },
    expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
    readinessTimeoutMs: 1_000,
  });

  assert.equal(result.status, "start_failed");
  assert.equal(result.reason, "SEMANTIC_WORKER_READINESS_TIMEOUT");
  const retained = [logPath, `${logPath}.1`, `${logPath}.2`].filter(existsSync);
  const diagnostic = retained.map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(diagnostic, /"event":"worker_start_failed"/);
  assert.match(diagnostic, /"reason":"SEMANTIC_WORKER_READINESS_TIMEOUT"/);
  assert.match(diagnostic, /"diagnostic":"WORKER_BOOTSTRAP_STDERR_[A-F0-9]{12}"/);
  assert.doesNotMatch(diagnostic, /TOP-SECRET|token=|private\/operator|Error:|\bat\s/);
  assert.ok(retained.every((path) => statSync(path).size <= 1_024));
  assert.equal(existsSync(`${logPath}.lock`), false);
  value.store.close();
});

test("delayed launcher stderr is drained after timeout before choosing fallback", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-delayed-stderr-"));
  const launcher = join(processDir, "launcher.mjs");
  const logPath = join(processDir, "worker.log");
  writeFileSync(launcher, "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>setTimeout(()=>{console.error('delayed-fatal');process.exit(23);},200));\nsetInterval(()=>{},1000);\n");
  chmodSync(launcher, 0o755);

  const result = ensureSemanticWorker({
    store: value.store,
    launcherPath: launcher,
    cwd: value.root,
    logPath,
    log: { maxBytes: 1_024, historyCount: 2 },
    expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
    // Leave enough time for the Node launcher to install its SIGTERM handler
    // even when the full lifecycle suite is running under heavy CPU load.
    readinessTimeoutMs: 1_000,
  });

  assert.equal(result.status, "start_failed");
  const diagnostic = [logPath, `${logPath}.1`, `${logPath}.2`]
    .filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(diagnostic, /"diagnostic":"WORKER_BOOTSTRAP_STDERR_[A-F0-9]{12}"/);
  assert.doesNotMatch(diagnostic, /delayed-fatal/);
  value.store.close();
});

test("delayed stderr readiness cleanup remains no-orphan under CPU load", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-loaded-stderr-"));
  const launcher = join(processDir, "launcher.mjs");
  const launcherPidFile = join(processDir, "launcher.pid");
  const logPath = join(processDir, "worker.log");
  writeFileSync(launcher, `#!/usr/bin/env node
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(launcherPidFile)}, String(process.pid));
    process.on("SIGTERM",()=>setTimeout(()=>{console.error("loaded-delayed-fatal");process.exit(23);},200));
    setInterval(()=>{},1000);
  `);
  chmodSync(launcher, 0o755);
  const load = Array.from({ length: 4 }, () => spawn(
    process.execPath,
    ["--input-type=module", "--eval", "const end=Date.now()+4000;while(Date.now()<end){}"],
    { stdio: ["ignore", "ignore", "ignore"] },
  ));
  let launcherPid = null;
  try {
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      logPath,
      log: { maxBytes: 1_024, historyCount: 2 },
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      readinessTimeoutMs: 2_000,
    });
    assert.equal(result.status, "start_failed");
    assert.equal(result.reason, "SEMANTIC_WORKER_READINESS_TIMEOUT");
    assert.equal(existsSync(launcherPidFile), true, "loaded launcher installed its handler");
    launcherPid = Number(readFileSync(launcherPidFile, "utf8"));
    assert.equal(processIsRunning(launcherPid), false, "loaded delayed launcher is gone before return");
    const diagnostic = [logPath, `${logPath}.1`, `${logPath}.2`]
      .filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n");
    assert.match(diagnostic, /"diagnostic":"WORKER_BOOTSTRAP_STDERR_[A-F0-9]{12}"/);
    assert.doesNotMatch(diagnostic, /loaded-delayed-fatal/);
  } finally {
    await Promise.all(load.map((child) => {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGKILL");
      return exited;
    }));
    if (launcherPid != null && processIsRunning(launcherPid)) process.kill(launcherPid, "SIGKILL");
    value.store.close();
  }
});

test("twenty empty-stderr readiness timeouts always emit a deterministic fallback diagnostic", async () => {
  const value = await fixture();
  const processDir = mkdtempSync(join(tmpdir(), "penguin-worker-empty-bootstrap-"));
  const launcher = join(processDir, "launcher.mjs");
  writeFileSync(launcher, `#!/usr/bin/env node
    import { writeFileSync } from "node:fs";
    writeFileSync(process.env.PENGUIN_TEST_EMPTY_BOOTSTRAP_PID, String(process.pid));
    writeFileSync(process.env.PENGUIN_TEST_EMPTY_BOOTSTRAP_READY, JSON.stringify({ pid: process.pid, readyAt: Date.now() }));
    process.on("SIGTERM", () => undefined);
    process.on("SIGINT", () => undefined);
    process.on("SIGHUP", () => undefined);
    setInterval(() => undefined, 1000);
  `);
  chmodSync(launcher, 0o755);

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const logPath = join(processDir, `worker-${attempt}.log`);
    const launcherPidFile = join(processDir, `launcher-${attempt}.pid`);
    const readyFile = join(processDir, `launcher-${attempt}.ready`);
    const cleanupCompleteFile = join(processDir, `cleanup-${attempt}.complete`);
    const readinessTimeoutMs = 1_500;
    const readinessStartedAt = Date.now();
    const result = ensureSemanticWorker({
      store: value.store,
      launcherPath: launcher,
      cwd: value.root,
      env: {
        PENGUIN_TEST_EMPTY_BOOTSTRAP_PID: launcherPidFile,
        PENGUIN_TEST_EMPTY_BOOTSTRAP_READY: readyFile,
      },
      logPath,
      log: { maxBytes: 1_024, historyCount: 1 },
      expectedRuntimeIdentity: runtimeIdentity({ modelHash: value.provider.modelHash }),
      readinessTimeoutMs,
    });

    assert.equal(result.status, "start_failed", `attempt ${attempt}`);
    assert.equal(result.reason, "SEMANTIC_WORKER_READINESS_TIMEOUT", `attempt ${attempt}`);
    assert.equal(existsSync(readyFile), true, `attempt ${attempt} launcher never completed its PID/ready protocol before timeout`);
    const ready = JSON.parse(readFileSync(readyFile, "utf8"));
    assert.equal(ready.pid, Number(readFileSync(launcherPidFile, "utf8")), `attempt ${attempt} protocol PID`);
    assert.ok(
      ready.readyAt >= readinessStartedAt && ready.readyAt <= readinessStartedAt + readinessTimeoutMs,
      `attempt ${attempt} launcher ready protocol must complete within the readiness window`,
    );
    const launcherPid = Number(readFileSync(launcherPidFile, "utf8"));
    assert.equal(processIsRunning(launcherPid), false, `attempt ${attempt} launcher is absent after cleanup`);
    writeFileSync(cleanupCompleteFile, "cleanup-complete");
    assert.equal(readFileSync(cleanupCompleteFile, "utf8"), "cleanup-complete", `attempt ${attempt}`);
    const records = [logPath, `${logPath}.1`]
      .filter(existsSync)
      .flatMap((path) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    const failure = records.find((record) => record.event === "worker_start_failed");
    assert.ok(failure, `attempt ${attempt} writes worker_start_failed`);
    const expected = createHash("sha256")
      .update(`${failure.reason}\0${failure.startToken}`)
      .digest("hex")
      .slice(0, 12)
      .toUpperCase();
    assert.equal(failure.diagnostic, `WORKER_BOOTSTRAP_FALLBACK_${expected}`, `attempt ${attempt}`);
    assert.doesNotMatch(JSON.stringify(failure), /Error:|\bat\s|private\/|token=/);
    assert.ok([logPath, `${logPath}.1`].filter(existsSync).every((path) => statSync(path).size <= 1_024));
  }
  value.store.close();
});

test("worker checkpoint failures and exit reasons are logged as sanitized structured diagnostics", async () => {
  const value = await fixture({ fileCount: 12 });
  const logPath = join(value.directory, "diagnostic-worker.log");
  const originalPragma = value.store.db.pragma.bind(value.store.db);
  let injected = false;
  value.store.db.pragma = (statement, ...args) => {
    if (statement === "wal_checkpoint(PASSIVE)" && !injected) {
      injected = true;
      throw new Error("SQLITE_IOERR token=checkpoint-secret");
    }
    return originalPragma(statement, ...args);
  };

  const result = await runSemanticWorker({
    store: value.store,
    ownerId: "diagnostic-worker",
    buildId: "build-a",
    providerFactory: async () => value.provider,
    batchSize: 1,
    log: { path: logPath, maxBytes: 2_048, historyCount: 2 },
  });

  assert.equal(result.status, "drained");
  const diagnostic = [logPath, `${logPath}.1`, `${logPath}.2`].filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.match(diagnostic, /"event":"checkpoint_failed"/);
  assert.match(diagnostic, /"reason":"WAL_CHECKPOINT_FAILED"/);
  assert.doesNotMatch(diagnostic, /SQLITE_IOERR|checkpoint-secret/);
  value.store.db.pragma = originalPragma;
  value.store.close();
});

test("worker_exit includes a sanitized reason without raw provider diagnostics", async () => {
  const value = await fixture();
  const logPath = join(value.directory, "worker-exit-reason.log");
  const result = await runSemanticWorker({
    store: value.store,
    ownerId: "reason-worker",
    buildId: "build-a",
    providerFactory: async () => { throw new Error("provider token=VERY-SECRET /private/model/path"); },
    log: { path: logPath, maxBytes: 2_048, historyCount: 1 },
  });
  const diagnostic = [logPath, `${logPath}.1`].filter(existsSync).map((path) => readFileSync(path, "utf8")).join("\n");
  assert.equal(result.status, "model_unavailable");
  assert.match(result.reason, /^WORKER_DIAGNOSTIC_[A-F0-9]{12}$/);
  assert.match(diagnostic, /"event":"worker_exit"/);
  assert.match(diagnostic, /"reason":"WORKER_DIAGNOSTIC_[A-F0-9]{12}"/);
  assert.doesNotMatch(diagnostic, /VERY-SECRET|token=|private\/model|Error:|\bat\s/);
  value.store.close();
});

test("one long-running worker keeps its live log and retained history bounded", async () => {
  const value = await fixture({ fileCount: 12 });
  const logPath = join(value.directory, "live-worker.log");
  const maxBytes = 384;
  const historyCount = 2;
  let providerCalls = 0;
  const provider = {
    ...value.provider,
    async embedDocuments(values) {
      providerCalls += 1;
      if (providerCalls === 5) {
        assert.equal(existsSync(`${logPath}.1`), true, "rotation happens before the worker exits");
      }
      return values.map(() => new Float32Array([1, 0]));
    },
  };

  const result = await runSemanticWorker({
    store: value.store,
    ownerId: "bounded-log-worker",
    buildId: "build-a",
    providerFactory: async () => provider,
    batchSize: 1,
    log: { path: logPath, maxBytes, historyCount },
  });

  assert.equal(result.status, "drained");
  assert.ok(providerCalls >= 5, `expected multiple live batches, got ${providerCalls}`);
  const retained = [logPath, `${logPath}.1`, `${logPath}.2`].filter(existsSync);
  assert.ok(retained.length >= 2, "current log and at least one rotated segment are retained");
  assert.equal(existsSync(`${logPath}.3`), false, "history count is a hard bound");
  assert.ok(retained.every((path) => statSync(path).size <= maxBytes));
  assert.ok(retained.reduce((total, path) => total + statSync(path).size, 0) <= maxBytes * (historyCount + 1));
  value.store.close();
});
