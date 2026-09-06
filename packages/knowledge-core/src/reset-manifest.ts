import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname } from "node:path";
import { canonicalJson } from "./canonical.js";

export type FullResetPhase = "planned" | "backed_up" | "fenced" | "reset" | "rolled_back" | "failed";

export interface FullResetRepositoryPlan {
  repoId: string;
  canonicalRoot: string;
  branchIds: string[];
  currentHeads: Record<string, string | null>;
  rowCounts: Record<string, number>;
}

export interface FullResetPlan {
  formatVersion: 1;
  operationId: string;
  rootPath: string;
  databasePath: string;
  databaseInstanceId: string;
  repositories: FullResetRepositoryPlan[];
  protectedAssetCounts: Record<string, number>;
  protectedAssetHashes: Record<string, string>;
  backupPath: string;
  baselinePath: string;
  protectedAssetPath: string;
  baselineDigest: string;
  sourceGroundTruthHash: string;
  risk: "full_corpus_reset";
  mode: "full_corpus_reset";
  confirmationToken: string;
  planDigest: string;
  manifestPath: string;
  expiresAt: string;
}

export interface ResetManifestPhaseRecord {
  phase: FullResetPhase;
  recordedAt: string;
  details?: Record<string, unknown>;
}

export interface ResetManifest {
  formatVersion: 1;
  plan: FullResetPlan;
  phase: FullResetPhase;
  tokenConsumed: boolean;
  phaseRecords: ResetManifestPhaseRecord[];
}

function noClobber(path: string, bytes: Uint8Array, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
  writeFileSync(temporary, bytes, { flag: "wx", mode });
  try {
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function binding(plan: Pick<FullResetPlan, "operationId" | "rootPath" | "databasePath" | "databaseInstanceId" | "repositories" | "backupPath" | "baselinePath" | "protectedAssetPath" | "baselineDigest" | "sourceGroundTruthHash" | "mode" | "risk" | "expiresAt">): unknown {
  return {
    operationId: plan.operationId,
    rootPath: plan.rootPath,
    databasePath: plan.databasePath,
    databaseInstanceId: plan.databaseInstanceId,
    backupPath: plan.backupPath,
    baselinePath: plan.baselinePath,
    protectedAssetPath: plan.protectedAssetPath,
    repositories: plan.repositories
      .map((repo) => ({
        repoId: repo.repoId,
        canonicalRoot: repo.canonicalRoot,
        branchIds: [...repo.branchIds].sort(),
        currentHeads: Object.fromEntries(Object.entries(repo.currentHeads).sort(([a], [b]) => a.localeCompare(b))),
        rowCounts: Object.fromEntries(Object.entries(repo.rowCounts).sort(([a], [b]) => a.localeCompare(b))),
      }))
      .sort((a, b) => a.repoId.localeCompare(b.repoId)),
    baselineDigest: plan.baselineDigest,
    sourceGroundTruthHash: plan.sourceGroundTruthHash,
    mode: plan.mode,
    risk: plan.risk,
    expiresAt: plan.expiresAt,
  };
}

export function fullResetPlanDigest(plan: Pick<FullResetPlan, "operationId" | "rootPath" | "databasePath" | "databaseInstanceId" | "repositories" | "backupPath" | "baselinePath" | "protectedAssetPath" | "baselineDigest" | "sourceGroundTruthHash" | "mode" | "risk" | "expiresAt">): string {
  return createHash("sha256").update(canonicalJson(binding(plan)), "utf8").digest("hex");
}

export function fullResetManifestPath(databasePath: string, operationId: string): string {
  return `${databasePath}.full-reset-${operationId}.json`;
}

export function createFullResetConfirmationToken(): string {
  return `reset_${randomBytes(32).toString("base64url")}`;
}

export function writeResetManifest(plan: FullResetPlan): string {
  const expectedDigest = fullResetPlanDigest(plan);
  if (expectedDigest !== plan.planDigest) throw new Error("RESET_PLAN_DIGEST_INVALID");
  const manifest: ResetManifest = { formatVersion: 1, plan, phase: "planned", tokenConsumed: false, phaseRecords: [] };
  noClobber(plan.manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"));
  return plan.manifestPath;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`RESET_MANIFEST_INVALID:${path}`);
  }
}

function phaseFiles(path: string): string[] {
  const directory = dirname(path);
  const prefix = `${basename(path)}.phase-`;
  try {
    return readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
      .map((name) => `${directory}/${name}`)
      .sort();
  } catch {
    return [];
  }
}

export function readResetManifest(path: string): ResetManifest {
  if (!existsSync(path)) throw new Error(`RESET_MANIFEST_NOT_FOUND:${path}`);
  const parsed = readJson(path) as Partial<ResetManifest>;
  if (parsed.formatVersion !== 1 || !parsed.plan || parsed.plan.formatVersion !== 1) throw new Error("RESET_MANIFEST_INVALID");
  const plan = parsed.plan as FullResetPlan;
  if (fullResetPlanDigest(plan) !== plan.planDigest) throw new Error("RESET_PLAN_DIGEST_INVALID");
  const records: ResetManifestPhaseRecord[] = Array.isArray(parsed.phaseRecords) ? [...parsed.phaseRecords] as ResetManifestPhaseRecord[] : [];
  let phase = parsed.phase ?? "planned";
  let tokenConsumed = parsed.tokenConsumed === true;
  const consumedPath = `${path}.consumed.json`;
  if (existsSync(consumedPath)) {
    const consumed = readJson(consumedPath) as { operationId?: string; planDigest?: string; recordedAt?: string };
    if (consumed.operationId !== plan.operationId || consumed.planDigest !== plan.planDigest) throw new Error("RESET_MANIFEST_CONSUMED_MARKER_MISMATCH");
    tokenConsumed = true;
  }
  for (const file of phaseFiles(path)) {
    const record = readJson(file) as ResetManifestPhaseRecord;
    if (!record || !["planned", "backed_up", "fenced", "reset", "rolled_back", "failed"].includes(record.phase)) throw new Error(`RESET_PHASE_INVALID:${file}`);
    records.push(record);
    phase = record.phase;
  }
  return { formatVersion: 1, plan, phase, tokenConsumed, phaseRecords: records };
}

/** The consumed marker is a create-once file. Competing executors cannot both
 * claim the same plan, even if they read the immutable manifest concurrently. */
export function consumeResetPlan(path: string, token: string, now = new Date()): void {
  const manifest = readResetManifest(path);
  if (manifest.tokenConsumed) throw new Error("RESET_PLAN_ALREADY_CONSUMED");
  if (manifest.plan.confirmationToken !== token) throw new Error("RESET_CONFIRMATION_TOKEN_MISMATCH");
  if (Date.parse(manifest.plan.expiresAt) <= now.getTime()) throw new Error("RESET_PLAN_EXPIRED");
  const consumedPath = `${path}.consumed.json`;
  const payload = { formatVersion: 1, operationId: manifest.plan.operationId, planDigest: manifest.plan.planDigest, recordedAt: now.toISOString() };
  try {
    noClobber(consumedPath, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST" || existsSync(consumedPath)) throw new Error("RESET_PLAN_ALREADY_CONSUMED");
    throw error;
  }
}

export function appendResetManifestPhase(path: string, phase: FullResetPhase, details?: Record<string, unknown>, now = new Date()): ResetManifestPhaseRecord {
  const manifest = readResetManifest(path);
  const record: ResetManifestPhaseRecord = { phase, recordedAt: now.toISOString(), ...(details ? { details } : {}) };
  const phasePath = `${path}.phase-${String(Date.now()).padStart(16, "0")}-${phase}-${randomUUID()}.json`;
  noClobber(phasePath, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  // Keep the readback above as an ownership check: a phase can never be
  // attached to a missing or digest-mismatched plan.
  if (manifest.plan.manifestPath !== path) throw new Error("RESET_MANIFEST_PATH_MISMATCH");
  return record;
}

export function resetManifestFileIdentity(path: string): { path: string; bytes: number; mtimeMs: number } {
  const stat = statSync(path);
  return { path, bytes: stat.size, mtimeMs: stat.mtimeMs };
}
