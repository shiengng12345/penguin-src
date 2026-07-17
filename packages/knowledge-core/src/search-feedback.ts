import { createHash, randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
export type FeedbackVerdict = "useful" | "dead_end" | "corrected";
export function recordSearchFeedback(store: KnowledgeStore, input: { query: string; hitId: string; verdict: FeedbackVerdict; correction?: { preferredHitId?: string; note?: string }; scopeHash: string; capabilityHash: string }): string {
  const id = `feedback_${randomUUID()}`;
  const queryHash = createHash("sha256").update(input.query).digest("hex");
  const correction = input.correction ? JSON.stringify(input.correction) : null;
  store.db.transaction(() => {
    store.db.prepare("INSERT INTO search_feedback(id,query_hash,hit_id,verdict,correction_json,scope_hash,capability_hash,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, queryHash, input.hitId, input.verdict, correction, input.scopeHash, input.capabilityHash, new Date().toISOString());
    if (input.verdict === "corrected") store.db.prepare("INSERT INTO reflection_suggestions(id,status,reproduction_json,evidence_json,created_at) VALUES (?,?,?,?,?)").run(`suggestion_${id}`, "pending", JSON.stringify({ queryHash, scopeHash: input.scopeHash, hitId: input.hitId }), JSON.stringify({ feedbackId: id, correction: input.correction ?? null }), new Date().toISOString());
  })();
  return id;
}
export function listSearchFeedback(store: KnowledgeStore, limit = 100): Array<Record<string, unknown>> { return store.db.prepare("SELECT id,query_hash AS queryHash,hit_id AS hitId,verdict,correction_json AS correction,scope_hash AS scopeHash,capability_hash AS capabilityHash,created_at AS createdAt FROM search_feedback ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>; }
export function deleteSearchFeedback(store: KnowledgeStore, id: string): boolean { return store.db.prepare("DELETE FROM search_feedback WHERE id=?").run(id).changes > 0; }
export function exportSearchFeedback(store: KnowledgeStore, input: { scopeHash?: string; from?: string; to?: string; limit?: number } = {}): Array<Record<string, unknown>> {
  const clauses = ["1=1"]; const params: unknown[] = [];
  if (input.scopeHash) { clauses.push("scope_hash=?"); params.push(input.scopeHash); }
  if (input.from) { clauses.push("created_at>=?"); params.push(input.from); }
  if (input.to) { clauses.push("created_at<=?"); params.push(input.to); }
  params.push(input.limit ?? 1000);
  return store.db.prepare(`SELECT id,query_hash AS queryHash,hit_id AS hitId,verdict,correction_json AS correction,scope_hash AS scopeHash,capability_hash AS capabilityHash,created_at AS createdAt FROM search_feedback WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
}
