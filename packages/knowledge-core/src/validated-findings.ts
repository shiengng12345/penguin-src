import { randomUUID } from "node:crypto";
import type { KnowledgeStore } from "./store.js";
import type { EvidenceRecord } from "./evidence-state.js";

export type FindingStatus = "draft" | "reproduced" | "validated" | "contradicted" | "resolved";
export interface ValidatedFinding {
  id: string;
  title: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  claim: string;
  affectedScopes: unknown[];
  reproduction: unknown;
  status: FindingStatus;
  gaps: string[];
  createdAt: string;
  updatedAt: string;
  evidence: Array<{ evidenceId: string; role: string; status?: EvidenceRecord["status"] }>;
}

const TRANSITIONS: Record<FindingStatus, FindingStatus[]> = {
  draft: ["reproduced", "contradicted"],
  reproduced: ["validated", "contradicted", "draft"],
  validated: ["resolved", "contradicted"],
  contradicted: ["draft", "resolved"],
  resolved: [],
};

export class ValidatedFindingStore {
  constructor(private readonly store: KnowledgeStore) {}

  create(input: Omit<ValidatedFinding, "id" | "createdAt" | "updatedAt" | "status" | "evidence"> & { status?: FindingStatus }): ValidatedFinding {
    const now = new Date().toISOString();
    const finding: ValidatedFinding = { ...input, id: `finding_${randomUUID()}`, status: input.status ?? "draft", evidence: [], createdAt: now, updatedAt: now };
    this.store.db.prepare("INSERT INTO validated_findings(id,title,severity,claim,affected_scopes_json,reproduction_json,status,gaps_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(finding.id, finding.title, finding.severity, finding.claim, JSON.stringify(finding.affectedScopes), JSON.stringify(finding.reproduction), finding.status, JSON.stringify(finding.gaps), now, now);
    return finding;
  }

  get(id: string): ValidatedFinding | undefined {
    const row = this.store.db.prepare("SELECT * FROM validated_findings WHERE id=?").get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    const evidence = this.store.db.prepare("SELECT fe.evidence_id AS evidenceId,fe.evidence_role AS role,te.status FROM finding_evidence fe LEFT JOIN trust_evidence te ON te.id=fe.evidence_id WHERE fe.finding_id=? ORDER BY fe.evidence_id,fe.evidence_role").all(id) as Array<{ evidenceId: string; role: string; status?: EvidenceRecord["status"] }>;
    return { id: row.id, title: row.title, severity: row.severity as ValidatedFinding["severity"], claim: row.claim, affectedScopes: JSON.parse(row.affected_scopes_json), reproduction: JSON.parse(row.reproduction_json), status: row.status as FindingStatus, gaps: JSON.parse(row.gaps_json), createdAt: row.created_at, updatedAt: row.updated_at, evidence };
  }

  list(status?: FindingStatus): ValidatedFinding[] {
    const ids = (status ? this.store.db.prepare("SELECT id FROM validated_findings WHERE status=? ORDER BY updated_at DESC").all(status) : this.store.db.prepare("SELECT id FROM validated_findings ORDER BY updated_at DESC").all()) as Array<{ id: string }>;
    return ids.map((row) => this.get(row.id)!).filter(Boolean);
  }

  transition(id: string, to: FindingStatus): ValidatedFinding {
    const current = this.get(id);
    if (!current) throw new Error("FINDING_NOT_FOUND");
    if (!TRANSITIONS[current.status].includes(to)) throw new Error(`FINDING_INVALID_TRANSITION:${current.status}->${to}`);
    if (to === "validated") {
      const reproduction = current.reproduction as { safe?: boolean; steps?: unknown[]; expected?: string; observed?: string };
      if (reproduction?.safe !== true || !Array.isArray(reproduction.steps) || !reproduction.expected || !reproduction.observed) throw new Error("FINDING_REPRODUCTION_UNAVAILABLE");
      if (!current.evidence.length || current.evidence.some((item) => item.status === "stale" || item.status === "contradicted")) throw new Error("FINDING_EVIDENCE_INSUFFICIENT");
    }
    const updatedAt = new Date().toISOString();
    this.store.db.prepare("UPDATE validated_findings SET status=?,updated_at=? WHERE id=?").run(to, updatedAt, id);
    return this.get(id)!;
  }

  attachEvidence(findingId: string, evidenceId: string, role: "primary" | "reproduction" | "counterexample" | "context"): ValidatedFinding {
    if (!this.get(findingId)) throw new Error("FINDING_NOT_FOUND");
    if (!this.store.db.prepare("SELECT 1 FROM trust_evidence WHERE id=?").get(evidenceId)) throw new Error("EVIDENCE_NOT_FOUND");
    this.store.db.prepare("INSERT OR IGNORE INTO finding_evidence(finding_id,evidence_id,evidence_role) VALUES (?,?,?)").run(findingId, evidenceId, role);
    this.store.db.prepare("UPDATE validated_findings SET updated_at=? WHERE id=?").run(new Date().toISOString(), findingId);
    return this.get(findingId)!;
  }
}
