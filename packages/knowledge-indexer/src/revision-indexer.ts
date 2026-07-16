import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, sha256Hex, SCHEMA_VERSION, FileFactStore, GitTopologyStore, ResolutionStore, resolveBranchBase, type KnowledgeStore, type ParsedFileFact, type RevisionContext } from "@penguin/knowledge-core";
import { extractSymbols } from "./extract.js";
import { langForExtension } from "./registry.js";
import { GitObjectReader, resolveRevisionTopology } from "./git-topology.js";
import { walkRepoFiles } from "./walk.js";
import { ensureBaseSnapshot } from "./base-snapshot.js";

export interface IndexRevisionInput { store: KnowledgeStore; rootPath: string; repoId: string; revision: { branch?: string; commitSha?: string; useWorktree?: boolean }; base?: { branch?: string; commitSha?: string }; publishBranchId?: string; parserVersion: string; resolverVersion: string; coordinator: RevisionIndexCoordinator }
export interface IndexRevisionReport { context: RevisionContext; totalFiles: number; changedFiles: number; reusedFileFacts: number; resolvedFiles: number; reusePercent: number; publishedBranchId?: string; degradationReason?: string }
export class RevisionIndexCoordinator {
  private readonly jobs = new Map<string, Promise<unknown>>();
  async runExclusive<T>(key: string, work: () => Promise<T>): Promise<T> { const previous = this.jobs.get(key) as Promise<T> | undefined; if (previous) return previous; const current = work(); this.jobs.set(key, current); try { return await current; } finally { if (this.jobs.get(key) === current) this.jobs.delete(key); } }
}
function identity(repoId: string, path: string, name: string): string { return `${repoId}::${path}::${name}`; }
function byTarget(fact: ParsedFileFact, rawTarget: string): string | undefined {
  const exact = fact.symbols.find((symbol) => symbol.identityKey === rawTarget || symbol.title === rawTarget || symbol.identityKey.endsWith(`.${rawTarget}`));
  return exact?.identityKey;
}
export async function extractFileFact(input: { repoId: string; rootPath: string; relPath: string; source: string; contentHash: string; parserVersion?: string }): Promise<ParsedFileFact> {
  const language = langForExtension(input.relPath); const extracted = language ? await extractSymbols({ lang: language, source: input.source, relPath: input.relPath }) : { symbols: [], fileImports: [], endpoints: [], logSites: [], identifiers: [] } as any;
  const symbols = (extracted.symbols ?? []).map((symbol: any) => ({ identityKey: identity(input.repoId, input.relPath, symbol.qualifiedName), title: symbol.name, kind: symbol.kind, ...(symbol.signature ? { signature: symbol.signature } : {}), startLine: symbol.startLine, endLine: symbol.endLine, contentHash: symbol.contentHash }));
  const byName = new Map(symbols.flatMap((symbol: any) => [[symbol.title, symbol.identityKey], [symbol.identityKey, symbol.identityKey]]));
  const sourceKey = (qualified: string | null | undefined) => qualified ? identity(input.repoId, input.relPath, qualified) : undefined;
  const edgeType = (kind: string) => kind === "call" ? "calls" : kind === "type" ? "references" : kind === "throws" ? "throws" : kind === "env" ? "uses" : "imports";
  const refs = (extracted.refs ?? []).map((ref: any) => ({ rawTarget: ref.rawName, edgeType: edgeType(ref.kind), sourceIdentityKey: sourceKey(ref.enclosingQualifiedName), line: ref.startLine }));
  const endpoints = (extracted.endpoints ?? []).map((endpoint: any) => ({ endpointKey: endpoint.grpcService && endpoint.grpcMethod ? `grpc::${endpoint.grpcService}.${String(endpoint.grpcMethod).toLowerCase()}` : endpoint.key, protocol: endpoint.protocol, ...(endpoint.grpcService ? { service: endpoint.grpcService } : {}), ...(endpoint.grpcMethod ? { method: endpoint.grpcMethod } : {}), ...(endpoint.key ? { route: endpoint.key } : {}), sourceIdentityKey: sourceKey(endpoint.handlerQualifiedName) }));
  const logSites = (extracted.logSites ?? []).map((site: any) => ({ level: site.level, template: site.message, sourceIdentityKey: sourceKey(site.enclosingQualifiedName), line: site.startLine }));
  return { repoId: input.repoId, filePath: input.relPath, contentHash: input.contentHash, language: language ?? "unknown", parserVersion: input.parserVersion ?? "parser-v1", exportsHash: createHash("sha256").update(symbols.map((item: { identityKey: string }) => item.identityKey).sort().join("\n")).digest("hex"), symbols, imports: (extracted.fileImports ?? []).map((specifier: string) => ({ specifier, importedNames: [], kind: "static" as const })), unresolvedReferences: refs, endpoints, logSites };
}
export async function indexRevision(input: IndexRevisionInput): Promise<IndexRevisionReport> {
  const requestedBase = input.base?.branch ?? input.base?.commitSha;
  const canonicalBranch = !requestedBase ? input.store.getDefaultBranch(input.repoId) : undefined;
  const targetBranch = input.revision.branch ?? null;
  const explicitBase = requestedBase ?? (canonicalBranch && targetBranch && canonicalBranch.name !== targetBranch ? canonicalBranch.name : undefined);
  const topology = resolveRevisionTopology(input.rootPath, input.revision, { explicitBase, includeDirtyWorktree: input.revision.useWorktree === true });
  const key = `${input.repoId}:${topology.headSha}:${topology.treeHash}:${topology.worktreeFingerprint ?? "clean"}:${input.parserVersion}:${input.resolverVersion}`;
  return input.coordinator.runExclusive(key, async () => {
    const topologyStore = new GitTopologyStore(input.store);
    const prior = input.publishBranchId ? input.store.db.prepare("SELECT current_snapshot_id AS currentSnapshotId, last_indexed_commit AS lastIndexedCommit FROM branches WHERE id=?").get(input.publishBranchId) as { currentSnapshotId: string | null; lastIndexedCommit: string | null } | undefined : undefined;
    const mergeBaseSnapshot = topology.mergeBaseSha
      ? input.store.db.prepare("SELECT id FROM revision_snapshots WHERE repo_id=? AND commit_sha=? AND state='ready' ORDER BY created_at DESC LIMIT 1").get(input.repoId, topology.mergeBaseSha) as { id: string } | undefined
      : undefined;
    let baseResolution = resolveBranchBase({
      repoId: input.repoId,
      targetBranch,
      canonicalMaster: canonicalBranch?.name ?? null,
      priorSnapshotId: prior?.currentSnapshotId ?? null,
      priorCommitSha: prior?.lastIndexedCommit ?? null,
      mergeBaseSha: topology.mergeBaseSha ?? null,
      mergeBaseSnapshotId: mergeBaseSnapshot?.id ?? null,
      canonicalSnapshotId: canonicalBranch?.current_snapshot_id ?? null,
      canonicalCommitSha: canonicalBranch?.last_indexed_commit ?? null,
      historyState: topology.historyState === "missing_history" ? "missing" : topology.historyState,
    });
    // A merge-base commit may not have a ready snapshot yet. Build that exact
    // immutable revision once without publishing a branch pointer, then use it
    // as the child snapshot's real base. Avoid recursion for a root commit
    // whose merge base is itself.
    baseResolution = await ensureBaseSnapshot(baseResolution, {
      materialize: async (commitSha) => {
        const materialized = await indexRevision({
          store: input.store,
          rootPath: input.rootPath,
          repoId: input.repoId,
          revision: { commitSha },
          parserVersion: input.parserVersion,
          resolverVersion: input.resolverVersion,
          coordinator: input.coordinator,
        });
        return { snapshotId: materialized.context.snapshotId };
      },
    }, topology.headSha);
    const snapshot = topologyStore.createBuildingSnapshot({ snapshotKey: key, repoId: input.repoId, commitSha: topology.sourceKind === "git_tree" ? topology.headSha : undefined, worktreeFingerprint: topology.worktreeFingerprint, parserVersion: input.parserVersion, resolverVersion: input.resolverVersion, schemaVersion: SCHEMA_VERSION, baseSnapshotId: baseResolution.baseSnapshotId ?? undefined, mergeBaseSha: topology.mergeBaseSha });
    if (snapshot.state === "ready") { const context = contextOf(input.repoId, topology, snapshot.id); const row = input.store.db.prepare("SELECT count(*) AS n FROM effective_snapshot_files WHERE snapshot_id=?").get(snapshot.id) as { n: number }; return { context, totalFiles: row.n, changedFiles: 0, reusedFileFacts: 0, resolvedFiles: 0, reusePercent: 100, ...(input.publishBranchId ? { publishedBranchId: input.publishBranchId } : {}) }; }
    try {
      const reader = new GitObjectReader(input.rootPath); const files = topology.sourceKind === "git_tree"
        ? reader.listTree(topology.headSha).filter((file) => Boolean(langForExtension(file.path))).map((file) => ({ path: file.path, blobSha: file.blobSha, source: reader.readBlob(file.blobSha).toString("utf8") }))
        : [...walkRepoFiles(input.rootPath)].filter((file) => Boolean(langForExtension(file.relPath))).map((file) => ({ path: file.relPath, blobSha: "", source: readFileSync(file.absPath, "utf8") }));
      const factStore = new FileFactStore(input.store); const resolutionStore = new ResolutionStore(input.store);
      const baseManifest = baseResolution.baseSnapshotId ? factStore.effectiveManifest(baseResolution.baseSnapshotId) : new Map<string, string>();
      const overlays: import("@penguin/knowledge-core").SnapshotOverlayEntry[] = [];
      const currentPaths = new Set<string>(); let reused = 0;
      for (const file of files) { const source = file.source; const hash = createHash("sha256").update(source).digest("hex"); const id = `filefact_${createHash("sha256").update(JSON.stringify([input.repoId, file.path, hash, langForExtension(file.path), input.parserVersion])).digest("hex")}`; if (input.store.db.prepare("SELECT 1 FROM file_facts WHERE id=?").get(id)) reused++; const fact = await extractFileFact({ repoId: input.repoId, rootPath: input.rootPath, relPath: file.path, source, contentHash: hash, parserVersion: input.parserVersion }); const factId = factStore.upsertFileFact(fact); currentPaths.add(file.path); const edges = fact.unresolvedReferences.filter((ref) => ref.sourceIdentityKey).map((ref) => ({ srcIdentityKey: ref.sourceIdentityKey!, ...(byTarget(fact, ref.rawTarget) ? { dstIdentityKey: byTarget(fact, ref.rawTarget)! } : { rawTarget: ref.rawTarget }), edgeType: ref.edgeType, method: "EXTRACTED", confidence: byTarget(fact, ref.rawTarget) ? 1 : 0.5, provenance: { parser: input.parserVersion, filePath: file.path, line: ref.line ?? null } })); const contextFingerprint = sha256Hex(canonicalJson({ fileFactId: factId, imports: fact.imports, symbols: fact.symbols.map((symbol) => symbol.identityKey), resolverVersion: input.resolverVersion })); const set = resolutionStore.replaceResolutionSet({ fileFactId: factId, contextFingerprint, resolverVersion: input.resolverVersion, edges }); resolutionStore.attachSnapshotResolution({ snapshotId: snapshot.id, filePath: file.path, resolutionSetId: set.id }); if (!baseManifest.has(file.path)) overlays.push({ op: "add", path: file.path, fileFactId: factId }); else if (baseManifest.get(file.path) !== factId) overlays.push({ op: "modify", path: file.path, fileFactId: factId }); }
      for (const [path, factId] of baseManifest) if (!currentPaths.has(path)) overlays.push({ op: "delete", path, fileFactId: null });
      factStore.replaceOverlay(snapshot.id, overlays); factStore.materializeManifest(snapshot.id);
      const expectedManifest = new Map<string, string>();
      for (const file of files) {
        const source = file.source;
        const hash = createHash("sha256").update(source).digest("hex");
        expectedManifest.set(file.path, `filefact_${createHash("sha256").update(JSON.stringify([input.repoId, file.path, hash, langForExtension(file.path), input.parserVersion])).digest("hex")}`);
      }
      factStore.assertManifestMatches(snapshot.id, expectedManifest);
      topologyStore.markSnapshotReady(snapshot.id); if (input.publishBranchId) topologyStore.publishSnapshot({ branchId: input.publishBranchId, snapshotId: snapshot.id, headCommit: topology.headSha });
      return { context: contextOf(input.repoId, topology, snapshot.id), totalFiles: files.length, changedFiles: files.length, reusedFileFacts: reused, resolvedFiles: files.length, reusePercent: files.length ? reused / files.length * 100 : 100, ...(input.publishBranchId ? { publishedBranchId: input.publishBranchId } : {}), ...(topology.historyState === "missing_history" ? { degradationReason: "missing_history" } : {}) };
    } catch (error) { topologyStore.markSnapshotFailed(snapshot.id, String((error as Error).message ?? error)); throw error; }
  });
}
function contextOf(repoId: string, topology: ReturnType<typeof resolveRevisionTopology>, snapshotId: string): RevisionContext { return { repoId, branch: topology.branch, commitSha: topology.headSha, snapshotId, ...(topology.mergeBaseSha ? { mergeBaseSha: topology.mergeBaseSha } : {}), ...(topology.worktreeFingerprint ? { worktreeFingerprint: topology.worktreeFingerprint } : {}), trust: topology.sourceKind === "worktree" ? "exact_worktree" : "exact_commit", ...(topology.historyState === "missing_history" ? { degradationReason: "missing_history" } : {}) }; }
