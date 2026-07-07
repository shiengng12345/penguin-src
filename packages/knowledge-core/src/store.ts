import { randomUUID } from "node:crypto";
import type DatabaseCtor from "better-sqlite3";
import { Ledger, readLedgerFile } from "./ledger.js";

type Database = DatabaseCtor.Database;
import type { LedgerEvent, LedgerEventInput } from "./ledger.js";
import { materialize } from "./materializer.js";
import { openDatabase } from "./schema.js";

export interface ParsedEdge {
  src: string;
  dst: string | null;
  rawTarget?: string | null;
  edgeType: string;
  origin: "parser";
  method: "EXTRACTED" | "INFERRED";
  confidence?: number;
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
    materialize(this.db, [event]);
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
           meta = CASE WHEN @metaProvided = 1 THEN excluded.meta ELSE nodes.meta END
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

  // 解析产出的代码边：同 file+branch 全量替换（§6.3 增量语义）。
  // 非 parser 边在这里是实现错误，不是数据——直接抛。
  replaceFileEdges(p: {
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
    const del = this.db.prepare(
      `DELETE FROM edges WHERE branch_id = ? AND origin = 'parser'
       AND json_extract(provenance, '$.file') = ?`,
    );
    const ins = this.db.prepare(
      `INSERT INTO edges (id, src, dst, raw_target, edge_type, branch_id,
         origin, method, confidence, provenance)
       VALUES (?, ?, ?, ?, ?, ?, 'parser', ?, ?, ?)`,
    );
    const tx = this.db.transaction(() => {
      del.run(p.branchId, p.filePath);
      for (const e of p.edges) {
        ins.run(
          `edge_${randomUUID()}`,
          e.src,
          e.dst,
          e.rawTarget ?? null,
          e.edgeType,
          p.branchId,
          e.method,
          e.confidence ?? 1.0,
          JSON.stringify({ file: p.filePath }),
        );
      }
    });
    tx();
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

  searchText(
    query: string,
    opts?: { types?: string[]; includeSensitive?: boolean; limit?: number },
  ): SearchHit[] {
    const limit = opts?.limit ?? 50;
    // FTS5 查询串加引号转义，避免用户输入被当作查询语法
    const match = `"${query.replace(/"/g, '""')}"`;

    const noteRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.node_type AS nodeType, n.title AS title,
                snippet(fts_notes, 2, '[', ']', '…', 12) AS snippet
         FROM fts_notes f
         JOIN nodes n ON n.id = f.node_id
         JOIN notes_index ni ON ni.node_id = f.node_id
         WHERE fts_notes MATCH ?
           AND (? = 1 OR (ni.sensitive = 0 AND ni.mcp_access = 'allowed'))
         LIMIT ?`,
      )
      .all(match, opts?.includeSensitive ? 1 : 0, limit) as SearchHit[];

    const symbolRows = this.db
      .prepare(
        `SELECT n.id AS nodeId, n.node_type AS nodeType, n.title AS title,
                NULL AS snippet
         FROM fts_symbols f
         JOIN nodes n ON n.id = f.node_id
         WHERE fts_symbols MATCH ?
         LIMIT ?`,
      )
      .all(match, limit) as SearchHit[];

    let hits = [...noteRows, ...symbolRows];
    if (opts?.types?.length) {
      hits = hits.filter((h) => opts.types!.includes(h.nodeType));
    }
    return hits.slice(0, limit);
  }

  resolveIdentity(
    key: string,
  ): { nodeId: string; via: "identity" | "alias" } | null {
    const direct = this.db
      .prepare("SELECT id FROM nodes WHERE identity_key = ?")
      .get(key) as { id: string } | undefined;
    if (direct) return { nodeId: direct.id, via: "identity" };

    const alias = this.db
      .prepare(
        `SELECT node_id FROM node_aliases
         WHERE alias_key = ? AND valid_to IS NULL
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(key) as { node_id: string } | undefined;
    if (alias) return { nodeId: alias.node_id, via: "alias" };
    return null;
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
