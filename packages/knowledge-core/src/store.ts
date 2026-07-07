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
    const existing = this.db
      .prepare("SELECT id FROM nodes WHERE node_type = ? AND identity_key = ?")
      .get(n.nodeType, n.identityKey) as { id: string } | undefined;
    if (existing) {
      this.db
        .prepare("UPDATE nodes SET title = ?, meta = ? WHERE id = ?")
        .run(n.title, JSON.stringify(n.meta ?? {}), existing.id);
      return existing.id;
    }
    const id = `node_${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO nodes (id, node_type, identity_key, repo_id, title, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        n.nodeType,
        n.identityKey,
        n.repoId ?? null,
        n.title,
        JSON.stringify(n.meta ?? {}),
        new Date().toISOString(),
      );
    return id;
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
}
