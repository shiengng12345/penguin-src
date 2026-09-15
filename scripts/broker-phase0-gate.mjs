// scripts/broker-phase0-gate.mjs
//
// Runs the Phase 0 "Part 1 Gate" (docs/superpowers/plans/2026-09-15-penguin-broker-phase0.md)
// end to end, in the only order that makes it honest:
//
//   1. record the broker's real topic list BEFORE touching anything — the
//      residue check compares against this live baseline, never a hardcoded
//      count, because the broker holds the user's real business topics.
//   2. run the capability suite (needs both the local-open `pulsar` broker
//      and the local-secure `broker-pulsar-secure` broker up).
//   3. stop the secure broker (only if it was running) before the cargo
//      step — two brokers plus a cargo build/run has OOM-killed a container
//      more than once against this project's 6.2 GB VM.
//   4. seed the DLQ/backlog fixtures with `cargo run --bin broker_sim`.
//   5. run the DLQ properties suite and require zero skips — a skip means
//      the fixtures were not seeded, and "Not run" never satisfies this gate.
//   6. delete the three fixture topics it seeded, then re-read the topic
//      list and require it to equal the baseline exactly.
//
// Cleanup (fixture topics + restoring the secure broker's running state)
// happens in a `finally` so a failure partway through still leaves the
// broker exactly as this script found it.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC_TAURI = join(ROOT, "src-tauri");
const ADMIN = process.env.BROKER_ADMIN_URL ?? "http://localhost:8080";
const BROKER_URL = process.env.BROKER_URL ?? "pulsar://localhost:6650";
const SECURE_CONTAINER = process.env.BROKER_SECURE_CONTAINER ?? "broker-pulsar-secure";
const FIXTURE_TOPICS = ["broker-sim-source", "broker-sim-source-DLQ", "broker-sim-peek-backlog"];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail ?? null });
  const line = `${ok ? "PASS" : "FAIL"}  ${name}`;
  console.log(detail ? `${line} — ${detail}` : line);
}

function tail(text, n = 25) {
  return (text ?? "").trim().split("\n").slice(-n).join("\n");
}

async function fetchTopicNames(adminUrl) {
  const res = await fetch(`${adminUrl}/admin/v2/persistent/public/default`);
  if (!res.ok) throw new Error(`GET topic list failed: HTTP ${res.status}`);
  const topics = await res.json();
  return new Set(topics.map((t) => t.replace(/^persistent:\/\/public\/default\//, "")));
}

// Cleanup must never throw: a failed delete must not mask whatever error (if
// any) triggered the enclosing finally block.
async function safeDeleteTopic(adminUrl, name) {
  try {
    await fetch(`${adminUrl}/admin/v2/persistent/public/default/${name}?force=true`, { method: "DELETE" });
  } catch { /* swallow: cleanup must not throw */ }
}

function runNodeTest(testFile) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", testFile], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const pass = Number(output.match(/^# pass (\d+)/mu)?.[1] ?? NaN);
  const fail = Number(output.match(/^# fail (\d+)/mu)?.[1] ?? NaN);
  const skipped = Number(output.match(/^# skipped (\d+)/mu)?.[1] ?? NaN);
  return { exitCode: result.status, pass, fail, skipped, output };
}

function runSimulator() {
  return spawnSync("cargo", ["run", "--bin", "broker_sim", "--", BROKER_URL], {
    cwd: SRC_TAURI,
    encoding: "utf8",
    timeout: 240_000,
  });
}

function isContainerRunning(name) {
  const result = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() === "true";
}

function stopContainer(name) {
  const result = spawnSync("docker", ["stop", name], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`docker stop ${name} failed: ${tail(`${result.stdout ?? ""}${result.stderr ?? ""}`)}`);
}

function startContainer(name) {
  const result = spawnSync("docker", ["start", name], { encoding: "utf8", timeout: 60_000 });
  if (result.status !== 0) throw new Error(`docker start ${name} failed: ${tail(`${result.stdout ?? ""}${result.stderr ?? ""}`)}`);
}

let baseline = null;
let secureWasRunning = false;
let secureStopped = false;

async function main() {
  // Step 0 — baseline, before anything else touches the broker.
  baseline = await fetchTopicNames(ADMIN);
  console.log(`INFO  baseline topic list recorded (${baseline.size} topic(s) on the broker before this run)`);

  // Step 1 — capability suite, while both brokers are still up.
  try {
    const r = runNodeTest("tests/broker-capability.test.mjs");
    if (r.exitCode !== 0 || r.fail !== 0 || !(r.pass > 0)) {
      throw new Error(`exit=${r.exitCode} pass=${r.pass} fail=${r.fail}\n${tail(r.output)}`);
    }
    record("broker-capability.test.mjs passes (local-open + local-secure)", true, `${r.pass} passed`);
  } catch (err) {
    record("broker-capability.test.mjs passes (local-open + local-secure)", false, err.message);
    throw err;
  }

  // Everything past this point may mutate broker/container state, so it is
  // wrapped in try/finally: a failure anywhere below must still clean up.
  try {
    secureWasRunning = isContainerRunning(SECURE_CONTAINER);
    if (secureWasRunning) {
      stopContainer(SECURE_CONTAINER);
      secureStopped = true;
      console.log(`INFO  stopped ${SECURE_CONTAINER} before the cargo build/run (was running; two brokers + cargo exceeds the 6.2 GB VM)`);
    } else {
      console.log(`INFO  ${SECURE_CONTAINER} was not running; leaving it alone`);
    }

    // Step 2 — seed fixtures.
    try {
      const r = runSimulator();
      if (r.status !== 0 || r.error) {
        const detail = r.error ? String(r.error) : tail(`${r.stdout ?? ""}\n${r.stderr ?? ""}`);
        throw new Error(`cargo run --bin broker_sim -- ${BROKER_URL} exited ${r.status}\n${detail}`);
      }
      record("seed fixtures via broker_sim", true, "produced broker-sim-source, broker-sim-source-DLQ, broker-sim-peek-backlog");
    } catch (err) {
      record("seed fixtures via broker_sim", false, err.message);
      throw err;
    }

    // Step 3 — DLQ properties suite, zero skips required.
    try {
      const r = runNodeTest("tests/broker-dlq-properties.test.mjs");
      if (r.skipped > 0) {
        throw new Error(
          `${r.skipped} test(s) skipped — the fixtures were not seeded (cargo run --bin broker_sim must ` +
          "populate broker-sim-source/-DLQ/-peek-backlog before this suite runs); a skip counts as Not run " +
          "and never satisfies this gate"
        );
      }
      if (r.exitCode !== 0 || r.fail !== 0 || !(r.pass > 0)) {
        throw new Error(`exit=${r.exitCode} pass=${r.pass} fail=${r.fail}\n${tail(r.output)}`);
      }
      record("broker-dlq-properties.test.mjs passes with zero skipped", true, `${r.pass} passed, 0 skipped`);
    } catch (err) {
      record("broker-dlq-properties.test.mjs passes with zero skipped", false, err.message);
      throw err;
    }
  } finally {
    for (const name of FIXTURE_TOPICS) {
      await safeDeleteTopic(ADMIN, name);
    }
    console.log(`INFO  deleted fixture topics (${FIXTURE_TOPICS.join(", ")})`);

    if (secureStopped) {
      try {
        startContainer(SECURE_CONTAINER);
        console.log(`INFO  restarted ${SECURE_CONTAINER}`);
      } catch (err) {
        record(`restore ${SECURE_CONTAINER} to running`, false, err.message);
      }
    }
  }

  // Step 4 — residue check against the real, live baseline.
  const after = await fetchTopicNames(ADMIN);
  const added = [...after].filter((t) => !baseline.has(t));
  const missing = [...baseline].filter((t) => !after.has(t));
  if (added.length || missing.length) {
    const parts = [];
    if (added.length) parts.push(`added: ${added.join(", ")}`);
    if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
    record("no broker-sim residue (topic list matches baseline)", false, parts.join("; "));
    throw new Error("topic list does not match the pre-run baseline");
  }
  record("no broker-sim residue (topic list matches baseline)", true, "topic list matches the pre-run baseline exactly");
}

try {
  await main();
  console.log("\nbroker:gate PASSED");
  process.exit(0);
} catch (err) {
  console.error(`\nbroker:gate FAILED: ${err.message}`);
  console.error("\nSummary:");
  for (const r of results) {
    console.error(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  }
  process.exit(1);
}
