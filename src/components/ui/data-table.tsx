// DataTable — the list primitive every broker surface builds on.
//
// Every later phase (connections, topics, subscriptions, messages, timeline
// events) lists something. This is built now, in Phase 0, so its problems
// surface while there is still exactly one consumer.
//
// Design contract (see task-16-brief.md for the full rationale):
//  - Five states share one contract: `loading`, `empty`, `stale`, `partial`,
//    `error`. `stale` and `partial` render the rows AND the notice — old or
//    incomplete data is still data an operator needs during an incident, and
//    hiding it is worse than marking it. State is always carried in text,
//    never by colour alone.
//  - Expansion is per row, toggled by a real <button> whose accessible name
//    contains "Expand".
//  - The table never pages or sorts itself — it reports `onPageChange` /
//    `onSortChange` and renders exactly the `rows` it is given. Paging
//    happens in Rust over a cached snapshot, because Pulsar's Admin REST
//    ignores pagination entirely; a component that sliced its own rows would
//    silently disagree with the backend's `total`.
//  - Column width is resized via `resizable-column.tsx`, not new drag logic.
//
// Virtualisation note (jsdom): @tanstack/react-virtual sizes its viewport by
// reading the scroll element's `offsetWidth`/`offsetHeight` the instant the
// scroll ref is attached (see virtual-core's `observeElementRect`), and
// jsdom always reports 0 for that — before its ResizeObserver stub (which
// never fires) would even get a chance to correct it. A component told its
// viewport is 0px tall legitimately renders zero rows, which reads like a
// missing-row bug rather than the environment artefact it is.
//
// Rather than weaken the tests, drop virtualisation, or reach into the test
// setup file, this component wraps the library's own `observeElementRect`
// with a fallback: whenever the *measured* rect comes back 0x0, it
// substitutes a fixed estimate instead of feeding the virtualiser a
// zero-height viewport. This exists for jsdom, which always measures 0x0 —
// but it is not jsdom-exclusive: a genuinely collapsed container in a real
// browser (`display: none`, a zero-height flex parent, a closed panel) hits
// the same branch and gets the same substitute rect. When that happens the
// virtualiser computes its range against a phantom ~800x420 viewport instead
// of the container's real (zero) size, so it may mount some extra rows into
// something invisible or mispositioned until the container's next real,
// non-zero measurement corrects it via the normal ResizeObserver path. No
// row data is lost or skipped either way — this only ever affects *how many
// rows are mounted and where*, never which rows exist in `rows` or whether
// they're reachable by scrolling once the container has a real size.
import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from "react";
import { useVirtualizer, observeElementRect, type Rect } from "@tanstack/react-virtual";
import { ResizableColumn } from "./resizable-column";
import { DataTableStatusRegion } from "./data-table-status";
import { DataTablePagination } from "./data-table-pagination";
import type { DataTableState } from "./data-table-types";
import { cn } from "@/lib/utils";

export interface DataTableColumn<T> {
  key: string;
  header: string;
  width?: number;
  render: (row: T) => ReactNode;
  sortable?: boolean;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  total: number;
  offset: number;
  limit: number;
  rowKey: (row: T) => string;
  state: DataTableState;
  errorMessage?: string;
  onPageChange: (offset: number) => void;
  onSortChange?: (key: string, dir: "asc" | "desc") => void;
  expandedContent?: (row: T) => ReactNode;
}

const DEFAULT_COLUMN_WIDTH = 160;
const MIN_COLUMN_WIDTH = 72;
const MAX_COLUMN_WIDTH = 640;
const EXPAND_COLUMN_WIDTH = 32;
const ROW_HEIGHT_ESTIMATE = 44;
const EXPANSION_HEIGHT_ESTIMATE = 96;
const VIEWPORT_HEIGHT = 420;
const FALLBACK_VIEWPORT_RECT: Rect = { width: 800, height: VIEWPORT_HEIGHT };

// See the file header note: substitutes a fixed estimate only when the
// scroll container's measured rect is 0x0 (always true in jsdom; also true
// for a genuinely collapsed container in a real browser), and otherwise
// passes the library's own, real measurement straight through unmodified.
const observeElementRectWithFallback: typeof observeElementRect = (instance, cb) =>
  observeElementRect(instance, (rect) => {
    cb(rect.width > 0 && rect.height > 0 ? rect : FALLBACK_VIEWPORT_RECT);
  });

type SortState = { key: string; dir: "asc" | "desc" };

type Entry<T> =
  | { kind: "row"; row: T }
  | { kind: "expansion"; row: T };

export function DataTable<T>(props: DataTableProps<T>) {
  const {
    columns,
    rows,
    total,
    offset,
    limit,
    rowKey,
    state,
    errorMessage,
    onPageChange,
    onSortChange,
    expandedContent,
  } = props;

  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(columns.map((c) => [c.key, c.width ?? DEFAULT_COLUMN_WIDTH])),
  );
  // Backfill widths for columns added after mount, without clobbering ones
  // the operator has already resized.
  useEffect(() => {
    setColumnWidths((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const column of columns) {
        if (!(column.key in next)) {
          next[column.key] = column.width ?? DEFAULT_COLUMN_WIDTH;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [columns]);

  const handleWidthChange = useCallback((key: string, width: number) => {
    setColumnWidths((prev) => (prev[key] === width ? prev : { ...prev, [key]: width }));
  }, []);

  const [sortState, setSortState] = useState<SortState | null>(null);
  const handleSort = useCallback(
    (column: DataTableColumn<T>) => {
      const nextDir: "asc" | "desc" =
        sortState?.key === column.key && sortState.dir === "asc" ? "desc" : "asc";
      setSortState({ key: column.key, dir: nextDir });
      onSortChange?.(column.key, nextDir);
    },
    [sortState, onSortChange],
  );

  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const toggleExpand = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const entries = useMemo<Entry<T>[]>(() => {
    const list: Entry<T>[] = [];
    for (const row of rows) {
      list.push({ kind: "row", row });
      if (expandedContent && expandedKeys.has(rowKey(row))) {
        list.push({ kind: "expansion", row });
      }
    }
    return list;
  }, [rows, expandedContent, expandedKeys, rowKey]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      entries[index]?.kind === "expansion" ? EXPANSION_HEIGHT_ESTIMATE : ROW_HEIGHT_ESTIMATE,
    overscan: 8,
    // See the file header note: this is what makes rows render under jsdom.
    observeElementRect: observeElementRectWithFallback,
    initialRect: FALLBACK_VIEWPORT_RECT,
  });

  const showTable = state !== "error";

  return (
    <div
      className="flex flex-col rounded-md border border-border"
      data-state={state}
      aria-busy={state === "loading" || undefined}
    >
      <DataTableStatusRegion state={state} errorMessage={errorMessage} />

      {showTable && (
        <>
          <div role="table" aria-rowcount={rows.length} className="min-w-full">
            <div role="row" className="flex items-stretch border-b border-border bg-muted/60 text-sm font-medium">
              {expandedContent && <div style={{ width: EXPAND_COLUMN_WIDTH }} className="shrink-0" />}
              {columns.map((column) => (
                <ColumnHeaderCell
                  key={column.key}
                  column={column}
                  width={columnWidths[column.key] ?? column.width ?? DEFAULT_COLUMN_WIDTH}
                  onWidthChange={handleWidthChange}
                  sortDir={sortState?.key === column.key ? sortState.dir : undefined}
                  onSort={column.sortable ? () => handleSort(column) : undefined}
                />
              ))}
            </div>

            <div ref={scrollRef} style={{ height: VIEWPORT_HEIGHT, overflowY: "auto" }} className="relative">
              <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                {virtualizer.getVirtualItems().map((virtualItem) => {
                  const entry = entries[virtualItem.index];
                  if (!entry) return null;
                  const key = `${rowKey(entry.row)}-${entry.kind}`;
                  return (
                    <div
                      key={key}
                      ref={virtualizer.measureElement}
                      data-index={virtualItem.index}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${virtualItem.start}px)`,
                      }}
                    >
                      {entry.kind === "row" ? (
                        <DataRow
                          row={entry.row}
                          columns={columns}
                          columnWidths={columnWidths}
                          rowKeyValue={rowKey(entry.row)}
                          expandable={Boolean(expandedContent)}
                          expanded={expandedKeys.has(rowKey(entry.row))}
                          onToggleExpand={toggleExpand}
                        />
                      ) : (
                        <div
                          className="flex border-b border-border bg-muted/20 px-3 py-2 text-sm"
                          style={{ paddingLeft: expandedContent ? EXPAND_COLUMN_WIDTH : undefined }}
                        >
                          {expandedContent?.(entry.row)}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <DataTablePagination offset={offset} limit={limit} total={total} onPageChange={onPageChange} />
        </>
      )}
    </div>
  );
}

function DataRow<T>({
  row,
  columns,
  columnWidths,
  rowKeyValue,
  expandable,
  expanded,
  onToggleExpand,
}: {
  row: T;
  columns: DataTableColumn<T>[];
  columnWidths: Record<string, number>;
  rowKeyValue: string;
  expandable: boolean;
  expanded: boolean;
  onToggleExpand: (key: string) => void;
}) {
  return (
    <div role="row" className="flex items-stretch border-b border-border text-sm">
      {expandable && (
        <div style={{ width: EXPAND_COLUMN_WIDTH }} className="flex shrink-0 items-center justify-center">
          <button
            type="button"
            aria-label={expanded ? "Collapse row" : "Expand row"}
            onClick={() => onToggleExpand(rowKeyValue)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
        </div>
      )}
      {columns.map((column) => (
        <div
          key={column.key}
          role="cell"
          style={{ width: columnWidths[column.key] ?? column.width ?? DEFAULT_COLUMN_WIDTH }}
          className="flex shrink-0 items-center truncate px-2 py-2"
        >
          {column.render(row)}
        </div>
      ))}
    </div>
  );
}

function ColumnHeaderCell<T>({
  column,
  width,
  onWidthChange,
  sortDir,
  onSort,
}: {
  column: DataTableColumn<T>;
  width: number;
  onWidthChange: (key: string, width: number) => void;
  sortDir: "asc" | "desc" | undefined;
  onSort: (() => void) | undefined;
}) {
  // Measures the rendered (resizable) cell so body columns can mirror its
  // width. ResizableColumn owns the drag logic and its own width state; this
  // is the one piece of glue needed to keep header and body columns aligned
  // without duplicating that logic.
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
    <div ref={measureRef} className="inline-block shrink-0 align-top">
      <ResizableColumn
        defaultWidth={width}
        minWidth={MIN_COLUMN_WIDTH}
        maxWidth={MAX_COLUMN_WIDTH}
        className="border-r border-border"
      >
        <div
          role="columnheader"
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
