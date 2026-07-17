import type { KnowledgeStore } from "./store.js";

export type DomainPersona = "frontend" | "backend" | "qa" | "sre" | "pm/security";
export interface DomainClaimCandidate {
  id: string;
  statement: string;
  kind: "actor" | "capability" | "entry_point" | "rule" | "state_change" | "side_effect" | "external_system" | "failure_mode";
  personas: DomainPersona[];
  evidence: Array<{ source: "graph" | "source" | "note"; nodeId?: string; filePath?: string; startLine?: number; endLine?: number }>;
  status: "candidate";
}
export interface DomainFlowStep { from: string; to: string; relation: string; evidence: DomainClaimCandidate["evidence"]; }

function personas(kind: DomainClaimCandidate["kind"]): DomainPersona[] {
  if (kind === "entry_point" || kind === "capability") return ["frontend", "backend", "qa", "pm/security"];
  if (kind === "failure_mode") return ["backend", "qa", "sre", "pm/security"];
  if (kind === "external_system" || kind === "side_effect") return ["backend", "sre", "pm/security"];
  return ["backend", "qa", "pm/security"];
}

/** Build auditable domain candidates from indexed facts. This deliberately
 * never upgrades an inference to a verified business truth. */
export function buildDomainClaims(store: KnowledgeStore, options: { repoId?: string; persona?: DomainPersona } = {}): DomainClaimCandidate[] {
  const params: unknown[] = [];
  const where = options.repoId ? "WHERE n.repo_id=? AND" : "WHERE";
  if (options.repoId) params.push(options.repoId);
  const nodes = store.db.prepare(`SELECT n.id,n.node_type AS nodeType,n.title,n.repo_id AS repoId,sv.file_path AS filePath,sv.start_line AS startLine,sv.end_line AS endLine
    FROM nodes n LEFT JOIN symbol_versions sv ON sv.node_id=n.id AND sv.status IN ('active','verified') ${where}
    n.node_type IN ('endpoint','service','entity','event','test','note') ORDER BY n.node_type,n.title,n.id`).all(...params) as Array<{ id: string; nodeType: string; title: string; filePath?: string; startLine?: number; endLine?: number }>;
  const claims: DomainClaimCandidate[] = [];
  for (const node of nodes) {
    const kind: DomainClaimCandidate["kind"] = node.nodeType === "endpoint" ? "entry_point" : node.nodeType === "service" ? "capability" : node.nodeType === "entity" ? "state_change" : node.nodeType === "event" ? "side_effect" : node.nodeType === "test" ? "rule" : "actor";
    const claim = { id: `domain_${node.id}_${kind}`, statement: `Candidate ${kind.replace("_", " ")} represented by ${node.title}.`, kind, personas: personas(kind), evidence: [{ source: node.nodeType === "note" ? "note" as const : "source" as const, nodeId: node.id, ...(node.filePath ? { filePath: node.filePath } : {}), ...(node.startLine ? { startLine: node.startLine } : {}), ...(node.endLine ? { endLine: node.endLine } : {}) }], status: "candidate" as const };
    if (!options.persona || claim.personas.includes(options.persona)) claims.push(claim);
  }
  return claims;
}

/** Revision-neutral graph view for domain explanations; every hop carries the
 * source locator of its source symbol when one is available. */
export function buildDomainFlow(store: KnowledgeStore, options: { repoId?: string; target?: string } = {}): DomainFlowStep[] {
  const params: unknown[] = [];
  const filters: string[] = ["e.status IN ('active','suggested')"];
  if (options.repoId) { filters.push("(src.repo_id=? OR dst.repo_id=?)"); params.push(options.repoId, options.repoId); }
  if (options.target) { filters.push("(src.title LIKE ? OR dst.title LIKE ?)"); params.push(`%${options.target}%`, `%${options.target}%`); }
  return store.db.prepare(`SELECT src.title AS fromTitle,dst.title AS toTitle,e.edge_type AS relation,src.id AS sourceNodeId,sv.file_path AS filePath,sv.start_line AS startLine,sv.end_line AS endLine
    FROM edges e JOIN nodes src ON src.id=e.src JOIN nodes dst ON dst.id=e.dst LEFT JOIN symbol_versions sv ON sv.node_id=src.id AND sv.status IN ('active','verified')
    WHERE ${filters.join(" AND ")} ORDER BY src.title,dst.title,e.edge_type`).all(...params).map((row) => {
      const item = row as { fromTitle: string; toTitle: string; relation: string; sourceNodeId: string; filePath?: string; startLine?: number; endLine?: number };
      return { from: item.fromTitle, to: item.toTitle, relation: item.relation, evidence: [{ source: "graph" as const, nodeId: item.sourceNodeId, ...(item.filePath ? { filePath: item.filePath } : {}), ...(item.startLine ? { startLine: item.startLine } : {}), ...(item.endLine ? { endLine: item.endLine } : {}) }] };
    });
}
