import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, relative, resolve as pathResolve } from "node:path";
import { performance } from "node:perf_hooks";
import { SCHEMA_VERSION, GitTopologyStore, FileFactStore, ResolutionStore, SourceStore, SourceSnapshotStore, resolveBranchBase, type KnowledgeStore, type ParsedFileFact, type ParsedEdge, type SnapshotOverlayEntry, type SourceSnapshotOverlayEntry } from "@penguin/knowledge-core";
import { extractSymbols, type ExtractedFile, type ExtractedSymbol } from "./extract.js";
import { extractFieldAccesses } from "./field-access.js";
import { extractIacFacts } from "./iac.js";
import { grpcEndpointKey } from "./grpc-client.js";
import { allForwardingMethods, extractFunctionNameCalls } from "./frontend-grpc-client.js";
import { verifiedConnectRpcGetters, extractConnectRpcCalls } from "./connect-rpc-client.js";
import { withParsedTree } from "./parser.js";
import { readGitContext } from "./git.js";
import { indexGitObjects } from "./gitgraph.js";
import { langForExtension } from "./registry.js";
import { detectRenames } from "./rename.js";
import { resolveRefs, type SymbolIndex } from "./resolve.js";
import { isLikelyMinified } from "./walk.js";
import { parseProtoEndpoints } from "./proto-parser.js";
import { extractFpmsGrpcCalls } from "./grpc-js-client.js";
import { detectPackages, flyoverPackageNames } from "./package-detect.js";
import { discoverRepoCoverage } from "./walk.js";
import { summarizeCoverage, type CoverageSummary, type CoverageWarning } from "./coverage.js";
import { ingestSourceFile } from "./source-ingest.js";
import { hashFileStream } from "./encoding.js";
import { anonymousCallbackIdentity } from "./identity.js";

export interface IndexReport {
  repoId: string;
  branchId: string;
  branchName: string;
  commit: string | null;
  headCommit: string | null;
  indexedCommit: string | null;
  worktreeState: "clean" | "dirty" | "unknown" | "not_applicable";
  dirtyFiles: string[];
  pendingFiles: string[];
  worktreeFingerprint: string;
  parserVersion: string;
  schemaVersion: number;
  staleReason: "worktree_dirty" | "git_status_unavailable" | null;
  coverageGaps: string[];
  coverage: CoverageSummary;
  coverageWarnings: CoverageWarning[];
  scanned: number;
  parsed: number;
  skipped: number;
  deleted: number;
  errors: number;
  renamed: number;
  commits: number; // git commit nodes captured
  tags: number; // git tag nodes captured
  timings: {
    totalMs: number;
    stages: Partial<Record<IndexStageId, number>>;
    parse: ParseTimingBreakdown;
  };
  maintenance: {
    walAutoCheckpointPages: number;
    sqliteTuning: {
      previousCacheSize: number;
      activeCacheSize: number;
      previousMmapSize: number;
      activeMmapSize: number;
    };
    analyzedIndexes: string[];
    analyzeMs: number;
    optimizeMs: number;
    checkpointMs: number;
    checkpointAttempts: number;
    checkpointWarning: string | null;
    checkpoint: { busy: number; log: number; checkpointed: number };
  };
}

export interface ParseTimingBreakdown {
  filePasses: number;
  secondPasses: number;
  edgeSets: Record<"cached" | "compared" | "replaced", number>;
  edgeSetsByPass: Record<"first" | "second", Record<"cached" | "compared" | "replaced", number>>;
  sourceHashMs: number;
  sourceLookupMs: number;
  sourceIngestMs: number;
  sourceReadMs: number;
  extractMs: number;
  fileFactMs: number;
  priorSymbolsMs: number;
  transactionMs: number;
  nodeWritesMs: number;
  logSitesMs: number;
  symbolVersionsMs: number;
  referenceResolutionMs: number;
  graphWritesMs: number;
  replaceEdgesMs: number;
  symbolFtsMs: number;
  identifierFtsMs: number;
  checkpointMs: number;
  metricsMs: number;
}

type ParseDurationKey = Exclude<keyof ParseTimingBreakdown, "filePasses" | "secondPasses" | "edgeSets" | "edgeSetsByPass">;

function emptyParseTimings(): ParseTimingBreakdown {
  return {
    filePasses: 0,
    secondPasses: 0,
    edgeSets: { cached: 0, compared: 0, replaced: 0 },
    edgeSetsByPass: {
      first: { cached: 0, compared: 0, replaced: 0 },
      second: { cached: 0, compared: 0, replaced: 0 },
    },
    sourceHashMs: 0,
    sourceLookupMs: 0,
    sourceIngestMs: 0,
    sourceReadMs: 0,
    extractMs: 0,
    fileFactMs: 0,
    priorSymbolsMs: 0,
    transactionMs: 0,
    nodeWritesMs: 0,
    logSitesMs: 0,
    symbolVersionsMs: 0,
    referenceResolutionMs: 0,
    graphWritesMs: 0,
    replaceEdgesMs: 0,
    symbolFtsMs: 0,
    identifierFtsMs: 0,
    checkpointMs: 0,
    metricsMs: 0,
  };
}

function addParseDuration(
  timings: ParseTimingBreakdown | undefined,
  key: ParseDurationKey,
  startedAt: number,
): void {
  if (timings) timings[key] += performance.now() - startedAt;
}

// v7: TSX extraction gained jsx-component / jsx-callback dynamic-dispatch
// refs (renders / invokes_dynamic edges). Bumping forces existing indexes to
// reprocess on their next index run — without it, checkpoint-skipped files
// silently lack the new edges forever.
export const KNOWLEDGE_PARSER_VERSION = "tree-sitter-wasm-v7-jsx-dynamic-edges";
export const KNOWLEDGE_RESOLVER_VERSION = "resolver-v4-import-scoped-qualified";

// In-process index task lock: one active task per repo+branch+checkout (§8.3).
const activeLocks = new Set<string>();
export class IndexTaskLock {
  private constructor(readonly key: string) {}
  static tryAcquire(key: string): IndexTaskLock | null {
    if (activeLocks.has(key)) return null;
    activeLocks.add(key);
    return new IndexTaskLock(key);
  }
  release(): void {
    activeLocks.delete(this.key);
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function symbolIdentityKey(repoId: string, relPath: string, qualifiedName: string): string {
  // Top-level declarations already carry their file prefix. Class members do
  // not (`PlayerClientGrpc.getPlayerInfo`), so add it here to keep identical
  // copied classes in different physical files from collapsing onto one node.
  const fileScopedName = qualifiedName.startsWith(`${relPath}::`)
    ? qualifiedName
    : `${relPath}::${qualifiedName}`;
  return `${repoId}::${fileScopedName}`;
}

// Test files (*.spec.ts / *.test.ts / __tests__/…) get `tests` edges to the
// symbols they exercise, so "what tests cover X" is a graph query (§ vision #9).
function isTestFile(relPath: string): boolean {
  return /\.(spec|test)\.[cm]?[jt]sx?$/.test(relPath) || relPath.includes("__tests__/");
}

// A file is a first-class node (node_type='file') so import/defines edges have
// real endpoints (both AI reviewers: file nodes are the missing primitive).
function fileIdentityKey(repoId: string, relPath: string): string {
  return `${repoId}::file::${relPath}`;
}

// Resolve a relative import specifier to a repo-relative file path (or null for
// bare/external modules or unresolved paths). Tries TS/JS extensions + index.
const IMPORT_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"];
const IMPORT_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function resolveRelativeImport(fromAbsPath: string, spec: string, rootPath: string): string | null {
  if (!spec.startsWith(".")) return null; // bare/external module — no file node
  const base = pathResolve(dirname(fromAbsPath), spec);
  const emittedExtension = extname(base);
  const sourceCandidates = emittedExtension === ".js"
    ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", base.slice(0, -3) + ".d.ts"]
    : emittedExtension === ".jsx"
      ? [base.slice(0, -4) + ".tsx"]
      : emittedExtension === ".mjs"
        ? [base.slice(0, -4) + ".mts"]
        : emittedExtension === ".cjs"
          ? [base.slice(0, -4) + ".cts"]
          : [];
  for (const cand of [...sourceCandidates, ...IMPORT_EXTS.map((e) => base + e), ...IMPORT_INDEX.map((e) => base + e)]) {
    if (isFile(cand)) {
      const rel = relative(rootPath, cand);
      if (rel && !rel.startsWith("..")) return rel.split("\\").join("/");
    }
  }
  return null;
}

// Same-repo resolution backend (node identity is branch-independent, D6).
function storeSymbolIndex(store: KnowledgeStore, repoId: string): SymbolIndex {
  return {
    byQualifiedName: (qn) => {
      const bare = qn.split("::").at(-1)!.split(".").at(-1)!;
      const rows = store.db
        .prepare(
          `SELECT id, meta FROM nodes
           WHERE node_type='symbol' AND repo_id=?
             AND title=?`,
        )
        .all(repoId, bare) as Array<{ id: string; meta: string }>;
      const exact = rows.filter((row) => {
        try {
          return (JSON.parse(row.meta) as { qualifiedName?: string }).qualifiedName === qn;
        } catch {
          return false;
        }
      });
      return exact.length === 1 ? exact[0].id : null;
    },
    bareNameCandidates: (bare) => {
      const rows = store.db
        .prepare(
          `SELECT n.id AS id,
                  (SELECT sv.file_path FROM symbol_versions sv
                     WHERE sv.node_id = n.id AND sv.status='fresh' LIMIT 1) AS filePath
           FROM nodes n
           WHERE n.node_type='symbol' AND n.repo_id=?
             AND n.title=?`,
        )
        .all(repoId, bare) as Array<{
        id: string;
        filePath: string | null;
      }>;
      return rows;
    },
  };
}

// The innermost symbol node id (smallest line span) enclosing `line` in
// (branch, filePath), read straight from the DB rather than an in-memory
// map — so it resolves correctly even for a checkpoint-skipped file whose
// fresh symbol_versions rows persist unchanged from a prior run (needed by
// the zero-config frontend-call always-fresh scan in indexRepo, which walks
// EVERY ts/tsx file regardless of this run's incremental skip).
function enclosingSymbolNodeId(
  store: KnowledgeStore,
  branchId: string,
  filePath: string,
  line: number,
): string | null {
  const rows = store.db
    .prepare(
      `SELECT n.id AS id, sv.start_line AS startLine, sv.end_line AS endLine
       FROM symbol_versions sv JOIN nodes n ON n.id = sv.node_id
       WHERE sv.branch_id=? AND sv.file_path=? AND sv.status='fresh'`,
    )
    .all(branchId, filePath) as Array<{ id: string; startLine: number; endLine: number }>;
  let best: { id: string; startLine: number; endLine: number } | null = null;
  for (const r of rows) {
    if (r.startLine <= line && line <= r.endLine) {
      if (!best || r.endLine - r.startLine < best.endLine - best.startLine) best = r;
    }
  }
  return best ? best.id : null;
}

// Prior symbols (qualifiedName + contentHash) for a file+branch, for rename detection.
function priorSymbols(
  store: KnowledgeStore,
  repoId: string,
  branchId: string,
  filePath: string,
): ExtractedSymbol[] {
  const rows = store.db
    .prepare(
      `SELECT json_extract(n.meta, '$.qualifiedName') AS qn,
              sv.content_hash AS hash, sv.kind AS kind
       FROM symbol_versions sv JOIN nodes n ON n.id = sv.node_id
       WHERE sv.branch_id=? AND sv.file_path=? AND sv.status='fresh'`,
    )
    .all(branchId, filePath) as Array<{ qn: string; hash: string; kind: string }>;
  return rows.map((r) => ({
    qualifiedName: r.qn,
    name: "",
    kind: r.kind,
    signature: null,
    startLine: 0,
    endLine: 0,
    contentHash: r.hash,
  }));
}

// Index one already-read source file: extract → rename→ledger (before txn) →
// one SQLite txn replacing this file's parser-derived data (§6.3.2).
async function indexFileWithSource(
  store: KnowledgeStore,
  p: {
    repoId: string;
    branchId: string;
    commit: string | null;
    relPath: string;
    absPath: string;
    rootPath: string;
    source: string;
    contentHash: string;
    mtimeMs: number;
    sizeBytes: number;
    recordRenames?: boolean;
    snapshotId?: string;
    timings?: ParseTimingBreakdown;
    pass?: "first" | "second";
    preExtracted?: ExtractedFile;
    deferEdgesOnUnresolved?: boolean;
  },
): Promise<{
  error: string | null;
  renamed: number;
  // Endpoints this file defines (NestJS decorators) — surfaced so indexRepo
  // can emit discovery events without re-parsing.
  endpoints: Array<{ key: string; protocol: string }>;
  // Bare names that resolved to ZERO candidates (forward references) — the
  // caller retries this file in a second pass once the symbol table is full.
  retryNames: string[];
  fileFactId?: string;
  extracted?: ExtractedFile;
}> {
  if (p.timings) p.timings.filePasses += 1;
  const lang = langForExtension(p.relPath);
  const iacFacts = extractIacFacts(p.relPath, p.source);
  // Skip non-source files AND minified/generated bundles that slipped past the
  // name filter — parsing them yields single-letter symbols that dominate hubs.
  if (!lang || isLikelyMinified(p.source)) {
    if (iacFacts.length > 0) {
      const fileNodeId = store.upsertNode({ nodeType: "file", identityKey: fileIdentityKey(p.repoId, p.relPath), repoId: p.repoId, title: p.relPath, meta: { path: p.relPath, kind: "iac" } });
      const edges: ParsedEdge[] = [];
      for (const fact of iacFacts) {
        const nodeId = store.upsertNode({ nodeType: fact.kind === "secret_ref" ? "entity" : "service", identityKey: `${p.repoId}::iac::${fact.kind}::${fact.name}`, repoId: p.repoId, title: fact.name, meta: { iacKind: fact.kind, status: fact.status, filePath: fact.locator.filePath, startLine: fact.startLine, locatorOnly: fact.kind === "secret_ref" } });
        edges.push({ src: fileNodeId, dst: nodeId, edgeType: fact.relation ?? "references", origin: "parser", method: fact.status === "verified" ? "EXTRACTED" : "INFERRED", ...(fact.status === "candidate" ? { confidence: 0.5 } : {}), provenance: { source: "iac", filePath: fact.locator.filePath, startLine: fact.startLine, kind: fact.kind } });
      }
      store.replaceFileEdges({ repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, edges });
    }
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash, status: "skipped",
    });
    return { error: null, renamed: 0, endpoints: [], retryNames: [] };
  }

  let timingStartedAt = performance.now();
  const extracted = p.preExtracted
    ?? await extractSymbols({ lang, source: p.source, relPath: p.relPath });
  if (!p.preExtracted) addParseDuration(p.timings, "extractMs", timingStartedAt);
  // Object-literal keys / interface / type-alias / class field names — none
  // of these are symbol nodes, so this feeds fts_identifiers only (see
  // identifiers.ts). TS/JS-only for now: the grammar node types it looks for
  // (property_signature, public_field_definition, pair) are TS/JS-specific.
  if (extracted.parseError) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, lang,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash,
      status: "error", error: extracted.parseError,
    });
    return { error: extracted.parseError, renamed: 0, endpoints: [], retryNames: [] };
  }
  timingStartedAt = performance.now();
  const fileFactId = new FileFactStore(store).upsertFileFact({
    repoId: p.repoId, filePath: p.relPath, contentHash: p.contentHash,
    language: lang, parserVersion: "parser-v1",
    exportsHash: createHash("sha256").update(extracted.symbols.map((symbol) => symbol.qualifiedName).sort().join("\n")).digest("hex"),
    symbols: extracted.symbols.map((symbol) => ({ identityKey: symbolIdentityKey(p.repoId, p.relPath, symbol.qualifiedName), title: symbol.name, kind: symbol.kind, ...(symbol.signature ? { signature: symbol.signature } : {}), startLine: symbol.startLine, endLine: symbol.endLine, contentHash: symbol.contentHash })),
    imports: [], unresolvedReferences: [], endpoints: [], logSites: [],
  });
  addParseDuration(p.timings, "fileFactMs", timingStartedAt);
  // Hoisted out of the write-transaction closure below so the return can see it.
  let retryNames: string[] = [];
  let snapshotResolutionEdges: Array<{
    srcIdentityKey: string;
    dstIdentityKey?: string;
    rawTarget?: string;
    edgeType: string;
    method: string;
    confidence: number;
    provenance: Record<string, unknown>;
  }> | null = null;

  // Rename detection BEFORE the rebuildable txn — aliases go to the Ledger (§2.2.4).
  timingStartedAt = performance.now();
  const prior = priorSymbols(store, p.repoId, p.branchId, p.relPath);
  addParseDuration(p.timings, "priorSymbolsMs", timingStartedAt);
  const priorKeys = new Set(prior.map((s) => s.qualifiedName));
  const nowKeys = new Set(extracted.symbols.map((s) => s.qualifiedName));
  const disappeared = prior.filter((s) => !nowKeys.has(s.qualifiedName));
  const appeared = extracted.symbols.filter((s) => !priorKeys.has(s.qualifiedName));
  const renames = detectRenames({ disappeared, appeared });
  // Ambiguous same-body moves go to a confirmation queue (Ledger), never
  // auto-applied (§11 相似度检测进确认队列).
  for (const s of p.recordRenames === false ? [] : renames.suggested) {
    store.recordKnowledge({
      type: "rename_suggested",
      origin: "system",
      method: "INFERRED",
      actor: { type: "system", id: "knowledge-indexer" },
      payload: {
        old_key: symbolIdentityKey(p.repoId, p.relPath, s.oldKey),
        candidate_keys: s.candidateKeys.map((k) => symbolIdentityKey(p.repoId, p.relPath, k)),
      },
    });
  }

  // Resolve this file's relative imports → target repo-relative paths (used both
  // for `imports` edges and to scope bare-name symbol resolution).
  const importedFiles = new Set<string>();
  for (const spec of extracted.fileImports) {
    const target = resolveRelativeImport(p.absPath, spec, p.rootPath);
    if (target && target !== p.relPath) importedFiles.add(target);
  }

  const tx = store.db.transaction(() => {
    // 0. the file itself is a node (defines/imports edges hang off it)
    let transactionStepStartedAt = performance.now();
    const fileNodeId = store.upsertNode({
      nodeType: "file",
      identityKey: fileIdentityKey(p.repoId, p.relPath),
      repoId: p.repoId,
      title: p.relPath,
      meta: { path: p.relPath, lang },
    });

    // 1. upsert nodes for current symbols, collect qualifiedName → nodeId
    const fileSymbolIds = new Map<string, string>();
    for (const sym of extracted.symbols) {
      const nodeId = store.upsertNode({
        nodeType: "symbol",
        identityKey: symbolIdentityKey(p.repoId, p.relPath, sym.qualifiedName),
        repoId: p.repoId,
        title: sym.name,
        meta: { kind: sym.kind, qualifiedName: sym.qualifiedName },
      });
      fileSymbolIds.set(sym.qualifiedName, nodeId);
    }
    addParseDuration(p.timings, "nodeWritesMs", transactionStepStartedAt);

    // log_site identity is content-addressed. Upsert the current set first so
    // unchanged sites keep stable node/edge ids, then delete only disappeared
    // sites; clearing the whole file here made every rebuild rewrite its graph.
    transactionStepStartedAt = performance.now();
    const logSiteNodes: Array<{ site: (typeof extracted.logSites)[number]; nodeId: string }> = [];
    for (const site of extracted.logSites) {
      const identityKey = `${p.repoId}::log::${p.relPath}:${site.startLine}:${sha256(site.message).slice(0, 16)}`;
      const nodeId = store.upsertNode({
        nodeType: "log_site",
        identityKey,
        repoId: p.repoId,
        title: site.message,
        meta: {
          filePath: p.relPath,
          startLine: site.startLine,
          level: site.level,
          message: site.message,
          enclosingQualifiedName: site.enclosingQualifiedName,
        },
      });
      logSiteNodes.push({ site, nodeId });
    }
    store.clearLogSitesForFile(
      p.repoId,
      p.relPath,
      logSiteNodes.map(({ nodeId }) => nodeId),
    );
    addParseDuration(p.timings, "logSitesMs", transactionStepStartedAt);

    // 2. mark this file's prior versions stale, then upsert fresh versions
    transactionStepStartedAt = performance.now();
    store.markFileSymbolsStale({ branchId: p.branchId, filePath: p.relPath });
    for (const sym of extracted.symbols) {
      const nodeId = fileSymbolIds.get(sym.qualifiedName)!;
      store.upsertSymbolVersion({
        nodeId, branchId: p.branchId, commitSha: p.commit ?? "(workdir)",
        filePath: p.relPath, lang, kind: sym.kind, signature: sym.signature,
        startLine: sym.startLine, endLine: sym.endLine, contentHash: sym.contentHash,
        status: "fresh",
      });
    }
    addParseDuration(p.timings, "symbolVersionsMs", transactionStepStartedAt);

    // 3. resolve call/type refs → edges (import-scoped), plus structural edges:
    //    file →defines→ symbol, and file →imports→ imported file.
    transactionStepStartedAt = performance.now();
    const symbolLookup = storeSymbolIndex(store, p.repoId);
    const resolved = resolveRefs({
      refs: extracted.refs, fileSymbols: extracted.symbols,
      fileSymbolIds, lookup: symbolLookup,
      currentFile: p.relPath, importedFiles,
    });
    // Cap: a file with hundreds of external (node_modules/stdlib) misses would
    // otherwise carry a huge retry list for names that never resolve.
    retryNames = [...new Set(resolved.unresolvedNames)].slice(0, 100);
    addParseDuration(p.timings, "referenceResolutionMs", transactionStepStartedAt);
    transactionStepStartedAt = performance.now();
    const structural: ParsedEdge[] = [];
    for (const nodeId of fileSymbolIds.values()) {
      structural.push({ src: fileNodeId, dst: nodeId, edgeType: "defines", origin: "parser", method: "EXTRACTED" });
    }
    for (const target of importedFiles) {
      const targetFileId = store.upsertNode({
        nodeType: "file",
        identityKey: fileIdentityKey(p.repoId, target),
        repoId: p.repoId,
        title: target,
        meta: { path: target },
      });
      structural.push({ src: fileNodeId, dst: targetFileId, edgeType: "imports", origin: "parser", method: "EXTRACTED" });
    }
    // tests: a spec/test file → the symbols it exercises (the resolved call/type
    // targets that live outside this file). Grounded in real usage, not guessed.
    if (isTestFile(p.relPath)) {
      const localIds = new Set(fileSymbolIds.values());
      const tested = new Map<string, { method: "EXTRACTED" | "INFERRED"; confidence?: number; callbackIdentity?: string }>();
      for (const edge of resolved.edges) {
        if (!edge.dst || localIds.has(edge.dst)) continue;
        tested.set(edge.dst, { method: edge.method, confidence: edge.confidence });
      }
      // Jest/Vitest callbacks are commonly anonymous, so their calls have no
      // enclosing symbol and cannot form normal calls edges. Import scoping is
      // still strong evidence: accept only a unique symbol from an imported file.
      let callbackOrdinal = 0;
      for (const ref of extracted.refs) {
        if (ref.enclosingQualifiedName || (ref.kind !== "call" && ref.kind !== "type")) continue;
        const callbackIdentity = anonymousCallbackIdentity(`${p.relPath}::test-file`, callbackOrdinal++);
        const importedCandidates = symbolLookup
          .bareNameCandidates(ref.rawName)
          .filter((candidate) => candidate.filePath && importedFiles.has(candidate.filePath));
        if (importedCandidates.length === 0) {
          retryNames = [...new Set([...retryNames, ref.rawName])].slice(0, 100);
          continue;
        }
        if (importedCandidates.length === 1) {
          tested.set(importedCandidates[0].id, { method: "EXTRACTED", callbackIdentity });
          continue;
        }
        const confidence = 1 / importedCandidates.length;
        for (const candidate of importedCandidates) {
          if (!tested.has(candidate.id)) tested.set(candidate.id, { method: "INFERRED", confidence, callbackIdentity });
        }
      }
      for (const [dst, evidence] of tested) {
        structural.push({
          src: fileNodeId, dst, edgeType: "tests", origin: "parser",
          method: evidence.method, ...(evidence.confidence != null ? { confidence: evidence.confidence } : {}), ...(evidence.callbackIdentity ? { provenance: { callbackIdentity: evidence.callbackIdentity, astOrdinal: Number(evidence.callbackIdentity.split("#").at(-1)) } } : {}),
        });
      }
    }
    // endpoints (NestJS gRPC/kafka/http): an `endpoint` node → its handler method
    // ('handles'). gRPC endpoints are GLOBAL (cross-repo id = grpc::Svc.method) so
    // a provider here connects to consumers in OTHER repos. http/kafka stay repo-scoped.
    for (const ep of extracted.endpoints) {
      const handlerId = fileSymbolIds.get(ep.handlerQualifiedName);
      if (!handlerId) continue;
      const isGrpc = ep.protocol === "grpc" && ep.grpcService && ep.grpcMethod;
      const identityKey = isGrpc
        ? grpcEndpointKey(ep.grpcService!, ep.grpcMethod!) // global, cross-repo
        : `${p.repoId}::endpoint::${ep.key}`;
      const endpointId = store.upsertNode({
        nodeType: "endpoint",
        identityKey,
        repoId: isGrpc ? null : p.repoId, // gRPC endpoints belong to no single repo
        title: ep.key,
        meta: { protocol: ep.protocol, service: ep.grpcService, method: ep.grpcMethod, controller: ep.controllerName, httpStatus: ep.httpStatus },
      });
      // gRPC endpoints are global (repo-less) → branch-less so cross-service
      // traversal survives branch-scoping. http/kafka stay repo/branch-scoped.
      structural.push({ src: endpointId, dst: handlerId, edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: !!isGrpc });
    }
    // consumer side: inter-service gRPC calls → 'invokes' to the SAME global
    // endpoint id → the cross-repo service-call graph.
    for (const gc of extracted.grpcClientCalls) {
      const src = gc.enclosingQualifiedName ? fileSymbolIds.get(gc.enclosingQualifiedName) : undefined;
      if (!src) continue;
      const endpointId = store.upsertNode({
        nodeType: "endpoint",
        identityKey: grpcEndpointKey(gc.service, gc.method),
        repoId: null,
        title: `gRPC ${gc.service}.${gc.method}`,
        meta: { protocol: "grpc", service: gc.service, method: gc.method },
      });
      structural.push({ src, dst: endpointId, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true });
    }
    // FPMS-style JS gRPC client calls (serviceRegistry + grpcClientCall pattern).
    // Detected via regex on the source for non-NestJS, bare grpc-js patterns.
    if (lang === "js") {
      const jsCalls = extractFpmsGrpcCalls(p.source);
      for (const jc of jsCalls) {
        // Match the function name to an extracted symbol. qualifiedName is
        // file-prefixed ("<relPath>::<name>", possibly dot-nested), so compare
        // against the local name after the "::" — matching on a bare name or a
        // ".name" suffix alone never fires (that regression left every real
        // FPMS call site with zero invokes edges).
        const matching = extracted.symbols.find((s) => {
          const sep = s.qualifiedName.lastIndexOf("::");
          const local = sep === -1 ? s.qualifiedName : s.qualifiedName.slice(sep + 2);
          return local === jc.functionName || local.endsWith(`.${jc.functionName}`);
        });
        const src = matching ? fileSymbolIds.get(matching.qualifiedName) : undefined;
        if (!src) continue;
        const endpointId = store.upsertNode({
          nodeType: "endpoint",
          identityKey: grpcEndpointKey(jc.service, jc.method),
          repoId: null,
          title: `gRPC ${jc.service}.${jc.method}`,
          meta: { protocol: "grpc", service: jc.service, method: jc.method },
        });
        structural.push({ src, dst: endpointId, edgeType: "invokes", origin: "parser", method: "EXTRACTED", branchless: true });
      }
    }
    // Protocol/channel bindings are explicit graph facts. Literal names are
    // extracted as verified; template/computed names remain candidate edges.
    for (const channel of extracted.channels) {
      const topicId = store.upsertNode({
        nodeType: channel.protocol === "websocket" ? "websocket_event" : "topic",
        identityKey: `${p.repoId}::channel::${channel.protocol}::${channel.name}`,
        repoId: p.repoId,
        title: channel.name,
        meta: { protocol: channel.protocol, status: channel.status, source: channel.source, filePath: p.relPath, startLine: channel.startLine },
      });
      const src = channel.enclosingQualifiedName ? fileSymbolIds.get(channel.enclosingQualifiedName) ?? fileNodeId : fileNodeId;
      structural.push({ src, dst: topicId, edgeType: channel.role === "producer" ? "publishes" : "subscribes", origin: "parser", method: channel.status === "verified" ? "EXTRACTED" : "INFERRED", ...(channel.status === "candidate" ? { confidence: 0.5 } : {}), provenance: { protocol: channel.protocol, source: channel.source, filePath: p.relPath, startLine: channel.startLine } });
    }
    // code entities: thrown errors + env reads → entity nodes, edges from the
    // enclosing symbol ('throws' / 'uses'). "where is XError thrown / who uses JWT_SECRET".
    for (const ref of extracted.refs) {
      if (ref.kind !== "throws" && ref.kind !== "env") continue;
      const src = ref.enclosingQualifiedName ? fileSymbolIds.get(ref.enclosingQualifiedName) : undefined;
      if (!src) continue;
      const entityType = ref.kind === "throws" ? "error" : "env";
      const entityId = store.upsertNode({
        nodeType: "entity",
        identityKey: `${p.repoId}::entity::${entityType}::${ref.rawName}`,
        repoId: p.repoId,
        title: ref.rawName,
        meta: { entityType },
      });
      structural.push({
        src, dst: entityId,
        edgeType: ref.kind === "throws" ? "throws" : "uses",
        origin: "parser", method: "EXTRACTED",
      });
    }
    for (const { site, nodeId: dst } of logSiteNodes) {
      const src = site.enclosingQualifiedName ? fileSymbolIds.get(site.enclosingQualifiedName) : undefined;
      if (!src || !dst) continue;
      structural.push({ src, dst, edgeType: "emits_log", origin: "parser", method: "EXTRACTED" });
    }
    // Conservative field graph: static property access is AST-adjacent exact
    // evidence; computed access remains an inferred candidate and is excluded
    // from verified impact traversal by the core query layer.
    for (const access of extractFieldAccesses(p.source)) {
      const owner = extracted.symbols
        .filter((symbol) => symbol.startLine <= access.startLine && symbol.endLine >= access.startLine)
        .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
      const src = (owner ? fileSymbolIds.get(owner.qualifiedName) : undefined) ?? fileNodeId;
      const fieldId = store.upsertNode({
        nodeType: "field",
        identityKey: `${p.repoId}::field::${p.relPath}::${access.object}::${access.field}`,
        repoId: p.repoId,
        title: access.field,
        meta: { filePath: p.relPath, object: access.object, field: access.field, startLine: access.startLine },
      });
      structural.push({ src, dst: fieldId, edgeType: access.kind, origin: "parser", method: access.method, confidence: access.method === "EXTRACTED" ? 1 : 0.45 });
    }
    addParseDuration(p.timings, "graphWritesMs", transactionStepStartedAt);
    transactionStepStartedAt = performance.now();
    if (!(p.deferEdgesOnUnresolved && retryNames.length > 0)) {
      const fileEdges = [...resolved.edges, ...structural];
      const edgeSetResult = store.replaceFileEdges({
        repoId: p.repoId, branchId: p.branchId, filePath: p.relPath,
        edges: fileEdges,
      });
      snapshotResolutionEdges = fileEdges.flatMap((edge) => {
        const srcIdentityKey = store.getNode(edge.src)?.identity_key;
        if (!srcIdentityKey) return [];
        const dstIdentityKey = edge.dst ? store.getNode(edge.dst)?.identity_key : undefined;
        return [{
          srcIdentityKey,
          ...(dstIdentityKey ? { dstIdentityKey } : {}),
          ...(edge.rawTarget ? { rawTarget: edge.rawTarget } : {}),
          edgeType: edge.edgeType,
          method: edge.method,
          confidence: edge.confidence ?? 1,
          provenance: { ...edge.provenance, filePath: p.relPath },
        }];
      });
      if (p.timings) {
        p.timings.edgeSets[edgeSetResult] += 1;
        p.timings.edgeSetsByPass[p.pass ?? "first"][edgeSetResult] += 1;
      }
    }
    addParseDuration(p.timings, "replaceEdgesMs", transactionStepStartedAt);

    // 4. FTS for each symbol
    transactionStepStartedAt = performance.now();
    for (const sym of extracted.symbols) {
      store.indexSymbolText({
        nodeId: fileSymbolIds.get(sym.qualifiedName)!, name: sym.name, signature: sym.signature,
      });
    }
    addParseDuration(p.timings, "symbolFtsMs", transactionStepStartedAt);

    // 4b. field/object-key identifier index (file:line only, not graph nodes)
    transactionStepStartedAt = performance.now();
    store.indexIdentifiers({ repoId: p.repoId, filePath: p.relPath, entries: extracted.identifiers });
    addParseDuration(p.timings, "identifierFtsMs", transactionStepStartedAt);

    // 5. checkpoint
    transactionStepStartedAt = performance.now();
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, lang,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash, status: "indexed",
    });
    addParseDuration(p.timings, "checkpointMs", transactionStepStartedAt);

    return { fileSymbolIds };
  });

  timingStartedAt = performance.now();
  const { fileSymbolIds } = tx();
  addParseDuration(p.timings, "transactionMs", timingStartedAt);

  if (p.snapshotId && snapshotResolutionEdges) {
    const resolverVersion = KNOWLEDGE_RESOLVER_VERSION;
    const contextFingerprint = createHash("sha256")
      .update(JSON.stringify({ fileFactId, resolverVersion, edges: snapshotResolutionEdges }))
      .digest("hex");
    const resolutions = new ResolutionStore(store);
    const set = resolutions.replaceResolutionSet({
      fileFactId,
      contextFingerprint,
      resolverVersion,
      edges: snapshotResolutionEdges,
    });
    resolutions.attachSnapshotResolution({
      snapshotId: p.snapshotId,
      filePath: p.relPath,
      resolutionSetId: set.id,
    });
  }

  // Apply rename aliases now that node ids exist (Ledger-first, outside the txn).
  let renamed = 0;
  for (const ev of p.recordRenames === false ? [] : renames.auto) {
    // the alias's node = the appeared symbol sharing the gone symbol's hash
    const gone = disappeared.find((d) => d.qualifiedName === ev.aliasKey);
    const arrived = appeared.find((a) => a.contentHash === gone?.contentHash);
    const nodeId = arrived ? fileSymbolIds.get(arrived.qualifiedName) : undefined;
    if (nodeId) {
      store.recordKnowledge({
        type: "node_alias_added",
        origin: "system",
        method: "EXTRACTED",
        actor: { type: "system", id: "knowledge-indexer" },
        target: { node_id: nodeId },
        payload: {
          alias_key: symbolIdentityKey(p.repoId, p.relPath, ev.aliasKey),
          alias_type: "qualified_name",
          reason: "rename",
        },
      });
      renamed += 1;
    }
  }

  return {
    error: null,
    renamed,
    endpoints: extracted.endpoints.map((e) => ({ key: e.key, protocol: e.protocol })),
    retryNames,
    fileFactId,
    extracted,
  };
}

// Pipeline stages indexRepo runs through, in order. UIs render this list.
export type IndexStageId = "scan" | "parse" | "deletes" | "proto" | "link" | "packages" | "git";

// Progress events: the legacy per-file "scan"/"index" shapes are kept verbatim
// (existing CLI bar + Tauri Wiki bar parse them), PLUS typed pipeline events —
// stage lifecycle, throttled metric snapshots, discoveries — so UIs can
// narrate indexing ("what am I building for you") instead of a bare % bar.
export type IndexProgressEvent =
  | { phase: "scan"; done: number; total: number; file: string; langs?: Record<string, number> }
  | { phase: "index"; done: number; total: number; file: string; lang?: string }
  | { phase: "stage"; stage: IndexStageId; state: "start" | "done"; detail?: string; elapsedMs?: number }
  | { phase: "metric"; symbols: number; edges: number; endpoints: number }
  | { phase: "discovery"; kind: "endpoint" | "service" | "link"; title: string; file?: string };

export function resolveIndexMode(
  mode: "rebuild" | "incremental",
  prior: { parser_version?: string | null; indexed_schema_version?: number | null } | undefined,
  parserVersion: string,
  schemaVersion: number,
): "rebuild" | "incremental" {
  if (mode === "rebuild") return "rebuild";
  if (!prior) return "incremental";
  if (prior.parser_version !== parserVersion) return "rebuild";
  if ((prior.indexed_schema_version ?? 0) !== schemaVersion) return "rebuild";
  return "incremental";
}

// Index a whole repo (headless). incremental uses the files_index quick filter;
// rebuild clears the branch's checkpoints so every file re-parses (§8.3).
export async function indexRepo(input: {
  store: KnowledgeStore;
  rootPath: string;
  mode: "incremental" | "rebuild";
  onProgress?: (p: IndexProgressEvent) => void;
}): Promise<IndexReport> {
  const runStartedAt = Date.now();
  const { store, rootPath, mode } = input;
  const git = readGitContext(rootPath);
  // Prefer the git remote's repo name (e.g. penguin-src); fall back to the local
  // folder name for non-git checkouts or remote-less repos.
  // Index from the git worktree root (git.checkoutPath), not the passed-in
  // subdir — so a subdir and its repo root map to ONE repo with consistent
  // repo-root-relative paths (no duplicate penguin-src).
  const scanRoot = git.checkoutPath;
  const repoId = store.registerRepo({
    name: git.repoName ?? basename(scanRoot),
    rootPath: scanRoot,
  });
  // Register WITHOUT claiming "live": a branch earns live status only when its
  // index SUCCEEDS (validation V1 — a failed run must not look trustworthy).
  // Existing branches keep their current status during the run.
  const prior = store.getBranch(repoId, git.branch);
  const effectiveMode = resolveIndexMode(mode, prior ?? undefined, KNOWLEDGE_PARSER_VERSION, SCHEMA_VERSION);
  const branchId = store.registerBranch({
    repoId, name: git.branch, headCommit: git.commit, checkoutPath: git.checkoutPath,
    status: (prior?.status as "live" | "snapshot" | "gone" | undefined) ?? "snapshot",
  });

  const lockKey = `${repoId}:${branchId}:${git.checkoutPath}`;
  const lock = IndexTaskLock.tryAcquire(lockKey);
  if (!lock) {
    throw new Error(`index task already running for ${git.branch}`);
  }
  // Cross-process guard (app calls spawn a fresh CLI process each time, so the
  // in-process lock above cannot see them): a DB marker removeBranch checks.
  store.acquireIndexMarker(branchId);
  const topology = new GitTopologyStore(store);
  const canonical = store.getDefaultBranch(repoId);
  const baseResolution = resolveBranchBase({
    repoId,
    targetBranch: git.isGit && !["(detached)", "(workdir)"].includes(git.branch) ? git.branch : null,
    canonicalMaster: canonical?.name ?? null,
    priorSnapshotId: prior?.current_snapshot_id ?? null,
    priorCommitSha: prior?.last_indexed_commit ?? null,
    mergeBaseSha: null,
    mergeBaseSnapshotId: null,
    canonicalSnapshotId: canonical?.current_snapshot_id ?? null,
    canonicalCommitSha: canonical?.last_indexed_commit ?? null,
    historyState: git.isGit ? "missing" : "not_git",
  });
  const baseSnapshotId = baseResolution.baseSnapshotId ?? undefined;
  const snapshotRevisionKey = git.worktreeState === "clean"
    ? (git.commit ?? git.worktreeFingerprint)
    : `${git.commit ?? "worktree"}:${git.worktreeFingerprint}`;
  const snapshot = topology.createBuildingSnapshot({
    snapshotKey: `${repoId}:${snapshotRevisionKey}:${KNOWLEDGE_PARSER_VERSION}:${KNOWLEDGE_RESOLVER_VERSION}:${SCHEMA_VERSION}`,
    repoId,
    ...(git.commit ? { commitSha: git.commit } : {}),
    worktreeFingerprint: git.worktreeFingerprint,
    parserVersion: KNOWLEDGE_PARSER_VERSION,
    resolverVersion: KNOWLEDGE_RESOLVER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    ...(baseSnapshotId ? { baseSnapshotId } : {}),
  });
  let snapshotAlreadyReady = snapshot.state === "ready";
  if (snapshot.state === "failed" || snapshot.state === "cold") {
    store.db.prepare("UPDATE revision_snapshots SET state='building', failure_reason=NULL, last_accessed_at=? WHERE id=?").run(new Date().toISOString(), snapshot.id);
    snapshotAlreadyReady = false;
  }
  let snapshotPublished = false;

  const report: IndexReport = {
    repoId, branchId, branchName: git.branch, commit: git.commit,
    headCommit: git.commit,
    indexedCommit: git.worktreeState === "clean" ? git.commit : null,
    worktreeState: git.worktreeState,
    dirtyFiles: [...git.dirtyFiles],
    pendingFiles: [],
    worktreeFingerprint: git.worktreeFingerprint,
    parserVersion: KNOWLEDGE_PARSER_VERSION,
    schemaVersion: SCHEMA_VERSION,
    staleReason: git.worktreeState === "dirty"
      ? "worktree_dirty"
      : git.worktreeState === "unknown"
        ? "git_status_unavailable"
        : null,
    coverageGaps: git.worktreeState === "unknown" ? ["git_status_unavailable"] : [],
    coverage: { discovered: 0, admitted: 0, excluded: 0, failed: 0, stale: 0, byReason: {} },
    coverageWarnings: [],
    scanned: 0, parsed: 0, skipped: 0, deleted: 0, errors: 0, renamed: 0,
    commits: 0, tags: 0,
    timings: { totalMs: 0, stages: {}, parse: emptyParseTimings() },
    maintenance: {
      walAutoCheckpointPages: 0,
      sqliteTuning: {
        previousCacheSize: 0,
        activeCacheSize: 0,
        previousMmapSize: 0,
        activeMmapSize: 0,
      },
      analyzedIndexes: [],
      analyzeMs: 0,
      optimizeMs: 0,
      checkpointMs: 0,
      checkpointAttempts: 0,
      checkpointWarning: null,
      checkpoint: { busy: 0, log: 0, checkpointed: 0 },
    },
  };
  const dirtyFiles = new Set(git.dirtyFiles);
  const commitForFile = (relPath: string): string | null => {
    if (git.worktreeState === "unknown") return "(worktree)";
    return dirtyFiles.has(relPath) ? "(worktree)" : git.commit;
  };

  const emit = input.onProgress;
  const stageT0 = new Map<IndexStageId, number>();
  const stageStart = (s: IndexStageId) => {
    stageT0.set(s, Date.now());
    emit?.({ phase: "stage", stage: s, state: "start" });
  };
  const stageDone = (s: IndexStageId, detail?: string) => {
    const elapsedMs = Date.now() - (stageT0.get(s) ?? Date.now());
    report.timings.stages[s] = elapsedMs;
    emit?.({
      phase: "stage", stage: s, state: "done", detail,
      elapsedMs,
    });
  };
  // Endpoints surfaced this run (per-file NestJS + proto pass) for the metric line.
  let endpointsFound = 0;
  const emitMetric = () => {
    if (!emit) return;
    const symbols = (store.db
      .prepare("SELECT COUNT(*) AS c FROM nodes WHERE repo_id=? AND node_type='symbol'")
      .get(repoId) as { c: number }).c;
    const edges = (store.db
      .prepare("SELECT COUNT(*) AS c FROM edges WHERE branch_id=? AND status='active'")
      .get(branchId) as { c: number }).c;
    emit({ phase: "metric", symbols, edges, endpoints: endpointsFound });
  };

  let rebuildTransactionOpen = false;
  const previousWalAutoCheckpoint = Number(
    store.db.pragma("wal_autocheckpoint", { simple: true }),
  );
  const previousCacheSize = Number(store.db.pragma("cache_size", { simple: true }));
  const previousMmapSize = Number(store.db.pragma("mmap_size", { simple: true }));
  const rebuildCacheSize = -262_144; // 256 MiB, expressed as KiB by SQLite.
  const rebuildMmapSize = 1_073_741_824; // 1 GiB of read-only mapped pages.
  report.maintenance.walAutoCheckpointPages = previousWalAutoCheckpoint;
  report.maintenance.sqliteTuning = {
    previousCacheSize,
    activeCacheSize: rebuildCacheSize,
    previousMmapSize,
    activeMmapSize: rebuildMmapSize,
  };
  try {
    store.db.pragma("wal_autocheckpoint = 0");
    store.db.pragma(`cache_size = ${rebuildCacheSize}`);
    store.db.pragma(`mmap_size = ${rebuildMmapSize}`);
    report.maintenance.sqliteTuning.activeCacheSize = Number(
      store.db.pragma("cache_size", { simple: true }),
    );
    report.maintenance.sqliteTuning.activeMmapSize = Number(
      store.db.pragma("mmap_size", { simple: true }),
    );
    if (effectiveMode === "rebuild") {
      store.db.exec("BEGIN IMMEDIATE");
      rebuildTransactionOpen = true;
      store.db.prepare("DELETE FROM files_index WHERE repo_id=? AND branch_id=?").run(repoId, branchId);
    }

    // Collect the file list first so progress has a total for a % bar.
    stageStart("scan");
    const discovery = discoverRepoCoverage(scanRoot);
    const coverageUpsert = store.db.prepare(`INSERT INTO coverage_records(repo_id,file_path,git_state,coverage_status,reason_code,classification,byte_size,reason,parser_status,parser_language,parser_version,parser_error,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(repo_id,file_path) DO UPDATE SET git_state=excluded.git_state,coverage_status=excluded.coverage_status,reason_code=excluded.reason_code,classification=excluded.classification,byte_size=excluded.byte_size,reason=excluded.reason,parser_status=excluded.parser_status,parser_language=excluded.parser_language,parser_version=excluded.parser_version,parser_error=excluded.parser_error,updated_at=excluded.updated_at`);
    for (const file of discovery.files) {
      const language = langForExtension(file.relativePath);
      const parserStatus = file.coverageStatus === "admitted" && language ? "not_applicable" : file.coverageStatus === "admitted" ? "unsupported" : "not_applicable";
      coverageUpsert.run(repoId, file.relativePath, file.gitState, file.coverageStatus, file.reasonCode, file.classification, file.byteSize, file.reason, parserStatus, language, null, null, new Date().toISOString());
    }
    report.coverage = summarizeCoverage(discovery.files);
    report.coverageWarnings = discovery.warnings;
    for (const warning of discovery.warnings) report.coverageGaps.push(warning.code);
    for (const [reasonCode, count] of Object.entries(report.coverage.byReason)) {
      if (reasonCode !== "text_searchable" && count > 0) report.coverageGaps.push(`${reasonCode}:${count}`);
    }
    const admittedDiscovery = discovery.files
      .filter((file) => file.coverageStatus === "admitted" && !file.isSymlink)
    const files = admittedDiscovery
      .map((file) => ({
        absPath: file.absolutePath,
        relPath: file.relativePath,
        discovered: file,
        mtimeMs: (() => { try { return statSync(file.absolutePath).mtimeMs; } catch { return 0; } })(),
        sizeBytes: file.byteSize,
      }));
    // Per-language totals so UIs can render one bar per language ("other" =
    // walked but non-source: json/md/config — still checkpointed, so counted).
    const langOf = (relPath: string) => langForExtension(relPath) ?? "other";
    const langTotals: Record<string, number> = {};
    for (const f of files) langTotals[langOf(f.relPath)] = (langTotals[langOf(f.relPath)] ?? 0) + 1;
    input.onProgress?.({ phase: "scan", done: 0, total: files.length, file: "", langs: langTotals });
    stageDone("scan", `${files.length} files`);
    stageStart("parse");
    // Metric cadence: ~50 snapshots per run — cheap COUNTs, smooth counters.
    const metricEvery = Math.max(1, Math.floor(files.length / 50));

    // Files actually reprocessed this run (indexFileWithSource invoked, i.e.
    // NOT checkpoint-skipped). Used below to scope the frontend-call scan/
    // enqueue: a reprocessed file's OWN replaceFileEdges() call (inside
    // indexFileWithSource) wipes ALL previously-committed parser edges
    // provenanced to that file — INCLUDING a frontend `invokes` edge a prior
    // run's replayPendingFrontendEdges() attributed to it (provenance =
    // {file, repo}) — so re-enqueuing+replaying for a reprocessed file is a
    // wipe-then-recreate (safe, no duplicate). An UNCHANGED file's edges are
    // never wiped this run, so it must NOT be re-enqueued or
    // replayPendingFrontendEdges() would insert a second, duplicate edge
    // (it has no (src,dst) existence check — see idempotency).
    const reprocessedFiles = new Set<string>();
    const factStore = new FileFactStore(store);
    const sourceStore = new SourceStore(store);
    const sourceCow = new SourceSnapshotStore(store);
    const baseManifest = baseSnapshotId ? factStore.effectiveManifest(baseSnapshotId) : new Map<string, string>();
    const targetManifest = new Map(baseManifest);
    const baseSourceManifest = baseSnapshotId ? sourceCow.effectiveManifest(baseSnapshotId) : new Map<string, string>();
    const targetSourceManifest = new Map(baseSourceManifest);
    // Files whose refs had zero-candidate (forward-reference) misses in the
    // first pass — retried below once the full symbol table exists.
    const retryByFile = new Map<string, {
      file: (typeof files)[number];
      names: string[];
      extracted: ExtractedFile;
    }>();
    const seen = new Set<string>();
    let done = 0;
    for (const file of files) {
      report.scanned += 1;
      seen.add(file.relPath);
      done += 1;
      input.onProgress?.({ phase: "index", done, total: files.length, file: file.relPath, lang: langOf(file.relPath) });
      const prev = store.getFileCheckpoint(repoId, branchId, file.relPath);

      // Source ingestion is independent of parser support. Every admitted
      // file, including unsupported/config/documentation files, is available
      // through the revision-aware source corpus.
      let parseStepStartedAt = performance.now();
      const rawHash = (await hashFileStream(file.absPath)).contentHash;
      addParseDuration(report.timings.parse, "sourceHashMs", parseStepStartedAt);
      parseStepStartedAt = performance.now();
      const existingSource = store.db.prepare(
        "SELECT id FROM source_facts WHERE repo_id=? AND file_path=? AND content_hash=? ORDER BY source_fact_rowid DESC LIMIT 1",
      ).get(repoId, file.relPath, rawHash) as { id: string } | undefined;
      addParseDuration(report.timings.parse, "sourceLookupMs", parseStepStartedAt);
      let sourceFactId = existingSource?.id;
      if (!sourceFactId) {
        parseStepStartedAt = performance.now();
        sourceFactId = ingestSourceFile(store, repoId, file.discovered).sourceFactId;
        addParseDuration(report.timings.parse, "sourceIngestMs", parseStepStartedAt);
      }
      targetSourceManifest.set(file.relPath, sourceFactId);

      // quick filter: mtime+size unchanged (and not previously errored) → skip
      if (
        effectiveMode === "incremental" && prev && prev.status !== "error" &&
        prev.mtime_ms === file.mtimeMs && prev.size_bytes === file.sizeBytes
      ) {
        const fact = store.db.prepare(
          "SELECT id FROM file_facts WHERE repo_id=? AND file_path=? AND content_hash=? AND language=? AND parser_version=? LIMIT 1",
        ).get(repoId, file.relPath, prev.content_hash, langOf(file.relPath), KNOWLEDGE_PARSER_VERSION) as { id: string } | undefined;
        if (fact) targetManifest.set(file.relPath, fact.id);
        store.db.prepare("UPDATE coverage_records SET parser_status='parsed',parser_language=?,parser_version=?,parser_error=NULL,updated_at=? WHERE repo_id=? AND file_path=?").run(langOf(file.relPath), KNOWLEDGE_PARSER_VERSION, new Date().toISOString(), repoId, file.relPath);
        report.skipped += 1;
        continue;
      }

      parseStepStartedAt = performance.now();
      const source = readFileSync(file.absPath, "utf8");
      const contentHash = sha256(source);
      addParseDuration(report.timings.parse, "sourceReadMs", parseStepStartedAt);

      // hash unchanged (touch / format-revert) → refresh checkpoint mtime, skip parse
      if (
        effectiveMode === "incremental" && prev && prev.status !== "error" &&
        prev.content_hash === contentHash
      ) {
        store.upsertFileCheckpoint({
          repoId, branchId, filePath: file.relPath, lang: prev.lang,
          mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes, contentHash,
          status: prev.status as "indexed" | "deleted" | "error" | "skipped",
        });
        store.db.prepare("UPDATE coverage_records SET parser_status='parsed',parser_language=?,parser_version=?,parser_error=NULL,updated_at=? WHERE repo_id=? AND file_path=?").run(langOf(file.relPath), KNOWLEDGE_PARSER_VERSION, new Date().toISOString(), repoId, file.relPath);
        report.skipped += 1;
        continue;
      }

      reprocessedFiles.add(file.relPath);
      const r = await indexFileWithSource(store, {
        repoId, branchId, commit: commitForFile(file.relPath), relPath: file.relPath,
        absPath: file.absPath, rootPath: scanRoot,
        source, contentHash, mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes,
        recordRenames: effectiveMode !== "rebuild",
        snapshotId: snapshot.id,
        timings: report.timings.parse,
        pass: "first",
        deferEdgesOnUnresolved: true,
      });
      store.db.prepare("UPDATE coverage_records SET parser_status=?,parser_language=?,parser_version=?,parser_error=?,updated_at=? WHERE repo_id=? AND file_path=?").run(
        r.error ? "failed" : langOf(file.relPath) === "other" ? "unsupported" : "parsed",
        langForExtension(file.relPath),
        r.error || langOf(file.relPath) !== "other" ? KNOWLEDGE_PARSER_VERSION : null,
        r.error ?? null,
        new Date().toISOString(), repoId, file.relPath,
      );
      if (r.error) report.errors += 1;
      else report.parsed += 1;
      report.renamed += r.renamed;
      if (r.retryNames.length > 0 && r.extracted) {
        retryByFile.set(file.relPath, { file, names: r.retryNames, extracted: r.extracted });
      }
      if (r.fileFactId) targetManifest.set(file.relPath, r.fileFactId);
      for (const ep of r.endpoints) {
        endpointsFound += 1;
        emit?.({ phase: "discovery", kind: "endpoint", title: ep.key, file: file.relPath });
      }
      if (done % metricEvery === 0) {
        parseStepStartedAt = performance.now();
        emitMetric();
        addParseDuration(report.timings.parse, "metricsMs", parseStepStartedAt);
      }
    }

    // ── Second resolution pass. Single-pass resolution sees only symbols
    // indexed BEFORE the current file, so forward references (a file calling a
    // symbol whose defining file walks later) drop silently — a fresh rebuild
    // under-links massively vs a converged incremental DB (audit measured
    // −25% calls / −42% references fleet-wide). Re-index exactly the files
    // whose zero-candidate names NOW exist in the completed symbol table.
    // replaceFileEdges is wipe-then-recreate per file, so the redo is
    // idempotent; the frontend call scan below runs after this and already
    // treats these files as reprocessed.
    let reResolved = 0;
    if (retryByFile.size > 0) {
      for (const { file, extracted } of retryByFile.values()) {
        let source: string;
        try {
          source = readFileSync(file.absPath, "utf8");
        } catch { continue; }
        const r2 = await indexFileWithSource(store, {
          repoId, branchId, commit: commitForFile(file.relPath), relPath: file.relPath,
          absPath: file.absPath, rootPath: scanRoot,
          source, contentHash: sha256(source), mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes,
          recordRenames: effectiveMode !== "rebuild",
          snapshotId: snapshot.id,
          timings: report.timings.parse,
          pass: "second",
          preExtracted: extracted,
        });
        report.timings.parse.secondPasses += 1;
        if (!r2.error) reResolved += 1;
        if (!r2.error && r2.fileFactId) targetManifest.set(file.relPath, r2.fileFactId);
      }
    }
    stageDone(
      "parse",
      `${report.parsed} parsed · ${report.skipped} unchanged` +
        (reResolved > 0 ? ` · ${reResolved} re-linked` : ""),
    );

    // delete detection: checkpoints present but file gone from disk (§6.3.1)
    stageStart("deletes");
    for (const cp of store.listFileCheckpoints(repoId, branchId)) {
      if (seen.has(cp.file_path) || cp.status === "deleted") continue;
      store.markFileDeleted({ repoId, branchId, filePath: cp.file_path });
      store.markFileSymbolsStale({ branchId, filePath: cp.file_path });
      store.replaceFileEdges({ repoId, branchId, filePath: cp.file_path, edges: [] });
      store.clearLogSitesForFile(repoId, cp.file_path);
      const staleNodeIds = store.db
        .prepare("SELECT node_id FROM symbol_versions WHERE branch_id=? AND file_path=?")
        .all(branchId, cp.file_path) as Array<{ node_id: string }>;
      for (const row of staleNodeIds) store.deleteSymbolText(row.node_id);
      report.deleted += 1;
    }
    for (const path of [...targetManifest.keys()]) {
      if (!seen.has(path)) targetManifest.delete(path);
    }
    for (const path of [...targetSourceManifest.keys()]) {
      if (!seen.has(path)) targetSourceManifest.delete(path);
    }
    const cowOverlayEntries: SnapshotOverlayEntry[] = [];
    for (const [path, fileFactId] of targetManifest) {
      const baseFactId = baseManifest.get(path);
      if (!baseFactId) cowOverlayEntries.push({ op: "add", path, fileFactId });
      else if (baseFactId !== fileFactId) cowOverlayEntries.push({ op: "modify", path, fileFactId });
    }
    for (const path of baseManifest.keys()) {
      if (!targetManifest.has(path)) cowOverlayEntries.push({ op: "delete", path, fileFactId: null });
    }
    if (!snapshotAlreadyReady) {
      factStore.replaceOverlay(snapshot.id, cowOverlayEntries);
      factStore.materializeManifest(snapshot.id);
      factStore.assertManifestMatches(snapshot.id, targetManifest);
      const sourceOverlayEntries: SourceSnapshotOverlayEntry[] = [];
      for (const [path, sourceFactId] of targetSourceManifest) {
        const baseFactId = baseSourceManifest.get(path);
        if (!baseFactId) sourceOverlayEntries.push({ op: "add", path, sourceFactId });
        else if (baseFactId !== sourceFactId) sourceOverlayEntries.push({ op: "modify", path, sourceFactId });
      }
      for (const path of baseSourceManifest.keys()) {
        if (!targetSourceManifest.has(path)) sourceOverlayEntries.push({ op: "delete", path, sourceFactId: null });
      }
      sourceCow.replaceOverlay(snapshot.id, sourceOverlayEntries);
      sourceCow.materializeManifest(snapshot.id);
      sourceCow.assertManifestMatches(snapshot.id, targetSourceManifest);
    }
    stageDone("deletes", report.deleted > 0 ? `${report.deleted} removed` : undefined);
    stageStart("proto");

    // ── Proto file processing: extract gRPC service/method definitions from .proto
    // files and create endpoint + service nodes with handles edges. This powers the
    // service graph for repos that have proto definitions (e.g. flyover proto monorepo,
    // FPMS's @snsoft/*-grpc packages in node_modules).
    const protoModules = new Set<string>();
    for (const admittedFile of files) {
      if (!admittedFile.relPath.endsWith(".proto")) continue;
      const file = { relPath: admittedFile.relPath, absPath: admittedFile.absPath };
      let protoSource: string;
      try {
        protoSource = readFileSync(file.absPath, "utf8");
      } catch { continue; }
      const eps = parseProtoEndpoints(protoSource, file.relPath);
      if (eps.length === 0) continue;

      for (const ep of eps) protoModules.add(ep.module);

      const tx = store.db.transaction(() => {
        const svcId = store.upsertNode({
          nodeType: "service",
          identityKey: `grpc-module::${repoId}::${eps[0].module}`,
          repoId,
          title: eps[0].module,
          meta: { module: eps[0].module },
        });

        const edges: ParsedEdge[] = [];
        for (const ep of eps) {
          const endpointId = store.upsertNode({
            nodeType: "endpoint",
            identityKey: grpcEndpointKey(ep.service, ep.method),
            repoId: null,
            title: `${ep.service}.${ep.method}`,
            meta: { protocol: "grpc", service: ep.service, method: ep.method, source: ep.filePath },
          });
          edges.push({
            src: endpointId, dst: svcId,
            edgeType: "handles", origin: "parser", method: "EXTRACTED", branchless: true,
          });
        }
        store.replaceFileEdges({
          repoId, branchId, filePath: file.relPath, edges,
        });
      });
      tx();
      endpointsFound += eps.length;
      emit?.({
        phase: "discovery", kind: "service",
        title: `gRPC ${eps[0].module} (${eps.length} rpc${eps.length === 1 ? "" : "s"})`,
        file: file.relPath,
      });
    }
    stageDone("proto");
    stageStart("link");

    // ── Zero-config frontend→backend gRPC-web linking (no per-repo config
    // file anywhere — see frontend-grpc-client.ts). Runs UNCONDITIONALLY on
    // every repo. Two always-fresh whole-repo scans, same rationale as the
    // proto pass above (independent of the incremental per-file skip: a
    // wrapper class and its call site can live in files that are
    // individually checkpoint-skipped on a given run):
    //
    //   1. verifiedMethods = union of allForwardingMethods() (ANY static
    //      class method that is a SOLE forward to `this._net.<sameName>`)
    //      across every ts/tsx file. Backend repos have no such classes →
    //      empty set → the call-scan below is skipped entirely → 0 edges,
    //      safe to run on every repo.
    //   2. every `functionName: '<literal>'` call site (dispatcher-agnostic
    //      — any call shape) whose literal IS in verifiedMethods, attributed
    //      to its enclosing symbol's node id via a DB lookup against
    //      symbol_versions (works even for checkpoint-skipped files: their
    //      fresh rows persist unchanged from a prior run).
    //
    // Cheap substring pre-filters (`this._net` / `functionName`) keep tree-
    // sitter parsing bounded to files that could possibly match.
    const tsxFiles = files.map((file) => ({ relPath: file.relPath, absPath: file.absPath })).filter((f) => {
      const l = langForExtension(f.relPath);
      return l === "ts" || l === "tsx";
    });

    const verifiedMethods = new Set<string>();
    for (const file of tsxFiles) {
      let wSource: string;
      try {
        wSource = readFileSync(file.absPath, "utf8");
      } catch { continue; }
      if (!wSource.includes("this._net")) continue;
      const wLang = langForExtension(file.relPath) as "ts" | "tsx";
      try {
        const methods = await withParsedTree(wLang, wSource, allForwardingMethods, new Set<string>());
        for (const m of methods) verifiedMethods.add(m);
      } catch { continue; }
    }

    // Same whole-repo-every-run treatment for the @connectrpc/connect
    // convention (see connect-rpc-client.ts) — a 4th frontend calling shape,
    // independent of the `this._net` wrapper pattern above. Backend repos
    // have no createClient()-backed getters → empty set → the call-site scan
    // below is skipped entirely, same safety property as verifiedMethods.
    const verifiedGetters = new Set<string>();
    for (const file of tsxFiles) {
      let wSource: string;
      try {
        wSource = readFileSync(file.absPath, "utf8");
      } catch { continue; }
      if (!wSource.includes("createClient")) continue;
      const wLang = langForExtension(file.relPath) as "ts" | "tsx";
      try {
        const getters = await withParsedTree(wLang, wSource, verifiedConnectRpcGetters, new Set<string>());
        for (const m of getters) verifiedGetters.add(m);
      } catch { continue; }
    }

    // Call-site scan+enqueue is scoped to files REPROCESSED this run (unlike
    // verifiedMethods above, which must stay whole-repo for correctness — see
    // the reprocessedFiles comment above). This is required for idempotency,
    // not just an optimization: a reprocessed file's OWN replaceFileEdges()
    // call (inside indexFileWithSource, earlier in this same run) already
    // wiped any frontend `invokes` edge previously attributed to it (parser
    // edges are provenanced by file and fully replaced on reprocess), so
    // enqueue+replay here is a wipe-then-recreate. An UNCHANGED file's edges
    // were never wiped this run, so re-enqueuing it would make
    // replayPendingFrontendEdges() insert a SECOND, duplicate edge (it has no
    // (src,dst) existence check). clear-then-insert (rather than insert-only)
    // also prevents duplicate pending rows from accumulating across repeated
    // re-parses of the same frontend file before its backend endpoint shows
    // up, and correctly purges a call site that was removed/renamed away.
    const callScanFiles = tsxFiles.filter((f) => reprocessedFiles.has(f.relPath));
    for (const file of callScanFiles) {
      store.clearPendingFrontendEdgesForFile(repoId, file.relPath);
    }
    if (verifiedMethods.size > 0) {
      for (const file of callScanFiles) {
        let wSource: string;
        try {
          wSource = readFileSync(file.absPath, "utf8");
        } catch { continue; }
        if (!wSource.includes("functionName")) continue;
        const wLang = langForExtension(file.relPath) as "ts" | "tsx";
        try {
          const calls = await withParsedTree(
            wLang,
            wSource,
            (root) => extractFunctionNameCalls(root, verifiedMethods),
            [],
          );
          for (const call of calls) {
            const srcNodeId = enclosingSymbolNodeId(store, branchId, file.relPath, call.startLine);
            if (!srcNodeId) continue; // no symbol wraps this call site
            // Only-correct guarantee: link ONLY when EXACTLY ONE gRPC service
            // defines this method; 0 → deferred (service="", re-resolved on a
            // later replayPendingFrontendEdges()); >1 → skip, never link.
            const services = store.findEndpointServicesByMethod(call.functionName.toLowerCase());
            if (services.length > 1) continue;
            store.enqueuePendingFrontendEdge({
              repoId, filePath: file.relPath, srcNodeId,
              service: services.length === 1 ? services[0] : "",
              functionName: call.functionName, sourceType: "frontend_web",
            });
          }
        } catch { continue; }
      }
    }
    if (verifiedGetters.size > 0) {
      for (const file of callScanFiles) {
        let wSource: string;
        try {
          wSource = readFileSync(file.absPath, "utf8");
        } catch { continue; }
        const wLang = langForExtension(file.relPath) as "ts" | "tsx";
        try {
          const calls = await withParsedTree(
            wLang,
            wSource,
            (root) => extractConnectRpcCalls(root, verifiedGetters),
            [],
          );
          for (const call of calls) {
            const srcNodeId = enclosingSymbolNodeId(store, branchId, file.relPath, call.startLine);
            if (!srcNodeId) continue; // no symbol wraps this call site
            // Same only-correct guarantee as the functionName pattern above.
            const services = store.findEndpointServicesByMethod(call.functionName.toLowerCase());
            if (services.length > 1) continue;
            store.enqueuePendingFrontendEdge({
              repoId, filePath: file.relPath, srcNodeId,
              service: services.length === 1 ? services[0] : "",
              functionName: call.functionName, sourceType: "frontend_web",
            });
          }
        } catch { continue; }
      }
    }
    // Unconditional: also replays pending rows left by OTHER repos (e.g. this
    // repo's own proto pass just created the endpoint a prior frontend repo's
    // pending row was waiting on) even when THIS repo has no frontend calls.
    const replayed = store.replayPendingFrontendEdges();
    if (replayed > 0) {
      emit?.({
        phase: "discovery", kind: "link",
        title: `${replayed} frontend call${replayed === 1 ? "" : "s"} linked to backend endpoints`,
      });
    }
    stageDone("link");
    stageStart("packages");

    // ── Package dependency detection: npm package ↔ repo mapping for the
    // cross-repo service graph. Package metadata comes from committed manifest
    // and optional lockfile files; it never requires target-repo node_modules.
    const pkg = detectPackages(scanRoot, repoId);
    if (pkg) {
      const extraMappings: Array<{ name: string; repoId: string }> = [];
      if (protoModules.size > 0) {
        for (const n of flyoverPackageNames([...protoModules])) {
          extraMappings.push({ name: n, repoId });
        }
      }

      const allPkgs: Array<{ name: string; repoId: string }> = [];
      if (pkg.name) allPkgs.push({ name: pkg.name, repoId: pkg.repoId });
      for (const sub of pkg.subPackages ?? []) {
        if (sub.name) allPkgs.push({ name: sub.name, repoId: sub.repoId });
      }
      for (const e of extraMappings) {
        if (!allPkgs.some((a) => a.name === e.name)) allPkgs.push(e);
      }

      const publishedRepoIds = new Map(allPkgs.map((item) => [item.name, item.repoId]));
      const dependencyEdges = [
        ...pkg.dependencyEdges,
        ...(pkg.subPackages ?? []).flatMap((sub) => sub.dependencyEdges),
      ];

      if (allPkgs.length > 0 || dependencyEdges.length > 0) {
        const tx = store.db.transaction(() => {
          const packageNodes = new Map<string, string>();
          const ensurePackageNode = (name: string): string => {
            const existing = packageNodes.get(name);
            if (existing) return existing;
            store.upsertNode({
              nodeType: "service",
              identityKey: `npm-package::${name}`,
              repoId: publishedRepoIds.get(name) ?? null,
              title: name,
              meta: { package: name },
            });
            const node = store.db.prepare(
              "SELECT id FROM nodes WHERE identity_key = ? LIMIT 1",
            ).get(`npm-package::${name}`) as { id: string };
            packageNodes.set(name, node.id);
            return node.id;
          };

          for (const api of allPkgs) ensurePackageNode(api.name);

          const uniqueEdges = new Map<string, (typeof dependencyEdges)[number]>();
          for (const edge of dependencyEdges) {
            uniqueEdges.set(
              `${edge.from}\0${edge.to}\0${edge.resolvedVersion ?? ""}`,
              edge,
            );
          }

          const dt: ParsedEdge[] = [];
          for (const edge of uniqueEdges.values()) {
            const srcId = ensurePackageNode(edge.from);
            const dstId = ensurePackageNode(edge.to);
            dt.push({
              src: srcId, dst: dstId,
              edgeType: "depends_on",
              origin: "parser", method: "EXTRACTED",
              provenance: {
                source: edge.source,
                scope: edge.scope,
                specifier: edge.specifier,
                resolvedVersion: edge.resolvedVersion ?? null,
              },
            });
          }
          if (dt.length > 0) {
            store.replaceFileEdges({
              repoId, branchId, filePath: "~package.json", edges: dt,
            });
          }
        });
        tx();
      }
    }

    stageDone("packages");

    // git topology (commits/tags) into the graph — on-demand, bounded (§11).
    stageStart("git");
    const gitGraph = indexGitObjects({ store, rootPath });
    report.commits = gitGraph.commits;
    report.tags = gitGraph.tags;
    stageDone("git", gitGraph.commits > 0 ? `${gitGraph.commits} commits` : undefined);
    emitMetric();

    store.recordBranchIndexed({
      branchId,
      commit: report.indexedCommit,
      worktreeState: report.worktreeState,
      worktreeFingerprint: report.worktreeFingerprint,
      dirtyFiles: report.dirtyFiles,
      parserVersion: report.parserVersion,
      schemaVersion: report.schemaVersion,
      staleReason: report.staleReason,
    });
    if (!snapshotAlreadyReady) topology.markSnapshotReady(snapshot.id);
    topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: git.commit });
    snapshotPublished = true;
    // Success: NOW the branch is trustworthy — promote it to live and flip the
    // previously-indexed branch of THIS checkout to snapshot (design review
    // Q5 + validation V1: neither may happen on a failed run).
    store.setBranchStatus(branchId, "live");
    store.demoteSiblingBranches({ repoId, keepBranchId: branchId, checkoutPath: git.checkoutPath });
    if (git.isGit && git.branch !== "(detached)" && !store.getDefaultBranch(repoId)) {
      try { store.setDefaultBranch(repoId, branchId); } catch (error) {
        // Another successful first index may have elected the master between
        // the check and this transaction. The unique index makes that race
        // safe; preserve the already-published branch rather than failing it.
        if (!String((error as Error).message ?? error).match(/UNIQUE|constraint|busy/i)) throw error;
      }
    }
    if (rebuildTransactionOpen) {
      store.db.exec("COMMIT");
      rebuildTransactionOpen = false;
    }
    const rebuildHotIndexes = [
      "idx_edges_parser_branch_file",
      "idx_edges_parser_global_repo_file",
      "idx_symbol_versions_branch_file_status",
      "idx_nodes_log_site_repo_file",
      "idx_fts_symbol_rows_node",
      "idx_fts_identifier_rows_scope",
    ];
    const hasStatistics = store.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='sqlite_stat1'",
    ).get() != null;
    const existingStatistics = new Set(
      hasStatistics
        ? (store.db.prepare("SELECT idx FROM sqlite_stat1 WHERE idx IS NOT NULL").all() as Array<{ idx: string }>)
            .map(({ idx }) => idx)
        : [],
    );
    report.maintenance.analyzedIndexes = rebuildHotIndexes.filter(
      (indexName) => !existingStatistics.has(indexName),
    );
    let maintenanceStartedAt = performance.now();
    for (const indexName of report.maintenance.analyzedIndexes) {
      store.db.exec(`ANALYZE ${indexName}`);
    }
    report.maintenance.analyzeMs = performance.now() - maintenanceStartedAt;
    maintenanceStartedAt = performance.now();
    store.db.pragma("optimize");
    report.maintenance.optimizeMs = performance.now() - maintenanceStartedAt;
    maintenanceStartedAt = performance.now();
    const previousBusyTimeout = Number(store.db.pragma("busy_timeout", { simple: true }));
    let checkpoint = { busy: 0, log: 0, checkpointed: 0 };
    try {
      // A long-lived MCP reader can prevent TRUNCATE. Bound each wait so index
      // completion never stalls for the normal 5s busy timeout three times,
      // but retry transient readers before returning an observable warning.
      store.db.pragma("busy_timeout = 250");
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        report.maintenance.checkpointAttempts = attempt;
        const rows = store.db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
          busy: number;
          log: number;
          checkpointed: number;
        }>;
        checkpoint = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 };
        if (checkpoint.busy === 0) break;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    } finally {
      store.db.pragma(`busy_timeout = ${previousBusyTimeout}`);
    }
    report.maintenance.checkpointMs = performance.now() - maintenanceStartedAt;
    report.maintenance.checkpoint = checkpoint;
    if (checkpoint.busy > 0) {
      report.maintenance.checkpointWarning =
        `WAL_CHECKPOINT_BUSY after ${report.maintenance.checkpointAttempts} attempts; ` +
        `${checkpoint.log - checkpoint.checkpointed} WAL frame(s) remain`;
    }
    report.timings.totalMs = Date.now() - runStartedAt;
    return report;
  } catch (error) {
    if (rebuildTransactionOpen && store.db.inTransaction) {
      store.db.exec("ROLLBACK");
      rebuildTransactionOpen = false;
    }
    if (!snapshotPublished) {
      try { topology.markSnapshotFailed(snapshot.id, String((error as Error).message ?? error)); } catch { /* preserve original indexing error */ }
    }
    throw error;
  } finally {
    store.db.pragma(`wal_autocheckpoint = ${previousWalAutoCheckpoint}`);
    store.db.pragma(`cache_size = ${previousCacheSize}`);
    store.db.pragma(`mmap_size = ${previousMmapSize}`);
    store.releaseIndexMarker(branchId);
    lock.release();
  }
}

// Startup reconciliation = an incremental pass that catches app-off changes (§6.3).
export function reconcileOnStartup(input: {
  store: KnowledgeStore;
  rootPath: string;
}): Promise<IndexReport> {
  return indexRepo({ ...input, mode: "incremental" });
}
