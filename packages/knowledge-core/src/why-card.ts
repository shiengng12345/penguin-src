import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import { AuditStore } from "./audit.js";

export interface WhyCard { id: string; subject: unknown; question: string; answer: string; decision: string; alternatives: Array<{ option: string; rejectedBecause: string }>; constraints: string[]; consequences: string[]; evidence: unknown[]; gaps: string[]; status: "draft" | "reviewed" | "verified" | "stale" | "disputed"; revisionId?: string; owners: string[]; createdAt: string; reviewedAt?: string; }
export function createWhyCard(input: Omit<WhyCard, "id" | "createdAt" | "status"> & { status?: WhyCard["status"] }): WhyCard { return { ...input, id: `why_${randomUUID()}`, status: input.status ?? (input.evidence.length > 0 && input.decision ? "draft" : "draft"), createdAt: new Date().toISOString() }; }
export function transitionWhyCard(card: WhyCard, to: WhyCard["status"]): WhyCard {
  const valid = (card.status === "draft" && ["reviewed", "disputed", "stale"].includes(to)) || (card.status === "reviewed" && ["verified", "disputed", "stale"].includes(to)) || (card.status === "verified" && to === "stale") || (card.status === "disputed" && to === "reviewed") || (card.status === "stale" && to === "reviewed");
  if (!valid) throw new Error(`WHY_INVALID_TRANSITION:${card.status}->${to}`);
  return { ...card, status: to, ...(to === "reviewed" || to === "verified" ? { reviewedAt: new Date().toISOString() } : {}) };
}
export class WhyCardStore {
  constructor(private readonly store: KnowledgeStore) {}
  put(card: WhyCard): void {
    const subject = JSON.stringify(card.subject);
    const conflicting = this.store.db.prepare("SELECT id FROM why_cards WHERE subject_json=? AND id<>? AND status IN ('reviewed','verified') AND decision<>?").all(subject, card.id, card.decision) as Array<{ id: string }>;
    if (conflicting.length && ["reviewed", "verified"].includes(card.status)) this.store.db.prepare("UPDATE why_cards SET status='disputed' WHERE id IN (" + conflicting.map(() => "?").join(",") + ")").run(...conflicting.map((row) => row.id));
    this.store.db.prepare(`INSERT INTO why_cards(id,subject_json,question,answer,decision,alternatives_json,constraints_json,consequences_json,evidence_json,gaps_json,status,revision_id,owners_json,created_at,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET answer=excluded.answer,decision=excluded.decision,evidence_json=excluded.evidence_json,gaps_json=excluded.gaps_json,status=excluded.status,reviewed_at=excluded.reviewed_at`).run(card.id, subject, card.question, card.answer, card.decision, JSON.stringify(card.alternatives), JSON.stringify(card.constraints), JSON.stringify(card.consequences), JSON.stringify(card.evidence), JSON.stringify(card.gaps), card.status, card.revisionId ?? null, JSON.stringify(card.owners), card.createdAt, card.reviewedAt ?? null);
  }
  get(id: string): WhyCard | undefined { const row = this.store.db.prepare("SELECT * FROM why_cards WHERE id=?").get(id) as Record<string, string> | undefined; if (!row) return undefined; return { id: row.id, subject: JSON.parse(row.subject_json), question: row.question, answer: row.answer, decision: row.decision, alternatives: JSON.parse(row.alternatives_json), constraints: JSON.parse(row.constraints_json), consequences: JSON.parse(row.consequences_json), evidence: JSON.parse(row.evidence_json), gaps: JSON.parse(row.gaps_json), status: row.status as WhyCard["status"], ...(row.revision_id ? { revisionId: row.revision_id } : {}), owners: JSON.parse(row.owners_json), createdAt: row.created_at, ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}) }; }
  transition(id: string, to: WhyCard["status"], actorId = "system"): WhyCard {
    const current = this.get(id);
    if (!current) throw new Error("WHY_CARD_NOT_FOUND");
    const next = transitionWhyCard(current, to);
    this.put(next);
    new AuditStore(this.store).append({ capabilityId: "knowledge.why.transition", actorId, scopeHash: `why:${id}`, input: { id, from: current.status, to }, resultCode: "ok" });
    return next;
  }
  markStaleByContentHash(contentHash: string, actorId = "system"): string[] {
    const rows = this.store.db.prepare("SELECT id,evidence_json FROM why_cards WHERE status='verified'").all() as Array<{ id: string; evidence_json: string }>;
    const ids = rows.filter((row) => row.evidence_json.includes(contentHash)).map((row) => row.id);
    for (const id of ids) { this.store.db.prepare("UPDATE why_cards SET status='stale' WHERE id=?").run(id); new AuditStore(this.store).append({ capabilityId: "knowledge.why.stale", actorId, scopeHash: `why:${id}`, input: { id, reason: "evidence_content_hash_changed" }, resultCode: "ok" }); }
    return ids;
  }
}
