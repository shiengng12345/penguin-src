import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface AuditAppendInput {
  capabilityId: string;
  actorId: string;
  scopeHash: string;
  input: unknown;
  resultCode: string;
}

export interface AuditAppendOptions {
  eventId?: string;
  inputDigest?: string;
}

export class AuditStore {
  constructor(private readonly store: KnowledgeStore) {}

  /** Append to the single global hash chain under a SQLite write lock. When a
   * caller already owns a transaction, the no-op write upgrades a deferred
   * transaction before reading the tail without creating a nested savepoint. */
  append(input: AuditAppendInput, options: AuditAppendOptions = {}): string {
    const appendLocked = () => {
      this.store.db.prepare(
        "UPDATE knowledge_audit_events SET previous_hash=previous_hash WHERE 0",
      ).run();
      const previous = this.store.db.prepare(
        "SELECT event_hash FROM knowledge_audit_events ORDER BY seq DESC LIMIT 1",
      ).get() as { event_hash: string } | undefined;
      const eventId = options.eventId ?? `audit_${randomUUID()}`;
      const createdAt = new Date().toISOString();
      const inputDigest = options.inputDigest ?? digest(input.input);
      const previousHash = previous?.event_hash ?? null;
      const eventHash = digest({
        eventId,
        previousHash,
        capabilityId: input.capabilityId,
        actorId: input.actorId,
        scopeHash: input.scopeHash,
        inputDigest,
        resultCode: input.resultCode,
        createdAt,
      });
      this.store.db.prepare(`
        INSERT INTO knowledge_audit_events
          (event_id,previous_hash,event_hash,capability_id,actor_id,scope_hash,input_digest,result_code,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(
        eventId,
        previousHash,
        eventHash,
        input.capabilityId,
        input.actorId,
        input.scopeHash,
        inputDigest,
        input.resultCode,
        createdAt,
      );
      return eventId;
    };
    return this.store.db.inTransaction
      ? appendLocked()
      : this.store.db.transaction(appendLocked).immediate();
  }

  verify(): { ok: boolean; brokenAt?: number } {
    let previous: string | null = null;
    for (const row of this.store.db.prepare("SELECT * FROM knowledge_audit_events ORDER BY seq").all() as Array<Record<string, string | number>>) {
      if ((row.previous_hash ?? null) !== previous) return { ok: false, brokenAt: Number(row.seq) };
      previous = String(row.event_hash);
    }
    return { ok: true };
  }

  list(input: { scopeHash?: string; from?: string; to?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    const clauses = ["1=1"];
    const params: unknown[] = [];
    if (input.scopeHash) { clauses.push("scope_hash=?"); params.push(input.scopeHash); }
    if (input.from) { clauses.push("created_at>=?"); params.push(input.from); }
    if (input.to) { clauses.push("created_at<=?"); params.push(input.to); }
    params.push(input.limit ?? 1000);
    return this.store.db.prepare(`
      SELECT seq,event_id AS eventId,capability_id AS capabilityId,actor_id AS actorId,
             scope_hash AS scopeHash,input_digest AS inputDigest,result_code AS resultCode,
             created_at AS createdAt,event_hash AS eventHash
        FROM knowledge_audit_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY seq LIMIT ?
    `).all(...params) as Array<Record<string, unknown>>;
  }

  export(input: { scopeHash?: string; from?: string; to?: string; limit?: number } = {}): Array<Record<string, unknown>> {
    return this.list(input);
  }
}
