import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureCorpusBaseline,
  captureProtectedAssets,
  createConsistentDatabaseBackup,
  databaseInstanceId,
  openDatabase,
  writeCorpusBaseline,
  writeProtectedAssetBundle,
} from "../packages/knowledge-core/dist/index.js";

function option(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function required(name) {
  const value = option(name);
  if (!value) throw new Error(`missing --${name}=...`);
  return resolve(value);
}

const rootPath = required("root");
const databasePath = resolve(option("db") ?? join(homedir(), ".penguin", "knowledge", "knowledge.db"));
const ledgerPath = option("ledger") ? resolve(option("ledger")) : undefined;
const outputDirectory = resolve(option("out") ?? join(process.cwd(), `.penguin-corpus-baseline-${Date.now()}`));
const minimumFreeBytesAfterBackup = Number(option("minimum-free-after-bytes") ?? 10 * 1024 * 1024 * 1024);
if (!Number.isSafeInteger(minimumFreeBytesAfterBackup) || minimumFreeBytesAfterBackup < 0) {
  throw new Error(`invalid --minimum-free-after-bytes=${minimumFreeBytesAfterBackup}`);
}

if (!existsSync(databasePath)) throw new Error(`database not found: ${databasePath}`);
mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });

const db = openDatabase(databasePath);
const handle = { db };
try {
  // The ID is persisted by the normal writable open. A copied database can
  // therefore be distinguished from a path-based lookalike after restore.
  databaseInstanceId(handle, { ensure: true });
  const backup = await createConsistentDatabaseBackup(handle, join(outputDirectory, "knowledge.db.backup"), {
    minimumFreeBytesAfterBackup,
  });
  const protectedAssets = captureProtectedAssets(handle, { ensureDatabaseInstanceId: false });
  const baseline = captureCorpusBaseline(handle, {
    rootPath,
    databasePath,
    ledgerPath,
    protectedAssets,
    ensureDatabaseInstanceId: false,
  });
  if (baseline.databaseDataVersion !== backup.sourceDataVersion) {
    throw new Error("DATABASE_CHANGED_BETWEEN_BACKUP_AND_BASELINE");
  }

  const protectedAssetPath = writeProtectedAssetBundle(protectedAssets, join(outputDirectory, "protected-assets.json"));
  const baselinePath = writeCorpusBaseline(baseline, join(outputDirectory, "baseline.json"));
  const report = {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    outputDirectory,
    baselinePath,
    protectedAssetPath,
    backup,
    sourceMatchesBackup: true,
    databaseInstanceId: baseline.databaseInstanceId,
    databaseBytes: baseline.databaseBytes,
    walBytes: baseline.walBytes,
    shmBytes: baseline.shmBytes,
    repositoryCount: baseline.repositories.length,
    sourceGroundTruthComplete: baseline.sourceGroundTruthComplete,
    sourceGroundTruthGaps: baseline.sourceGroundTruthGaps,
    protectedAssetTables: Object.keys(protectedAssets.tables).length,
    protectedAssetMissingTables: protectedAssets.missingTables,
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  db.close();
}
