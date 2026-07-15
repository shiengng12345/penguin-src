import { randomUUID } from "node:crypto";
import type DatabaseCtor from "better-sqlite3";
import { Ledger, readLedgerFile } from "./ledger.js";

type Database = DatabaseCtor.Database;
import type { LedgerEvent, LedgerEventInput } from "./ledger.js";
import { materialize, LedgerGapError } from "./materializer.js";
import { openDatabase } from "./schema.js";

// signal 0 is a standard no-op liveness probe: it validates the pid without
// actually sending a signal. ESRCH = no such process (dead); EPERM = exists
// but owned by another user (still alive, just not signalable by us) — any
// other error is treated conservatively as "can't tell, assume alive".
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface ParsedEdge {
  src: string;
  dst: string | null;
  rawTarget?: string | null;
  edgeType: string;
  origin: "parser";
  method: "EXTRACTED" | "INFERRED";
  confidence?: number;
  // Cross-service edges to a GLOBAL (repo-less) gRPC endpoint are persisted
  // branch-less (branch_id IS NULL) so branch-scoped traversal — which each
  // microservice is indexed on a *different* branch — can still cross the
  // service boundary (query layer allows `branch_id IS NULL` through). Cleaned
  // up per (repo, file) on re-index since branch_id can't scope them.
  branchless?: boolean;
  // Frontend-origin provenance tag (e.g. "frontend_web" / "frontend_mobile")
  // for cross-service invokes edges parsed out of client code.
  sourceType?: string;
}

export interface NodeRow {
  id: string;
  node_type: string;
  identity_key: string;
  repo_id: string | null;
  title: string;
  meta: string;
  created_at: string;
}

export interface SearchHit {
  nodeId: string;
  nodeType: string;
  title: string;
  snippet: string | null;
  identityKey: string;
  filePath: string | null;
  branch: string | null;
  rank: number | null;
}

// file:line only, deliberately not a graph node — see fts_identifiers in
// schema.ts for why (object keys / interface / type / class field names).
export interface IdentifierHit {
  name: string;
  repoId: string;
  filePath: string;
  startLine: number;
  kind: string;
}

export type BranchStatus = "live" | "snapshot" | "gone";

export interface RepoRow {
  id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  created_at: string;
}

export interface BranchRow {
  id: string;
  repo_id: string;
  name: string;
  head_commit: string | null;
  last_indexed_commit: string | null;
  last_indexed_at: string | null;
  checkout_path: string | null;
  status: string;
  parser_version: string | null;
}

export type FileStatus = "indexed" | "deleted" | "error" | "skipped";

export interface FileCheckpointRow {
  id: string;
  repo_id: string;
  branch_id: string;
  file_path: string;
  lang: string | null;
  mtime_ms: number | null;
  size_bytes: number | null;
  content_hash: string | null;
  indexed_at: string | null;
  status: string;
  error: string | null;
}

export type SymbolStatus = "fresh" | "stale";

export interface SymbolVersionRow {
  id: string;
  node_id: string;
  branch_id: string;
  commit_sha: string;
  file_path: string;
  lang: string;
  kind: string;
  signature: string | null;
  start_line: number | null;
  end_line: number | null;
  content_hash: string;
  status: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

// 存储核心唯一对外 API（D4 隔离层）。
// §2.2 铁律在代码层的收口点：不可再生知识只有 recordKnowledge() 一个入口，
// 本类不提供任何绕过账本写 events/node_aliases/非 parser 边的方法。
export class KnowledgeStore {
  private constructor(
    readonly db: Database,
    private readonly ledger: Ledger,
    readonly ledgerPath: string,
  ) {}

  static open(opts: { dbPath: string; ledgerPath: string }): KnowledgeStore {
    const db = openDatabase(opts.dbPath);
    const { ledger, read } = Ledger.open(opts.ledgerPath);
    materialize(db, read.events); // 启动追平：账本领先则 replay
    return new KnowledgeStore(db, ledger, opts.ledgerPath);
  }

  close(): void {
    this.db.close();
  }

  // —— 不可再生知识唯一写入口：先账本，后物化 ——
  recordKnowledge(input: LedgerEventInput): LedgerEvent {
    const event = this.ledger.append(input);
    try {
      materialize(this.db, [event]);
    } catch (err) {
      // 多进程断档：别的进程在我方 DB 未追平时抢先追加了更早的 seq。
      // 读全账本重放补齐这段缺口（含我方刚写的这条）。
      if (err instanceof LedgerGapError) {
        materialize(this.db, readLedgerFile(this.ledgerPath).events);
      } else {
        throw err;
      }
    }
    return event;
  }

  // —— 解析衍生（可再生）直写 ——
  upsertNode(n: {
    nodeType: string;
    identityKey: string;
    repoId?: string | null;
    title: string;
    meta?: Record<string, unknown>;
  }): string {
    // 原子 upsert：app 与 CLI 可能并发索引同一符号，SELECT-then-INSERT 有竞态。
    // meta 省略时保留已有值——部分负载（只碰 title）不得清空既有元数据。
    const row = this.db
      .prepare(
        `INSERT INTO nodes (id, node_type, identity_key, repo_id, title, meta, created_at)
         VALUES (@id, @nodeType, @identityKey, @repoId, @title, @meta, @createdAt)
         ON CONFLICT (node_type, identity_key) DO UPDATE SET
           title = excluded.title,
           meta = CASE WHEN @metaProvided = 1 THEN excluded.meta ELSE nodes.meta END,
           -- A node referenced (as a bare dependency, repoId=null) before its
           -- real owner is indexed must not stay orphaned forever once that
           -- owner DOES get indexed and asserts ownership — but a null-repoId
           -- write (someone else merely depending on it) must never erase an
           -- already-known owner. First non-null repo_id wins; never downgrade,
           -- and never let a LATER different non-null repo_id steal ownership
           -- either (independent codex + deepcode review both caught the
           -- previous CASE only guarding against null, which let two real
           -- repoIds race and made the last writer silently win).
           repo_id = CASE
             WHEN nodes.repo_id IS NOT NULL THEN nodes.repo_id
             WHEN excluded.repo_id IS NOT NULL THEN excluded.repo_id
             ELSE NULL
           END
         RETURNING id`,
      )
      .get({
        id: `node_${randomUUID()}`,
        nodeType: n.nodeType,
        identityKey: n.identityKey,
        repoId: n.repoId ?? null,
        title: n.title,
        meta: JSON.stringify(n.meta ?? {}),
        createdAt: new Date().toISOString(),
        metaProvided: n.meta === undefined ? 0 : 1,
      }) as { id: string };
    return row.id;
  }

  getNode(id: string): NodeRow | null {
    return (
      (this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
        | NodeRow
        | undefined) ?? null
    );
  }

  // —— repo / branch 登记（可再生 Index 层，直写）——
  registerRepo(p: { name: string; rootPath: string; remoteUrl?: string | null }): string {
    const row = this.db
      .prepare(
        `INSERT INTO repos (id, name, root_path, remote_url, created_at)
         VALUES (@id, @name, @rootPath, @remoteUrl, @createdAt)
         ON CONFLICT (root_path) DO UPDATE SET
           name = excluded.name,
           remote_url = excluded.remote_url
         RETURNING id`,
      )
      .get({
        id: `repo_${randomUUID()}`,
        name: p.name,
        rootPath: p.rootPath,
        remoteUrl: p.remoteUrl ?? null,
        createdAt: new Date().toISOString(),
      }) as { id: string };
    return row.id;
  }

  getRepoByRoot(rootPath: string): RepoRow | null {
    return (
      (this.db.prepare("SELECT * FROM repos WHERE root_path = ?").get(rootPath) as
        | RepoRow
        | undefined) ?? null
    );
  }

  // Accepts EITHER a repo's internal id OR its display name (case-insensitive)
  // — callers (MCP/CLI) only ever see the display name in status/index output
  // and have no way to know the internal UUID without a prior lookup, so a
  // filter that only matched by id silently scoped every search to nothing.
  resolveRepoIds(idOrName: string): string[] {
    const byId = this.db.prepare("SELECT id FROM repos WHERE id = ?").get(idOrName) as { id: string } | undefined;
    if (byId) return [byId.id];
    const byName = this.db
      .prepare("SELECT id FROM repos WHERE name = ? COLLATE NOCASE")
      .all(idOrName) as { id: string }[];
    return byName.map((r) => r.id);
  }

  registerBranch(p: {
    repoId: string;
    name: string;
    headCommit?: string | null;
    checkoutPath?: string | null;
    status: BranchStatus;
  }): string {
    const row = this.db
      .prepare(
        `INSERT INTO branches (id, repo_id, name, head_commit, checkout_path, status)
         VALUES (@id, @repoId, @name, @headCommit, @checkoutPath, @status)
         ON CONFLICT (repo_id, name) DO UPDATE SET
           head_commit = excluded.head_commit,
           checkout_path = excluded.checkout_path,
           status = excluded.status
         RETURNING id`,
      )
      .get({
        id: `branch_${randomUUID()}`,
        repoId: p.repoId,
        name: p.name,
        headCommit: p.headCommit ?? null,
        checkoutPath: p.checkoutPath ?? null,
        status: p.status,
      }) as { id: string };
    return row.id;
  }

  getBranch(repoId: string, name: string): BranchRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM branches WHERE repo_id = ? AND name = ?")
        .get(repoId, name) as BranchRow | undefined) ?? null
    );
  }

  // A checkout has ONE branch checked out at a time: after indexing `keep` at
  // `checkoutPath`, any OTHER live branch of the same repo AND same checkout
  // is history — flip it to snapshot. Separate worktrees (different checkout
  // paths) legitimately stay live side by side, so they are left alone.
  demoteSiblingBranches(p: { repoId: string; keepBranchId: string; checkoutPath: string | null }): number {
    if (!p.checkoutPath) return 0;
    return this.db
      .prepare(
        `UPDATE branches SET status = 'snapshot'
         WHERE repo_id = ? AND id <> ? AND checkout_path = ? AND status = 'live'`,
      )
      .run(p.repoId, p.keepBranchId, p.checkoutPath).changes;
  }

  setBranchStatus(branchId: string, status: BranchStatus): void {
    this.db.prepare("UPDATE branches SET status = ? WHERE id = ?").run(status, branchId);
  }

  recordBranchIndexed(p: {
    branchId: string;
    commit?: string | null;
    worktreeState?: "clean" | "dirty" | "unknown" | "not_applicable";
    worktreeFingerprint?: string | null;
    dirtyFiles?: string[];
    parserVersion?: string | null;
    schemaVersion?: number | null;
    staleReason?: string | null;
  }): void {
    const r = this.db
      .prepare(
        `UPDATE branches
         SET last_indexed_at = @at,
             last_indexed_commit = CASE
               WHEN @updateCommit = 1 THEN @commit
               ELSE last_indexed_commit
             END,
             indexed_worktree_state = @worktreeState,
             indexed_worktree_fingerprint = @worktreeFingerprint,
             indexed_dirty_files = @dirtyFiles,
             parser_version = @parserVersion,
             indexed_schema_version = @schemaVersion,
             stale_reason = @staleReason
         WHERE id = @branchId`,
      )
      .run({
        branchId: p.branchId,
        commit: p.commit ?? null,
        updateCommit: Object.hasOwn(p, "commit") ? 1 : 0,
        worktreeState: p.worktreeState ?? "unknown",
        worktreeFingerprint: p.worktreeFingerprint ?? null,
        dirtyFiles: JSON.stringify(p.dirtyFiles ?? []),
        parserVersion: p.parserVersion ?? null,
        schemaVersion: p.schemaVersion ?? null,
        staleReason: p.staleReason ?? null,
        at: new Date().toISOString(),
      });
    // Fail loud, not silent: the branch row disappearing mid-index means a
    // concurrent removeBranch won — this run's rows are orphans, surface it.
    if (r.changes === 0) {
      throw new Error(`branch ${p.branchId} was removed while indexing — re-run the index`);
    }
  }

  // —— symbol_versions（分支作用域的实现快照，可再生直写）——
  // first_seen_at 在插入时定；更新只刷新 last_seen_at 与内容字段，不动 first_seen_at。
  upsertSymbolVersion(v: {
    nodeId: string;
    branchId: string;
    commitSha: string;
    filePath: string;
    lang: string;
    kind: string;
    signature?: string | null;
    startLine?: number | null;
    endLine?: number | null;
    contentHash: string;
    status?: SymbolStatus;
  }): string {
    const now = new Date().toISOString();
    const row = this.db
      .prepare(
        `INSERT INTO symbol_versions
           (id, node_id, branch_id, commit_sha, file_path, lang, kind, signature,
            start_line, end_line, content_hash, status, first_seen_at, last_seen_at)
         VALUES (@id, @nodeId, @branchId, @commitSha, @filePath, @lang, @kind, @signature,
            @startLine, @endLine, @contentHash, @status, @now, @now)
         ON CONFLICT (node_id, branch_id) DO UPDATE SET
           commit_sha = excluded.commit_sha,
           file_path = excluded.file_path,
           lang = excluded.lang,
           kind = excluded.kind,
           signature = excluded.signature,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           content_hash = excluded.content_hash,
           status = excluded.status,
           last_seen_at = excluded.last_seen_at
         RETURNING id`,
      )
      .get({
        id: `symver_${randomUUID()}`,
        nodeId: v.nodeId,
        branchId: v.branchId,
        commitSha: v.commitSha,
        filePath: v.filePath,
        lang: v.lang,
        kind: v.kind,
        signature: v.signature ?? null,
        startLine: v.startLine ?? null,
        endLine: v.endLine ?? null,
        contentHash: v.contentHash,
        status: v.status ?? "fresh",
        now,
      }) as { id: string };
    return row.id;
  }

  getSymbolVersion(nodeId: string, branchId: string): SymbolVersionRow | null {
    return (
      (this.db
        .prepare("SELECT * FROM symbol_versions WHERE node_id = ? AND branch_id = ?")
        .get(nodeId, branchId) as SymbolVersionRow | undefined) ?? null
    );
  }

  markFileSymbolsStale(p: { branchId: string; filePath: string }): number {
    const info = this.db
      .prepare(
        "UPDATE symbol_versions SET status = 'stale' WHERE branch_id = ? AND file_path = ?",
      )
      .run(p.branchId, p.filePath);
    return info.changes;
  }

  // —— files_index：逐文件增量检查点（可再生直写，spec §6.3.1）——
  getFileCheckpoint(
    repoId: string,
    branchId: string,
    filePath: string,
  ): FileCheckpointRow | null {
    return (
      (this.db
        .prepare(
          "SELECT * FROM files_index WHERE repo_id = ? AND branch_id = ? AND file_path = ?",
        )
        .get(repoId, branchId, filePath) as FileCheckpointRow | undefined) ?? null
    );
  }

  upsertFileCheckpoint(p: {
    repoId: string;
    branchId: string;
    filePath: string;
    lang?: string | null;
    mtimeMs?: number | null;
    sizeBytes?: number | null;
    contentHash?: string | null;
    status: FileStatus;
    error?: string | null;
  }): string {
    const row = this.db
      .prepare(
        `INSERT INTO files_index
           (id, repo_id, branch_id, file_path, lang, mtime_ms, size_bytes,
            content_hash, indexed_at, status, error)
         VALUES (@id, @repoId, @branchId, @filePath, @lang, @mtimeMs, @sizeBytes,
            @contentHash, @indexedAt, @status, @error)
         ON CONFLICT (repo_id, branch_id, file_path) DO UPDATE SET
           lang = excluded.lang,
           mtime_ms = excluded.mtime_ms,
           size_bytes = excluded.size_bytes,
           content_hash = excluded.content_hash,
           indexed_at = excluded.indexed_at,
           status = excluded.status,
           error = excluded.error
         RETURNING id`,
      )
      .get({
        id: `fidx_${randomUUID()}`,
        repoId: p.repoId,
        branchId: p.branchId,
        filePath: p.filePath,
        lang: p.lang ?? null,
        mtimeMs: p.mtimeMs ?? null,
        sizeBytes: p.sizeBytes ?? null,
        contentHash: p.contentHash ?? null,
        indexedAt: new Date().toISOString(),
        status: p.status,
        error: p.error ?? null,
      }) as { id: string };
    return row.id;
  }

  listFileCheckpoints(repoId: string, branchId: string): FileCheckpointRow[] {
    return this.db
      .prepare(
        "SELECT * FROM files_index WHERE repo_id = ? AND branch_id = ? ORDER BY file_path",
      )
      .all(repoId, branchId) as FileCheckpointRow[];
  }

  markFileDeleted(p: { repoId: string; branchId: string; filePath: string }): void {
    this.db
      .prepare(
        "UPDATE files_index SET status = 'deleted' WHERE repo_id = ? AND branch_id = ? AND file_path = ?",
      )
      .run(p.repoId, p.branchId, p.filePath);
  }

  // —— 笔记边（可再生：从 .md 解析出的 wikilink/entity_mention，直写；分支无关）——
  // 全量替换某笔记节点产出的 parser 边（未解析目标 dst=NULL + raw_target 保留）。
  replaceNoteEdges(
    srcNodeId: string,
    edges: Array<{
      dst: string | null;
      rawTarget: string | null;
      edgeType: string;
      confidence?: number;
    }>,
  ): void {
    const del = this.db.prepare(
      "DELETE FROM edges WHERE src = ? AND origin = 'parser' AND branch_id IS NULL",
    );
    // source_type is always NULL here: note wikilinks are never frontend-code
    // provenance, so there is no per-edge value to bind — kept as an explicit
    // literal (like branch_id) rather than a bound param.
    const ins = this.db.prepare(
      `INSERT INTO edges (id, src, dst, raw_target, edge_type, branch_id, origin, method, confidence, provenance, source_type)
       VALUES (?, ?, ?, ?, ?, NULL, 'parser', 'EXTRACTED', ?, '{}', NULL)`,
    );
    const tx = this.db.transaction(() => {
      del.run(srcNodeId);
      for (const e of edges) {
        ins.run(
          `edge_${randomUUID()}`,
          srcNodeId,
          e.dst,
          e.rawTarget,
          e.edgeType,
          e.confidence ?? 1.0,
        );
      }
    });
    tx();
  }

  // 目标节点出现后回填此前未解析的 wikilink（dst=NULL 且 raw_target 命中）。
  // 幂等：只更新仍为 NULL 的行。返回补上的边数。
  linkUnresolvedTargets(p: { nodeId: string; matches: string[] }): number {
    if (p.matches.length === 0) return 0;
    const placeholders = p.matches.map(() => "?").join(",");
    const info = this.db
      .prepare(
        `UPDATE edges SET dst = ?
         WHERE dst IS NULL AND edge_type = 'wikilink' AND raw_target IN (${placeholders})`,
      )
      .run(p.nodeId, ...p.matches);
    return info.changes;
  }

  // —— 凭据正文（§5 C 案）：只存本表，永不进 FTS/MCP；图里仅有 credential 节点 ——
  putCredential(p: { nodeId: string; title: string; kind: string; body: string }): void {
    this.db
      .prepare(
        `INSERT INTO credential_entries (node_id, title, kind, body, created_at)
         VALUES (@nodeId, @title, @kind, @body, @createdAt)
         ON CONFLICT (node_id) DO UPDATE SET title=@title, kind=@kind, body=@body`,
      )
      .run({ ...p, createdAt: new Date().toISOString() });
  }

  getCredential(nodeId: string): { title: string; kind: string; body: string } | null {
    return (
      (this.db
        .prepare("SELECT title, kind, body FROM credential_entries WHERE node_id = ?")
        .get(nodeId) as { title: string; kind: string; body: string } | undefined) ?? null
    );
  }

  // 只回元数据（title/kind），绝不含 body——供列表/图展示。
  listCredentialMeta(): Array<{ nodeId: string; title: string; kind: string; createdAt: string }> {
    return this.db
      .prepare(
        "SELECT node_id AS nodeId, title, kind, created_at AS createdAt FROM credential_entries ORDER BY created_at",
      )
      .all() as Array<{ nodeId: string; title: string; kind: string; createdAt: string }>;
  }

  // —— AI 建议边确认流（§8.2/§11）：建议→队列，确认后才进默认检索 ——
  // 都走 Ledger（不可再生知识）。suggestEdge 返回事件，其 id 即 acceptSuggestion/
  // rejectSuggestion 的 suggestion_event_id。
  suggestEdge(p: {
    src: string;
    dst?: string | null;
    rawTarget?: string | null;
    edgeType: string;
    confidence?: number;
    actorId?: string;
  }): LedgerEvent {
    return this.recordKnowledge({
      type: "ai_suggestion_created",
      origin: "ai",
      method: "INFERRED",
      actor: { type: "ai", id: p.actorId ?? "ai" },
      target: { node_id: p.src },
      payload: {
        src: p.src,
        dst: p.dst ?? null,
        raw_target: p.rawTarget ?? null,
        edge_type: p.edgeType,
        confidence: p.confidence ?? 0.5,
      },
    });
  }

  acceptSuggestion(suggestionEventId: string, actorId = "user"): void {
    this.recordKnowledge({
      type: "ai_suggestion_accepted",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: actorId },
      payload: { suggestion_event_id: suggestionEventId },
    });
  }

  rejectSuggestion(suggestionEventId: string, actorId = "user"): void {
    this.recordKnowledge({
      type: "ai_suggestion_rejected",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: actorId },
      payload: { suggestion_event_id: suggestionEventId },
    });
  }

  listSuggestions(): Array<{
    edgeId: string;
    suggestionEventId: string;
    src: string;
    dst: string | null;
    edgeType: string;
    confidence: number;
  }> {
    const rows = this.db
      .prepare(
        "SELECT id AS edgeId, src, dst, edge_type AS edgeType, confidence FROM edges WHERE status = 'suggested' ORDER BY src",
      )
      .all() as Array<{ edgeId: string; src: string; dst: string | null; edgeType: string; confidence: number }>;
    return rows.map((r) => ({ ...r, suggestionEventId: r.edgeId.replace(/^edge_/, "") }));
  }

  // —— Snapshot manifest（§11）：把一组 node/version 钉成一个命名世界状态 ——
  // 账本事件（不可再生）；重建后仍可从 events 表读回。V1 存 node id 清单，
  // 供 case 引用「当时的世界」。
  createSnapshot(p: { name: string; nodeIds: string[]; note?: string }): LedgerEvent {
    return this.recordKnowledge({
      type: "snapshot_manifest_created",
      origin: "user",
      method: "ASSERTED",
      actor: { type: "user", id: "user" },
      payload: { name: p.name, node_ids: p.nodeIds, note: p.note ?? null },
    });
  }

  // —— Workspaces（D14）：多 repo 逻辑分组，仅用于查询作用域 ——
  createWorkspace(name: string): string {
    const row = this.db
      .prepare(
        "INSERT INTO workspaces (id, name, created_at) VALUES (@id, @name, @at) RETURNING id",
      )
      .get({ id: `ws_${randomUUID()}`, name, at: new Date().toISOString() }) as { id: string };
    return row.id;
  }

  addRepoToWorkspace(workspaceId: string, repoId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO workspace_repos (workspace_id, repo_id) VALUES (?, ?)")
      .run(workspaceId, repoId);
  }

  workspaceRepoIds(workspaceId: string): string[] {
    return (
      this.db
        .prepare("SELECT repo_id FROM workspace_repos WHERE workspace_id = ?")
        .all(workspaceId) as { repo_id: string }[]
    ).map((r) => r.repo_id);
  }

  listWorkspaces(): Array<{ id: string; name: string; repoIds: string[] }> {
    const rows = this.db.prepare("SELECT id, name FROM workspaces ORDER BY name").all() as Array<{
      id: string;
      name: string;
    }>;
    return rows.map((w) => ({ ...w, repoIds: this.workspaceRepoIds(w.id) }));
  }

  // Pending rename-suggestion queue (ambiguous same-body moves, §11).
  listRenameSuggestions(): Array<{ id: string; oldKey: string; candidateKeys: string[]; ts: string }> {
    const rows = this.db
      .prepare("SELECT id, ts, payload FROM events WHERE event_type='rename_suggested' ORDER BY ts DESC")
      .all() as Array<{ id: string; ts: string; payload: string }>;
    return rows.map((r) => {
      const p = JSON.parse(r.payload) as { old_key?: string; candidate_keys?: string[] };
      return { id: r.id, oldKey: String(p.old_key ?? ""), candidateKeys: p.candidate_keys ?? [], ts: r.ts };
    });
  }

  listSnapshots(): Array<{ id: string; name: string; nodeIds: string[]; ts: string }> {
    const rows = this.db
      .prepare(
        "SELECT id, ts, payload FROM events WHERE event_type='snapshot_manifest_created' ORDER BY ts DESC",
      )
      .all() as Array<{ id: string; ts: string; payload: string }>;
    return rows.map((r) => {
      const p = JSON.parse(r.payload) as { name?: string; node_ids?: string[] };
      return { id: r.id, name: String(p.name ?? ""), nodeIds: p.node_ids ?? [], ts: r.ts };
    });
  }

  // 解析产出的代码边：同 file+branch 全量替换（§6.3 增量语义）。
  // 非 parser 边在这里是实现错误，不是数据——直接抛。
  replaceFileEdges(p: {
    repoId: string;
    branchId: string;
    filePath: string;
    edges: ParsedEdge[];
  }): void {
    for (const e of p.edges) {
      if (e.origin !== "parser") {
        throw new Error(
          `non-rebuildable edge (origin=${e.origin}) must go through recordKnowledge() — spec §2.2`,
        );
      }
    }
    // Branch-scoped parser edges for this file (identity = branch + file).
    const delScoped = this.db.prepare(
      `DELETE FROM edges WHERE branch_id = ? AND origin = 'parser'
       AND json_extract(provenance, '$.file') = ?`,
    );
    // Branch-less cross-service edges (global gRPC endpoints, branch_id IS NULL)
    // can't be scoped by branch, and relative file paths collide across repos —
    // so key their cleanup on (repo, file) from provenance.
    const delGlobal = this.db.prepare(
      `DELETE FROM edges WHERE branch_id IS NULL AND origin = 'parser'
       AND json_extract(provenance, '$.repo') = ?
       AND json_extract(provenance, '$.file') = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO edges (id, src, dst, raw_target, edge_type, branch_id,
         origin, method, confidence, provenance, source_type)
       VALUES (?, ?, ?, ?, ?, ?, 'parser', ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      delScoped.run(p.branchId, p.filePath);
      delGlobal.run(p.repoId, p.filePath);
      for (const e of p.edges) {
        ins.run(
          `edge_${randomUUID()}`,
          e.src,
          e.dst,
          e.rawTarget ?? null,
          e.edgeType,
          e.branchless ? null : p.branchId,
          e.method,
          e.confidence ?? 1.0,
          JSON.stringify({ file: p.filePath, repo: p.repoId }),
          e.sourceType ?? null,
        );
      }
    });
    tx();
  }

  // Direct identity lookup (no alias fallback) — used to check whether a
  // gRPC endpoint node has appeared yet before replaying a pending frontend
  // edge; resolveIdentity() is the fuller alias-aware variant used elsewhere.
  findNodeIdByIdentity(identityKey: string): string | null {
    const r = this.db
      .prepare("SELECT id FROM nodes WHERE identity_key = ?")
      .get(identityKey) as { id: string } | undefined;
    return r?.id ?? null;
  }

  // Native method-name uniqueness mode: given a lowercased method name,
  // return the DISTINCT proto-service names of all GLOBAL gRPC endpoint
  // nodes (`grpc::<Service>.<method>`, repo_id IS NULL) whose method matches.
  // The LIKE is a coarse pre-filter (methodLower may contain '_', a LIKE
  // single-char wildcard, causing over-matching); the exact suffix check in
  // JS below is what actually guarantees correctness — only rows whose
  // identity_key ends with EXACTLY '.'+methodLower count, so a method like
  // "x" can never match "grpc::A.bx". Method names never contain '.', so the
  // service is the substring between "grpc::" and the LAST '.'.
  findEndpointServicesByMethod(methodLower: string): string[] {
    const suffix = `.${methodLower}`;
    const pattern = `grpc::%${suffix}`;
    const rows = this.db
      .prepare(
        "SELECT identity_key FROM nodes WHERE node_type = 'endpoint' AND repo_id IS NULL AND identity_key LIKE ?",
      )
      .all(pattern) as Array<{ identity_key: string }>;
    const services = new Set<string>();
    for (const r of rows) {
      const key = r.identity_key;
      if (!key.startsWith("grpc::") || !key.endsWith(suffix)) continue;
      const body = key.slice("grpc::".length, key.length - suffix.length);
      if (body) services.add(body);
    }
    return [...services];
  }

  // Frontend and backend repos index independently, so a frontend call site
  // may be parsed before its backend gRPC endpoint node exists. Queue it here;
  // replayPendingFrontendEdges() links it once the endpoint shows up.
  enqueuePendingFrontendEdge(p: {
    repoId: string;
    filePath: string;
    srcNodeId: string;
    service: string;
    functionName: string;
    sourceType: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO pending_frontend_edges
           (id, repo_id, file_path, src_node_id, service, function_name, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `pfe_${randomUUID()}`,
        p.repoId,
        p.filePath,
        p.srcNodeId,
        p.service,
        p.functionName,
        p.sourceType,
      );
  }

  // Delete this (repo, file)'s previously-queued pending frontend edges before
  // re-enqueueing its current call sites. A frontend file re-parsed several
  // times before its backend endpoint exists would otherwise accumulate one
  // pending row per parse → duplicate `invokes` edges once replayed. Callers
  // should clear-then-insert per file rather than insert-only.
  clearPendingFrontendEdgesForFile(repoId: string, filePath: string): void {
    this.db
      .prepare("DELETE FROM pending_frontend_edges WHERE repo_id = ? AND file_path = ?")
      .run(repoId, filePath);
  }

  // For every pending row whose gRPC endpoint node now exists, insert the
  // branch-less `invokes` edge and delete the row. Returns count replayed.
  // NOTE: the key formula below must stay byte-identical to
  // knowledge-indexer's grpcEndpointKey() (`grpc::${service}.${method.toLowerCase()}`)
  // — inlined here rather than imported, since store.ts (core) must not
  // depend on the indexer package (wrong dependency direction).
  //
  // service === "" is the native-uniqueness-mode "resolve-by-method-later"
  // marker (pipeline.ts enqueues it when a method-name resolution found ZERO
  // backend services at stitch time — the backend repo may not be indexed
  // yet). Such rows are re-resolved here via findEndpointServicesByMethod()
  // on every replay rather than looked up by a fixed identity key, since no
  // single service was known when the row was queued.
  replayPendingFrontendEdges(): number {
    const rows = this.db
      .prepare("SELECT * FROM pending_frontend_edges")
      .all() as Array<{
      id: string;
      repo_id: string;
      file_path: string;
      src_node_id: string;
      service: string;
      function_name: string;
      source_type: string;
    }>;
    const ins = this.db.prepare(
      `INSERT INTO edges (id, src, dst, raw_target, edge_type, branch_id,
         origin, method, confidence, provenance, source_type)
       VALUES (?, ?, ?, NULL, 'invokes', NULL, 'parser', 'EXTRACTED', ?, ?, ?)`,
    );
    const del = this.db.prepare("DELETE FROM pending_frontend_edges WHERE id = ?");
    let replayed = 0;
    for (const row of rows) {
      let endpointId: string | null;
      if (row.service !== "") {
        const key = `grpc::${row.service}.${String(row.function_name).toLowerCase()}`;
        endpointId = this.findNodeIdByIdentity(key);
        if (!endpointId) continue; // still deferred: leave the row
      } else {
        const services = this.findEndpointServicesByMethod(String(row.function_name).toLowerCase());
        if (services.length > 1) {
          // became ambiguous since it was queued → drop, never link
          del.run(row.id);
          continue;
        }
        if (services.length === 0) continue; // still missing: leave the row
        const key = `grpc::${services[0]}.${String(row.function_name).toLowerCase()}`;
        endpointId = this.findNodeIdByIdentity(key);
        if (!endpointId) continue; // defensive: leave the row
      }
      // Defensive: the source symbol may have been GC'd (branch removal)
      // after this row was queued — an edge from a dead id would be an orphan.
      const srcAlive = this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(row.src_node_id);
      if (!srcAlive) {
        del.run(row.id);
        continue;
      }
      ins.run(
        `edge_${randomUUID()}`,
        row.src_node_id,
        endpointId,
        1.0,
        JSON.stringify({ file: row.file_path, repo: row.repo_id }),
        row.source_type,
      );
      del.run(row.id);
      replayed += 1;
    }
    return replayed;
  }

  indexNoteText(p: {
    nodeId: string;
    path: string;
    title: string;
    body: string;
    frontmatter?: Record<string, unknown>;
    sensitive?: boolean;
    mcpAccess?: "allowed" | "denied";
    contentHash: string;
  }): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO notes_index (node_id, path, frontmatter, sensitive, ai_access, mcp_access, content_hash)
           VALUES (@node_id, @path, @frontmatter, @sensitive, 'allowed', @mcp_access, @content_hash)
           ON CONFLICT (node_id) DO UPDATE SET
             path = @path, frontmatter = @frontmatter, sensitive = @sensitive,
             mcp_access = @mcp_access, content_hash = @content_hash`,
        )
        .run({
          node_id: p.nodeId,
          path: p.path,
          frontmatter: JSON.stringify(p.frontmatter ?? {}),
          sensitive: p.sensitive ? 1 : 0,
          mcp_access: p.mcpAccess ?? "allowed",
          content_hash: p.contentHash,
        });
      this.db.prepare("DELETE FROM fts_notes WHERE node_id = ?").run(p.nodeId);
      this.db
        .prepare("INSERT INTO fts_notes (node_id, title, body) VALUES (?, ?, ?)")
        .run(p.nodeId, p.title, p.body);
    });
    tx();
  }

  indexSymbolText(p: {
    nodeId: string;
    name: string;
    signature?: string | null;
  }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM fts_symbols WHERE node_id = ?").run(p.nodeId);
      this.db
        .prepare(
          "INSERT INTO fts_symbols (node_id, name, signature) VALUES (?, ?, ?)",
        )
        .run(p.nodeId, p.name, p.signature ?? "");
    });
    tx();
  }

  // (repo_id, file_path) is the idempotency key — a full re-parse of that
  // file replaces its whole prior set, same delete-then-insert convention as
  // indexSymbolText/indexNoteText above, scoped to the file since these
  // entries aren't individually addressable graph nodes with their own id.
  indexIdentifiers(p: {
    repoId: string;
    filePath: string;
    entries: Array<{ name: string; startLine: number; kind: string }>;
  }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM fts_identifiers WHERE repo_id = ? AND file_path = ?").run(p.repoId, p.filePath);
      const insert = this.db.prepare(
        "INSERT INTO fts_identifiers (name, repo_id, file_path, start_line, kind) VALUES (?, ?, ?, ?, ?)",
      );
      for (const e of p.entries) insert.run(e.name, p.repoId, p.filePath, e.startLine, e.kind);
    });
    tx();
  }

  clearLogSitesForFile(repoId: string, filePath: string): void {
    const rows = this.db.prepare(
      `SELECT id FROM nodes
       WHERE node_type = 'log_site' AND repo_id = ?
         AND json_extract(meta, '$.filePath') = ?`,
    ).all(repoId, filePath) as Array<{ id: string }>;
    const delFts = this.db.prepare("DELETE FROM fts_symbols WHERE node_id = ?");
    const delNode = this.db.prepare("DELETE FROM nodes WHERE id = ?");
    for (const row of rows) {
      delFts.run(row.id);
      delNode.run(row.id);
    }
  }

  // Same AND-per-term FTS5 construction as searchText — see its comment for
  // why the whole query must not be wrapped as one quoted phrase.
  searchIdentifiers(query: string, opts?: { limit?: number }): IdentifierHit[] {
    const limit = opts?.limit ?? 50;
    const terms = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const match = terms.length > 0
      ? terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
      : `"${query.replace(/"/g, '""')}"`;
    return this.db
      .prepare(
        `SELECT name, repo_id AS repoId, file_path AS filePath, start_line AS startLine, kind
         FROM fts_identifiers WHERE fts_identifiers MATCH ? ORDER BY bm25(fts_identifiers) LIMIT ?`,
      )
      .all(match, limit) as IdentifierHit[];
  }

  searchText(
    query: string,
    opts?: { types?: string[]; includeSensitive?: boolean; limit?: number },
  ): SearchHit[] {
    const limit = opts?.limit ?? 50;
    // Split into individual terms and AND them together (FTS5's implicit
    // operator between space-separated quoted phrases) instead of wrapping
    // the WHOLE query as one quoted PHRASE. A phrase requires every word
    // adjacent, in that exact order — almost no real multi-word query is:
    // reversed word order, an extra word, or a qualified "Class.method" name
    // (only the bare method name is indexed) all used to return zero
    // results even though the terms genuinely exist in the document. Each
    // term is individually quoted so a single token can never be
    // interpreted as FTS5 query syntax (AND/OR/NOT/NEAR/column filters).
    const terms = query.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const match = terms.length > 0
      ? terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" ")
      : `"${query.replace(/"/g, '""')}"`;

    const noteRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.node_type AS nodeType, n.title AS title,
                n.identity_key AS identityKey, ni.path AS filePath, NULL AS branch,
                bm25(fts_notes) AS rank,
                snippet(fts_notes, 2, '[', ']', '…', 12) AS snippet
         FROM fts_notes f
         JOIN nodes n ON n.id = f.node_id
         JOIN notes_index ni ON ni.node_id = f.node_id
         WHERE fts_notes MATCH ?
           AND (? = 1 OR (ni.sensitive = 0 AND ni.mcp_access = 'allowed'))
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, opts?.includeSensitive ? 1 : 0, limit) as SearchHit[];

    // LEFT JOIN symbol_versions: symbols indexed via indexSymbolText() alone
    // (no full pipeline run, e.g. some test fixtures) have no version row —
    // filePath/branch must degrade to null rather than dropping the hit.
    // Preferring status='fresh' picks the live branch's copy when a symbol
    // has versions across multiple branches; falls back to any version.
    const symbolRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.node_type AS nodeType, n.title AS title,
                n.identity_key AS identityKey, sv.file_path AS filePath, br.name AS branch,
                bm25(fts_symbols) AS rank,
                NULLIF(f.signature, '') AS snippet
         FROM fts_symbols f
         JOIN nodes n ON n.id = f.node_id
         LEFT JOIN symbol_versions sv ON sv.id = (
           SELECT id FROM symbol_versions WHERE node_id = n.id
           ORDER BY (status = 'fresh') DESC LIMIT 1
         )
         LEFT JOIN branches br ON br.id = sv.branch_id
         WHERE fts_symbols MATCH ?
           AND (sv.id IS NULL OR sv.status = 'fresh')
         ORDER BY rank
         LIMIT ?`,
      )
      .all(match, limit) as SearchHit[];

    // bm25 is lower-is-more-relevant; sort the merged note+symbol set by it
    // (nulls-safe fallback to 0) so relevance ordering holds across both kinds.
    let hits = [...noteRows, ...symbolRows].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    if (opts?.types?.length) {
      hits = hits.filter((h) => opts.types!.includes(h.nodeType));
    }
    return hits.slice(0, limit);
  }

  resolveIdentity(
    key: string,
  ): { nodeId: string; via: "identity" | "alias" } | null {
    const direct = this.db
      .prepare("SELECT id FROM nodes WHERE identity_key = ? COLLATE NOCASE")
      .get(key) as { id: string } | undefined;
    if (direct) return { nodeId: direct.id, via: "identity" };

    // JOIN nodes: ledger-replayed aliases can point at node ids that no longer
    // exist (post-wipe re-index assigns fresh ids). Returning a dead id here
    // crashes callers that dereference it (getNodeDetail's `getNode(id)!`).
    const alias = this.db
      .prepare(
        `SELECT a.node_id FROM node_aliases a
         JOIN nodes n ON n.id = a.node_id
         WHERE a.alias_key = ? COLLATE NOCASE AND a.valid_to IS NULL
         ORDER BY a.created_at DESC LIMIT 1`,
      )
      .get(key) as { node_id: string } | undefined;
    if (alias) return { nodeId: alias.node_id, via: "alias" };

    // Backward compatibility for pre file-scoped symbol keys such as
    // `repo_x::PlayerClientGrpc.getPlayerInfo`. New symbol identities include
    // the physical file path to avoid collapsing copied classes. Resolve the
    // old shape only when its repo + qualified name identifies exactly one
    // node; duplicates deliberately remain ambiguous instead of guessing.
    const separator = key.indexOf("::");
    if (separator > 0) {
      const repoId = key.slice(0, separator);
      const qualifiedName = key.slice(separator + 2);
      const legacyMatches = this.db
        .prepare(
          `SELECT id FROM nodes
           WHERE node_type='symbol' AND repo_id=?
             AND json_extract(meta, '$.qualifiedName')=? COLLATE NOCASE
           LIMIT 2`,
        )
        .all(repoId, qualifiedName) as Array<{ id: string }>;
      if (legacyMatches.length === 1) return { nodeId: legacyMatches[0].id, via: "identity" };
    }
    return null;
  }

  // Cross-process "index in progress" marker for a branch (meta table). The
  // in-process IndexTaskLock cannot guard app↔CLI races: every app call is its
  // own CLI process. A marker only blocks while its recorded pid is STILL
  // ALIVE — a crashed/killed indexer (never reaches its releaseIndexMarker
  // cleanup) must not lock retries out for the full 30 minutes just because
  // its timestamp is recent. The age check remains as a bounded fallback
  // (e.g. pid-reuse races), so a live-but-hung process still self-clears
  // after 30 minutes either way.
  acquireIndexMarker(branchId: string): void {
    const key = `index_lock::${branchId}`;
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    if (row) {
      try {
        const v = JSON.parse(row.value) as { pid?: number; startedAt?: string };
        const age = Date.now() - Date.parse(v.startedAt ?? "");
        const stillRunning = typeof v.pid === "number" && isPidAlive(v.pid);
        if (stillRunning && Number.isFinite(age) && age < 30 * 60_000) {
          throw new Error(`index already running for this branch (started ${v.startedAt})`);
        }
      } catch (e) {
        if (e instanceof Error && /already running/.test(e.message)) throw e;
        // unparseable marker → treat as stale
      }
    }
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  }

  releaseIndexMarker(branchId: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(`index_lock::${branchId}`);
  }

  private assertNoFreshIndexMarker(branchId: string): void {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = ?")
      .get(`index_lock::${branchId}`) as { value: string } | undefined;
    if (!row) return;
    try {
      const v = JSON.parse(row.value) as { pid?: number; startedAt?: string };
      const age = Date.now() - Date.parse(v.startedAt ?? "");
      const stillRunning = typeof v.pid === "number" && isPidAlive(v.pid);
      if (stillRunning && Number.isFinite(age) && age < 30 * 60_000) {
        throw new Error("an index is currently running for this branch — retry after it finishes");
      }
    } catch (e) {
      if (e instanceof Error && /currently running/.test(e.message)) throw e;
    }
  }

  // Toggle a branch's pinned flag. Pinned branches are exempt from every
  // automatic retention mechanism and refuse CLI deletion (unpin first).
  toggleBranchPinned(branchId: string): boolean {
    this.db.prepare("UPDATE branches SET pinned = 1 - pinned WHERE id = ?").run(branchId);
    const row = this.db.prepare("SELECT pinned FROM branches WHERE id = ?").get(branchId) as
      | { pinned: number }
      | undefined;
    return !!row?.pinned;
  }

  // Remove ONE branch: purge its branch-scoped rows, then GC only nodes with
  // no remaining liveness anywhere (versions, edges, notes, credentials,
  // response samples; file nodes also checked against files_index). Branchless
  // parser edges (global gRPC invokes/handles) are NOT branch-owned and are
  // never touched here — design review Q1.
  removeBranch(branchId: string): void {
    const branch = this.db
      .prepare("SELECT repo_id FROM branches WHERE id = ?")
      .get(branchId) as { repo_id: string } | undefined;
    if (!branch) return;
    this.assertNoFreshIndexMarker(branchId);
    const repoId = branch.repo_id;
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM edges WHERE branch_id = ?").run(branchId);
      this.db.prepare("DELETE FROM symbol_versions WHERE branch_id = ?").run(branchId);
      this.db.prepare("DELETE FROM files_index WHERE branch_id = ?").run(branchId);
      this.db.prepare("DELETE FROM branches WHERE id = ?").run(branchId);
      this.db.exec(`
        CREATE TEMP TABLE IF NOT EXISTS gc_nodes (id TEXT PRIMARY KEY);
        DELETE FROM gc_nodes;
      `);
      this.db
        .prepare(
          `INSERT INTO gc_nodes
           SELECT n.id FROM nodes n
           WHERE n.repo_id = ?
             AND n.node_type IN ('symbol','file','endpoint','entity','service','route')
             AND NOT EXISTS (SELECT 1 FROM symbol_versions sv WHERE sv.node_id = n.id)
             AND NOT EXISTS (SELECT 1 FROM edges e WHERE e.src = n.id OR e.dst = n.id)
             AND NOT EXISTS (SELECT 1 FROM notes_index ni WHERE ni.node_id = n.id)
             AND NOT EXISTS (SELECT 1 FROM credential_entries ce WHERE ce.node_id = n.id)
             AND NOT EXISTS (
               SELECT 1 FROM response_samples rs
               WHERE rs.endpoint_id = n.id OR rs.endpoint_key = n.identity_key
             )
             AND (n.node_type <> 'file' OR NOT EXISTS (
               SELECT 1 FROM files_index fi
               WHERE fi.repo_id = n.repo_id
                 AND n.identity_key = n.repo_id || '::file::' || fi.file_path
             ))`,
        )
        .run(repoId);
      this.db.exec(`
        -- pending frontend rows whose source symbol is being GC'd would make a
        -- later replay insert an orphan-src edge — drop them with the node.
        DELETE FROM pending_frontend_edges WHERE src_node_id IN (SELECT id FROM gc_nodes);
        DELETE FROM fts_symbols WHERE node_id IN (SELECT id FROM gc_nodes);
        DELETE FROM node_aliases WHERE node_id IN (SELECT id FROM gc_nodes);
        DELETE FROM nodes WHERE id IN (SELECT id FROM gc_nodes);
        DROP TABLE gc_nodes;
      `);
    });
    tx();
  }

  // Remove one repo and ALL its derived data (nodes, edges, versions, file
  // checkpoints, FTS rows, pending frontend rows, branches). Parser data only —
  // rebuildable by re-indexing; the append-only ledger stays untouched. Global
  // (repo-less) gRPC endpoint nodes survive: other repos may reference them,
  // and dangling ones are hidden by the UI / cleaned by their own pass.
  removeRepo(repoId: string): void {
    const tx = this.db.transaction(() => {
      // Edges: branch-scoped (this repo's branches), branchless parser edges
      // provenanced to this repo, and anything touching this repo's nodes.
      this.db.prepare(
        "DELETE FROM edges WHERE branch_id IN (SELECT id FROM branches WHERE repo_id = ?)",
      ).run(repoId);
      this.db.prepare(
        "DELETE FROM edges WHERE json_extract(provenance, '$.repo') = ?",
      ).run(repoId);
      this.db.prepare(
        `DELETE FROM edges WHERE src IN (SELECT id FROM nodes WHERE repo_id = ?)
           OR dst IN (SELECT id FROM nodes WHERE repo_id = ?)`,
      ).run(repoId, repoId);
      this.db.prepare(
        "DELETE FROM fts_symbols WHERE node_id IN (SELECT id FROM nodes WHERE repo_id = ?)",
      ).run(repoId);
      this.db.prepare(
        "DELETE FROM symbol_versions WHERE branch_id IN (SELECT id FROM branches WHERE repo_id = ?)",
      ).run(repoId);
      this.db.prepare(
        "DELETE FROM symbol_versions WHERE node_id IN (SELECT id FROM nodes WHERE repo_id = ?)",
      ).run(repoId);
      this.db.prepare("DELETE FROM pending_frontend_edges WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM files_index WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM workspace_repos WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM nodes WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM branches WHERE repo_id = ?").run(repoId);
      this.db.prepare("DELETE FROM repos WHERE id = ?").run(repoId);
    });
    tx();
  }

  // Purge notes whose markdown file no longer exists on disk. The file IS the
  // source of truth (see notes-fs.ts) — a DB-only note is stale residue that
  // reads as alive in the UI until the next DB wipe silently loses it forever
  // (audit F-3). Derived rows only; the append-only ledger is untouched.
  pruneMissingNotes(existingPaths: Set<string>): number {
    const rows = this.db
      .prepare("SELECT node_id, path FROM notes_index")
      .all() as Array<{ node_id: string; path: string }>;
    let pruned = 0;
    for (const r of rows) {
      if (existingPaths.has(r.path)) continue;
      this.db.prepare("DELETE FROM notes_index WHERE node_id = ?").run(r.node_id);
      this.db.prepare("DELETE FROM fts_notes WHERE node_id = ?").run(r.node_id);
      this.db.prepare("DELETE FROM edges WHERE src = ? OR dst = ?").run(r.node_id, r.node_id);
      this.db.prepare("DELETE FROM nodes WHERE id = ?").run(r.node_id);
      pruned += 1;
    }
    return pruned;
  }

  getAliases(nodeId: string): Array<{
    aliasKey: string;
    aliasType: string;
    reason: string | null;
    validFrom: string | null;
    validTo: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT alias_key AS aliasKey, alias_type AS aliasType, reason,
                valid_from AS validFrom, valid_to AS validTo
         FROM node_aliases WHERE node_id = ? ORDER BY created_at`,
      )
      .all(nodeId) as Array<{
      aliasKey: string;
      aliasType: string;
      reason: string | null;
      validFrom: string | null;
      validTo: string | null;
    }>;
  }

  // §9：启动/定期对账。账本领先 → 自动 replay 追平；
  // 账本尾部损坏 → 报告截断行（有效前缀照常使用），不阻塞。
  consistencyCheck(): {
    ledgerSeq: number;
    materializedSeq: number;
    status: "ok" | "index_behind";
    ledgerTruncatedAtLine: number | null;
  } {
    const read = readLedgerFile(this.ledgerPath);
    const ledgerSeq =
      read.events.length > 0 ? read.events[read.events.length - 1].seq : 0;
    let state = this.db
      .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'")
      .get() as { materialized_seq: number };

    if (state.materialized_seq < ledgerSeq) {
      materialize(this.db, read.events);
      state = this.db
        .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'")
        .get() as { materialized_seq: number };
    }

    return {
      ledgerSeq,
      materializedSeq: state.materialized_seq,
      status: state.materialized_seq >= ledgerSeq ? "ok" : "index_behind",
      ledgerTruncatedAtLine: read.truncatedAtLine,
    };
  }
}
