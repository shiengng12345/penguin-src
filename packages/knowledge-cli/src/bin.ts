#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore } from "@penguin/knowledge-core";
import { readBoundedHookInput } from "./claude-hook.js";
import { runCli } from "./index.js";
import { createLarkProcessRunner } from "./lark-document-client.js";
import type { IndependentCorpusOracle } from "@penguin/knowledge-indexer";

// Default knowledge location (bundled/CLI + app share the same store).
const DB_PATH = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
const LEDGER_PATH = process.env.PENGUIN_KNOWLEDGE_LEDGER ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl");
const NOTES_DIR = process.env.PENGUIN_KNOWLEDGE_NOTES ?? join(homedir(), ".penguin", "knowledge", "notes");
const API_DOC_PREVIEWS = process.env.PENGUIN_API_DOC_PREVIEWS ?? join(homedir(), ".penguin", "knowledge", "api-docs", "previews");
const HOOK_STATE_DIR = process.env.PENGUIN_HOOK_STATE_DIR ?? join(homedir(), ".penguin", "knowledge", "hook-sessions");
const SELF_PATH = fileURLToPath(import.meta.url);

function collectCorpusOracleIsolated(rootPath: string): Promise<IndependentCorpusOracle> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      // Oracle workers are one-shot correctness checks, not latency-sensitive
      // servers. Node 24's parallel TurboFan compilation can exhaust native
      // Zone memory on the large HTML grammar before JS heap limits apply.
      // Liftoff-only + one compilation task keeps the same parser semantics
      // while bounding native compiler memory for heavy repositories.
      ["--liftoff-only", "--wasm-num-compilation-tasks=1", SELF_PATH, "corpus", "oracle", rootPath, "--json"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: process.env },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`isolated corpus oracle failed for ${rootPath}: ${stderr.trim() || error.message}`));
          return;
        }
        try {
          const line = stdout.trim().split("\n").filter(Boolean).at(-1);
          if (!line) throw new Error("oracle produced no JSON output");
          resolve(JSON.parse(line) as IndependentCorpusOracle);
        } catch (parseError) {
          reject(new Error(`isolated corpus oracle returned invalid JSON for ${rootPath}: ${String((parseError as Error).message ?? parseError)}`));
        }
      },
    );
  });
}

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  // Live progress only when stderr is a TTY (don't spew bar frames into pipes/logs).
  progress: process.stderr.isTTY ? (chunk) => process.stderr.write(chunk) : undefined,
  storeExists: () => existsSync(DB_PATH),
  readStdin: process.argv[2] === "hook"
    ? async () => (await readBoundedHookInput(process.stdin)) ?? ""
    : undefined,
  hookStateDir: HOOK_STATE_DIR,
  notesDir: NOTES_DIR,
  apiDocPreviewRoot: API_DOC_PREVIEWS,
  larkProcessRunner: createLarkProcessRunner(),
  // Pipes, the Tauri bridge, and CI are non-interactive: every mutating
  // operation must first expose a scoped preview token and then receive that
  // exact token back on --confirm. A real TTY can keep the interactive flow.
  requireOperationConfirmation: !(process.stdin.isTTY && process.stdout.isTTY),
  collectCorpusOracle: collectCorpusOracleIsolated,
  // Machine-parseable progress lines on stderr (stdout stays the --json report).
  // The Rust bridge reads "PENGUIN_PROGRESS {json}" lines → Tauri events.
  progressEvent: (payload) => process.stderr.write(`PENGUIN_PROGRESS ${JSON.stringify(payload)}\n`),
  // Interactive multi-repo picker (init/index aimed at a folder of checkouts).
  // TTY-only: the app bridge and pipes must never block on a prompt.
  pickRepos: process.stdin.isTTY && process.stdout.isTTY
    ? async (candidates) => {
        const { default: checkbox } = await import("@inquirer/checkbox");
        try {
          return await checkbox({
            message: "这个目录包含多个 git 仓库 — 空格勾选要索引的,回车开始",
            choices: candidates.map((c) => ({ name: c.name, value: c.path })),
            pageSize: 15,
            loop: false,
          });
        } catch {
          return null; // Ctrl+C / prompt aborted — index nothing
        }
      }
    : undefined,
  openStore: (opts) => {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    return KnowledgeStore.open({
      dbPath: DB_PATH,
      ledgerPath: LEDGER_PATH,
      allowSchemaMutation: opts?.allowSchemaMutation,
      skipMaintenance: opts?.skipMaintenance,
    });
  },
  installSelf: () => {
    const self = fileURLToPath(import.meta.url);
    const binDir = join(homedir(), ".local", "bin");
    mkdirSync(binDir, { recursive: true });
    const link = join(binDir, "penguin");
    rmSync(link, { force: true });
    symlinkSync(self, link);
    return link;
  },
})
  // Use process.exitCode, NOT process.exit(): the app reads our stdout over a
  // pipe, and process.exit() drops un-flushed async pipe writes (files flush
  // synchronously, pipes don't) — which truncated large --json payloads into
  // "Unterminated string" JSON.parse errors in the Wiki. Setting exitCode lets
  // Node drain stdout and exit naturally (the store is already closed, so no
  // handle keeps the loop alive).
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e) => {
    process.stderr.write(String(e?.stack ?? e) + "\n");
    process.exitCode = 1;
  });
