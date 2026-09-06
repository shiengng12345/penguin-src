import type { KnowledgeStore } from "./store.js";
import { openRevisionView, type RevisionEdgeRow } from "./revision-view.js";
import { resolveRevisionContext, type RevisionContext } from "./revision.js";

export type DomainPersona = "frontend" | "backend" | "qa" | "sre" | "pm/security";
export interface DomainQueryEnvelope {
  repoId: string;
  snapshotId: string;
  commitSha: string;
  targetNodeId: string;
  maxDepth: number;
  limit: number;
}

export interface DomainQueryOptions {
  repoId?: string;
  persona?: DomainPersona;
  snapshotId?: string;
  commitSha?: string;
  targetNodeId?: string;
  target?: string;
  maxDepth?: number;
  limit?: number;
}

export interface DomainClaimCandidate {
  id: string;
  statement: string;
  kind: "actor" | "capability" | "entry_point" | "rule" | "state_change" | "side_effect" | "external_system" | "failure_mode";
  personas: DomainPersona[];
  evidence: Array<{ source: "graph" | "source" | "note"; nodeId?: string; filePath?: string; startLine?: number; endLine?: number }>;
  status: "candidate" | "insufficient";
  repoId?: string;
  snapshotId?: string;
  duplicateCount?: number;
  gaps?: string[];
}
export interface DomainFlowStep {
  from: string;
  to: string;
  relation: string;
  evidence: DomainClaimCandidate["evidence"];
  repoId?: string;
  snapshotId?: string;
  evidenceState?: "proven" | "inferred" | "candidate" | "insufficient";
  duplicateCount?: number;
  gaps?: string[];
}

export interface DomainExplainResult {
  envelope: DomainQueryEnvelope | null;
  claims: DomainClaimCandidate[];
  flow: DomainFlowStep[];
}

export class DomainScopeError extends Error {
  readonly code = "DOMAIN_SCOPE_NOT_FOUND" as const;

  constructor(message: string) {
    super(message);
    this.name = "DomainScopeError";
  }
}

function personas(kind: DomainClaimCandidate["kind"]): DomainPersona[] {
  if (kind === "entry_point" || kind === "capability") return ["frontend", "backend", "qa", "pm/security"];
  if (kind === "failure_mode") return ["backend", "qa", "sre", "pm/security"];
  if (kind === "external_system" || kind === "side_effect") return ["backend", "sre", "pm/security"];
  return ["backend", "qa", "pm/security"];
}

function scopeContext(store: KnowledgeStore, options: DomainQueryOptions): RevisionContext | null {
  if (!options.repoId || (!options.snapshotId && !options.commitSha)) return null;
  const resolved = resolveRevisionContext(store, {
    repoId: options.repoId,
    snapshotId: options.snapshotId,
    commitSha: options.commitSha,
  });
  if (resolved.status !== "resolved") {
    throw new DomainScopeError(`${resolved.reason}; Domain queries require an exact repo/revision envelope`);
  }
  return resolved.context;
}

function queryEnvelope(context: RevisionContext | null, options: DomainQueryOptions): DomainQueryEnvelope | null {
  if (!context) return null;
  return {
    repoId: context.repoId,
    snapshotId: context.snapshotId,
    commitSha: context.commitSha,
    targetNodeId: options.targetNodeId ?? options.target ?? "",
    maxDepth: Math.max(0, Math.min(options.maxDepth ?? 1, 8)),
    limit: Math.max(1, Math.min(options.limit ?? 100, 500)),
  };
}

interface DomainNodeRow {
  id: string;
  nodeType: string;
  title: string;
  repoId: string | null;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

function scopedNodeIds(store: KnowledgeStore, context: RevisionContext | null): Set<string> | null {
  if (!context) return null;
  const view = openRevisionView(store, context);
  const ids = new Set(view.symbolVersions().map((row) => row.nodeId));
  // Proto endpoints are global identities and may not have a symbol_versions
  // row. Admit them only through memberships whose file is in this exact
  // revision, otherwise a second repository can leak the same endpoint name.
  const files = new Set(view.listFiles().map((row) => row.filePath));
  const memberships = store.db.prepare("SELECT endpoint_id AS endpointId,file_path AS filePath FROM endpoint_memberships WHERE repo_id=?").all(context.repoId) as Array<{ endpointId: string; filePath: string }>;
  for (const membership of memberships) if (files.has(membership.filePath)) ids.add(membership.endpointId);
  return ids;
}

function domainNodes(store: KnowledgeStore, options: DomainQueryOptions, context: RevisionContext | null): DomainNodeRow[] {
  const params: unknown[] = [];
  const clauses = ["n.node_type IN ('endpoint','service','entity','event','test','note')"];
  if (options.repoId) {
    // Endpoint identities are intentionally global and carry repository
    // ownership in endpoint_memberships; requiring only nodes.repo_id would
    // make a real scoped endpoint disappear from Domain/Onboarding answers.
    clauses.push("(n.repo_id=? OR EXISTS (SELECT 1 FROM endpoint_memberships em WHERE em.endpoint_id=n.id AND em.repo_id=?))");
    params.push(options.repoId, options.repoId);
  }
  const nodeIds = scopedNodeIds(store, context);
  if (nodeIds && nodeIds.size === 0) return [];
  if (nodeIds) { clauses.push(`n.id IN (${[...nodeIds].map(() => "?").join(",")})`); params.push(...nodeIds); }
  if (options.targetNodeId) { clauses.push("(n.id=? OR n.identity_key=?)"); params.push(options.targetNodeId, options.targetNodeId); }
  const rows = store.db.prepare(`SELECT n.id,n.node_type AS nodeType,n.title,n.repo_id AS repoId,sv.file_path AS filePath,sv.start_line AS startLine,sv.end_line AS endLine
    FROM nodes n LEFT JOIN symbol_versions sv ON sv.node_id=n.id AND sv.status IN ('active','verified')
    WHERE ${clauses.join(" AND ")} ORDER BY n.node_type,n.title,n.id`).all(...params) as DomainNodeRow[];
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
}

function insufficientClaim(options: DomainQueryOptions, context: RevisionContext | null, gap: string): DomainClaimCandidate {
  return {
    id: `domain-insufficient-${options.targetNodeId ?? options.target ?? "scope"}`,
    statement: "Insufficient indexed evidence for this Domain query.",
    kind: "failure_mode",
    personas: personas("failure_mode"),
    evidence: [],
    status: "insufficient",
    ...(context ? { repoId: context.repoId, snapshotId: context.snapshotId } : {}),
    duplicateCount: 0,
    gaps: [gap],
  };
}

/** Build auditable domain candidates from indexed facts. This deliberately
 * never upgrades an inference to a verified business truth. When an exact
 * revision is supplied, every candidate is constrained to that revision's
 * effective symbol manifest; no global graph fallback is permitted. */
export function buildDomainClaims(store: KnowledgeStore, options: DomainQueryOptions = {}): DomainClaimCandidate[] {
  const context = scopeContext(store, options);
  const nodes = domainNodes(store, options, context);
  if (nodes.length === 0) {
    return options.targetNodeId || options.target
      ? [insufficientClaim(options, context, "target is absent from the selected repo/revision envelope")]
      : [];
  }
  const claims: DomainClaimCandidate[] = [];
  for (const node of nodes) {
    const kind: DomainClaimCandidate["kind"] = node.nodeType === "endpoint" ? "entry_point" : node.nodeType === "service" ? "capability" : node.nodeType === "entity" ? "state_change" : node.nodeType === "event" ? "side_effect" : node.nodeType === "test" ? "rule" : "actor";
    const claim = { id: `domain_${node.id}_${kind}`, statement: `Candidate ${kind.replace("_", " ")} represented by ${node.title}.`, kind, personas: personas(kind), evidence: [{ source: node.nodeType === "note" ? "note" as const : "source" as const, nodeId: node.id, ...(node.filePath ? { filePath: node.filePath } : {}), ...(node.startLine ? { startLine: node.startLine } : {}), ...(node.endLine ? { endLine: node.endLine } : {}) }], status: "candidate" as const, ...(context ? { repoId: context.repoId, snapshotId: context.snapshotId } : {}), duplicateCount: 1 };
    if (!options.persona || claim.personas.includes(options.persona)) claims.push(claim);
  }
  const claimLimit = options.limit ?? claims.length;
  return claims.slice(0, Math.max(1, Math.min(claimLimit || 1, 500)));
}

/** Revision-scoped graph flow. Global edges are excluded for exact revision
 * queries because their producer may belong to another repository. */
export function buildDomainFlow(store: KnowledgeStore, options: DomainQueryOptions = {}): DomainFlowStep[] {
  const context = scopeContext(store, options);
  const envelope = queryEnvelope(context, options);
  const nodes = domainNodes(store, options, context);
  if (nodes.length === 0) return [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const byIdentity = new Map<string, DomainNodeRow>();
  for (const node of nodes) {
    const row = store.db.prepare("SELECT identity_key AS identityKey FROM nodes WHERE id=?").get(node.id) as { identityKey: string } | undefined;
    if (row) byIdentity.set(row.identityKey, node);
  }
  const edges: RevisionEdgeRow[] = context
    ? openRevisionView(store, context).edges({ includeGlobal: false, limit: Math.max(1000, (envelope?.limit ?? 100) * 8) })
    : (store.db.prepare(`SELECT e.id,e.src AS srcId,e.dst AS dstId,e.edge_type AS edgeType,e.provenance,ns.identity_key AS srcIdentity,nd.identity_key AS dstIdentity
         FROM edges e JOIN nodes ns ON ns.id=e.src LEFT JOIN nodes nd ON nd.id=e.dst
        WHERE e.status IN ('active','suggested')${options.repoId ? " AND (ns.repo_id=? OR nd.repo_id=?)" : ""}
        ORDER BY ns.title,nd.title,e.edge_type,e.id`).all(...(options.repoId ? [options.repoId, options.repoId] : [])) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), srcIdentityKey: String(row.srcIdentity), ...(row.dstIdentity ? { dstIdentityKey: String(row.dstIdentity) } : {}), edgeType: String(row.edgeType), method: "legacy", confidence: 1, provenance: JSON.parse(String(row.provenance ?? "{}")), scope: "revision" as const,
    }));
  const adjacency = new Map<string, typeof edges>();
  for (const edge of edges) {
    const src = byIdentity.get(edge.srcIdentityKey);
    const dst = edge.dstIdentityKey ? byIdentity.get(edge.dstIdentityKey) : undefined;
    if (!src || !dst) continue;
    const list = adjacency.get(src.id) ?? [];
    list.push(edge);
    adjacency.set(src.id, list);
  }
  const target = options.targetNodeId
    ? (byId.get(options.targetNodeId) ?? nodes.find((node) => {
      const identity = store.db.prepare("SELECT identity_key AS identityKey FROM nodes WHERE id=?").get(node.id) as { identityKey: string } | undefined;
      return identity?.identityKey === options.targetNodeId;
    }))
    : options.target
      ? nodes.find((node) => node.title.toLowerCase().includes(options.target!.toLowerCase()))
      : nodes[0];
  if (!target) return [];
  const maxDepth = envelope?.maxDepth ?? Math.max(0, Math.min(options.maxDepth ?? 1, 8));
  const limit = envelope?.limit ?? Math.max(1, Math.min(options.limit ?? 100, 500));
  const queue: Array<{ id: string; depth: number }> = [{ id: target.id, depth: 0 }];
  const visited = new Set<string>([target.id]);
  const out: DomainFlowStep[] = [];
  const seen = new Set<string>();
  while (queue.length && out.length < limit) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const edge of adjacency.get(current.id) ?? []) {
      const dst = byIdentity.get(edge.dstIdentityKey!);
      const src = byIdentity.get(edge.srcIdentityKey);
      if (!src || !dst) continue;
      const key = `${src.id}|${dst.id}|${edge.edgeType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const provenance = edge.provenance ?? {};
      out.push({
        from: src.title,
        to: dst.title,
        relation: edge.edgeType,
        evidence: [{ source: "graph", nodeId: src.id, ...(typeof provenance.filePath === "string" ? { filePath: provenance.filePath } : {}), ...(typeof provenance.startLine === "number" ? { startLine: provenance.startLine } : {}) }],
        ...(context ? { repoId: context.repoId, snapshotId: context.snapshotId } : {}),
        evidenceState: edge.confidence >= 1 ? "proven" : "candidate",
        duplicateCount: 1,
      });
      if (!visited.has(dst.id)) { visited.add(dst.id); queue.push({ id: dst.id, depth: current.depth + 1 }); }
      if (out.length >= limit) break;
    }
  }
  return out;
}

export function explainDomain(store: KnowledgeStore, options: DomainQueryOptions = {}): DomainExplainResult {
  const context = scopeContext(store, options);
  return { envelope: queryEnvelope(context, options), claims: buildDomainClaims(store, options), flow: buildDomainFlow(store, options) };
}
