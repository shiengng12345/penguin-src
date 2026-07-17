import type { KnowledgeStore } from "./store.js";

export interface OntologyTerm {
  id: string;
  canonicalName: string;
  aliases: string[];
  scope: { workspaceId?: string; repoIds?: string[] };
  type: "actor" | "capability" | "entity" | "state" | "event" | "system";
  definition: string;
  evidence: unknown[];
  status: "draft" | "reviewed" | "verified" | "stale";
}

export interface OntologyAliasCandidate { id: string; canonicalName: string; type: OntologyTerm["type"]; scope: OntologyTerm["scope"]; }
export type OntologyAliasResolution =
  | { status: "none"; candidates: [] }
  | { status: "unique"; term: OntologyAliasCandidate }
  | { status: "ambiguous"; candidates: OntologyAliasCandidate[] };

function normalize(value: string): string { return value.trim().toLocaleLowerCase(); }
function scopesOverlap(a: OntologyTerm["scope"], b: OntologyTerm["scope"]): boolean {
  if (a.workspaceId && b.workspaceId && a.workspaceId !== b.workspaceId) return false;
  if (a.repoIds?.length && b.repoIds?.length && !a.repoIds.some((id) => b.repoIds!.includes(id))) return false;
  return true;
}
function candidate(row: Record<string, string>): OntologyAliasCandidate { return { id: row.id, canonicalName: row.canonical_name, type: row.term_type as OntologyTerm["type"], scope: JSON.parse(row.scope_json) as OntologyTerm["scope"] }; }

export class OntologyStore {
  constructor(private readonly store: KnowledgeStore) {}

  private rows(): Array<Record<string, string>> { return this.store.db.prepare("SELECT * FROM ontology_terms ORDER BY canonical_name").all() as Array<Record<string, string>>; }

  resolveAlias(alias: string, scope: OntologyTerm["scope"] = {}): OntologyAliasResolution {
    const needle = normalize(alias);
    if (!needle) return { status: "none", candidates: [] };
    const matches = this.rows().filter((row) => {
      const term = JSON.parse(row.aliases_json) as string[];
      return (normalize(row.canonical_name) === needle || term.some((item) => normalize(item) === needle)) && scopesOverlap(JSON.parse(row.scope_json) as OntologyTerm["scope"], scope);
    }).map(candidate);
    if (matches.length === 0) return { status: "none", candidates: [] };
    if (matches.length === 1) return { status: "unique", term: matches[0] };
    return { status: "ambiguous", candidates: matches };
  }

  /** Return an explicit resolution; callers can refuse ambiguous aliases. */
  upsert(term: OntologyTerm): OntologyAliasResolution {
    const conflicts = this.rows().filter((row) => row.id !== term.id && scopesOverlap(JSON.parse(row.scope_json) as OntologyTerm["scope"], term.scope))
      .filter((row) => {
        const names = [row.canonical_name, ...(JSON.parse(row.aliases_json) as string[])].map(normalize);
        return [term.canonicalName, ...term.aliases].some((name) => names.includes(normalize(name)));
      }).map(candidate);
    if (conflicts.length) return { status: "ambiguous", candidates: conflicts };
    this.store.db.prepare("INSERT INTO ontology_terms(id,canonical_name,aliases_json,scope_json,term_type,definition,evidence_json,status) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET canonical_name=excluded.canonical_name,aliases_json=excluded.aliases_json,scope_json=excluded.scope_json,definition=excluded.definition,evidence_json=excluded.evidence_json,status=excluded.status")
      .run(term.id, term.canonicalName, JSON.stringify(term.aliases), JSON.stringify(term.scope), term.type, term.definition, JSON.stringify(term.evidence), term.status);
    return { status: "unique", term: { id: term.id, canonicalName: term.canonicalName, type: term.type, scope: term.scope } };
  }

  /** Expansion is deliberately unavailable for an ambiguous alias. */
  expansion(query: string, scope: OntologyTerm["scope"] = {}): { terms: string[]; boost: number; ambiguous: OntologyAliasCandidate[] } {
    const resolved = this.resolveAlias(query, scope);
    if (resolved.status === "ambiguous") return { terms: [], boost: 0, ambiguous: resolved.candidates };
    if (resolved.status === "none") return { terms: [], boost: 0, ambiguous: [] };
    const row = this.rows().find((item) => item.id === resolved.term.id);
    if (!row) return { terms: [], boost: 0, ambiguous: [] };
    const aliases = JSON.parse(row.aliases_json) as string[];
    return { terms: [...new Set([row.canonical_name, ...aliases])].filter((term) => normalize(term) !== normalize(query)), boost: 0.04, ambiguous: [] };
  }

  link(fromId: string, toId: string, relation: string, evidence: unknown[] = []): void {
    if (!this.store.db.prepare("SELECT 1 FROM ontology_terms WHERE id=?").get(fromId) || !this.store.db.prepare("SELECT 1 FROM ontology_terms WHERE id=?").get(toId)) throw new Error("ONTOLOGY_TERM_NOT_FOUND");
    this.store.db.prepare("INSERT OR REPLACE INTO ontology_links(from_id,to_id,relation,evidence_json) VALUES (?,?,?,?)").run(fromId, toId, relation, JSON.stringify(evidence));
  }

  list(): OntologyTerm[] {
    return this.rows().map((row) => ({ id: row.id, canonicalName: row.canonical_name, aliases: JSON.parse(row.aliases_json), scope: JSON.parse(row.scope_json), type: row.term_type as OntologyTerm["type"], definition: row.definition, evidence: JSON.parse(row.evidence_json), status: row.status as OntologyTerm["status"] }));
  }
}
