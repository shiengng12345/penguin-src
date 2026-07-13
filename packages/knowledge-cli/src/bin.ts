#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KnowledgeStore } from "@penguin/knowledge-core";
import { runCli } from "./index.js";

// Default knowledge location (bundled/CLI + app share the same store).
const DB_PATH = process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
const LEDGER_PATH = process.env.PENGUIN_KNOWLEDGE_LEDGER ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl");
const NOTES_DIR = process.env.PENGUIN_KNOWLEDGE_NOTES ?? join(homedir(), ".penguin", "knowledge", "notes");

runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  // Live progress only when stderr is a TTY (don't spew bar frames into pipes/logs).
  progress: process.stderr.isTTY ? (chunk) => process.stderr.write(chunk) : undefined,
  storeExists: () => existsSync(DB_PATH),
  notesDir: NOTES_DIR,
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
  openStore: () => {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    return KnowledgeStore.open({ dbPath: DB_PATH, ledgerPath: LEDGER_PATH });
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
