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
    const seenSnapshots = new Set<string>();
    const seenPaths = new Set<string>();
    let current: string | null = context.snapshotId;
    while (current && !seenSnapshots.has(current)) {
      seenSnapshots.add(current);
      const rows = store.db.prepare("SELECT file_path, resolution_set_id FROM snapshot_resolution_refs WHERE snapshot_id=? ORDER BY file_path").all(current) as Array<{ file_path: string; resolution_set_id: string }>;
      for (const row of rows) {
        if (seenPaths.has(row.file_path)) continue;
        seenPaths.add(row.file_path);
        ids.push(row.resolution_set_id);
      }
      // Every child overlay shadows the same path in its base snapshot. A
      // delete has no resolution ref of its own, so without this tombstone the
      // base file's edges would leak back into a revision whose manifest no
      // longer contains that file.
      const overlayPaths = store.db.prepare(
        "SELECT file_path FROM snapshot_overlays WHERE snapshot_id=?",
      ).all(current) as Array<{ file_path: string }>;
      for (const row of overlayPaths) seenPaths.add(row.file_path);
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
      // Resolve against the overlay-aware effective manifest. For a bounded
      // node lookup, query the requested identities once and intersect their
      // file facts with that manifest. The old loop below issued one SQL query
      // per indexed file even when the caller requested a single node.
      const files = manifest();
      if (nodeIds?.length) {
        const p = placeholders(nodeIds);
        const identities = store.db.prepare(
          `SELECT id, identity_key FROM nodes WHERE id IN (${p}) OR identity_key IN (${p})`,
        ).all(...nodeIds, ...nodeIds) as Array<{ id: string; identity_key: string }>;
        if (identities.length === 0) return [];
        const fileByFact = new Map(files.map((file) => [file.fileFactId, file]));
        const identityKeys = identities.map((row) => row.identity_key);
        const rows = store.db.prepare(
          `SELECT s.file_fact_id,s.identity_key,s.title,s.kind,s.signature,s.start_line,s.end_line,s.content_hash,n.id AS node_id
             FROM file_fact_symbols s LEFT JOIN nodes n ON n.identity_key=s.identity_key
            WHERE s.identity_key IN (${placeholders(identityKeys)})
            ORDER BY s.identity_key`,
        ).all(...identityKeys) as Array<Record<string, unknown>>;
        const out: RevisionSymbolRow[] = [];
        for (const row of rows) {
          const file = fileByFact.get(String(row.file_fact_id));
          if (!file) continue;
          out.push({ nodeId: String(row.node_id ?? row.identity_key), identityKey: String(row.identity_key), title: String(row.title), kind: String(row.kind), ...(row.signature ? { signature: String(row.signature) } : {}), filePath: file.filePath, language: file.language, ...(row.start_line == null ? {} : { startLine: Number(row.start_line) }), ...(row.end_line == null ? {} : { endLine: Number(row.end_line) }), contentHash: String(row.content_hash) });
        }
        return out;
      }
      const out: RevisionSymbolRow[] = [];
      for (const file of files) {
        const rows = store.db.prepare("SELECT s.identity_key,s.title,s.kind,s.signature,s.start_line,s.end_line,s.content_hash,n.id AS node_id FROM file_fact_symbols s LEFT JOIN nodes n ON n.identity_key=s.identity_key WHERE s.file_fact_id=? ORDER BY s.identity_key").all(file.fileFactId) as Array<Record<string, unknown>>;
        for (const row of rows) out.push({ nodeId: String(row.node_id ?? row.identity_key), identityKey: String(row.identity_key), title: String(row.title), kind: String(row.kind), ...(row.signature ? { signature: String(row.signature) } : {}), filePath: file.filePath, language: file.language, ...(row.start_line == null ? {} : { startLine: Number(row.start_line) }), ...(row.end_line == null ? {} : { endLine: Number(row.end_line) }), contentHash: String(row.content_hash) });
      }
      return out;
    },
    hasNode: (nodeId) => Boolean(store.db.prepare("SELECT 1 FROM nodes WHERE id=? OR identity_key=?").get(nodeId, nodeId)),
    edges: (filter) => {
      if (legacy) {
        const clauses: string[] = ["(e.branch_id=? OR e.branch_id IS NULL)", "e.status='active'"]; const params: unknown[] = [context.branchId];
        const nodeIds = filter.nodeIds?.map((value) => store.findNodeIdByIdentity(value) ?? value);
        if (nodeIds?.length) { const p = placeholders(nodeIds); if (filter.direction === "in") clauses.push(`e.dst IN (${p})`); else if (filter.direction === "out") clauses.push(`e.src IN (${p})`); else clauses.push(`(e.src IN (${p}) OR e.dst IN (${p}))`); params.push(...nodeIds, ...(filter.direction === "both" ? nodeIds : [])); }
        if (filter.edgeTypes?.length) { clauses.push(`e.edge_type IN (${placeholders(filter.edgeTypes)})`); params.push(...filter.edgeTypes); }
        const rows = store.db.prepare(`SELECT e.*,ns.identity_key AS src_identity,nd.identity_key AS dst_identity FROM edges e JOIN nodes ns ON ns.id=e.src LEFT JOIN nodes nd ON nd.id=e.dst WHERE ${clauses.join(" AND ")} ORDER BY e.edge_type,src_identity,dst_identity,e.id LIMIT ?`).all(...params, filter.limit ?? 1000) as Array<Record<string, unknown>>;
        return rows.map((row) => ({ id: String(row.id), srcIdentityKey: String(row.src_identity), ...(row.dst_identity ? { dstIdentityKey: String(row.dst_identity) } : {}), ...(row.raw_target ? { rawTarget: String(row.raw_target) } : {}), edgeType: String(row.edge_type), method: String(row.method), confidence: Number(row.confidence), provenance: JSON.parse(String(row.provenance ?? "{}")), scope: row.branch_id == null ? "legacy_global" : "revision" as const }));
      }
      const resolutionIds = snapshotResolutionIds();
      const identityKeys = filter.nodeIds?.map((value) => store.getNode(value)?.identity_key ?? value);
      const clauses: string[] = [];
      const filterParams: unknown[] = [];
      if (identityKeys?.length) {
        const p = placeholders(identityKeys);
        clauses.push(filter.direction === "in"
          ? `r.dst_identity_key IN (${p})`
          : filter.direction === "out"
            ? `r.src_identity_key IN (${p})`
            : `(r.src_identity_key IN (${p}) OR r.dst_identity_key IN (${p}))`);
        filterParams.push(...identityKeys, ...(filter.direction === "both" ? identityKeys : []));
      }
      if (filter.edgeTypes?.length) { clauses.push(`r.edge_type IN (${placeholders(filter.edgeTypes)})`); filterParams.push(...filter.edgeTypes); }
      const limit = filter.limit ?? 1000;
      const rows = resolutionIds.length
        ? store.db.prepare(`SELECT r.* FROM resolved_edges r WHERE r.resolution_set_id IN (${placeholders(resolutionIds)})${clauses.length ? ` AND ${clauses.join(" AND ")}` : ""} ORDER BY r.edge_type,r.src_identity_key,r.dst_identity_key,r.id LIMIT ?`).all(...resolutionIds, ...filterParams, limit) as Array<Record<string, unknown>>
        : [];

      const globalClauses: string[] = [];
      const globalParams: unknown[] = [];
      if (identityKeys?.length) {
        const p = placeholders(identityKeys);
        globalClauses.push(filter.direction === "in"
          ? `dst_identity_key IN (${p})`
          : filter.direction === "out"
            ? `src_identity_key IN (${p})`
            : `(src_identity_key IN (${p}) OR dst_identity_key IN (${p}))`);
        globalParams.push(...identityKeys, ...(filter.direction === "both" ? identityKeys : []));
      }
      if (filter.edgeTypes?.length) {
        globalClauses.push(`edge_type IN (${placeholders(filter.edgeTypes)})`);
        globalParams.push(...filter.edgeTypes);
      }
      const global = store.db.prepare(`SELECT * FROM global_resolved_edges${globalClauses.length ? ` WHERE ${globalClauses.join(" AND ")}` : ""} ORDER BY edge_type,src_identity_key,dst_identity_key,id LIMIT ?`).all(...globalParams, limit) as Array<Record<string, unknown>>;
      return [...rows.map((row) => ({ id: String(row.id), srcIdentityKey: String(row.src_identity_key), ...(row.dst_identity_key ? { dstIdentityKey: String(row.dst_identity_key) } : {}), ...(row.raw_target ? { rawTarget: String(row.raw_target) } : {}), edgeType: String(row.edge_type), method: String(row.method), confidence: Number(row.confidence), provenance: JSON.parse(String(row.provenance ?? "{}")), scope: "revision" as const })), ...global.map((row) => ({ id: String(row.id), srcIdentityKey: String(row.src_identity_key), ...(row.dst_identity_key ? { dstIdentityKey: String(row.dst_identity_key) } : {}), ...(row.raw_target ? { rawTarget: String(row.raw_target) } : {}), edgeType: String(row.edge_type), method: String(row.method), confidence: Number(row.confidence), provenance: JSON.parse(String(row.provenance ?? "{}")), scope: "global" as const }))].slice(0, limit);
    },
    touch: () => store.db.prepare("UPDATE revision_snapshots SET last_accessed_at=? WHERE id=?").run(new Date().toISOString(), context.snapshotId),
  };
}
