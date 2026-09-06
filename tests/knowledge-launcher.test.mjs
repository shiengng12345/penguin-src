import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const cliLauncher = join(root, "scripts/knowledge-cli-launcher.mjs");
const mcpLauncher = join(root, "scripts/knowledge-mcp-launcher.mjs");

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const status = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const state = status.stdout.trim();
  return status.status === 0 && state.length > 0 && !state.startsWith("Z");
}

function processIdentity(pid) {
  const result = spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,lstart=,stat=", "-p", String(pid)], { encoding: "utf8" });
  const row = result.stdout.trim();
  const match = /^(\d+)\s+(\d+)\s+(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)$/u.exec(row);
  assert.ok(match && !match[5].startsWith("Z"), `process identity unavailable: ${row}`);
  return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startIdentity: match[4] };
}

async function waitUntil(predicate, message, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForExit(child, message, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "penguin-launcher-"));
  const runtimes = join(home, "runtimes");
  const generation = join(runtimes, "build-b");
  mkdirSync(join(generation, "mcp", "dist"), { recursive: true });
  mkdirSync(join(generation, "wasm"), { recursive: true });
  writeFileSync(join(generation, "node"), "#!/bin/sh\nprintf '%s\\n' /tmp/fake \"$@\"\n");
  chmodSync(join(generation, "node"), 0o755);
  writeFileSync(join(generation, "penguin.mjs"), "");
  writeFileSync(join(generation, "mcp", "dist", "index.js"), "");
  writeFileSync(join(generation, "manifest.json"), JSON.stringify({
    schemaVersion: 1, ready: true, buildId: "build-b", nodePath: "node",
    appVersion: "1.16.0", capabilityHash: "a".repeat(64), contractSchemaVersion: 18,
    contractVersion: "2", modelHash: "b".repeat(64),
    cliEntry: "penguin.mjs", mcpEntry: "mcp/dist/index.js", wasmPath: "wasm",
  }));
  symlinkSync(generation, join(runtimes, "current"));
  return { runtimes };
}

test("CLI launcher resolves the active manifest and forwards arguments", () => {
  const { runtimes } = fixture();
  const result = spawnSync(process.execPath, [cliLauncher, "status", "--json"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes }, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), ["/tmp/fake", realpathSync(join(runtimes, "build-b", "penguin.mjs")), "status", "--json"]);
});

test("MCP launcher resolves the same active build without changing its path", () => {
  const { runtimes } = fixture();
  const result = spawnSync(process.execPath, [mcpLauncher, "--stdio"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes }, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), ["/tmp/fake", realpathSync(join(runtimes, "build-b", "mcp", "dist", "index.js")), "--stdio"]);
});

test("MCP launcher forwards termination to its active runtime child", async () => {
  const { runtimes } = fixture();
  const generation = join(runtimes, "build-b");
  const readyFile = join(generation, "child-ready");
  const termFile = join(generation, "child-terminated");
  writeFileSync(join(generation, "node"), `#!/bin/sh
trap 'printf terminated > "${termFile}"; exit 0' TERM INT HUP
printf '%s' "$$" > "${readyFile}"
while :; do sleep 0.1; done
`);
  chmodSync(join(generation, "node"), 0o755);
  const launcher = spawn(process.execPath, [mcpLauncher], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const waitUntil = async (predicate, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for launcher lifecycle evidence");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  try {
    await waitUntil(() => existsSync(readyFile));
    const runtimePid = Number(readFileSync(readyFile, "utf8"));
    assert.ok(Number.isInteger(runtimePid) && runtimePid > 1);
    const launcherExit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("launcher did not exit after forwarding SIGTERM")), 2_000);
      launcher.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    launcher.kill("SIGTERM");
    await waitUntil(() => existsSync(termFile));
    await launcherExit;
    assert.equal(readFileSync(termFile, "utf8"), "terminated");
    assert.throws(() => process.kill(runtimePid, 0), /ESRCH/);
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
  }
});

test("CLI launcher forwards termination to its active runtime child", async () => {
  const { runtimes } = fixture();
  const generation = join(runtimes, "build-b");
  const readyFile = join(generation, "cli-child-ready");
  const termFile = join(generation, "cli-child-terminated");
  writeFileSync(join(generation, "node"), `#!/bin/sh
trap 'printf terminated > "${termFile}"; exit 0' TERM INT HUP
printf '%s' "$$" > "${readyFile}"
while :; do sleep 0.1; done
`);
  chmodSync(join(generation, "node"), 0o755);
  const launcher = spawn(process.execPath, [cliLauncher], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let launcherStdout = "";
  let launcherStderr = "";
  launcher.stdout.on("data", (chunk) => { launcherStdout += chunk; });
  launcher.stderr.on("data", (chunk) => { launcherStderr += chunk; });
  const waitUntil = async (predicate, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for CLI launcher lifecycle evidence");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let runtimePid = null;
  try {
    await waitUntil(() => existsSync(readyFile) || launcher.exitCode !== null);
    assert.equal(existsSync(readyFile), true, `${launcherStdout}\n${launcherStderr}`);
    runtimePid = Number(readFileSync(readyFile, "utf8"));
    assert.ok(Number.isInteger(runtimePid) && runtimePid > 1);
    const launcherExit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CLI launcher did not exit after forwarding SIGTERM")), 2_000);
      launcher.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    launcher.kill("SIGTERM");
    await waitUntil(() => existsSync(termFile));
    await launcherExit;
    assert.equal(readFileSync(termFile, "utf8"), "terminated");
    assert.throws(() => process.kill(runtimePid, 0), /ESRCH/);
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    if (runtimePid != null) {
      try { process.kill(runtimePid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("CLI launcher force-terminates only its owned runtime child after the grace window", async () => {
  const { runtimes } = fixture();
  const generation = join(runtimes, "build-b");
  const readyFile = join(generation, "cli-force-child-ready");
  writeFileSync(join(generation, "node"), `#!/bin/sh
trap '' TERM INT HUP
printf '%s' "$$" > "${readyFile}"
while :; do sleep 0.1; done
`);
  chmodSync(join(generation, "node"), 0o755);
  const launcher = spawn(process.execPath, [cliLauncher], {
    env: {
      ...process.env,
      PENGUIN_RUNTIME_ROOT: runtimes,
      PENGUIN_LAUNCHER_TERMINATION_GRACE_MS: "100",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const waitUntil = async (predicate, timeoutMs = 2_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("timed out waiting for forced CLI launcher cleanup");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  let runtimePid = null;
  try {
    await waitUntil(() => existsSync(readyFile));
    runtimePid = Number(readFileSync(readyFile, "utf8"));
    const launcherExit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CLI launcher did not force-terminate its child")), 2_000);
      launcher.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    launcher.kill("SIGTERM");
    await launcherExit;
    assert.throws(() => process.kill(runtimePid, 0), /ESRCH/);
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    if (runtimePid != null) {
      try { process.kill(runtimePid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("MCP launcher force-terminates an owned runtime which ignores TERM", async () => {
  const { runtimes } = fixture();
  const generation = join(runtimes, "build-b");
  const readyFile = join(generation, "mcp-force-child-ready");
  writeFileSync(join(generation, "node"), `#!/bin/sh
trap '' TERM INT HUP
printf '%s' "$$" > "${readyFile}"
while :; do sleep 0.1; done
`);
  chmodSync(join(generation, "node"), 0o755);
  const launcher = spawn(process.execPath, [mcpLauncher], {
    env: {
      ...process.env,
      PENGUIN_RUNTIME_ROOT: runtimes,
      PENGUIN_LAUNCHER_TERMINATION_GRACE_MS: "100",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  let runtimePid = null;
  try {
    await waitUntil(() => existsSync(readyFile), "MCP runtime never became ready");
    runtimePid = Number(readFileSync(readyFile, "utf8"));
    launcher.kill("SIGTERM");
    await waitForExit(launcher, "MCP launcher did not force-terminate its runtime");
    await waitUntil(() => !pidIsAlive(runtimePid), "ignored-TERM MCP runtime survived launcher exit");
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
    if (runtimePid != null && pidIsAlive(runtimePid)) process.kill(runtimePid, "SIGKILL");
  }
});

for (const [name, launcherPath] of [["CLI", cliLauncher], ["MCP", mcpLauncher]]) {
  test(`${name} launcher cleans its verified descendant tree and preserves an unrelated process`, async () => {
    const { runtimes } = fixture();
    const generation = join(runtimes, "build-b");
    const runtimePidFile = join(generation, `${name.toLowerCase()}-tree-runtime.pid`);
    const descendantPidFile = join(generation, `${name.toLowerCase()}-tree-descendant.pid`);
    writeFileSync(join(generation, "node"), `#!/bin/sh
trap '' TERM INT HUP
sh -c 'trap "" TERM INT HUP; while :; do sleep 0.1; done' &
printf '%s' "$!" > "${descendantPidFile}"
printf '%s' "$$" > "${runtimePidFile}"
while :; do sleep 0.1; done
`);
    chmodSync(join(generation, "node"), 0o755);
    const unrelated = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const launcher = spawn(process.execPath, [launcherPath], {
      env: {
        ...process.env,
        PENGUIN_RUNTIME_ROOT: runtimes,
        PENGUIN_LAUNCHER_TERMINATION_GRACE_MS: "100",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let runtimePid = null;
    let descendantPid = null;
    try {
      await waitUntil(
        () => existsSync(runtimePidFile) && existsSync(descendantPidFile),
        `${name} runtime tree never became ready`,
      );
      runtimePid = Number(readFileSync(runtimePidFile, "utf8"));
      descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
      assert.equal(pidIsAlive(unrelated.pid), true, "unrelated sentinel starts alive");
      launcher.kill("SIGTERM");
      await waitForExit(launcher, `${name} launcher did not exit after tree cleanup`);
      await waitUntil(
        () => !pidIsAlive(runtimePid) && !pidIsAlive(descendantPid),
        `${name} launcher left an owned descendant alive`,
      );
      assert.equal(pidIsAlive(unrelated.pid), true, "unrelated sentinel must survive owned-tree cleanup");
    } finally {
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      for (const pid of [runtimePid, descendantPid, unrelated.pid]) {
        if (pid != null && pidIsAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });
}

for (const [name, launcherPath] of [["CLI", cliLauncher], ["MCP", mcpLauncher]]) {
  test(`${name} launcher cleans a registered self-detached PPID 1 descendant and preserves an unrelated sentinel`, async () => {
    if (process.platform === "win32") return;
    const { runtimes } = fixture();
    const generation = join(runtimes, "build-b");
    const runtimePidFile = join(generation, `${name.toLowerCase()}-reparent-runtime.pid`);
    const grandchildPidFile = join(generation, `${name.toLowerCase()}-reparent-grandchild.pid`);
    const readyFile = join(generation, `${name.toLowerCase()}-reparent-ready`);
    const handoffReadyFile = join(generation, `${name.toLowerCase()}-reparent-handoff-ready`);
    const freezeReadyFile = join(generation, `${name.toLowerCase()}-reparent-freeze-ready`);
    const intermediateReadyFile = join(generation, `${name.toLowerCase()}-reparent-intermediate-ready`);
    const registrationFile = join(generation, `${name.toLowerCase()}-reparent-registered`);
    const registryPath = join(generation, `${name.toLowerCase()}-owned-processes.jsonl`);
    const registryToken = `test-owned-${name.toLowerCase()}`;
    const grandchild = join(generation, `${name.toLowerCase()}-grandchild.mjs`);
    const intermediate = join(generation, `${name.toLowerCase()}-intermediate.mjs`);
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
      writeFileSync(${JSON.stringify(handoffReadyFile)}, "handoff-recorded");
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
      while (!existsSync(${JSON.stringify(handoffReadyFile)})) {
        if (Date.now() >= deadline) process.exit(91);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      writeFileSync(${JSON.stringify(intermediateReadyFile)}, "handoff-observed");
      process.exit(0);
    `);
    writeFileSync(join(generation, "node"), `#!/usr/bin/env node
      import { spawn } from "node:child_process";
      import { existsSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(runtimePidFile)}, String(process.pid));
      const intermediate = spawn(process.execPath, [${JSON.stringify(intermediate)}], { stdio: "ignore" });
      intermediate.once("exit", () => {
        if (existsSync(${JSON.stringify(intermediateReadyFile)})) writeFileSync(${JSON.stringify(readyFile)}, "tree-ready");
      });
      process.on("SIGTERM", () => process.exit(0));
      process.on("SIGINT", () => process.exit(0));
      process.on("SIGHUP", () => process.exit(0));
      setInterval(()=>{},1000);
    `);
    chmodSync(join(generation, "node"), 0o755);
    const unrelated = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    writeFileSync(registryPath, "", { mode: 0o600 });
    const launcher = spawn(process.execPath, [launcherPath], {
      env: {
        ...process.env,
        PENGUIN_RUNTIME_ROOT: runtimes,
        PENGUIN_LAUNCHER_TERMINATION_GRACE_MS: "150",
        PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY: registryPath,
        PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN: registryToken,
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let runtimePid = null;
    let grandchildPid = null;
    try {
      await waitUntil(() => existsSync(readyFile), `${name} reparent fixture never completed its tree-ready handshake`, 5_000);
      assert.equal(readFileSync(readyFile, "utf8"), "tree-ready");
      assert.equal(existsSync(runtimePidFile), true, "tree-ready is only written after the runtime PID protocol");
      assert.equal(existsSync(grandchildPidFile), true, "tree-ready is only written after the detached child PID protocol");
      assert.equal(existsSync(registrationFile), true, "tree-ready is only written after ownership registration");
      runtimePid = Number(readFileSync(runtimePidFile, "utf8"));
      grandchildPid = Number(readFileSync(grandchildPidFile, "utf8"));
      assert.equal(readFileSync(registrationFile, "utf8"), "registered", "self-detached child must complete the ownership handshake");
      await waitUntil(
        () => Number(spawnSync("/bin/ps", ["-o", "ppid=", "-p", String(grandchildPid)], { encoding: "utf8" }).stdout.trim()) === 1,
        `${name} detached grandchild was not reparented to PID 1`,
      );
      launcher.kill("SIGTERM");
      await waitForExit(launcher, `${name} launcher did not exit after reparented cleanup`);
      assert.equal(readFileSync(freezeReadyFile, "utf8"), "freeze-ready", "launcher must request and verify a self-freeze before signaling the handoff PGID");
      await waitUntil(() => !pidIsAlive(grandchildPid), `${name} reparented grandchild survived launcher exit`);
      assert.equal(pidIsAlive(unrelated.pid), true, "unrelated sentinel must survive runtime-group cleanup");
    } finally {
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      for (const pid of [runtimePid, grandchildPid, unrelated.pid]) {
        if (pid != null && pidIsAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });
}

for (const launcherPath of [cliLauncher, mcpLauncher]) {
  test(`${launcherPath.endsWith("cli-launcher.mjs") ? "CLI" : "MCP"} launcher rejects a reused PID identity before signaling`, () => {
    const probe = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      const launcher = await import(${JSON.stringify(pathToFileURL(launcherPath).href)});
      const expected = { pid: 4242, startIdentity: "Mon Sep  1 12:00:00 2026", pgid: 4242 };
      const reused = { pid: 4242, startIdentity: "Mon Sep  1 12:00:01 2026", pgid: 4242 };
      if (launcher.sameProcessIdentity(expected, reused)) process.exit(9);
    `], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
  });
}

test("CLI launcher default grace covers SQLite busy timeout before force cleanup", async () => {
  if (process.platform === "win32") return;
  const { runtimes } = fixture();
  const generation = join(runtimes, "build-b");
  const readyFile = join(generation, "busy-grace-ready");
  const cleanupFile = join(generation, "busy-grace-cleanup");
  writeFileSync(join(generation, "node"), `#!/usr/bin/env node
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(readyFile)}, "ready");
    process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(cleanupFile)}, "done"); process.exit(0); }, 5200));
    setInterval(()=>{},1000);
  `);
  chmodSync(join(generation, "node"), 0o755);
  const launcher = spawn(process.execPath, [cliLauncher], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    await waitUntil(() => existsSync(readyFile), "busy-grace runtime never became ready");
    launcher.kill("SIGTERM");
    await waitForExit(launcher, "launcher force-killed before SQLite busy cleanup could finish", 8_000);
    assert.equal(existsSync(cleanupFile), true, "default launcher grace must exceed SQLite busy_timeout=5000ms");
  } finally {
    if (launcher.exitCode === null) launcher.kill("SIGKILL");
  }
});

for (const [name, launcherPath] of [["CLI", cliLauncher], ["MCP", mcpLauncher]]) {
  test(`${name} launcher cleans an ignored-TERM descendant before a cooperative runtime exits`, async () => {
    const { runtimes } = fixture();
    const generation = join(runtimes, "build-b");
    const readyFile = join(generation, `${name.toLowerCase()}-cooperative-tree-ready`);
    const descendantPidFile = join(generation, `${name.toLowerCase()}-cooperative-descendant.pid`);
    writeFileSync(join(generation, "node"), `#!/bin/sh
sh -c 'trap "" TERM INT HUP; while :; do sleep 0.1; done' &
printf '%s' "$!" > "${descendantPidFile}"
trap 'exit 0' TERM INT HUP
printf ready > "${readyFile}"
while :; do sleep 0.1; done
`);
    chmodSync(join(generation, "node"), 0o755);
    const launcher = spawn(process.execPath, [launcherPath], {
      env: {
        ...process.env,
        PENGUIN_RUNTIME_ROOT: runtimes,
        PENGUIN_LAUNCHER_TERMINATION_GRACE_MS: "100",
      },
      stdio: ["ignore", "ignore", "ignore"],
    });
    let descendantPid = null;
    try {
      await waitUntil(
        () => existsSync(readyFile) && existsSync(descendantPidFile),
        `${name} cooperative runtime tree never became ready`,
      );
      descendantPid = Number(readFileSync(descendantPidFile, "utf8"));
      launcher.kill("SIGTERM");
      await waitForExit(launcher, `${name} launcher did not exit after cooperative runtime cleanup`);
      await waitUntil(() => !pidIsAlive(descendantPid), `${name} cooperative runtime left its descendant alive`);
    } finally {
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      if (descendantPid != null && pidIsAlive(descendantPid)) process.kill(descendantPid, "SIGKILL");
    }
  });
}

test("launchers remain standalone install artifacts", () => {
  const { runtimes } = fixture();
  const installDir = mkdtempSync(join(tmpdir(), "penguin-standalone-launchers-"));
  for (const [name, source, args] of [
    ["penguin", cliLauncher, ["status"]],
    ["penguin-mcp", mcpLauncher, ["--stdio"]],
  ]) {
    const installed = join(installDir, name);
    copyFileSync(source, installed);
    chmodSync(installed, 0o755);
    const result = spawnSync(process.execPath, [installed, ...args], {
      env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes }, encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("missing, malformed, and escaping manifests fail closed", () => {
  const home = mkdtempSync(join(tmpdir(), "penguin-launcher-invalid-"));
  const run = () => spawnSync(process.execPath, [cliLauncher], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: join(home, "runtimes") }, encoding: "utf8",
  });
  let result = run();
  assert.equal(result.status, 78);
  assert.match(result.stderr, /RUNTIME_NOT_INSTALLED/);
  mkdirSync(join(home, "runtimes"), { recursive: true });
  mkdirSync(join(home, "runtimes", "invalid"), { recursive: true });
  writeFileSync(join(home, "runtimes", "invalid", "manifest.json"), "not-json");
  symlinkSync(join(home, "runtimes", "invalid"), join(home, "runtimes", "current"));
  result = run();
  assert.equal(result.status, 78);
  assert.match(result.stderr, /RUNTIME_MANIFEST_INVALID/);
});

test("launchers reject manifests missing capability, contract schema, or model identity", () => {
  for (const missing of ["capabilityHash", "contractSchemaVersion", "modelHash"]) {
    const { runtimes } = fixture();
    const manifestPath = join(runtimes, "build-b", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest[missing];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [cliLauncher], {
      env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes }, encoding: "utf8",
    });
    assert.equal(result.status, 78, `${missing} must be required`);
    assert.match(result.stderr, /RUNTIME_MANIFEST_INVALID/);
  }
});

test("CLI launcher forwards the full runtime identity to the worker process", () => {
  const { runtimes } = fixture();
  const generation = join(runtimes, "build-b");
  writeFileSync(join(generation, "node"), `#!/bin/sh\nprintf '%s\\n' "$PENGUIN_BUILD_ID" "$PENGUIN_CAPABILITY_HASH" "$PENGUIN_SCHEMA_VERSION" "$PENGUIN_MODEL_HASH"\n`);
  chmodSync(join(generation, "node"), 0o755);
  const result = spawnSync(process.execPath, [cliLauncher, "semantic", "worker", "--drain"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes }, encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split("\n"), ["build-b", "a".repeat(64), "18", "b".repeat(64)]);
});

for (const [name, launcherPath] of [["CLI", cliLauncher], ["MCP", mcpLauncher]]) {
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    test(`${name} launcher handles ${signal} sent by its runtime immediately after detached spawn`, async () => {
      if (process.platform === "win32") return;
      const { runtimes } = fixture();
      const generation = join(runtimes, "build-b");
      const started = join(generation, `${name}-${signal}-early-started`);
      const terminated = join(generation, `${name}-${signal}-early-terminated`);
      writeFileSync(join(generation, "node"), `#!/usr/bin/env node
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(started)}, "started");
        process.on(${JSON.stringify(signal)}, () => { writeFileSync(${JSON.stringify(terminated)}, "terminated"); process.exit(0); });
        process.kill(process.ppid, ${JSON.stringify(signal)});
        setInterval(() => {}, 1000);
      `);
      chmodSync(join(generation, "node"), 0o755);
      const launcher = spawn(process.execPath, [launcherPath], {
        env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      launcher.stderr.on("data", (chunk) => { stderr += chunk; });
      try {
        await waitForExit(launcher, `${name} did not handle immediate ${signal}`, 3_000);
        assert.equal(existsSync(started), true, `${name} runtime was never spawned: ${stderr}`);
        assert.equal(existsSync(terminated), true, `${name} queued ${signal} was not forwarded after boundary setup: ${stderr}`);
      } finally {
        if (launcher.exitCode === null) launcher.kill("SIGKILL");
      }
    });
  }
}

test("CLI launcher pins current to one resolved generation while activation flips the current symlink", () => {
  const { runtimes } = fixture();
  const first = join(runtimes, "build-b");
  const second = join(runtimes, "build-c");
  const observed = join(first, "pinned-generation.json");
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, "node"), "#!/bin/sh\nprintf wrong-generation\\n\n");
  chmodSync(join(second, "node"), 0o755);
  writeFileSync(join(second, "penguin.mjs"), "");
  writeFileSync(join(second, "manifest.json"), JSON.stringify({
    schemaVersion: 1, ready: true, buildId: "build-c", nodePath: "node", cliEntry: "penguin.mjs",
    appVersion: "1.16.1", capabilityHash: "c".repeat(64), contractSchemaVersion: 18,
    contractVersion: "2", modelHash: "d".repeat(64), wasmPath: "wasm",
  }));
  writeFileSync(join(first, "node"), `#!/usr/bin/env node
    import { unlinkSync, symlinkSync, writeFileSync } from "node:fs";
    unlinkSync(${JSON.stringify(join(runtimes, "current"))});
    symlinkSync(${JSON.stringify(second)}, ${JSON.stringify(join(runtimes, "current"))});
    writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ entry: process.argv[2], buildId: process.env.PENGUIN_BUILD_ID }));
  `);
  chmodSync(join(first, "node"), 0o755);
  const result = spawnSync(process.execPath, [cliLauncher, "status"], {
    env: { ...process.env, PENGUIN_RUNTIME_ROOT: runtimes }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(readFileSync(observed, "utf8")), { entry: realpathSync(join(first, "penguin.mjs")), buildId: "build-b" });
  unlinkSync(join(runtimes, "current"));
  symlinkSync(first, join(runtimes, "current"));
});

for (const [name, launcherPath] of [["CLI", cliLauncher], ["MCP", mcpLauncher]]) {
  test(`${name} launcher does not signal when a same-UID registry claim copies a real identity but has invalid ancestry`, async () => {
    if (process.platform === "win32") return;
    const { runtimes } = fixture();
    const generation = join(runtimes, "build-b");
    const registry = join(generation, `${name}-forged-owners.jsonl`);
    const ready = join(generation, `${name}-forged-ready`);
    const runtimePidFile = join(generation, `${name}-forged-runtime.pid`);
    const runtimeSignaled = join(generation, `${name}-forged-runtime-signaled`);
    const sentinel = spawn(process.execPath, ["--input-type=module", "--eval", "setInterval(()=>{},1000)"], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    const copiedIdentity = processIdentity(sentinel.pid);
    writeFileSync(registry, `${JSON.stringify({ type: "handoff", version: 1, token: "forged", ...copiedIdentity })}\n`, { mode: 0o600 });
    writeFileSync(join(generation, "node"), `#!/bin/sh\nprintf '%s' "$$" > ${JSON.stringify(runtimePidFile)}\nprintf ready > ${JSON.stringify(ready)}\ntrap 'printf signaled > ${JSON.stringify(runtimeSignaled)}; exit 0' TERM INT HUP\nwhile :; do sleep 0.1; done\n`);
    chmodSync(join(generation, "node"), 0o755);
    const launcher = spawn(process.execPath, [launcherPath], {
      env: {
        ...process.env,
        PENGUIN_RUNTIME_ROOT: runtimes,
        PENGUIN_RUNTIME_OWNED_PROCESS_REGISTRY: registry,
        PENGUIN_RUNTIME_OWNED_PROCESS_TOKEN: "forged",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let runtimePid = null;
    launcher.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await waitUntil(() => existsSync(ready), `${name} forged-registry runtime never started`);
      runtimePid = Number(readFileSync(runtimePidFile, "utf8"));
      launcher.kill("SIGTERM");
      await waitForExit(launcher, `${name} launcher did not report forged registry`, 3_000);
      assert.notEqual(launcher.exitCode, 0);
      assert.match(stderr, /CLEANUP_UNPROVEN|OWNERSHIP_HANDOFF_UNPROVEN/);
      assert.equal(existsSync(runtimeSignaled), false, "cleanup-unproven must be decided before any termination signal");
      assert.equal(pidIsAlive(runtimePid), true, "owned runtime remains untouched when the ownership set is unproven");
      assert.equal(pidIsAlive(sentinel.pid), true, "copied unrelated identity must never be signaled");
    } finally {
      if (launcher.exitCode === null) launcher.kill("SIGKILL");
      if (runtimePid != null && pidIsAlive(runtimePid)) process.kill(runtimePid, "SIGKILL");
      if (pidIsAlive(sentinel.pid)) process.kill(sentinel.pid, "SIGKILL");
    }
  });
}
