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
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(String(e?.stack ?? e) + "\n");
    process.exit(1);
  });
