import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { extractSymbols, type ExtractedSymbol } from "./extract.js";
import { readGitContext } from "./git.js";
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
          `SELECT id FROM nodes
           WHERE node_type='symbol' AND repo_id=?
             AND (identity_key = ? OR identity_key LIKE ? OR identity_key LIKE ?)`,
        )
        .all(repoId, symbolIdentityKey(repoId, bare), `%::${bare}`, `%.${bare}`) as {
        id: string;
      }[];
      return rows.map((r) => r.id);
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
  for (const ev of renames) {
    // The alias points at the node keeping the NEW identity; find it after upsert.
    // We defer node creation to the txn, so resolve the new node's id there.
    // Store the intent; applied post-txn once node ids exist.
    void ev;
  }

  const tx = store.db.transaction(() => {
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

    // 3. resolve call refs → edges, full-replace this file's parser edges
    const resolved = resolveRefs({
      refs: extracted.refs, fileSymbols: extracted.symbols,
      fileSymbolIds, lookup: storeSymbolIndex(store, p.repoId),
    });
    store.replaceFileEdges({ branchId: p.branchId, filePath: p.relPath, edges: resolved.edges });

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
  for (const ev of renames) {
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
  };

  try {
    if (mode === "rebuild") {
      store.db.prepare("DELETE FROM files_index WHERE repo_id=? AND branch_id=?").run(repoId, branchId);
    }

    const seen = new Set<string>();
    for (const file of walkRepoFiles(rootPath)) {
      report.scanned += 1;
      seen.add(file.relPath);
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
