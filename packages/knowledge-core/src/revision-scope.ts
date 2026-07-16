import type { RevisionContext } from "./revision.js";

export interface RevisionReadScope {
  revision: RevisionContext;
  edgeSql(alias?: string): { sql: string; params: unknown[] };
  symbolSql(alias?: string): { sql: string; params: unknown[] };
  fileSql(alias?: string): { sql: string; params: unknown[] };
}

/**
 * Read predicates for the legacy branch-index tables. Parser edges with a
 * null branch are global facts (for example cross-repository gRPC endpoints),
 * while symbols and files are always branch-owned.
 */
export function legacyRevisionScope(revision: RevisionContext): RevisionReadScope {
  if (!revision.branchId) throw new Error("legacy revision scope requires branchId");
  return {
    revision,
    edgeSql(alias = "edges") {
      return {
        sql: `(${alias}.branch_id = ? OR ${alias}.branch_id IS NULL)`,
        params: [revision.branchId],
      };
    },
    symbolSql(alias = "symbol_versions") {
      return { sql: `${alias}.branch_id = ?`, params: [revision.branchId] };
    },
    fileSql(alias = "files_index") {
      return { sql: `${alias}.branch_id = ?`, params: [revision.branchId] };
    },
  };
}
