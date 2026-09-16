// Shared types for DataTable and its sibling files (status region, pagination
// footer, cell renderers). Kept separate so those siblings don't need to
// import from data-table.tsx itself (which would create a needless import
// cycle).
import type { ReactNode } from "react";

export type DataTableState = "loading" | "empty" | "stale" | "partial" | "error" | "ready";

// Shared sizing constants — used by data-table.tsx (state init, virtualiser
// sizing) and data-table-cells.tsx (per-cell fallback widths) alike, so they
// live here rather than being duplicated or awkwardly re-exported.
export const DEFAULT_COLUMN_WIDTH = 160;
export const MIN_COLUMN_WIDTH = 72;
export const MAX_COLUMN_WIDTH = 640;
export const EXPAND_COLUMN_WIDTH = 32;

export interface DataTableColumn<T> {
  key: string;
  header: string;
  width?: number;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  /** When true, this column absorbs whatever row width is left over after
   *  every other column has taken its own (fixed, resizable) width, instead
   *  of sitting at a fixed width itself — see `data-table-cells.tsx`. Mark
   *  the one column carrying the primary identifier (a topic name, a
   *  connection's admin URL) so the table uses its full available width
   *  instead of leaving a dead region beside cramped columns. At most one
   *  column should set this; `width` still supplies its minimum width and
   *  its drag-resize floor. */
  grow?: boolean;
}
