import { createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

function suggestionId(queryHash: string, scopeHash: string): string {
  return `reflection_${createHash("sha256").update(`${queryHash}:${scopeHash}`).digest("hex").slice(0, 24)}`;
}

export interface ReflectionSuggestion {
  id: string;
  status: string;
  reproduction: Record<string, unknown>;
  evidence: Record<string, unknown>;
  createdAt: string;
  reviewedAt?: string;
}

/** Offline-only feedback aggregation. It writes pending, replayable suggestions
 * but never changes ranking weights or source truth. */
export function reflectSearchFeedback(store: KnowledgeStore): { status: "ok" | "insufficient_evidence"; deadEnds: number; suggestions: string[] } {
  const deadEnds = Number((store.db.prepare("SELECT COUNT(*) AS n FROM search_feedback WHERE verdict='dead_end'").get() as { n: number }).n ?? 0);
  if (deadEnds < 2) return { status: "insufficient_evidence", deadEnds, suggestions: [] };
  const groups = store.db.prepare("SELECT query_hash AS queryHash,scope_hash AS scopeHash,capability_hash AS capabilityHash,COUNT(*) AS count,GROUP_CONCAT(hit_id) AS hitIds FROM search_feedback WHERE verdict='dead_end' GROUP BY query_hash,scope_hash,capability_hash HAVING COUNT(*)>=2").all() as Array<{ queryHash: string; scopeHash: string; capabilityHash: string; count: number; hitIds: string }>;
  const suggestions: string[] = [];
  for (const group of groups) {
    const id = suggestionId(group.queryHash, group.scopeHash);
    store.db.prepare("INSERT INTO reflection_suggestions(id,status,reproduction_json,evidence_json,created_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json").run(
      id,
      "pending",
      JSON.stringify({ queryHash: group.queryHash, scopeHash: group.scopeHash, capabilityHash: group.capabilityHash }),
      JSON.stringify({ kind: "repeated_dead_end", count: group.count, hitIds: group.hitIds.split(","), replay: "rerun the original hashed query within the recorded scope" }),
      new Date().toISOString(),
    );
    suggestions.push(id);
  }
  return { status: "ok", deadEnds, suggestions };
}

export function listReflectionSuggestions(store: KnowledgeStore, status?: string): ReflectionSuggestion[] {
  const rows = status
    ? store.db.prepare("SELECT id,status,reproduction_json AS reproduction,evidence_json AS evidence,created_at AS createdAt,reviewed_at AS reviewedAt FROM reflection_suggestions WHERE status=? ORDER BY created_at DESC").all(status)
    : store.db.prepare("SELECT id,status,reproduction_json AS reproduction,evidence_json AS evidence,created_at AS createdAt,reviewed_at AS reviewedAt FROM reflection_suggestions ORDER BY created_at DESC").all();
  return (rows as Array<Record<string, unknown>>).map((row) => ({ id: String(row.id), status: String(row.status), reproduction: JSON.parse(String(row.reproduction)), evidence: JSON.parse(String(row.evidence)), createdAt: String(row.createdAt), ...(row.reviewedAt ? { reviewedAt: String(row.reviewedAt) } : {}) }));
}

export function reviewReflectionSuggestion(store: KnowledgeStore, id: string, status: "accepted" | "rejected"): boolean {
  if (status !== "accepted" && status !== "rejected") throw new Error("REFLECTION_STATUS_INVALID");
  return store.db.prepare("UPDATE reflection_suggestions SET status=?,reviewed_at=? WHERE id=? AND status='pending'").run(status, new Date().toISOString(), id).changes > 0;
}
