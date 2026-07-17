import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore } from "../packages/knowledge-core/dist/index.js";

test("rollout backup creates a verified DB backup and secret-free portable artifact", () => {
  const dir = mkdtempSync(join(tmpdir(), "pk-rollout-backup-"));
  const dbPath = join(dir, "knowledge.db");
  const ledgerPath = join(dir, "ledger.jsonl");
  const vault = join(dir, "vault"); mkdirSync(vault); writeFileSync(join(vault, "decision.md"), "decision\n");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  store.registerRepo({ name: "backup", rootPath: dir });
  store.close();
  const out = join(dir, "backup-out");
  const raw = execFileSync(process.execPath, ["scripts/knowledge-rollout-backup.mjs", `--db=${dbPath}`, `--ledger=${ledgerPath}`, `--vault=${vault}`, `--out=${out}`], { encoding: "utf8" });
  const report = JSON.parse(raw);
  assert.equal(report.verification.backupIntegrity, "ok");
  assert.equal(report.verification.restoredIntegrity, "ok");
  assert.equal(report.versions.cli.name, "@penguin/knowledge-cli");
  assert.ok(report.versions.runtime.length >= 1);
  assert.equal(report.artifact.includesSource, false);
  assert.equal(report.artifact.includesNotes, false);
  assert.equal(readFileSync(join(out, "report.json"), "utf8").includes("knowledge.pka"), true);
});
