import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve as pathResolve } from "node:path";
import type { KnowledgeStore, ParsedEdge } from "@penguin/knowledge-core";
import { extractSymbols, type ExtractedSymbol } from "./extract.js";
import { grpcEndpointKey } from "./grpc-client.js";
import { loadFrontendGrpcConfig, type FrontendGrpcConfig } from "./frontend-grpc-config.js";
import { verifiedForwardingMethods } from "./frontend-grpc-client.js";
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

// One frontend gRPC-web call site with its src symbol resolved to a node id
// (collected during the per-file loop; gated + stitched into `invokes` edges
// AFTER the whole repo is walked, since wrapper verification can live in a
// different file than the call site — see indexRepo).
interface CollectedFrontendCall {
  src: string;
  service: string;
  functionName: string;
  filePath: string;
  // Native method-name uniqueness mode (see frontend-grpc-config.ts):
  // `service` is empty and the stitch below must resolve the ONE candidate
  // backend service by method name instead of the usual exact enum→service
  // gate.
  resolveByMethod?: boolean;
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
    frontendGrpcConfig?: FrontendGrpcConfig;
  },
): Promise<{
  error: string | null;
  renamed: number;
  frontendCalls: CollectedFrontendCall[];
}> {
  const lang = langForExtension(p.relPath);
  // Skip non-source files AND minified/generated bundles that slipped past the
  // name filter — parsing them yields single-letter symbols that dominate hubs.
  if (!lang || isLikelyMinified(p.source)) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash, status: "skipped",
    });
    return { error: null, renamed: 0, frontendCalls: [] };
  }

  const extracted = await extractSymbols({
    lang, source: p.source, relPath: p.relPath, frontendGrpcConfig: p.frontendGrpcConfig,
  });
  if (extracted.parseError) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, lang,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash,
      status: "error", error: extracted.parseError,
    });
    return { error: extracted.parseError, renamed: 0, frontendCalls: [] };
  }

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
        // Match the function name to an extracted symbol (e.g. "AdminUnlockPlayer"
        // → qualifiedName "fpmsNTApi.AdminUnlockPlayer").
        const matching = extracted.symbols.find((s) =>
          s.qualifiedName === jc.functionName || s.qualifiedName.endsWith(`.${jc.functionName}`)
        );
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

    // 6. frontend gRPC-web call sites (collected, NOT stitched here — the
    // wrapper-verification gate needs whole-repo data: a wrapper class and a
    // call site may live in different files, so indexRepo stitches after the
    // full per-file loop, using a dedicated always-fresh wrapper scan — see
    // indexRepo). Only the src symbol is resolvable at this scope.
    const frontendCalls: CollectedFrontendCall[] = [];
    for (const fc of extracted.frontendGrpcCalls) {
      if (!fc.enclosingQualifiedName) continue;
      const src = fileSymbolIds.get(fc.enclosingQualifiedName);
      if (src) {
        frontendCalls.push({
          src, service: fc.service, functionName: fc.functionName, filePath: p.relPath,
          resolveByMethod: fc.resolveByMethod,
        });
      }
    }

    return { fileSymbolIds, frontendCalls };
  });

  const { fileSymbolIds, frontendCalls } = tx();

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

  return { error: null, renamed, frontendCalls };
}

// Index a whole repo (headless). incremental uses the files_index quick filter;
// rebuild clears the branch's checkpoints so every file re-parses (§8.3).
export async function indexRepo(input: {
  store: KnowledgeStore;
  rootPath: string;
  mode: "incremental" | "rebuild";
  // Progress callback: phase "scan" fires once after the walk with the total
  // file count; phase "index" fires per file with done/total for a % bar.
  onProgress?: (p: { phase: "scan" | "index"; done: number; total: number; file: string }) => void;
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
  const branchId = store.registerBranch({
    repoId, name: git.branch, headCommit: git.commit, checkoutPath: git.checkoutPath, status: "live",
  });

  const lockKey = `${repoId}:${branchId}:${git.checkoutPath}`;
  const lock = IndexTaskLock.tryAcquire(lockKey);
  if (!lock) {
    throw new Error(`index task already running for ${git.branch}`);
  }

  const report: IndexReport = {
    repoId, branchId, branchName: git.branch, commit: git.commit,
    scanned: 0, parsed: 0, skipped: 0, deleted: 0, errors: 0, renamed: 0,
    commits: 0, tags: 0,
  };

  try {
    if (mode === "rebuild") {
      store.db.prepare("DELETE FROM files_index WHERE repo_id=? AND branch_id=?").run(repoId, branchId);
    }

    // Collect the file list first so progress has a total for a % bar.
    const files = [...walkRepoFiles(scanRoot)];
    input.onProgress?.({ phase: "scan", done: 0, total: files.length, file: "" });

    // Frontend gRPC-web wiring (§Task 6): per-repo config, plus whole-repo
    // accumulators. A wrapper class and its call sites can live in different
    // files, so these collect across the ENTIRE per-file loop below and are
    // only gated/stitched into edges once the loop (and the proto pass, which
    // may create this repo's own endpoints) has finished.
    const frontendGrpcConfig = loadFrontendGrpcConfig(scanRoot) ?? undefined;
    const frontendCalls: CollectedFrontendCall[] = [];
    const verifiedMethodsByService: Record<string, Set<string>> = {};
    // Files actually reprocessed this run (indexFileWithSource invoked, i.e.
    // NOT checkpoint-skipped) — a superset of frontendCalls' file paths. Used
    // to clear stale pending rows even when a file's call sites were REMOVED
    // (so frontendCalls no longer mentions it) rather than merely re-gated.
    const reprocessedFiles = new Set<string>();

    const seen = new Set<string>();
    let done = 0;
    for (const file of files) {
      report.scanned += 1;
      seen.add(file.relPath);
      done += 1;
      input.onProgress?.({ phase: "index", done, total: files.length, file: file.relPath });
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
        frontendGrpcConfig,
      });
      if (r.error) report.errors += 1;
      else report.parsed += 1;
      report.renamed += r.renamed;
      frontendCalls.push(...r.frontendCalls);
    }

    // delete detection: checkpoints present but file gone from disk (§6.3.1)
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
    }

    // ── Wrapper verification: ALWAYS scanned fresh across the whole repo,
    // independent of the incremental per-file skip above (same reasoning as
    // the proto pass re-walking every .proto file every run, right above).
    // Rationale: verifiedMethodsByService gates the frontend stitch below; if
    // it were only populated from files actually reprocessed THIS run, then
    // any incremental run where a call-site file changes but its (unchanged,
    // skipped) wrapper file does not would see an empty/stale gate for that
    // service — wrongly failing verification and, worse, wiping an already-
    // confirmed edge that the reprocessed call-site file's own
    // replaceFileEdges() call just deleted (branch-less cleanup keyed on that
    // file's provenance) without the stitch being able to re-add it. A cheap
    // substring pre-filter keeps this bounded to files that actually mention
    // a configured wrapper class name.
    if (frontendGrpcConfig && Object.keys(frontendGrpcConfig.wrappers).length > 0) {
      const wrapperClassNames = [...new Set(Object.values(frontendGrpcConfig.wrappers))];
      for (const file of walkRepoFiles(scanRoot)) {
        const wLang = langForExtension(file.relPath);
        if (wLang !== "ts" && wLang !== "tsx") continue;
        let wSource: string;
        try {
          wSource = readFileSync(file.absPath, "utf8");
        } catch { continue; }
        const mentioned = wrapperClassNames.filter((c) => wSource.includes(c));
        if (mentioned.length === 0) continue;
        let tree;
        try {
          const parser = await loadParser(wLang);
          tree = parser.parse(wSource);
        } catch { continue; }
        if (!tree) continue;
        for (const [service, cls] of Object.entries(frontendGrpcConfig.wrappers)) {
          if (!mentioned.includes(cls)) continue;
          const verified = verifiedForwardingMethods(tree.rootNode, cls);
          if (verified.size === 0) continue;
          const set = (verifiedMethodsByService[service] ??= new Set<string>());
          for (const m of verified) set.add(m);
        }
      }
    }

    // ── Native method-name uniqueness mode: ALSO scanned fresh across the
    // whole repo (same rationale as the wrapper-verification pass above).
    // Facade wrappers (e.g. casino-plus-app PromotionService) have methods
    // spanning MULTIPLE backend proto services, so there is no per-service
    // wrapper class to key off — instead every configured uniqueness wrapper
    // class's sole-forward static methods are unioned into ONE flat set,
    // gating the method-name-resolution stitch branch below.
    const verifiedUniquenessMethods = new Set<string>();
    const uniquenessWrapperNames = [...new Set(frontendGrpcConfig?.methodNameResolution?.wrappers ?? [])];
    if (uniquenessWrapperNames.length > 0) {
      for (const file of walkRepoFiles(scanRoot)) {
        const wLang = langForExtension(file.relPath);
        if (wLang !== "ts" && wLang !== "tsx") continue;
        let wSource: string;
        try {
          wSource = readFileSync(file.absPath, "utf8");
        } catch { continue; }
        const mentioned = uniquenessWrapperNames.filter((c) => wSource.includes(c));
        if (mentioned.length === 0) continue;
        let tree;
        try {
          const parser = await loadParser(wLang);
          tree = parser.parse(wSource);
        } catch { continue; }
        if (!tree) continue;
        for (const cls of mentioned) {
          const verified = verifiedForwardingMethods(tree.rootNode, cls);
          for (const m of verified) verifiedUniquenessMethods.add(m);
        }
      }
    }

    // ── Frontend gRPC-web stitch: confirmed-only invokes edges + deferred
    // re-stitch (§Task 6). Runs after the proto pass above so THIS repo's own
    // endpoints already exist.
    //
    // Deliberately does NOT call store.replaceFileEdges() again for a frontend
    // file: each file's OTHER edges (defines/imports/calls/...) were already
    // committed by exactly one replaceFileEdges() call inside the per-file
    // loop above, and replaceFileEdges() REPLACES ALL parser edges for that
    // (repo, file) — a second call here would wipe them. Instead every gated
    // call funnels through the pending-edge queue: enqueue (never replaces
    // existing edges), then replayPendingFrontendEdges() converts any row
    // whose endpoint already exists into a real `invokes` edge immediately —
    // giving the same "endpoint exists → edge emitted now" outcome without
    // ever touching the edges this file's own replaceFileEdges() call owns.
    //
    // clear-then-insert per file (rather than insert-only) prevents duplicate
    // pending rows from accumulating across repeated re-parses of the same
    // frontend file before its backend endpoint shows up (Task 5 review
    // carry-in). The pending row is keyed on the FRONTEND file's own
    // (repoId, filePath) — not the backend's — so that file's own
    // replaceFileEdges() call correctly purges the replayed branch-less edge
    // on the next re-index (provenance.repo/provenance.file match).
    //
    // Cleared for every REPROCESSED file (not just files with frontendCalls
    // this run): a file whose call site was removed/refactored away still
    // needs its stale pending row purged, or a since-deleted call would
    // wrongly materialize into an edge once the endpoint later appears.
    for (const filePath of reprocessedFiles) {
      store.clearPendingFrontendEdgesForFile(repoId, filePath);
    }
    for (const fc of frontendCalls) {
      if (fc.resolveByMethod) {
        // Uniqueness branch: no single service for this call site — verify
        // the facade wrapper forwards this method 1:1, then link ONLY if
        // exactly one backend service defines it (skip ambiguous/missing —
        // only-correct edges).
        if (!verifiedUniquenessMethods.has(fc.functionName)) continue; // not a verified forwarding method
        const services = store.findEndpointServicesByMethod(fc.functionName.toLowerCase());
        if (services.length !== 1) continue; // 0 (missing) or >1 (ambiguous) → no edge
        store.enqueuePendingFrontendEdge({
          repoId, filePath: fc.filePath, srcNodeId: fc.src,
          service: services[0], functionName: fc.functionName, sourceType: "frontend_web",
        });
        continue;
      }
      if (!verifiedMethodsByService[fc.service]?.has(fc.functionName)) continue; // wrapper gate
      store.enqueuePendingFrontendEdge({
        repoId, filePath: fc.filePath, srcNodeId: fc.src,
        service: fc.service, functionName: fc.functionName, sourceType: "frontend_web",
      });
    }
    // Unconditional: also replays pending rows left by OTHER repos (e.g. this
    // repo's own proto pass just created the endpoint a prior frontend repo's
    // pending row was waiting on) even when THIS repo has no frontend calls.
    store.replayPendingFrontendEdges();

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

    // git topology (commits/tags) into the graph — on-demand, bounded (§11).
    const gitGraph = indexGitObjects({ store, rootPath });
    report.commits = gitGraph.commits;
    report.tags = gitGraph.tags;

    store.recordBranchIndexed({ branchId, commit: git.commit });
    return report;
  } finally {
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
