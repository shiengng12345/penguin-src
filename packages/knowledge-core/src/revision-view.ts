import type { KnowledgeStore } from "./store.js";
import type { RevisionContext } from "./revision.js";
import { FileFactStore } from "./file-fact-store.js";

export interface RevisionFileRow { filePath: string; fileFactId: string; contentHash: string; language: string }
export interface RevisionSymbolRow { nodeId: string; identityKey: string; title: string; kind: string; signature?: string; filePath: string; language: string; startLine?: number; endLine?: number; contentHash: string }
export interface RevisionEdgeFilter { nodeIds?: string[]; edgeTypes?: string[]; direction?: "in" | "out" | "both"; limit?: number }
export interface RevisionEdgeRow { id: string; srcIdentityKey: string; dstIdentityKey?: string; rawTarget?: string; edgeType: string; method: string; confidence: number; provenance: Record<string, unknown>; scope: "revision" | "global" | "legacy_global" }
export interface RevisionView { readonly context: RevisionContext; listFiles(): RevisionFileRow[]; symbolVersions(nodeIds?: string[]): RevisionSymbolRow[]; hasNode(nodeId: string): boolean; edges(filter: RevisionEdgeFilter): RevisionEdgeRow[]; touch(): void }

function placeholders(values: string[]): string { return values.length ? values.map(() => "?").join(",") : "NULL"; }

export function openRevisionView(store: KnowledgeStore, context: RevisionContext): RevisionView {
  const legacy = context.snapshotId.startsWith("legacy:");
  const facts = legacy ? null : new FileFactStore(store);
  const snapshotResolutionIds = (): string[] => {
    if (legacy) return [];
    const ids: string[] = [];
    const seen = new Set<string>();
    let current: string | null = context.snapshotId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const rows = store.db.prepare("SELECT resolution_set_id FROM snapshot_resolution_refs WHERE snapshot_id=?").all(current) as Array<{ resolution_set_id: string }>;
      ids.push(...rows.map((row) => row.resolution_set_id));
      const parent = store.db.prepare("SELECT base_snapshot_id FROM revision_snapshots WHERE id=?").get(current) as { base_snapshot_id: string | null } | undefined;
      current = parent?.base_snapshot_id ?? null;
    }
    return [...new Set(ids)];
  };
  const manifest = () => legacy ? (store.db.prepare("SELECT file_path, content_hash, COALESCE(lang,'') AS language FROM files_index WHERE branch_id=? AND status != 'deleted' ORDER BY file_path").all(context.branchId) as Array<{ file_path: string; content_hash: string | null; language: string }>).map((row) => ({ filePath: row.file_path, fileFactId: `legacy:${context.branchId}:${row.file_path}`, contentHash: row.content_hash ?? "", language: row.language })) : [...facts!.effectiveManifest(context.snapshotId)].map(([filePath, fileFactId]) => { const row = store.db.prepare("SELECT content_hash, language FROM file_facts WHERE id=?").get(fileFactId) as { content_hash: string; language: string } | undefined; return { filePath, fileFactId, contentHash: row?.content_hash ?? "", language: row?.language ?? "" }; });
  return {
    context,
    listFiles: () => manifest(),
    symbolVersions: (nodeIds) => {
      if (legacy) {
        const filter = nodeIds?.length ? ` AND sv.node_id IN (${placeholders(nodeIds)})` : "";
        const rows = store.db.prepare(`SELECT sv.node_id,n.identity_key,n.title,sv.kind,sv.signature,sv.file_path,sv.start_line,sv.end_line,sv.content_hash FROM symbol_versions sv JOIN nodes n ON n.id=sv.node_id WHERE sv.branch_id=? AND sv.status='fresh'${filter} ORDER BY sv.file_path, n.identity_key`).all(context.branchId, ...(nodeIds ?? [])) as Array<Record<string, unknown>>;
        return rows.map((row) => ({ nodeId: String(row.node_id), identityKey: String(row.identity_key), title: String(row.title), kind: String(row.kind), ...(row.signature ? { signature: String(row.signature) } : {}), filePath: String(row.file_path), language: String(row.lang ?? ""), ...(row.start_line == null ? {} : { startLine: Number(row.start_line) }), ...(row.end_line == null ? {} : { endLine: Number(row.end_line) }), contentHash: String(row.content_hash) }));
      }
      // When callers already have bounded FTS candidates, resolve only those
      // symbols through the materialized snapshot manifest. The old path
      // always expanded the entire manifest first, turning a lexical/auto
      // query into an O(all files + all symbols) scan on large repositories.
      if (nodeIds?.length) {
        const placeholders = nodeIds.map(() => "?").join(",");
        const rows = store.db.prepare(`
          SELECT s.identity_key,s.title,s.kind,s.signature,s.start_line,s.end_line,s.content_hash,
                 n.id AS node_id,e.file_path AS file_path,ff.language
          FROM effective_snapshot_files e
          JOIN file_fact_symbols s ON s.file_fact_id=e.file_fact_id
          JOIN file_facts ff ON ff.id=e.file_fact_id
          LEFT JOIN nodes n ON n.identity_key=s.identity_key
          WHERE e.snapshot_id=? AND n.id IN (${placeholders})
          ORDER BY e.file_path, s.identity_key
        `).all(context.snapshotId, ...nodeIds) as Array<Record<string, unknown>>;
        return rows.map((row) => ({ nodeId: String(row.node_id), identityKey: String(row.identity_key), title: String(row.title), kind: String(row.kind), ...(row.signature ? { signature: String(row.signature) } : {}), filePath: String(row.file_path), language: String(row.language ?? ""), ...(row.start_line == null ? {} : { startLine: Number(row.start_line) }), ...(row.end_line == null ? {} : { endLine: Number(row.end_line) }), contentHash: String(row.content_hash) }));
      }
      const files = manifest(); const ids = new Set(nodeIds ?? []); const out: RevisionSymbolRow[] = [];
      for (const file of files) {
        const rows = store.db.prepare("SELECT s.identity_key,s.title,s.kind,s.signature,s.start_line,s.end_line,s.content_hash,n.id AS node_id FROM file_fact_symbols s LEFT JOIN nodes n ON n.identity_key=s.identity_key WHERE s.file_fact_id=? ORDER BY s.identity_key").all(file.fileFactId) as Array<Record<string, unknown>>;
        for (const row of rows) if (!nodeIds?.length || ids.has(String(row.node_id))) out.push({ nodeId: String(row.node_id ?? row.identity_key), identityKey: String(row.identity_key), title: String(row.title), kind: String(row.kind), ...(row.signature ? { signature: String(row.signature) } : {}), filePath: file.filePath, language: file.language, ...(row.start_line == null ? {} : { startLine: Number(row.start_line) }), ...(row.end_line == null ? {} : { endLine: Number(row.end_line) }), contentHash: String(row.content_hash) });
      }
      return out;
    },
    hasNode: (nodeId) => Boolean(store.db.prepare("SELECT 1 FROM nodes WHERE id=? OR identity_key=?").get(nodeId, nodeId)),
    edges: (filter) => {
      if (legacy) {
        const clauses: string[] = ["(e.branch_id=? OR e.branch_id IS NULL)", "e.status='active'"]; const params: unknown[] = [context.branchId];
        if (filter.nodeIds?.length) { const p = placeholders(filter.nodeIds); if (filter.direction === "in") clauses.push(`e.dst IN (${p})`); else if (filter.direction === "out") clauses.push(`e.src IN (${p})`); else clauses.push(`(e.src IN (${p}) OR e.dst IN (${p}))`); params.push(...filter.nodeIds, ...(filter.direction === "both" ? filter.nodeIds : [])); }
        if (filter.edgeTypes?.length) { clauses.push(`e.edge_type IN (${placeholders(filter.edgeTypes)})`); params.push(...filter.edgeTypes); }
        const rows = store.db.prepare(`SELECT e.*,ns.identity_key AS src_identity,nd.identity_key AS dst_identity FROM edges e JOIN nodes ns ON ns.id=e.src LEFT JOIN nodes nd ON nd.id=e.dst WHERE ${clauses.join(" AND ")} ORDER BY e.edge_type,src_identity,dst_identity,e.id LIMIT ?`).all(...params, filter.limit ?? 1000) as Array<Record<string, unknown>>;
        return rows.map((row) => ({ id: String(row.id), srcIdentityKey: String(row.src_identity), ...(row.dst_identity ? { dstIdentityKey: String(row.dst_identity) } : {}), ...(row.raw_target ? { rawTarget: String(row.raw_target) } : {}), edgeType: String(row.edge_type), method: String(row.method), confidence: Number(row.confidence), provenance: JSON.parse(String(row.provenance ?? "{}")), scope: row.branch_id == null ? "legacy_global" : "revision" as const }));
      }
      const resolutionIds = snapshotResolutionIds();
      const clauses: string[] = []; const params: unknown[] = resolutionIds.length ? [resolutionIds] : [context.snapshotId];
      if (filter.nodeIds?.length) { const p = placeholders(filter.nodeIds); clauses.push(filter.direction === "in" ? `d.identity_key IN (${p})` : filter.direction === "out" ? `s.identity_key IN (${p})` : `(s.identity_key IN (${p}) OR d.identity_key IN (${p}))`); params.push(...filter.nodeIds, ...(filter.direction === "both" ? filter.nodeIds : [])); }
      if (filter.edgeTypes?.length) { clauses.push(`r.edge_type IN (${placeholders(filter.edgeTypes)})`); params.push(...filter.edgeTypes); }
      const refPredicate = resolutionIds.length ? `x.resolution_set_id IN (${placeholders(resolutionIds)})` : "x.snapshot_id=?";
      const rows = store.db.prepare(`SELECT r.*,s.identity_key AS src_identity,d.identity_key AS dst_identity FROM snapshot_resolution_refs x JOIN resolved_edges r ON r.resolution_set_id=x.resolution_set_id LEFT JOIN nodes s ON s.identity_key=r.src_identity_key LEFT JOIN nodes d ON d.identity_key=r.dst_identity_key WHERE ${refPredicate}${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""} ORDER BY r.edge_type,src_identity,dst_identity,r.id LIMIT ?`).all(...(resolutionIds.length ? resolutionIds : [context.snapshotId]), ...params.slice(1), filter.limit ?? 1000) as Array<Record<string, unknown>>;
      const global = store.db.prepare("SELECT * FROM global_resolved_edges ORDER BY edge_type,src_identity_key,dst_identity_key,id LIMIT ?").all(filter.limit ?? 1000) as Array<Record<string, unknown>>;
      return [...rows.map((row) => ({ id: String(row.id), srcIdentityKey: String(row.src_identity ?? row.src_identity_key), ...(row.dst_identity ? { dstIdentityKey: String(row.dst_identity) } : row.dst_identity_key ? { dstIdentityKey: String(row.dst_identity_key) } : {}), ...(row.raw_target ? { rawTarget: String(row.raw_target) } : {}), edgeType: String(row.edge_type), method: String(row.method), confidence: Number(row.confidence), provenance: JSON.parse(String(row.provenance ?? "{}")), scope: "revision" as const })), ...global.map((row) => ({ id: String(row.id), srcIdentityKey: String(row.src_identity_key), ...(row.dst_identity_key ? { dstIdentityKey: String(row.dst_identity_key) } : {}), ...(row.raw_target ? { rawTarget: String(row.raw_target) } : {}), edgeType: String(row.edge_type), method: String(row.method), confidence: Number(row.confidence), provenance: JSON.parse(String(row.provenance ?? "{}")), scope: "global" as const }))].slice(0, filter.limit ?? 1000);
    },
    touch: () => store.db.prepare("UPDATE revision_snapshots SET last_accessed_at=? WHERE id=?").run(new Date().toISOString(), context.snapshotId),
  };
}
