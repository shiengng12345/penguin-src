// Per-column cell renderers for DataTable — the header cell (wraps
// `ResizableColumn`) and the body row. Split out of data-table.tsx to keep
// that file under this repo's file-size budget (see data-table-types.ts /
// data-table-row-props.ts for the same reasoning applied to types and the
// rowProps merge policy).
//
// Both cells honor `column.grow`: a grow column drops its shrink-0 fixed
// width and instead flexes to fill whatever room the row has left over
// (see resizable-column.tsx), so the table uses its full available width
// instead of leaving a dead region beside cramped fixed-width columns. Every
// other column keeps the original fixed-pixel-width behaviour unchanged.
import { useEffect, useRef, type HTMLAttributes } from "react";
import { ResizableColumn } from "./resizable-column";
import { mergeRowProps } from "./data-table-row-props";
import { DEFAULT_COLUMN_WIDTH, type DataTableColumn } from "./data-table-types";
import { cn } from "@/lib/utils";

export function DataRow<T>({
  row,
  columns,
  columnWidths,
  rowKeyValue,
  expandable,
  expanded,
  onToggleExpand,
  rowProps,
  expandLabel,
  expandColumnWidth,
}: {
  row: T;
  columns: DataTableColumn<T>[];
  columnWidths: Record<string, number>;
  rowKeyValue: string;
  expandable: boolean;
  expanded: boolean;
  onToggleExpand: (key: string) => void;
  rowProps?: HTMLAttributes<HTMLDivElement>;
  expandLabel?: string;
  expandColumnWidth: number;
}) {
  // See data-table-row-props.ts for the merge policy: the caller can
  // decorate this row (aria-current, aria-expanded, data-*, ...) but the
  // row's own role/className/style are never simply overwritten.
  const rowAttrs = mergeRowProps<HTMLDivElement>(
    { role: "row", className: "flex items-stretch border-b border-border text-sm" },
    rowProps,
  );
  return (
    <div {...rowAttrs}>
      {expandable && (
        <div style={{ width: expandColumnWidth }} className="flex shrink-0 items-center justify-center">
          <button
            type="button"
            aria-label={
              expandLabel
                ? `${expanded ? "Collapse" : "Expand"} ${expandLabel}`
                : expanded
                ? "Collapse row"
                : "Expand row"
            }
            // Stop the click reaching the row. A consumer can put a row-level
            // onClick on `rowProps` (TopicTable does, to open a topic's detail
            // pane); without this, expanding a row to peek at its partitions
            // also fires that handler — an unwanted fetch and an unwanted
            // pane, every time someone expands a row.
            onClick={(event) => {
              event.stopPropagation();
              onToggleExpand(rowKeyValue);
            }}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        </div>
      )}
      {columns.map((column) => {
        const width = columnWidths[column.key] ?? column.width ?? DEFAULT_COLUMN_WIDTH;
        return (
          <div
            key={column.key}
            role="cell"
            data-grow={column.grow ? "true" : undefined}
            style={column.grow ? { minWidth: width } : { width }}
            className={cn(
              "flex items-center truncate px-2 py-2",
              column.grow ? "flex-1" : "shrink-0",
            )}
          >
            {column.render(row)}
          </div>
        );
      })}
    </div>
  );
}

export function ColumnHeaderCell<T>({
  column,
  width,
  onWidthChange,
  sortDir,
  onSort,
  minWidth,
  maxWidth,
}: {
  column: DataTableColumn<T>;
  width: number;
  onWidthChange: (key: string, width: number) => void;
  sortDir: "asc" | "desc" | undefined;
  onSort: (() => void) | undefined;
  minWidth: number;
  maxWidth: number;
}) {
  // Measures the rendered (resizable) cell so body columns can mirror its
  // width. ResizableColumn owns the drag logic and its own width state; this
  // is the one piece of glue needed to keep header and body columns aligned
  // without duplicating that logic. For a `grow` column this also picks up
  // its flex-filled width, which is exactly what lets the body cell (which
  // has no flex layout information of its own) match it.
  const measureRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = measureRef.current;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((observerEntries) => {
      const observedWidth = observerEntries[0]?.contentRect.width;
      if (observedWidth && Math.round(observedWidth) !== width) {
        onWidthChange(column.key, Math.round(observedWidth));
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [column.key, width, onWidthChange]);

  return (
    <div
      ref={measureRef}
      className={cn("inline-block align-top", column.grow ? "flex-1" : "shrink-0")}
    >
      <ResizableColumn
        defaultWidth={width}
        minWidth={minWidth}
        maxWidth={maxWidth}
        grow={column.grow}
        className="border-r border-border"
      >
        <div
          role="columnheader"
          data-grow={column.grow ? "true" : undefined}
          aria-sort={sortDir ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
          className={cn("flex items-center gap-1 whitespace-nowrap px-2 py-2")}
        >
          <span>{column.header}</span>
          {onSort && (
            <button
              type="button"
              aria-label={`Sort by ${column.header}`}
              onClick={onSort}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              <span aria-hidden="true">{sortDir === "asc" ? "▲" : sortDir === "desc" ? "▼" : "↕"}</span>
            </button>
          )}
        </div>
      </ResizableColumn>
    </div>
  );
}
