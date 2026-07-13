import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve as pathResolve } from "node:path";
import type { KnowledgeStore, ParsedEdge } from "@penguin/knowledge-core";
import { extractSymbols, type ExtractedSymbol } from "./extract.js";
import { grpcEndpointKey } from "./grpc-client.js";
import { allForwardingMethods, extractFunctionNameCalls } from "./frontend-grpc-client.js";
import { loadParser } from "./parser.js";
import { readGitContext } from "./git.js";
import { indexGitObjects } from "./gitgraph.js";
import { langForExtension } from "./registry.js";
import { detectRenames } from "./rename.js";
import { resolveRefs, type SymbolIndex } from "./resolve.js";
import { walkRepoFiles, isLikelyMinified } from "./walk.js";
import { parseProtoEndpoints } from "./proto-parser.js";
import { extractFpmsGrpcCalls } from "./grpc-js-client.js";
import { detectPackages, flyoverPackageNames } from "./package-detect.js";

export interface IndexReport {
  repoId: string;
  branchId: string;
  branchName: string;
  commit: string | null;
  scanned: number;
  parsed: number;
  skipped: number;
  deleted: number;
  errors: number;
  renamed: number;
  commits: number; // git commit nodes captured
  tags: number; // git tag nodes captured
}

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

function symbolIdentityKey(repoId: string, qualifiedName: string): string {
  return `${repoId}::${qualifiedName}`;
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
  for (const cand of [...IMPORT_EXTS.map((e) => base + e), ...IMPORT_INDEX.map((e) => base + e)]) {
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
      const row = store.db
        .prepare(
          "SELECT id FROM nodes WHERE node_type='symbol' AND repo_id=? AND identity_key=?",
        )
        .get(repoId, symbolIdentityKey(repoId, qn)) as { id: string } | undefined;
      return row?.id ?? null;
    },
    bareNameCandidates: (bare) => {
      const rows = store.db
        .prepare(
          `SELECT n.id AS id,
                  (SELECT sv.file_path FROM symbol_versions sv
                     WHERE sv.node_id = n.id AND sv.status='fresh' LIMIT 1) AS filePath
           FROM nodes n
           WHERE n.node_type='symbol' AND n.repo_id=?
             AND (n.identity_key = ? OR n.identity_key LIKE ? OR n.identity_key LIKE ?)`,
        )
        .all(repoId, symbolIdentityKey(repoId, bare), `%::${bare}`, `%.${bare}`) as Array<{
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
      `SELECT n.identity_key AS ik, sv.content_hash AS hash, sv.kind AS kind
       FROM symbol_versions sv JOIN nodes n ON n.id = sv.node_id
       WHERE sv.branch_id=? AND sv.file_path=? AND sv.status='fresh'`,
    )
    .all(branchId, filePath) as Array<{ ik: string; hash: string; kind: string }>;
  const prefix = `${repoId}::`;
  return rows.map((r) => ({
    qualifiedName: r.ik.startsWith(prefix) ? r.ik.slice(prefix.length) : r.ik,
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
}> {
  const lang = langForExtension(p.relPath);
  // Skip non-source files AND minified/generated bundles that slipped past the
  // name filter — parsing them yields single-letter symbols that dominate hubs.
  if (!lang || isLikelyMinified(p.source)) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash, status: "skipped",
    });
    return { error: null, renamed: 0, endpoints: [], retryNames: [] };
  }

  const extracted = await extractSymbols({ lang, source: p.source, relPath: p.relPath });
  if (extracted.parseError) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, lang,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash,
      status: "error", error: extracted.parseError,
    });
    return { error: extracted.parseError, renamed: 0, endpoints: [], retryNames: [] };
  }
  // Hoisted out of the write-transaction closure below so the return can see it.
  let retryNames: string[] = [];

  // Rename detection BEFORE the rebuildable txn — aliases go to the Ledger (§2.2.4).
  const prior = priorSymbols(store, p.repoId, p.branchId, p.relPath);
  const priorKeys = new Set(prior.map((s) => s.qualifiedName));
  const nowKeys = new Set(extracted.symbols.map((s) => s.qualifiedName));
  const disappeared = prior.filter((s) => !nowKeys.has(s.qualifiedName));
  const appeared = extracted.symbols.filter((s) => !priorKeys.has(s.qualifiedName));
  const renames = detectRenames({ disappeared, appeared });
  // Ambiguous same-body moves go to a confirmation queue (Ledger), never
  // auto-applied (§11 相似度检测进确认队列).
  for (const s of renames.suggested) {
    store.recordKnowledge({
      type: "rename_suggested",
      origin: "system",
      method: "INFERRED",
      actor: { type: "system", id: "knowledge-indexer" },
      payload: { old_key: symbolIdentityKey(p.repoId, s.oldKey), candidate_keys: s.candidateKeys.map((k) => symbolIdentityKey(p.repoId, k)) },
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
        identityKey: symbolIdentityKey(p.repoId, sym.qualifiedName),
        repoId: p.repoId,
        title: sym.name,
        meta: { kind: sym.kind, qualifiedName: sym.qualifiedName },
      });
      fileSymbolIds.set(sym.qualifiedName, nodeId);
    }

    // 2. mark this file's prior versions stale, then upsert fresh versions
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

    // 3. resolve call/type refs → edges (import-scoped), plus structural edges:
    //    file →defines→ symbol, and file →imports→ imported file.
    const resolved = resolveRefs({
      refs: extracted.refs, fileSymbols: extracted.symbols,
      fileSymbolIds, lookup: storeSymbolIndex(store, p.repoId),
      currentFile: p.relPath, importedFiles,
    });
    // Cap: a file with hundreds of external (node_modules/stdlib) misses would
    // otherwise carry a huge retry list for names that never resolve.
    retryNames = [...new Set(resolved.unresolvedNames)].slice(0, 100);
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
      const tested = new Set(resolved.edges.map((e) => e.dst).filter((d): d is string => !!d && !localIds.has(d)));
      for (const dst of tested) {
        structural.push({ src: fileNodeId, dst, edgeType: "tests", origin: "parser", method: "EXTRACTED" });
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
    store.replaceFileEdges({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath,
      edges: [...resolved.edges, ...structural],
    });

    // 4. FTS for each symbol
    for (const sym of extracted.symbols) {
      store.indexSymbolText({
        nodeId: fileSymbolIds.get(sym.qualifiedName)!, name: sym.name, signature: sym.signature,
      });
    }

    // 5. checkpoint
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, lang,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash, status: "indexed",
    });

    return { fileSymbolIds };
  });

  const { fileSymbolIds } = tx();

  // Apply rename aliases now that node ids exist (Ledger-first, outside the txn).
  let renamed = 0;
  for (const ev of renames.auto) {
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
        payload: { alias_key: symbolIdentityKey(p.repoId, ev.aliasKey), alias_type: "qualified_name", reason: "rename" },
      });
      renamed += 1;
    }
  }

  return {
    error: null,
    renamed,
    endpoints: extracted.endpoints.map((e) => ({ key: e.key, protocol: e.protocol })),
    retryNames,
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

// Index a whole repo (headless). incremental uses the files_index quick filter;
// rebuild clears the branch's checkpoints so every file re-parses (§8.3).
export async function indexRepo(input: {
  store: KnowledgeStore;
  rootPath: string;
  mode: "incremental" | "rebuild";
  onProgress?: (p: IndexProgressEvent) => void;
}): Promise<IndexReport> {
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

  const report: IndexReport = {
    repoId, branchId, branchName: git.branch, commit: git.commit,
    scanned: 0, parsed: 0, skipped: 0, deleted: 0, errors: 0, renamed: 0,
    commits: 0, tags: 0,
  };

  const emit = input.onProgress;
  const stageT0 = new Map<IndexStageId, number>();
  const stageStart = (s: IndexStageId) => {
    stageT0.set(s, Date.now());
    emit?.({ phase: "stage", stage: s, state: "start" });
  };
  const stageDone = (s: IndexStageId, detail?: string) => {
    emit?.({
      phase: "stage", stage: s, state: "done", detail,
      elapsedMs: Date.now() - (stageT0.get(s) ?? Date.now()),
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

  try {
    if (mode === "rebuild") {
      store.db.prepare("DELETE FROM files_index WHERE repo_id=? AND branch_id=?").run(repoId, branchId);
    }

    // Collect the file list first so progress has a total for a % bar.
    stageStart("scan");
    const files = [...walkRepoFiles(scanRoot)];
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
    // Files whose refs had zero-candidate (forward-reference) misses in the
    // first pass — retried below once the full symbol table exists.
    const retryByFile = new Map<string, { file: (typeof files)[number]; names: string[] }>();
    const seen = new Set<string>();
    let done = 0;
    for (const file of files) {
      report.scanned += 1;
      seen.add(file.relPath);
      done += 1;
      input.onProgress?.({ phase: "index", done, total: files.length, file: file.relPath, lang: langOf(file.relPath) });
      const prev = store.getFileCheckpoint(repoId, branchId, file.relPath);

      // quick filter: mtime+size unchanged (and not previously errored) → skip
      if (
        mode === "incremental" && prev && prev.status !== "error" &&
        prev.mtime_ms === file.mtimeMs && prev.size_bytes === file.sizeBytes
      ) {
        report.skipped += 1;
        continue;
      }

      const source = readFileSync(file.absPath, "utf8");
      const contentHash = sha256(source);

      // hash unchanged (touch / format-revert) → refresh checkpoint mtime, skip parse
      if (
        mode === "incremental" && prev && prev.status !== "error" &&
        prev.content_hash === contentHash
      ) {
        store.upsertFileCheckpoint({
          repoId, branchId, filePath: file.relPath, lang: prev.lang,
          mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes, contentHash,
          status: prev.status as "indexed" | "deleted" | "error" | "skipped",
        });
        report.skipped += 1;
        continue;
      }

      reprocessedFiles.add(file.relPath);
      const r = await indexFileWithSource(store, {
        repoId, branchId, commit: git.commit, relPath: file.relPath,
        absPath: file.absPath, rootPath: scanRoot,
        source, contentHash, mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes,
      });
      if (r.error) report.errors += 1;
      else report.parsed += 1;
      report.renamed += r.renamed;
      if (r.retryNames.length > 0) retryByFile.set(file.relPath, { file, names: r.retryNames });
      for (const ep of r.endpoints) {
        endpointsFound += 1;
        emit?.({ phase: "discovery", kind: "endpoint", title: ep.key, file: file.relPath });
      }
      if (done % metricEvery === 0) emitMetric();
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
      const idx = storeSymbolIndex(store, repoId);
      for (const { file, names } of retryByFile.values()) {
        if (!names.some((n) => idx.bareNameCandidates(n).length > 0)) continue;
        let source: string;
        try {
          source = readFileSync(file.absPath, "utf8");
        } catch { continue; }
        const r2 = await indexFileWithSource(store, {
          repoId, branchId, commit: git.commit, relPath: file.relPath,
          absPath: file.absPath, rootPath: scanRoot,
          source, contentHash: sha256(source), mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes,
        });
        if (!r2.error) reResolved += 1;
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
      store.db
        .prepare(
          `DELETE FROM fts_symbols WHERE node_id IN (
             SELECT node_id FROM symbol_versions WHERE branch_id=? AND file_path=?
           )`,
        )
        .run(branchId, cp.file_path);
      report.deleted += 1;
    }
    stageDone("deletes", report.deleted > 0 ? `${report.deleted} removed` : undefined);
    stageStart("proto");

    // ── Proto file processing: extract gRPC service/method definitions from .proto
    // files and create endpoint + service nodes with handles edges. This powers the
    // service graph for repos that have proto definitions (e.g. flyover proto monorepo,
    // FPMS's @snsoft/*-grpc packages in node_modules).
    const protoModules = new Set<string>();
    for (const file of walkRepoFiles(scanRoot)) {
      if (!file.relPath.endsWith(".proto")) continue;
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
    const tsxFiles = [...walkRepoFiles(scanRoot)].filter((f) => {
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
      let tree;
      try {
        const parser = await loadParser(wLang);
        tree = parser.parse(wSource);
      } catch { continue; }
      if (!tree) continue;
      for (const m of allForwardingMethods(tree.rootNode)) verifiedMethods.add(m);
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
        let tree;
        try {
          const parser = await loadParser(wLang);
          tree = parser.parse(wSource);
        } catch { continue; }
        if (!tree) continue;
        for (const call of extractFunctionNameCalls(tree.rootNode, verifiedMethods)) {
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
    // cross-repo service graph. Creates service nodes for published packages
    // and depends_on edges for @snsoft-scoped dependencies.
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

      if (allPkgs.length > 0 || pkg.dependencies.length > 0) {
        const tx = store.db.transaction(() => {
          const consumerName = pkg.name || repoId;
          const consumerId = store.upsertNode({
            nodeType: "service",
            identityKey: `npm-package::${consumerName}`,
            repoId,
            title: consumerName,
            meta: { package: consumerName },
          });

          for (const api of allPkgs) {
            store.upsertNode({
              nodeType: "service",
              identityKey: `npm-package::${api.name}`,
              repoId: api.repoId,
              title: api.name,
              meta: { package: api.name },
            });
          }

          const dt: ParsedEdge[] = [];
          for (const dep of pkg.dependencies) {
            const depId = store.upsertNode({
              nodeType: "service",
              identityKey: `npm-package::${dep}`,
              repoId: null,
              title: dep,
              meta: { package: dep },
            });
            dt.push({
              src: consumerId, dst: depId,
              edgeType: "depends_on",
              origin: "parser", method: "EXTRACTED",
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

    store.recordBranchIndexed({ branchId, commit: git.commit });
    // Success: NOW the branch is trustworthy — promote it to live and flip the
    // previously-indexed branch of THIS checkout to snapshot (design review
    // Q5 + validation V1: neither may happen on a failed run).
    store.setBranchStatus(branchId, "live");
    store.demoteSiblingBranches({ repoId, keepBranchId: branchId, checkoutPath: git.checkoutPath });
    return report;
  } finally {
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
