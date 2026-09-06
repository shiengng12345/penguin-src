import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  canonicalJson,
  sha256Hex,
  FileFactStore,
  GitTopologyStore,
  INDEX_FORMAT_VERSION,
  ResolutionStore,
  SourceSnapshotStore,
  SourceStore,
  workingTreeOverlaySnapshotKey,
  type KnowledgeStore,
  type ParsedFileFact,
  type RevisionContext,
  type SnapshotOverlayEntry,
  type SourceSnapshotOverlayEntry,
  type WorkingTreeOverlayResult,
  type WorkingTreeOverlayStatus,
} from "@penguin/knowledge-core";
import { DEFAULT_COVERAGE_POLICY } from "./coverage-policy.js";
import type { DiscoveredFile } from "./coverage.js";
import { classifyTextBuffer } from "./text-classifier.js";
import { readGitContext } from "./git.js";
import { extractFileFact } from "./revision-indexer.js";
import { langForExtension } from "./registry.js";

export interface PrepareWorkingTreeOverlayInput {
  store: KnowledgeStore;
  rootPath: string;
  repoId?: string;
  parserVersion: string;
  resolverVersion: string;
}

export class WorkingTreeOverlayError extends Error {
  constructor(
    readonly code:
      | "REPOSITORY_NOT_INDEXED"
      | "BRANCH_NOT_INDEXED"
      | "WORKING_TREE_STATE_UNAVAILABLE"
      | "WORKING_TREE_BASE_NOT_READY"
      | "WORKING_TREE_BASE_BEHIND"
      | "WORKING_TREE_OVERLAY_BUSY",
    message: string,
  ) {
    super(message);
    this.name = "WorkingTreeOverlayError";
  }
}

interface BaseRevision {
  repoId: string;
  branchId: string;
  branch: string;
  baseSnapshotId: string;
  commitSha: string | null;
  snapshotId: string;
  worktreeFingerprint?: string;
}

interface PreparedFile {
  path: string;
  absolutePath: string;
  gitState: DiscoveredFile["gitState"];
  rawBytes: Buffer;
  file: DiscoveredFile;
  language: ReturnType<typeof langForExtension>;
}

function overlayError(code: WorkingTreeOverlayError["code"], message: string): WorkingTreeOverlayError {
  return new WorkingTreeOverlayError(code, message);
}

function normalizedRelativePath(rootPath: string, candidate: string): string | null {
  const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (!normalized || isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  const absolute = resolve(rootPath, normalized);
  const canonicalRoot = resolve(rootPath);
  const relativePath = relative(canonicalRoot, absolute).replaceAll("\\", "/");
  return relativePath && relativePath !== ".." && !relativePath.startsWith("../") ? relativePath : null;
}

function fileState(git: ReturnType<typeof readGitContext>, path: string): DiscoveredFile["gitState"] {
  return git.untrackedFiles.includes(path) ? "untracked" : "tracked";
}

function sourceFactCoverage(file: DiscoveredFile): DiscoveredFile {
  return { ...file, content: file.content ?? "" };
}

function byTarget(fact: ParsedFileFact, rawTarget: string): string | undefined {
  return fact.symbols.find((symbol) =>
    symbol.identityKey === rawTarget
      || symbol.title === rawTarget
      || symbol.identityKey.endsWith(`.${rawTarget}`))?.identityKey;
}

function edgesForFact(fact: ParsedFileFact, parserVersion: string) {
  const edgeType = (kind: string) => kind === "call" || kind === "calls"
    ? "calls"
    : kind === "type" || kind === "references"
      ? "references"
      : kind === "throws"
        ? "throws"
        : kind === "env" || kind === "uses"
          ? "uses"
          : "imports";
  return fact.unresolvedReferences
    .filter((ref) => ref.sourceIdentityKey)
    .map((ref) => {
      const target = byTarget(fact, ref.rawTarget);
      return {
        srcIdentityKey: ref.sourceIdentityKey!,
        ...(target ? { dstIdentityKey: target } : { rawTarget: ref.rawTarget }),
        edgeType: edgeType(ref.edgeType),
        method: "EXTRACTED",
        confidence: target ? 1 : 0.5,
        provenance: { parser: parserVersion, filePath: fact.filePath, line: ref.line ?? null, revisionKind: "working_tree" },
      };
    });
}

function baseContext(base: BaseRevision, snapshot: { commit_sha: string | null; worktree_fingerprint: string | null }): RevisionContext {
  return {
    repoId: base.repoId,
    branchId: base.branchId,
    branch: base.branch,
    commitSha: snapshot.commit_sha ?? base.commitSha ?? "(worktree)",
    snapshotId: base.snapshotId,
    ...(snapshot.worktree_fingerprint ? { worktreeFingerprint: snapshot.worktree_fingerprint } : {}),
    trust: snapshot.commit_sha ? "exact_commit" : "trust_unavailable",
  };
}

function statusFor(base: BaseRevision, snapshotId: string, git: ReturnType<typeof readGitContext>, changes?: Partial<WorkingTreeOverlayStatus>): WorkingTreeOverlayStatus {
  return {
    repoId: base.repoId,
    branchId: base.branchId,
    branch: base.branch,
    baseSnapshotId: base.baseSnapshotId,
    snapshotId,
    commitSha: git.commit,
    worktreeFingerprint: git.worktreeFingerprint,
    state: git.worktreeState,
    applied: false,
    modifiedPaths: [],
    addedPaths: [],
    deletedPaths: [],
    untrackedPaths: [...git.untrackedFiles].sort(),
    generatedPaths: [],
    gaps: [],
    ...changes,
  };
}

function currentBase(store: KnowledgeStore, repoId: string, branchName: string, headCommit: string | null): BaseRevision {
  const branch = store.getBranch(repoId, branchName);
  if (!branch) throw overlayError("BRANCH_NOT_INDEXED", `branch "${branchName}" is not indexed; run penguin index first`);
  const snapshotId = branch.current_snapshot_id;
  if (!snapshotId || snapshotId.startsWith("legacy:")) {
    throw overlayError("WORKING_TREE_BASE_NOT_READY", `branch "${branchName}" has no immutable ready snapshot; run penguin index first`);
  }
  const snapshot = store.db.prepare(
    `SELECT id, repo_id AS repoId, commit_sha AS commitSha, worktree_fingerprint AS worktreeFingerprint, state
       FROM revision_snapshots WHERE id=? AND repo_id=?`,
  ).get(snapshotId, repoId) as { id: string; repoId: string; commitSha: string | null; worktreeFingerprint: string | null; state: string } | undefined;
  if (!snapshot || snapshot.state !== "ready") {
    throw overlayError("WORKING_TREE_BASE_NOT_READY", `branch "${branchName}" does not point to a ready immutable snapshot`);
  }
  if (headCommit && branch.last_indexed_commit && branch.last_indexed_commit !== headCommit) {
    throw overlayError(
      "WORKING_TREE_BASE_BEHIND",
      `checked-out HEAD ${headCommit} is newer than indexed commit ${branch.last_indexed_commit}; index the committed revision before using --working-tree`,
    );
  }
  if (headCommit && snapshot.commitSha && snapshot.commitSha !== headCommit) {
    throw overlayError(
      "WORKING_TREE_BASE_BEHIND",
      `working-tree overlay base ${snapshot.commitSha} does not match checked-out HEAD ${headCommit}; index the committed revision first`,
    );
  }
  return {
    repoId,
    branchId: branch.id,
    branch: branch.name,
    baseSnapshotId: snapshot.id,
    commitSha: snapshot.commitSha ?? headCommit,
    snapshotId: snapshot.id,
    worktreeFingerprint: snapshot.worktreeFingerprint ?? undefined,
  };
}

function resetFailedOverlay(store: KnowledgeStore, snapshotId: string): void {
  const now = new Date().toISOString();
  store.db.prepare("UPDATE revision_snapshots SET state='building', failure_reason=NULL, last_accessed_at=? WHERE id=?").run(now, snapshotId);
  for (const table of [
    "snapshot_overlays",
    "effective_snapshot_files",
    "snapshot_resolution_refs",
    "source_snapshot_overlays",
    "effective_snapshot_sources",
  ]) store.db.prepare(`DELETE FROM ${table} WHERE snapshot_id=?`).run(snapshotId);
}

function prepareFiles(rootPath: string, git: ReturnType<typeof readGitContext>, baseFiles: Map<string, string>, baseSources: Map<string, string>): {
  files: PreparedFile[];
  modifiedPaths: string[];
  addedPaths: string[];
  deletedPaths: string[];
  generatedPaths: string[];
  gaps: string[];
} {
  const files: PreparedFile[] = [];
  const modifiedPaths = new Set<string>();
  const addedPaths = new Set<string>();
  const deletedPaths = new Set<string>();
  const generatedPaths = new Set<string>();
  const gaps: string[] = [];
  const dirty = [...new Set(git.dirtyFiles)].sort();
  for (const dirtyPath of dirty) {
    const path = normalizedRelativePath(rootPath, dirtyPath);
    if (!path) {
      gaps.push(`${dirtyPath}:outside_workspace`);
      continue;
    }
    const absolutePath = join(rootPath, path);
    const basePresent = baseFiles.has(path) || baseSources.has(path);
    if (!existsSync(absolutePath)) {
      if (basePresent) deletedPaths.add(path);
      continue;
    }
    let stats;
    try { stats = lstatSync(absolutePath); } catch {
      if (basePresent) deletedPaths.add(path);
      gaps.push(`${path}:read_error`);
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      if (basePresent) deletedPaths.add(path);
      gaps.push(`${path}:unsupported_file_type`);
      continue;
    }
    let rawBytes: Buffer;
    try { rawBytes = readFileSync(absolutePath); } catch {
      if (basePresent) deletedPaths.add(path);
      gaps.push(`${path}:read_error`);
      continue;
    }
    const classification = classifyTextBuffer(rawBytes, path, DEFAULT_COVERAGE_POLICY);
    const gitState = fileState(git, path);
    if (classification.classification === "generated") generatedPaths.add(path);
    if (classification.status !== "admitted" || classification.text === undefined) {
      if (basePresent) deletedPaths.add(path);
      gaps.push(`${path}:${classification.reasonCode}`);
      continue;
    }
    const file: DiscoveredFile = {
      absolutePath,
      relativePath: path,
      gitState,
      byteSize: rawBytes.byteLength,
      classification: classification.classification,
      coverageStatus: classification.status,
      reasonCode: classification.reasonCode,
      reason: "working-tree overlay: current checkout content",
      ...(classification.encoding ? { encoding: classification.encoding } : {}),
      ...(classification.lineCount !== undefined ? { lineCount: classification.lineCount } : {}),
      ...(classification.text !== undefined ? { content: classification.text } : {}),
    };
    files.push({ path, absolutePath, gitState, rawBytes, file, language: langForExtension(path) });
    if (basePresent) modifiedPaths.add(path);
    else addedPaths.add(path);
  }
  return {
    files,
    modifiedPaths: [...modifiedPaths].sort(),
    addedPaths: [...addedPaths].sort(),
    deletedPaths: [...deletedPaths].sort(),
    generatedPaths: [...generatedPaths].sort(),
    gaps: [...new Set(gaps)].sort(),
  };
}

/** Build a small copy-on-write snapshot from only the current dirty paths.
 * The branch's committed snapshot is never repointed, so a query can inspect
 * uncommitted code without pretending that HEAD or the durable branch index
 * changed. */
export async function prepareWorkingTreeOverlay(input: PrepareWorkingTreeOverlayInput): Promise<WorkingTreeOverlayResult> {
  const git = readGitContext(input.rootPath);
  if (git.worktreeState === "unknown") throw overlayError("WORKING_TREE_STATE_UNAVAILABLE", git.statusError ?? "git worktree state is unavailable");
  const repo = input.store.getRepoByRoot(git.checkoutPath);
  const repoId = input.repoId ?? repo?.id;
  if (!repoId) throw overlayError("REPOSITORY_NOT_INDEXED", `repository ${git.checkoutPath} is not indexed; run penguin index first`);
  const base = currentBase(input.store, repoId, git.branch, git.commit);
  const baseFacts = new FileFactStore(input.store).effectiveManifest(base.baseSnapshotId);
  const baseSources = new SourceSnapshotStore(input.store).effectiveManifest(base.baseSnapshotId);
  const prepared = prepareFiles(git.checkoutPath, git, baseFacts, baseSources);
  if (git.worktreeState !== "dirty") {
    const row = input.store.db.prepare("SELECT commit_sha,worktree_fingerprint FROM revision_snapshots WHERE id=?").get(base.baseSnapshotId) as { commit_sha: string | null; worktree_fingerprint: string | null };
    return { context: baseContext(base, row), status: statusFor(base, base.baseSnapshotId, git) };
  }

  const snapshotKey = workingTreeOverlaySnapshotKey({
    repoId,
    branchId: base.branchId,
    baseSnapshotId: base.baseSnapshotId,
    commitSha: git.commit,
    worktreeFingerprint: git.worktreeFingerprint,
    parserVersion: input.parserVersion,
    resolverVersion: input.resolverVersion,
  });
  const topology = new GitTopologyStore(input.store);
  const { snapshot, created } = topology.createOrGetBuildingSnapshot({
    snapshotKey,
    repoId,
    ...(git.commit ? { commitSha: git.commit } : {}),
    worktreeFingerprint: git.worktreeFingerprint,
    parserVersion: input.parserVersion,
    resolverVersion: input.resolverVersion,
    schemaVersion: INDEX_FORMAT_VERSION,
    baseSnapshotId: base.baseSnapshotId,
  });
  const statusChanges = {
    applied: true,
    modifiedPaths: prepared.modifiedPaths,
    addedPaths: prepared.addedPaths,
    deletedPaths: prepared.deletedPaths,
    generatedPaths: prepared.generatedPaths,
    gaps: prepared.gaps,
  } satisfies Partial<WorkingTreeOverlayStatus>;
  if (snapshot.state === "ready") {
    return {
      context: {
        repoId,
        branchId: base.branchId,
        branch: base.branch,
        commitSha: git.commit ?? "(worktree)",
        snapshotId: snapshot.id,
        worktreeFingerprint: git.worktreeFingerprint,
        trust: "exact_worktree",
      },
      status: statusFor(base, snapshot.id, git, statusChanges),
    };
  }
  if (snapshot.state === "building" && !created) throw overlayError("WORKING_TREE_OVERLAY_BUSY", `working-tree overlay ${snapshot.id} is already being built`);
  resetFailedOverlay(input.store, snapshot.id);

  const factStore = new FileFactStore(input.store);
  const sourceStore = new SourceStore(input.store);
  const sourceSnapshots = new SourceSnapshotStore(input.store);
  const resolutionStore = new ResolutionStore(input.store);
  const fileOverlays: SnapshotOverlayEntry[] = [];
  const sourceOverlays: SourceSnapshotOverlayEntry[] = [];

  try {
    for (const preparedFile of prepared.files) {
      const source = sourceFactForFile(input.store, repoId, sourceFactCoverage(preparedFile.file), preparedFile.rawBytes);
      if (!baseSources.has(preparedFile.path)) sourceOverlays.push({ op: "add", path: preparedFile.path, sourceFactId: source.sourceFactId });
      else if (baseSources.get(preparedFile.path) !== source.sourceFactId) sourceOverlays.push({ op: "modify", path: preparedFile.path, sourceFactId: source.sourceFactId });
      if (!preparedFile.language) {
        if (baseFacts.has(preparedFile.path)) fileOverlays.push({ op: "delete", path: preparedFile.path, fileFactId: null });
        continue;
      }
      let fact: ParsedFileFact;
      try {
        fact = await extractFileFact({ repoId, rootPath: git.checkoutPath, relPath: preparedFile.path, source: preparedFile.file.content ?? "", contentHash: source.contentHash, parserVersion: input.parserVersion });
      } catch (error) {
        if (baseFacts.has(preparedFile.path)) fileOverlays.push({ op: "delete", path: preparedFile.path, fileFactId: null });
        statusChanges.gaps.push(`${preparedFile.path}:parse_error:${String((error as Error).message ?? error)}`);
        continue;
      }
      const factId = factStore.upsertFileFact(fact);
      sourceStore.attachFileFact(factId, source.sourceFactId);
      if (!baseFacts.has(preparedFile.path)) fileOverlays.push({ op: "add", path: preparedFile.path, fileFactId: factId });
      else if (baseFacts.get(preparedFile.path) !== factId) fileOverlays.push({ op: "modify", path: preparedFile.path, fileFactId: factId });
      const contextFingerprint = sha256Hex(canonicalJson({ fileFactId: factId, imports: fact.imports, symbols: fact.symbols.map((symbol) => symbol.identityKey), resolverVersion: input.resolverVersion }));
      const resolution = resolutionStore.replaceResolutionSet({ fileFactId: factId, contextFingerprint, resolverVersion: input.resolverVersion, edges: edgesForFact(fact, input.parserVersion) });
      resolutionStore.attachSnapshotResolution({ snapshotId: snapshot.id, filePath: preparedFile.path, resolutionSetId: resolution.id });
    }
    for (const path of prepared.deletedPaths) {
      if (baseFacts.has(path)) fileOverlays.push({ op: "delete", path, fileFactId: null });
      if (baseSources.has(path)) sourceOverlays.push({ op: "delete", path, sourceFactId: null });
    }
    factStore.replaceOverlay(snapshot.id, deduplicateFileOverlays(fileOverlays));
    sourceSnapshots.replaceOverlay(snapshot.id, deduplicateSourceOverlays(sourceOverlays));
    factStore.materializeManifest(snapshot.id);
    sourceSnapshots.materializeManifest(snapshot.id);
    topology.markSnapshotReady(snapshot.id);
    return {
      context: {
        repoId,
        branchId: base.branchId,
        branch: base.branch,
        commitSha: git.commit ?? "(worktree)",
        snapshotId: snapshot.id,
        worktreeFingerprint: git.worktreeFingerprint,
        trust: "exact_worktree",
      },
      status: statusFor(base, snapshot.id, git, { ...statusChanges, gaps: [...new Set(statusChanges.gaps)].sort() }),
    };
  } catch (error) {
    try { topology.markSnapshotFailed(snapshot.id, String((error as Error).message ?? error)); } catch { /* preserve original failure */ }
    throw error;
  }
}

function sourceFactForFile(store: KnowledgeStore, repoId: string, file: DiscoveredFile, rawBytes: Buffer): { sourceFactId: string; contentHash: string } {
  const contentHash = createHash("sha256").update(rawBytes).digest("hex");
  const sourceStore = new SourceStore(store);
  const blobId = sourceStore.putBlob({ contentHash, rawBytes, decodedContent: file.content ?? rawBytes.toString("utf8"), encoding: file.encoding ?? "utf8" });
  const sourceFactId = sourceStore.putSourceFact({ repoId, filePath: file.relativePath, factFingerprint: `working-tree-overlay-v1:${contentHash}:${file.reasonCode}`, contentHash, sourceBlobId: blobId, coverage: { status: file.coverageStatus, reasonCode: file.reasonCode, classification: file.classification, gitState: file.gitState, byteSize: file.byteSize, reason: file.reason, encoding: file.encoding ?? "utf8" } });
  return { sourceFactId, contentHash };
}

function deduplicateFileOverlays(entries: SnapshotOverlayEntry[]): SnapshotOverlayEntry[] {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
}

function deduplicateSourceOverlays(entries: SourceSnapshotOverlayEntry[]): SourceSnapshotOverlayEntry[] {
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
}
