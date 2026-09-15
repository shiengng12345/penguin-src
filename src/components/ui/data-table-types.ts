// Shared types for DataTable and its sibling files (status region, pagination
// footer). Kept separate so those siblings don't need to import from
// data-table.tsx itself (which would create a needless import cycle).
export type DataTableState = "loading" | "empty" | "stale" | "partial" | "error" | "ready";
