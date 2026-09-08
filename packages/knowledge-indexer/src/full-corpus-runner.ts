import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import {
  indexRepo,
  type IndexProgressEvent,
  type IndexReport,
} from "./pipeline.js";

export type FullCorpusPhase = "index" | "rebuild" | "verify";
export type FullCorpusMode = "index" | "rebuild";
export type FullCorpusJobState = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface FullCorpusJob {
  jobId: string;
  rootPath: string;
  repoIds: string[];
  phase: FullCorpusPhase;
  currentRepoId: string | null;
  completedRepos: number;
  totalRepos: number;
  parsed: number;
  skipped: number;
  errors: number;
  startedAt: string;
  updatedAt: string;
  /** Durable state extends the original C3 contract without changing its
   * required counters. */
  state: FullCorpusJobState;
  mode: FullCorpusMode | "both";
  statusPath: string;
  controlPath: string;
  heartbeatAt: string;
  lastFile: string | null;
  queueWaitMs: number;
  executionMs: number;
  retryCount: number;
  lastError: string | null;
  remediation: string | null;
}

export interface FullCorpusRepoReceipt {
  repoId: string;
  branchId: string;
  head: string;
  parsed: number;
  skipped: number;
  errors: number;
  snapshots: number;
  symbols: number;
  edges: number;
  endpoints: number;
  mode: FullCorpusMode;
  eligibleFiles: number;
  zeroEligibleFilePolicy: boolean;
  indexedAt: string | null;
  revisionAligned: boolean;
  databaseInstanceId: string;
  snapshotId: string | null;
  failure: string | null;
}

export interface FullCorpusRunOptions {
  store: KnowledgeStore;
  rootPath: string;
  /** Defaults to both public operations: `index` then `rebuild`. */
  modes?: FullCorpusMode[];
  statusPath?: string;
  jobId?: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  /** Used only by the terminal-job retry wrapper to retain retry history. */
  initialRetryCount?: number;
  onProgress?: (event: IndexProgressEvent & { rootPath: string; job: FullCorpusJob }) => void;
}

export interface FullCorpusRetryOptions {
  store: KnowledgeStore;
  statusPath: string;
  signal?: AbortSignal;
  maxAttempts?: number;
  onProgress?: (event: IndexProgressEvent & { rootPath: string; job: FullCorpusJob }) => void;
}

export interface FullCorpusRunResult {
  job: FullCorpusJob;
  statusPath: string;
  repositories: Record<FullCorpusMode, FullCorpusRepoReceipt[]>;
  failures: Array<{ mode: FullCorpusMode; rootPath: string; error: string }>;
}

interface FullCorpusControl {
  action: "pause" | "resume" | "cancel" | "retry";
  requestedAt: string;
  reason?: string;
}

const DEFAULT_MAX_ATTEMPTS = 1;
const DEFAULT_STATUS_DIRECTORY = join(homedir(), ".penguin", "jobs");
const CONTROL_SUFFIX = ".control.json";
const EXECUTION_LOCK_SUFFIX = ".run.lock";
const DIRECTORY_SKIP = new Set([
  ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", ".next",
  ".turbo", "vendor", "coverage", ".pnpm-store", ".npm", ".venv", "venv",
]);

class FullCorpusCancelled extends Error {
  constructor() {
    super("FULL_CORPUS_CANCELLED");
  }
}

function canonicalPath(path: string): string {
  try { return realpathSync.native(path); }
  catch { return resolve(path); }
}

function writeAtomicJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try { renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function controlPath(statusPath: string): string {
  return `${statusPath}${CONTROL_SUFFIX}`;
}

function statusPathFor(rootPath: string, jobId: string, requested?: string): string {
  return resolve(requested ?? join(DEFAULT_STATUS_DIRECTORY, `full-corpus-${jobId}.json`));
}

function acquireRunLock(statusPath: string, jobId: string): () => void {
  const path = `${statusPath}${EXECUTION_LOCK_SUFFIX}`;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as { code?: string }).code === "EEXIST") throw new Error(`FULL_CORPUS_JOB_BUSY:${path}`);
    throw error;
  }
  try {
    writeFileSync(path, JSON.stringify({ jobId, pid: process.pid, startedAt: new Date().toISOString() }) + "\n", { flag: "w", mode: 0o600 });
  } finally { closeSync(fd); }
  return () => {
    try {
      const current = readFileSync(path, "utf8");
      if (current.includes(`"jobId":"${jobId}"`)) unlinkSync(path);
    } catch { /* never remove another run's replacement lock */ }
  };
}

function hasGitMarker(path: string): boolean {
  try { return lstatSync(join(path, ".git")).isDirectory() || lstatSync(join(path, ".git")).isFile(); }
  catch { return false; }
}

/** Discover actual checkout roots without treating a Projects folder as one
 * giant repository. Once a .git marker is found, traversal stops at that
 * checkout; nested source directories are not separate corpus shards. */
export function discoverFullCorpusRepositories(rootPath: string): string[] {
  const root = canonicalPath(rootPath);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`FULL_CORPUS_ROOT_NOT_DIRECTORY:${root}`);
  const found: string[] = [];
  const seen = new Set<string>();
  const visit = (directory: string, depth: number): void => {
    const canonical = canonicalPath(directory);
    if (seen.has(canonical)) return;
    if (hasGitMarker(canonical)) {
      seen.add(canonical);
      found.push(canonical);
      return;
    }
    if (depth > 8) return;
    let entries: Array<import("node:fs").Dirent>;
    try { entries = readdirSync(canonical, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || DIRECTORY_SKIP.has(entry.name)) continue;
      visit(join(canonical, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return found.sort((left, right) => left.localeCompare(right));
}

function newJob(
  rootPath: string,
  statusPath: string,
  modes: FullCorpusMode[],
  totalRepos: number,
  initialRetryCount = 0,
): FullCorpusJob {
  const now = new Date().toISOString();
  return {
    jobId: statusPath.match(/full-corpus-([^/]+)\.json$/)?.[1] ?? `job_${randomUUID()}`,
    rootPath,
    repoIds: [],
    phase: modes[0] ?? "verify",
    currentRepoId: null,
    completedRepos: 0,
    totalRepos,
    parsed: 0,
    skipped: 0,
    errors: 0,
    startedAt: now,
    updatedAt: now,
    state: "running",
    mode: modes.length === 2 ? "both" : modes[0] ?? "index",
    statusPath,
    controlPath: controlPath(statusPath),
    heartbeatAt: now,
    lastFile: null,
    queueWaitMs: 0,
    executionMs: 0,
    retryCount: Math.max(0, Math.floor(initialRetryCount)),
    lastError: null,
    remediation: null,
  };
}

function persistJob(job: FullCorpusJob): void {
  job.updatedAt = new Date().toISOString();
  job.heartbeatAt = job.updatedAt;
  writeAtomicJson(job.statusPath, job);
}

export function readFullCorpusJob(statusPath: string): FullCorpusJob {
  const parsed = readJson(resolve(statusPath)) as FullCorpusJob;
  if (!parsed || typeof parsed.jobId !== "string" || typeof parsed.rootPath !== "string" || typeof parsed.phase !== "string") {
    throw new Error(`FULL_CORPUS_JOB_INVALID:${statusPath}`);
  }
  return parsed;
}

function readControl(job: FullCorpusJob): FullCorpusControl | null {
  try {
    const control = readJson(job.controlPath) as FullCorpusControl;
    if (!["pause", "resume", "cancel", "retry"].includes(control.action)) return null;
    return control;
  } catch { return null; }
}

function clearControl(job: FullCorpusJob): void {
  try { unlinkSync(job.controlPath); } catch { /* already consumed */ }
}

function requestControl(statusPath: string, action: FullCorpusControl["action"], reason?: string): string {
  const resolved = resolve(statusPath);
  const job = readFullCorpusJob(resolved);
  if (action === "retry") throw new Error("FULL_CORPUS_RETRY_REQUIRES_NEW_RUN");
  if (job.state !== "running" && job.state !== "paused") {
    throw new Error(`FULL_CORPUS_JOB_NOT_ACTIVE:${job.state}`);
  }
  writeAtomicJson(job.controlPath, { action, requestedAt: new Date().toISOString(), ...(reason ? { reason } : {}) });
  return job.controlPath;
}

export function requestFullCorpusPause(statusPath: string, reason?: string): string {
  return requestControl(statusPath, "pause", reason);
}

export function requestFullCorpusResume(statusPath: string): string {
  return requestControl(statusPath, "resume");
}

export function requestFullCorpusCancel(statusPath: string, reason?: string): string {
  return requestControl(statusPath, "cancel", reason);
}

export function requestFullCorpusRetry(statusPath: string, reason?: string): string {
  return requestControl(statusPath, "retry", reason);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

async function waitIfPaused(job: FullCorpusJob, signal?: AbortSignal): Promise<void> {
  for (;;) {
    if (signal?.aborted) throw new FullCorpusCancelled();
    const control = readControl(job);
    if (control?.action === "cancel") {
      clearControl(job);
      throw new FullCorpusCancelled();
    }
    if (control?.action === "pause") {
      if (job.state !== "paused") {
        job.state = "paused";
        persistJob(job);
      }
      await sleep(100);
      continue;
    }
    if (control?.action === "resume") clearControl(job);
    if (job.state === "paused") {
      job.state = "running";
      persistJob(job);
    }
    return;
  }
}

function receipt(store: KnowledgeStore, report: IndexReport, mode: FullCorpusMode, eligibleFiles: number): FullCorpusRepoReceipt {
  const symbols = Number((store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE repo_id=? AND node_type='symbol'").get(report.repoId) as { n: number }).n ?? 0);
  const edges = Number((store.db.prepare("SELECT COUNT(*) AS n FROM edges WHERE branch_id=? AND status='active'").get(report.branchId) as { n: number }).n ?? 0);
  const endpoints = Number((store.db.prepare("SELECT COUNT(DISTINCT endpoint_id) AS n FROM endpoint_memberships WHERE repo_id=?").get(report.repoId) as { n: number }).n ?? 0);
  const snapshots = Number((store.db.prepare("SELECT COUNT(*) AS n FROM revision_snapshots WHERE repo_id=? AND state='ready'").get(report.repoId) as { n: number }).n ?? 0);
  const instance = store.db.prepare("SELECT value FROM meta WHERE key='database_instance_id'").get() as { value?: string } | undefined;
  return {
    repoId: report.repoId,
    branchId: report.branchId,
    head: report.headCommit ?? report.commit ?? "(worktree)",
    parsed: report.parsed,
    skipped: report.skipped,
    errors: report.errors,
    snapshots,
    symbols,
    edges,
    endpoints,
    mode,
    eligibleFiles,
    zeroEligibleFilePolicy: eligibleFiles === 0,
    indexedAt: report.revisionTruth?.checkedAt ?? null,
    revisionAligned: report.revisionTruth?.alignment === "aligned",
    databaseInstanceId: instance?.value ?? "unknown",
    snapshotId: report.revisionTruth?.snapshotId ?? null,
    failure: null,
  };
}

function persistedShardEvidence(store: KnowledgeStore, report: IndexReport): number {
  const checkpoints = Number((store.db.prepare(`
    SELECT COUNT(*) AS n
      FROM files_index fi
      JOIN coverage_records c ON c.repo_id=fi.repo_id AND c.file_path=fi.file_path
     WHERE fi.repo_id=? AND fi.branch_id=?
       AND fi.status='indexed' AND c.coverage_status='admitted'
  `).get(report.repoId, report.branchId) as { n: number }).n ?? 0);
  const snapshotId = report.revisionTruth?.snapshotId;
  if (!snapshotId) return checkpoints;
  const sourceRows = Number((store.db.prepare(
    "SELECT COUNT(*) AS n FROM effective_snapshot_sources WHERE snapshot_id=?",
  ).get(snapshotId) as { n: number }).n ?? 0);
  return Math.max(checkpoints, sourceRows);
}

async function runMode(
  store: KnowledgeStore,
  roots: string[],
  mode: FullCorpusMode,
  job: FullCorpusJob,
  options: FullCorpusRunOptions,
  attempts: number,
): Promise<{ receipts: FullCorpusRepoReceipt[]; failures: Array<{ rootPath: string; error: string }> }> {
  job.phase = mode;
  job.completedRepos = 0;
  job.totalRepos = roots.length;
  job.parsed = 0;
  job.skipped = 0;
  job.errors = 0;
  job.state = "running";
  persistJob(job);
  const receipts: FullCorpusRepoReceipt[] = [];
  const failures: Array<{ rootPath: string; error: string }> = [];
  for (const rootPath of roots) {
    await waitIfPaused(job, options.signal);
    job.currentRepoId = null;
    job.lastFile = relative(job.rootPath, rootPath) || rootPath;
    persistJob(job);
    const startedAt = Date.now();
    let report: IndexReport | null = null;
    let lastError: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      await waitIfPaused(job, options.signal);
      try {
        report = await indexRepo({
          store,
          rootPath,
          mode: mode === "rebuild" ? "rebuild" : "incremental",
          onProgress: (event) => {
            job.lastFile = "file" in event ? (event.file ?? job.lastFile) : job.lastFile;
            job.executionMs = Date.now() - startedAt;
            persistJob(job);
            options.onProgress?.({ ...event, rootPath, job: { ...job } });
          },
        });
        break;
      } catch (error) {
        lastError = String((error as Error)?.message ?? error);
        job.retryCount += attempt < attempts ? 1 : 0;
        job.lastError = lastError;
        job.remediation = "inspect the shard error and rerun this full-corpus job; no ready state was fabricated";
        persistJob(job);
        if (attempt < attempts) continue;
      }
    }
    job.executionMs += Date.now() - startedAt;
    if (!report) {
      const error = lastError ?? "FULL_CORPUS_SHARD_FAILED";
      failures.push({ rootPath, error });
      job.errors += 1;
      persistJob(job);
      continue;
    }
    const eligibleFiles = report.coverage.admitted;
    // An incremental retry may legitimately parse zero files when the prior
    // attempt already published the same content and this run only reuses
    // checkpoints/source rows. Reject only a true zero-evidence shard; a
    // parsed-zero shortcut must not turn an empty publication into success.
    const persistedEvidence = persistedShardEvidence(store, report);
    if (report.parsed === 0 && eligibleFiles > 0 && persistedEvidence === 0) {
      const error = `FULL_CORPUS_ZERO_PARSED:${rootPath}:${eligibleFiles}`;
      failures.push({ rootPath, error });
      job.errors += 1;
      job.lastError = error;
      job.remediation = "the shard had eligible files but persisted zero parsed files; inspect parser/runtime before accepting the corpus";
      persistJob(job);
      continue;
    }
    const shard = receipt(store, report, mode, eligibleFiles);
    receipts.push(shard);
    job.repoIds = [...new Set([...job.repoIds, report.repoId])].sort();
    job.currentRepoId = report.repoId;
    job.parsed += report.parsed;
    job.skipped += report.skipped;
    job.errors += report.errors;
    job.completedRepos += 1;
    job.lastError = null;
    persistJob(job);
  }
  job.currentRepoId = null;
  persistJob(job);
  return { receipts, failures };
}

function normalizeModes(modes: FullCorpusMode[] | undefined): FullCorpusMode[] {
  const selected: FullCorpusMode[] = modes?.length ? modes : ["index", "rebuild"];
  const unique = [...new Set(selected)];
  if (unique.some((mode) => mode !== "index" && mode !== "rebuild")) throw new Error("FULL_CORPUS_MODE_INVALID");
  return unique;
}

/** Run all discovered checkouts serially through the canonical indexRepo
 * publisher. Parsing is shard-scoped; SQLite publication is deliberately one
 * repo at a time so a failed shard cannot be reported as a ready whole root. */
export async function runFullCorpus(options: FullCorpusRunOptions): Promise<FullCorpusRunResult> {
  const rootPath = canonicalPath(options.rootPath);
  const roots = discoverFullCorpusRepositories(rootPath);
  if (roots.length === 0) throw new Error(`FULL_CORPUS_NO_GIT_REPOSITORIES:${rootPath}`);
  const modes = normalizeModes(options.modes);
  const jobId = options.jobId ?? `job_${Date.now()}_${randomUUID().slice(0, 12)}`;
  const statusPath = statusPathFor(rootPath, jobId, options.statusPath);
  const job = newJob(rootPath, statusPath, modes, roots.length, options.initialRetryCount);
  job.jobId = jobId;
  const release = acquireRunLock(statusPath, jobId);
  const result: FullCorpusRunResult = {
    job,
    statusPath,
    repositories: { index: [], rebuild: [] },
    failures: [],
  };
  const attempts = Math.max(1, Math.min(5, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)));
  const startedAt = Date.now();
  try {
    persistJob(job);
    for (const mode of modes) {
      const modeResult = await runMode(options.store, roots, mode, job, options, attempts);
      result.repositories[mode] = modeResult.receipts;
      result.failures.push(...modeResult.failures.map((failure) => ({ mode, ...failure })));
      if (modeResult.failures.length > 0) {
        job.state = "failed";
        job.phase = "verify";
        job.currentRepoId = null;
        job.executionMs = Date.now() - startedAt;
        job.remediation = "repair or rerun failed shards; successful shards remain individually scoped and are not promoted as a whole-root success";
        persistJob(job);
        return result;
      }
    }
    await waitIfPaused(job, options.signal);
    job.phase = "verify";
    job.state = "completed";
    job.executionMs = Date.now() - startedAt;
    job.currentRepoId = null;
    job.lastError = null;
    job.remediation = null;
    persistJob(job);
    return result;
  } catch (error) {
    if (error instanceof FullCorpusCancelled || String((error as Error)?.message ?? error) === "FULL_CORPUS_CANCELLED") {
      job.state = "cancelled";
      job.phase = "verify";
      job.lastError = "FULL_CORPUS_CANCELLED";
      job.remediation = "resume requires a new run from the last per-repository receipt; no incomplete shard is reported fresh";
    } else {
      job.state = "failed";
      job.phase = "verify";
      job.lastError = String((error as Error)?.message ?? error);
      job.remediation = "inspect the durable job receipt before retrying; no whole-corpus success is claimed";
    }
    job.executionMs = Date.now() - startedAt;
    job.currentRepoId = null;
    persistJob(job);
    return result;
  } finally {
    release();
  }
}

/**
 * Retry a terminal corpus job using its persisted root/mode contract. A retry
 * is a new writer run, not a control-file hint: a stale retry request can
 * never be silently ignored by an already-running worker.
 */
export async function retryFullCorpus(options: FullCorpusRetryOptions): Promise<FullCorpusRunResult> {
  const statusPath = resolve(options.statusPath);
  const previous = readFullCorpusJob(statusPath);
  if (previous.state === "running" || previous.state === "paused") {
    throw new Error("FULL_CORPUS_JOB_ACTIVE");
  }
  if (previous.state !== "failed" && previous.state !== "cancelled") {
    throw new Error(`FULL_CORPUS_RETRY_NOT_ALLOWED:${previous.state}`);
  }
  clearControl(previous);
  const modes: FullCorpusMode[] = previous.mode === "both"
    ? ["index", "rebuild"]
    : [previous.mode];
  return runFullCorpus({
    store: options.store,
    rootPath: previous.rootPath,
    modes,
    statusPath,
    jobId: previous.jobId,
    initialRetryCount: previous.retryCount + 1,
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
}
