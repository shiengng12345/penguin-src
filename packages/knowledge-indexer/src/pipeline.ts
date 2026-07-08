import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, relative, resolve as pathResolve } from "node:path";
import type { KnowledgeStore, ParsedEdge } from "@penguin/knowledge-core";
import { extractSymbols, type ExtractedSymbol } from "./extract.js";
import { readGitContext } from "./git.js";
import { indexGitObjects } from "./gitgraph.js";
import { langForExtension } from "./registry.js";
import { detectRenames } from "./rename.js";
import { resolveRefs, type SymbolIndex } from "./resolve.js";
import { walkRepoFiles } from "./walk.js";

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
): Promise<{ error: string | null; renamed: number }> {
  const lang = langForExtension(p.relPath);
  if (!lang) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash, status: "skipped",
    });
    return { error: null, renamed: 0 };
  }

  const extracted = await extractSymbols({ lang, source: p.source });
  if (extracted.parseError) {
    store.upsertFileCheckpoint({
      repoId: p.repoId, branchId: p.branchId, filePath: p.relPath, lang,
      mtimeMs: p.mtimeMs, sizeBytes: p.sizeBytes, contentHash: p.contentHash,
      status: "error", error: extracted.parseError,
    });
    return { error: extracted.parseError, renamed: 0 };
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
    // routes (NestJS): a `route` node per HTTP endpoint → its handler method
    // (edge_type 'handles'). Lets AI walk Route → Controller.method → Service…
    for (const route of extracted.routes) {
      const handlerId = fileSymbolIds.get(route.handlerQualifiedName);
      if (!handlerId) continue;
      const routeNodeId = store.upsertNode({
        nodeType: "route",
        identityKey: `${p.repoId}::route::${route.httpMethod} ${route.routePath}`,
        repoId: p.repoId,
        title: `${route.httpMethod} ${route.routePath}`,
        meta: { httpMethod: route.httpMethod, path: route.routePath, controller: route.controllerName },
      });
      structural.push({ src: routeNodeId, dst: handlerId, edgeType: "handles", origin: "parser", method: "EXTRACTED" });
    }
    store.replaceFileEdges({
      branchId: p.branchId, filePath: p.relPath,
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

    return fileSymbolIds;
  });

  const fileSymbolIds = tx();

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

  return { error: null, renamed };
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
  const repoId = store.registerRepo({ name: basename(rootPath), rootPath: git.checkoutPath });
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
    const files = [...walkRepoFiles(rootPath)];
    input.onProgress?.({ phase: "scan", done: 0, total: files.length, file: "" });

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

      const r = await indexFileWithSource(store, {
        repoId, branchId, commit: git.commit, relPath: file.relPath,
        absPath: file.absPath, rootPath,
        source, contentHash, mtimeMs: file.mtimeMs, sizeBytes: file.sizeBytes,
      });
      if (r.error) report.errors += 1;
      else report.parsed += 1;
      report.renamed += r.renamed;
    }

    // delete detection: checkpoints present but file gone from disk (§6.3.1)
    for (const cp of store.listFileCheckpoints(repoId, branchId)) {
      if (seen.has(cp.file_path) || cp.status === "deleted") continue;
      store.markFileDeleted({ repoId, branchId, filePath: cp.file_path });
      store.markFileSymbolsStale({ branchId, filePath: cp.file_path });
      store.replaceFileEdges({ branchId, filePath: cp.file_path, edges: [] });
      store.db
        .prepare(
          `DELETE FROM fts_symbols WHERE node_id IN (
             SELECT node_id FROM symbol_versions WHERE branch_id=? AND file_path=?
           )`,
        )
        .run(branchId, cp.file_path);
      report.deleted += 1;
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
