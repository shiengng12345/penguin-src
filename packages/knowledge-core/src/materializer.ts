import type DatabaseCtor from "better-sqlite3";
import type { LedgerEvent } from "./ledger.js";

type Database = DatabaseCtor.Database;

// 传入的事件与已物化位置之间有断档（materialized_seq+1 缺失）。发生在多进程
// 场景：另一进程追加了 seq N，本进程 DB 尚未物化，本进程又追加 seq N+1 并只
// 传了自己这条。若直接应用会把 materialized_seq 越过 N，导致 N 永久不被物化
// （连全量重放也跳过）。抛出让调用方改走「读全账本重放」补齐（终审 Important）。
export class LedgerGapError extends Error {
  constructor(
    readonly expectedSeq: number,
    readonly gotSeq: number,
  ) {
    super(
      `ledger materialize gap: expected seq ${expectedSeq}, got ${gotSeq} — caller must replay the full ledger`,
    );
    this.name = "LedgerGapError";
  }
}

// Ledger → SQLite 物化（§2.1/§2.2）。
// events/node_aliases/manual edges 是账本的物化视图——本模块是唯一写它们的地方。
// 物化行 id 从账本事件 id 确定性派生，保证「删库重放」结果逐字节可复现。
export function materialize(
  db: Database,
  events: LedgerEvent[],
): { applied: number } {
  const state = db
    .prepare("SELECT materialized_seq FROM ledger_state WHERE id='main'")
    .get() as { materialized_seq: number };
  const pending = events
    .filter((e) => e.seq > state.materialized_seq)
    .sort((a, b) => a.seq - b.seq);
  if (pending.length === 0) return { applied: 0 };
  // 只允许从 materialized_seq+1 连续物化；断档必须由调用方全量重放补齐。
  if (pending[0].seq !== state.materialized_seq + 1) {
    throw new LedgerGapError(state.materialized_seq + 1, pending[0].seq);
  }

  const insertEvent = db.prepare(`
    INSERT INTO events (id, ledger_seq, ts, event_type, node_id, edge_id,
      branch_id, repo_id, workspace_id, origin, method, payload, provenance)
    VALUES (@id, @ledger_seq, @ts, @event_type, @node_id, @edge_id,
      @branch_id, @repo_id, @workspace_id, @origin, @method, @payload, @provenance)
  `);
  const upsertAlias = db.prepare(`
    INSERT INTO node_aliases (id, node_id, alias_key, alias_type,
      current_identity_key, valid_from, reason, confidence, created_at)
    VALUES (@id, @node_id, @alias_key, @alias_type,
      @current_identity_key, @valid_from, @reason, @confidence, @created_at)
    ON CONFLICT (node_id, alias_key, alias_type) DO UPDATE SET
      valid_to = NULL, reason = @reason, confidence = @confidence
  `);
  // 与 events 一致 fail-loud：重放已物化事件只会发生在 ledger_state 被人为破坏时，
  // 此时应报错回滚（spec §9 绝不静默），而不是静默跳过。
  const insertEdge = db.prepare(`
    INSERT INTO edges (id, src, dst, raw_target, edge_type,
      branch_id, origin, method, confidence, provenance)
    VALUES (@id, @src, @dst, @raw_target, @edge_type,
      @branch_id, @origin, @method, @confidence, @provenance)
  `);
  // AI suggestion edge (pending confirmation, §8.2/§11): status='suggested' so
  // queries exclude it by default until accepted.
  const insertSuggestedEdge = db.prepare(`
    INSERT INTO edges (id, src, dst, raw_target, edge_type,
      branch_id, origin, method, confidence, provenance, status)
    VALUES (@id, @src, @dst, @raw_target, @edge_type,
      @branch_id, 'ai', 'INFERRED', @confidence, @provenance, 'suggested')
  `);
  const insertResponseSample = db.prepare(`
    INSERT INTO response_samples (id, endpoint_id, endpoint_key, status, content_type, sample, captured_at)
    VALUES (@id, @endpoint_id, @endpoint_key, @status, @content_type, @sample, @captured_at)
  `);
  const setEdgeStatus = db.prepare(
    "UPDATE edges SET status = @status, method = @method, confidence = @confidence WHERE id = @id",
  );
  const undoAlias = db.prepare(`
    UPDATE node_aliases SET valid_to = @valid_to
    WHERE node_id = @node_id AND alias_key = @alias_key AND alias_type = @alias_type
  `);
  const lookupIdentity = db.prepare(
    "SELECT identity_key FROM nodes WHERE id = ?",
  );
  const advance = db.prepare(
    "UPDATE ledger_state SET materialized_seq = ?, materialized_at = ? WHERE id = 'main'",
  );

  const run = db.transaction((batch: LedgerEvent[]) => {
    for (const e of batch) {
      insertEvent.run({
        id: e.id,
        ledger_seq: e.seq,
        ts: e.ts,
        event_type: e.type,
        node_id: e.target?.node_id ?? null,
        edge_id: e.target?.edge_id ?? null,
        branch_id: e.target?.branch_id ?? null,
        repo_id: e.target?.repo_id ?? null,
        workspace_id: e.target?.workspace_id ?? null,
        origin: e.origin,
        method: e.method,
        payload: JSON.stringify(e.payload ?? {}),
        provenance: JSON.stringify(e.provenance ?? {}),
      });

      const p = (e.payload ?? {}) as Record<string, unknown>;
      switch (e.type) {
        case "node_alias_added": {
          const nodeId = e.target?.node_id;
          if (!nodeId) break;
          const identity = lookupIdentity.get(nodeId) as
            | { identity_key: string }
            | undefined;
          upsertAlias.run({
            id: `alias_${e.id}`,
            node_id: nodeId,
            alias_key: String(p.alias_key ?? ""),
            alias_type: String(p.alias_type ?? "qualified_name"),
            current_identity_key: identity?.identity_key ?? null,
            valid_from: e.ts,
            reason: p.reason == null ? null : String(p.reason),
            confidence: typeof p.confidence === "number" ? p.confidence : 1.0,
            created_at: e.ts,
          });
          break;
        }
        case "manual_edge_created": {
          insertEdge.run({
            id: `edge_${e.id}`,
            src: String(p.src ?? e.target?.node_id ?? ""),
            dst: p.dst == null ? null : String(p.dst),
            raw_target: p.raw_target == null ? null : String(p.raw_target),
            edge_type: String(p.edge_type ?? "wikilink"),
            branch_id: e.target?.branch_id ?? null,
            origin: e.origin,
            method: e.method,
            confidence: typeof p.confidence === "number" ? p.confidence : 1.0,
            provenance: JSON.stringify(e.provenance ?? {}),
          });
          break;
        }
        case "ai_suggestion_created": {
          insertSuggestedEdge.run({
            id: `edge_${e.id}`,
            src: String(p.src ?? e.target?.node_id ?? ""),
            dst: p.dst == null ? null : String(p.dst),
            raw_target: p.raw_target == null ? null : String(p.raw_target),
            edge_type: String(p.edge_type ?? "wikilink"),
            branch_id: e.target?.branch_id ?? null,
            confidence: typeof p.confidence === "number" ? p.confidence : 0.5,
            provenance: JSON.stringify(e.provenance ?? {}),
          });
          break;
        }
        case "ai_suggestion_accepted": {
          setEdgeStatus.run({
            id: `edge_${String(p.suggestion_event_id ?? "")}`,
            status: "active",
            method: "ASSERTED",
            confidence: 1.0,
          });
          break;
        }
        case "ai_suggestion_rejected": {
          setEdgeStatus.run({
            id: `edge_${String(p.suggestion_event_id ?? "")}`,
            status: "rejected",
            method: "INFERRED",
            confidence: 0.0,
          });
          break;
        }
        case "response_sample_captured": {
          insertResponseSample.run({
            id: `sample_${e.id}`,
            endpoint_id: String(p.endpoint_id ?? ""),
            endpoint_key: String(p.endpoint_key ?? ""),
            status: p.status == null ? null : String(p.status),
            content_type: p.content_type == null ? null : String(p.content_type),
            sample: String(p.sample ?? ""),
            captured_at: e.ts,
          });
          break;
        }
        case "alias_merge_undone": {
          undoAlias.run({
            valid_to: e.ts,
            node_id: e.target?.node_id ?? "",
            alias_key: String(p.alias_key ?? ""),
            alias_type: String(p.alias_type ?? "qualified_name"),
          });
          break;
        }
        default:
          break; // 其余类型只落 events 行（V1）
      }
    }
    const last = batch[batch.length - 1];
    advance.run(last.seq, new Date().toISOString());
  });

  run(pending);
  return { applied: pending.length };
}
