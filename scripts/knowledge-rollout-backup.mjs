import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore, exportKnowledgeArtifact, importKnowledgeArtifact, restoreKnowledgeArtifact } from "../packages/knowledge-core/dist/index.js";

function option(name) { const prefix = `--${name}=`; return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length); }
function required(name) { const value = option(name); if (!value) throw new Error(`missing --${name}=...`); return resolve(value); }
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function fileReport(path) { return { path, bytes: statSync(path).size, sha256: digest(path) }; }
function packageVersion(path) { const value = JSON.parse(readFileSync(path, "utf8")); return { name: value.name, version: value.version, sha256: digest(path) }; }

const database = required("db");
const ledger = option("ledger") ? resolve(option("ledger")) : null;
const vault = option("vault") ? resolve(option("vault")) : null;
const externalConfig = option("external-config") ? resolve(option("external-config")) : null;
const output = resolve(option("out") ?? join(process.cwd(), ".penguin-rollout-backup"));
if (!existsSync(database)) throw new Error(`database not found: ${database}`);
mkdirSync(output, { recursive: true, mode: 0o700 });
const store = KnowledgeStore.open({ dbPath: database, ledgerPath: ledger ?? join(output, "source-ledger.jsonl") });
try {
  store.db.pragma("wal_checkpoint(PASSIVE)");
  if (store.db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("SOURCE_DATABASE_INTEGRITY_FAILED");
  const backupPath = join(output, "knowledge.db.backup");
  await store.db.backup(backupPath);
  const artifact = exportKnowledgeArtifact(store, { includeSource: false, includeNotes: false, includeEvidence: false, includeEmbeddings: false });
  const artifactPath = join(output, "knowledge.pka");
  writeFileSync(artifactPath, artifact.bytes, { mode: 0o600 });

  const copied = {};
  if (ledger && existsSync(ledger)) { const target = join(output, "ledger.jsonl"); cpSync(ledger, target, { mode: 0o600 }); copied.ledger = fileReport(target); }
  if (vault && existsSync(vault)) { const target = join(output, "vault"); cpSync(vault, target, { recursive: true }); copied.vault = { path: target, entries: 1 }; }
  if (externalConfig && existsSync(externalConfig)) { const target = join(output, "external-config.metadata.json"); const parsed = JSON.parse(readFileSync(externalConfig, "utf8")); writeFileSync(target, JSON.stringify({ capturedAt: new Date().toISOString(), config: parsed }, null, 2), { mode: 0o600 }); copied.externalConfig = fileReport(target); }

  const backupStore = KnowledgeStore.open({ dbPath: backupPath, ledgerPath: join(output, "backup-ledger.jsonl") });
  const backupIntegrity = backupStore.db.pragma("integrity_check", { simple: true });
  backupStore.close();
  const imported = importKnowledgeArtifact(artifact.bytes);
  const restoreDir = join(tmpdir(), `penguin-rollout-restore-${process.pid}-${Date.now()}`);
  mkdirSync(restoreDir, { recursive: true, mode: 0o700 });
  const restoredPath = join(restoreDir, "knowledge.db");
  restoreKnowledgeArtifact(artifact.bytes, restoredPath, { confirmed: true });
  const restoredStore = KnowledgeStore.open({ dbPath: restoredPath, ledgerPath: join(restoreDir, "ledger.jsonl") });
  const restoredIntegrity = restoredStore.db.pragma("integrity_check", { simple: true });
  restoredStore.close();
  rmSync(restoreDir, { recursive: true, force: true });
  const report = {
    generatedAt: new Date().toISOString(),
    versions: {
      app: (readFileSync("src-tauri/Cargo.toml", "utf8").match(/^version\s*=\s*"([^"]+)"/m) ?? [])[1] ?? "unknown",
      cli: packageVersion("packages/knowledge-cli/package.json"),
      mcp: packageVersion("packages/mcp/package.json"),
      runtime: ["packages/knowledge-cli/dist/bin.js", "packages/mcp/dist/index.js"].filter(existsSync).map(fileReport),
    },
    source: { database, ...(ledger ? { ledger } : {}), ...(vault ? { vault } : {}), ...(externalConfig ? { externalConfig } : {}) },
    databaseBackup: fileReport(backupPath),
    artifact: { ...fileReport(artifactPath), manifest: artifact.manifest, includesSource: false, includesNotes: false, includesEvidence: false, includesEmbeddings: false },
    copied,
    verification: { backupIntegrity, artifactBytes: imported.database.byteLength, restoredIntegrity, restoreSucceeded: restoredIntegrity === "ok" },
    secretPolicy: "portable artifact excludes source/notes/evidence/embeddings; vault and external metadata are copied only when explicitly supplied",
  };
  writeFileSync(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
  if (backupIntegrity !== "ok" || restoredIntegrity !== "ok") process.exitCode = 1;
} finally { store.close(); }
