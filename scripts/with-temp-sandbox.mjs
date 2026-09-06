#!/usr/bin/env node
/*
 * Runs a command with TMPDIR pointed at a disposable directory that is removed
 * when the command exits. Tests and the CLI/MCP processes they spawn create
 * scratch directories via os.tmpdir(); without a sandbox those survive the run
 * and accumulate in the user's temp directory indefinitely.
 *
 * Usage: node scripts/with-temp-sandbox.mjs <command> [args...]
 */
import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("with-temp-sandbox: expected a command to run");
  process.exit(2);
}

const sandbox = mkdtempSync(join(tmpdir(), "pengvi-sandbox-"));
let removed = false;
function removeSandbox() {
  if (removed) return;
  removed = true;
  rmSync(sandbox, { recursive: true, force: true });
}
process.on("exit", removeSandbox);

const child = spawn(command, args, {
  stdio: "inherit",
  // TMP/TEMP are read by tooling that does not go through os.tmpdir().
  env: { ...process.env, TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox },
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  removeSandbox();
  console.error(`with-temp-sandbox: failed to run ${command}: ${error.message}`);
  process.exit(127);
});

child.on("exit", (code, signal) => {
  removeSandbox();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
