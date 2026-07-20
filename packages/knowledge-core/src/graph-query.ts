import type { KnowledgeStore } from "./store.js";
import { openRevisionView } from "./revision-view.js";
import type { RevisionContext } from "./revision.js";
import { classifyEdgeTrust } from "./edge-proof.js";
export interface GraphQueryRequest { scope?: { repoId?: string; branchId?: string; snapshotId?: string; workspaceId?: string; revisions?: Array<{ repoId?: string; branch?: string; snapshotId?: string }> }; start: { nodeIds?: string[]; kinds?: string[]; name?: string; filePath?: string }; traverse: Array<{ edgeTypes: string[]; direction: "out" | "in" | "both"; minDepth: number; maxDepth: number; statuses: Array<"verified" | "candidate"> }>; where?: { nodeKinds?: string[]; repoIds?: string[]; pathPrefixes?: string[] }; project: Array<"nodes" | "edges" | "paths" | "source" | "provenance">; limit: number; cursor?: string; }
export interface GraphQueryResult { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>>; paths: string[][]; source: Array<Record<string, unknown>>; provenance: Array<Record<string, unknown>>; coverage: { languages: string[]; resolvers: string[]; unresolved: number; discovered: number; admitted: number; excluded: number; failed: number }; truncated: boolean; gaps: string[]; cursor?: string; }
function validate(request: GraphQueryRequest): void {
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 500) throw new Error("GRAPH_QUERY_LIMIT_INVALID");
  if (!Array.isArray(request.traverse) || request.traverse.some((step) => !Number.isInteger(step.minDepth) || !Number.isInteger(step.maxDepth) || step.minDepth < 0 || step.maxDepth < 0 || step.maxDepth > 12 || step.minDepth > step.maxDepth || !["out", "in", "both"].includes(step.direction) || step.statuses.some((status) => !["verified", "candidate"].includes(status)))) throw new Error("GRAPH_QUERY_DEPTH_INVALID");
  if (!Array.isArray(request.project) || request.project.some((item) => !["nodes", "edges", "paths", "source", "provenance"].includes(item))) throw new Error("GRAPH_QUERY_PROJECT_INVALID");
}
export function graphQuery(store: KnowledgeStore, request: GraphQueryRequest): GraphQueryResult {
  validate(request); const nodeIds = new Set(request.start.nodeIds ?? []); const params: unknown[] = []; const clauses: string[] = [];
  const visibleNodeIds = new Set<string>();
  const scopedEdges: Array<Record<string, unknown>> = [];
  if (request.scope?.snapshotId) {
    const snapshot = store.db.prepare("SELECT repo_id,commit_sha,worktree_fingerprint FROM revision_snapshots WHERE id=?").get(request.scope.snapshotId) as { repo_id: string; commit_sha: string | null; worktree_fingerprint: string | null } | undefined;
    if (!snapshot) throw new Error("GRAPH_QUERY_SNAPSHOT_NOT_FOUND");
    const context: RevisionContext = { repoId: snapshot.repo_id, commitSha: snapshot.commit_sha ?? "", snapshotId: request.scope.snapshotId, ...(snapshot.worktree_fingerprint ? { worktreeFingerprint: snapshot.worktree_fingerprint } : {}), trust: "exact_commit" };
    const view = openRevisionView(store, context);
    const identities = new Map<string, string>();
    for (const symbol of view.symbolVersions()) { visibleNodeIds.add(symbol.nodeId); identities.set(symbol.identityKey, symbol.nodeId); }
    for (const edge of view.edges({ limit: 50000 })) {
      const src = identities.get(edge.srcIdentityKey) ?? (store.db.prepare("SELECT id FROM nodes WHERE identity_key=?").get(edge.srcIdentityKey) as { id: string } | undefined)?.id;
      const dst = edge.dstIdentityKey ? identities.get(edge.dstIdentityKey) ?? (store.db.prepare("SELECT id FROM nodes WHERE identity_key=?").get(edge.dstIdentityKey) as { id: string } | undefined)?.id : null;
      if (src) scopedEdges.push({ id: edge.id, src, dst, edge_type: edge.edgeType, status: "active", method: edge.method, provenance: JSON.stringify(edge.provenance) });
    }
  }
  if (request.start.name) { clauses.push("(n.title=? OR n.identity_key=? OR n.identity_key LIKE ?)"); params.push(request.start.name, request.start.name, `%::${request.start.name}`); }
  if (request.start.filePath) { clauses.push("EXISTS (SELECT 1 FROM symbol_versions sv WHERE sv.node_id=n.id AND sv.file_path=?)"); params.push(request.start.filePath); }
  if (request.start.kinds?.length) { clauses.push(`n.node_type IN (${request.start.kinds.map(() => "?").join(",")})`); params.push(...request.start.kinds); }
  if (request.where?.nodeKinds?.length) { clauses.push(`n.node_type IN (${request.where.nodeKinds.map(() => "?").join(",")})`); params.push(...request.where.nodeKinds); }
  if (request.where?.repoIds?.length) { clauses.push(`n.repo_id IN (${request.where.repoIds.map(() => "?").join(",")})`); params.push(...request.where.repoIds); }
  if (request.where?.pathPrefixes?.length) { clauses.push(`EXISTS (SELECT 1 FROM symbol_versions sv WHERE sv.node_id=n.id AND (${request.where.pathPrefixes.map(() => "sv.file_path LIKE ?").join(" OR ")}))`); params.push(...request.where.pathPrefixes.map((prefix) => `${prefix.replace(/%/g, "\\%")}%`)); }
  if (clauses.length) for (const row of store.db.prepare(`SELECT n.id FROM nodes n WHERE ${clauses.join(" AND ")} LIMIT ?`).all(...params, request.limit) as Array<{id:string}>) nodeIds.add(row.id);
  const nodes = new Map<string, Record<string, unknown>>(); const edges: Array<Record<string, unknown>> = []; const paths: string[][] = []; const source: Array<Record<string, unknown>> = []; const gaps: string[] = [];
  const queue = [...nodeIds].map((id) => ({ id, depth: 0, path: [id] })); const visited = new Set<string>();
  while (queue.length > 0 && nodes.size < request.limit) {
    const item = queue.shift()!; if (visited.has(`${item.id}:${item.depth}`)) continue; visited.add(`${item.id}:${item.depth}`);
    const node = store.db.prepare("SELECT id,node_type,title,identity_key,repo_id,meta FROM nodes WHERE id=?").get(item.id) as Record<string, unknown> | undefined; if (!node) { gaps.push(`missing_node:${item.id}`); continue; }
    if (visibleNodeIds.size > 0 && node.repo_id != null && !visibleNodeIds.has(item.id)) { gaps.push(`out_of_scope:${item.id}`); continue; }
    if (!request.where?.pathPrefixes?.length || Boolean(store.db.prepare(`SELECT 1 FROM symbol_versions WHERE node_id=? AND (${request.where.pathPrefixes.map(() => "file_path LIKE ?").join(" OR ")}) LIMIT 1`).get(item.id, ...request.where.pathPrefixes.map((prefix) => `${prefix.replace(/%/g, "\\%")}%`)))) nodes.set(item.id, node);
    if (item.depth >= (request.traverse.at(-1)?.maxDepth ?? 0)) continue;
    const step = request.traverse[Math.min(item.depth, request.traverse.length - 1)]; if (!step) continue;
    const typeSql = step.edgeTypes.length ? `AND e.edge_type IN (${step.edgeTypes.map(() => "?").join(",")})` : "";
    const directionSql = step.direction === "out" ? "e.src=?" : step.direction === "in" ? "e.dst=?" : "(e.src=? OR e.dst=?)";
    const nextIdSql = step.direction === "out" ? "e.dst" : step.direction === "in" ? "e.src" : "CASE WHEN e.src=? THEN e.dst ELSE e.src END";
    const endpointParams = step.direction === "both" ? [item.id, item.id] : [item.id];
    const nextIdParams = step.direction === "both" ? [item.id] : [];
    const allowedStatuses = new Set(step.statuses.length ? step.statuses : ["verified"]);
    const edgeStatus = (value: unknown, method?: unknown, provenance?: unknown): "verified" | "candidate" => classifyEdgeTrust({ method: String(method ?? ""), provenance }).status === "candidate" || value === "suggested" || value === "candidate" ? "candidate" : "verified";
    const rows = scopedEdges.length > 0
      ? scopedEdges.filter((edge) => (step.direction === "out" ? edge.src === item.id : step.direction === "in" ? edge.dst === item.id : edge.src === item.id || edge.dst === item.id) && (!step.edgeTypes.length || step.edgeTypes.includes(String(edge.edge_type))) && allowedStatuses.has(edgeStatus(edge.status, edge.method, edge.provenance))).map((edge) => ({ ...edge, status: edgeStatus(edge.status, edge.method, edge.provenance), next_id: step.direction === "out" ? edge.dst : step.direction === "in" ? edge.src : (edge.src === item.id ? edge.dst : edge.src) })).slice(0, request.limit)
      : store.db.prepare(`SELECT e.*, ${nextIdSql} AS next_id, CASE WHEN e.status='suggested' OR e.method='INFERRED' THEN 'candidate' ELSE 'verified' END AS query_status FROM edges e WHERE ${directionSql} ${typeSql} AND e.status <> 'rejected' AND (e.status='active' OR e.status='suggested' OR e.status IS NULL) AND (CASE WHEN e.status='suggested' OR e.method='INFERRED' THEN 'candidate' ELSE 'verified' END IN (${[...allowedStatuses].map(() => "?").join(",")})) LIMIT ?`).all(...nextIdParams, ...endpointParams, ...step.edgeTypes, ...allowedStatuses, request.limit) as Array<Record<string, unknown>>;
    for (const edge of rows) { const next = String(edge.next_id ?? ""); if (!next) continue; if (request.where?.pathPrefixes?.length && !Boolean(store.db.prepare(`SELECT 1 FROM symbol_versions WHERE node_id=? AND (${request.where.pathPrefixes.map(() => "file_path LIKE ?").join(" OR ")}) LIMIT 1`).get(next, ...request.where.pathPrefixes.map((prefix) => `${prefix.replace(/%/g, "\\%")}%`)))) continue; const path = [...item.path, next]; const row = edge as Record<string, unknown>; const dispatchHop = row.edge_type === "dispatches_to"; edges.push({ ...row, status: row.query_status ?? row.status ?? "verified", ...(dispatchHop ? { dispatchHop: true, hopType: "dispatch" } : {}) }); paths.push(path); if (item.depth + 1 >= step.minDepth) queue.push({ id: next, depth: item.depth + 1, path }); if (edges.length >= request.limit) break; }
  }
  if (queue.length > 0) gaps.push("limit_reached");
  if (request.project.includes("source")) for (const id of nodes.keys()) {
    const rows = store.db.prepare("SELECT file_path AS filePath,start_line AS startLine,end_line AS endLine,content_hash AS contentHash FROM symbol_versions WHERE node_id=? AND status='fresh' ORDER BY start_line LIMIT 3").all(id) as Array<Record<string, unknown>>;
    for (const row of rows) source.push({ nodeId: id, revisionId: request.scope?.snapshotId ?? request.scope?.branchId ?? "live", ...row, hydration: "knowledge_get_hit" });
  }
  const repoIds = [...new Set([...nodes.values()].map((node) => typeof node.repo_id === "string" ? node.repo_id : null).filter((repoId): repoId is string => Boolean(repoId)))];
  const coverage = repoIds.length === 0
    ? { languages: [], resolvers: [], unresolved: 0, discovered: 0, admitted: 0, excluded: 0, failed: 0 }
    : (() => {
        const marks = repoIds.map(() => "?").join(",");
        const languages = (store.db.prepare(`SELECT DISTINCT lang AS value FROM symbol_versions WHERE node_id IN (SELECT id FROM nodes WHERE repo_id IN (${marks})) AND lang IS NOT NULL`).all(...repoIds) as Array<{ value: string }>).map((row) => row.value);
        const resolvers = (store.db.prepare(`SELECT DISTINCT resolver_version AS value FROM revision_snapshots WHERE repo_id IN (${marks}) AND resolver_version IS NOT NULL`).all(...repoIds) as Array<{ value: string }>).map((row) => row.value);
        const counts = store.db.prepare(`SELECT COUNT(*) AS discovered, SUM(coverage_status='admitted') AS admitted, SUM(coverage_status<>'admitted') AS excluded, SUM(coverage_status='failed') AS failed FROM coverage_records WHERE repo_id IN (${marks})`).get(...repoIds) as { discovered: number | null; admitted: number | null; excluded: number | null; failed: number | null };
        const unresolved = Number((store.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE dst IS NULL AND src IN (SELECT id FROM nodes WHERE repo_id IN (${marks}))`).get(...repoIds) as { n: number }).n ?? 0);
        return { languages, resolvers, unresolved, discovered: counts.discovered ?? 0, admitted: counts.admitted ?? 0, excluded: counts.excluded ?? 0, failed: counts.failed ?? 0 };
      })();
  return { nodes: request.project.includes("nodes") ? [...nodes.values()] : [], edges: request.project.includes("edges") ? edges.slice(0, request.limit) : [], paths: request.project.includes("paths") ? paths.slice(0, request.limit) : [], source, provenance: request.project.includes("provenance") ? edges.map((edge) => ({ edgeId: edge.id, status: edge.status ?? "verified", method: edge.method === "EXTRACTED" ? "ast_exact" : edge.method === "INFERRED" ? "heuristic" : edge.method ?? "unknown", ...(edge.edge_type === "dispatches_to" ? { hopType: "dispatch" } : {}), provenance: edge.provenance ?? null })) : [], coverage, truncated: queue.length > 0 || edges.length >= request.limit, gaps, ...(queue.length > 0 ? { cursor: Buffer.from(JSON.stringify({ last: queue[0]?.id ?? "", depth: queue[0]?.depth ?? 0 })).toString("base64url") } : {}) };
}
