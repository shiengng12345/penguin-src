import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SourceStore } from "./source-store.js";
import type { KnowledgeStore } from "./store.js";

export interface SourceBackfillOptions {
  store: KnowledgeStore;
  repoId?: string;
  rootPath?: string;
  batchSize: number;
  resumeAfter?: string;
  dryRun: boolean;
}

export interface BackfillReport {
  candidates: number;
  processed: number;
  bytes: number;
  unavailable: number;
  dryRun: boolean;
  lastKey: string | null;
}

type Candidate = { key: string; snapshotId: string; repoId: string; rootPath: string; commitSha: string | null; filePath: string; contentHash: string };

function readAtRevision(candidate: Candidate): Buffer | null {
  if (candidate.commitSha) {
    try {
      return execFileSync("git", ["-C", candidate.rootPath, "show", `${candidate.commitSha}:${candidate.filePath}`], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch { /* fall through to current checkout */ }
  }
  const path = join(candidate.rootPath, candidate.filePath);
  try { return existsSync(path) ? readFileSync(path) : null; } catch { return null; }
}

function recordUnavailable(store: KnowledgeStore, candidate: Candidate, reason: string): void {
  store.db.prepare(`INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,file_path) DO UPDATE SET coverage_status='failed',reason_code=excluded.reason_code,reason=excluded.reason,updated_at=excluded.updated_at`)
    .run(candidate.repoId, candidate.filePath, "tracked", "failed", "revision_content_unavailable", "unknown", 0, reason, new Date().toISOString());
}

/** Reconstructs source text only from a checkout or git object, never facts_json. */
export async function backfillSourceCorpus(options: SourceBackfillOptions): Promise<BackfillReport> {
  const { store } = options;
  const repoFilter = options.repoId ? "AND s.repo_id=?" : "";
  const args = options.repoId ? [options.repoId] : [];
  const rows = store.db.prepare(
    `SELECT s.id AS snapshotId, s.repo_id AS repoId, s.commit_sha AS commitSha,
            r.root_path AS rootPath, f.file_path AS filePath, f.content_hash AS contentHash
       FROM effective_snapshot_files e
       JOIN revision_snapshots s ON s.id=e.snapshot_id
       JOIN file_facts f ON f.id=e.file_fact_id
       JOIN repos r ON r.id=s.repo_id
      WHERE e.file_path=f.file_path ${repoFilter}
        AND NOT EXISTS (SELECT 1 FROM effective_snapshot_sources x WHERE x.snapshot_id=e.snapshot_id AND x.file_path=e.file_path)
      ORDER BY s.id, f.file_path`,
  ).all(...args) as Array<Omit<Candidate, "key">>;
  const candidates = rows.map((row) => ({ ...row, key: `${row.snapshotId}:${row.filePath}` })).filter((row) => !options.resumeAfter || row.key > options.resumeAfter);
  const report: BackfillReport = { candidates: candidates.length, processed: 0, bytes: 0, unavailable: 0, dryRun: options.dryRun, lastKey: null };
  const sourceStore = new SourceStore(store);
  let batch: Candidate[] = [];
  const flush = (): void => {
    if (batch.length === 0) return;
    if (!options.dryRun) {
      for (const candidate of batch) {
        const raw = readAtRevision(candidate);
        if (!raw) { report.unavailable += 1; recordUnavailable(store, candidate, "revision content could not be read from the requested checkout/git object"); continue; }
        const actualHash = createHash("sha256").update(raw).digest("hex");
        if (actualHash !== candidate.contentHash) { report.unavailable += 1; recordUnavailable(store, candidate, "checkout content hash differs from the revision fact"); continue; }
        const blobId = sourceStore.putBlob({ contentHash: actualHash, rawBytes: raw, decodedContent: raw.toString("utf8"), encoding: "utf8" });
        const factId = sourceStore.putSourceFact({ repoId: candidate.repoId, filePath: candidate.filePath, factFingerprint: `backfill-v1:${candidate.contentHash}`, contentHash: actualHash, sourceBlobId: blobId,
          coverage: { status: "admitted", reasonCode: "backfilled", classification: "unknown" } });
        store.db.prepare("INSERT OR IGNORE INTO effective_snapshot_sources(snapshot_id,file_path,source_fact_id,source_blob_id) VALUES (?,?,?,?)").run(candidate.snapshotId, candidate.filePath, factId, blobId);
        report.processed += 1;
        report.bytes += raw.byteLength;
      }
    } else {
      for (const candidate of batch) {
        const raw = readAtRevision(candidate);
        if (!raw) report.unavailable += 1;
        else { report.processed += 1; report.bytes += raw.byteLength; }
      }
    }
    report.lastKey = batch.at(-1)!.key;
    if (!options.dryRun && report.lastKey) {
      store.db.prepare("INSERT INTO source_backfill_checkpoints(scope,last_key,processed,unavailable,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(scope) DO UPDATE SET last_key=excluded.last_key,processed=excluded.processed,unavailable=excluded.unavailable,updated_at=excluded.updated_at")
        .run(options.repoId ?? "all", report.lastKey, report.processed, report.unavailable, new Date().toISOString());
    }
    batch = [];
  };
  for (const candidate of candidates) {
    batch.push(candidate);
    if (batch.length >= Math.max(1, options.batchSize)) flush();
  }
  flush();
  return report;
}
