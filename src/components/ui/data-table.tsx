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
import { useEffect, useMemo, useRef, useState, useCallback, type HTMLAttributes, type ReactNode } from "react";
import { useVirtualizer, observeElementRect, type Rect } from "@tanstack/react-virtual";
import { DataTableStatusRegion } from "./data-table-status";
import { DataTablePagination } from "./data-table-pagination";
import { DataRow, ColumnHeaderCell } from "./data-table-cells";
import {
  DEFAULT_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  EXPAND_COLUMN_WIDTH,
  type DataTableState,
  type DataTableColumn,
} from "./data-table-types";

// Re-exported for existing consumers (`TopicTable`, `ConnectionTable`, tests)
// that import the column type from this module — the type itself now lives
// in data-table-types.ts alongside the sizing constants above, so
// data-table-cells.tsx can use it without importing from here.
export type { DataTableColumn };

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
  /** Per-row attributes (e.g. `aria-current`, `aria-expanded`, `data-*`) to
   *  merge onto that row's own `role="row"` div — see
   *  `data-table-row-props.ts` for the merge policy. */
  rowProps?: (row: T) => HTMLAttributes<HTMLDivElement>;
  /** Per-row noun for the expand/collapse toggle's accessible name — e.g.
   *  `(t) => t.shortName` produces "Expand events" / "Collapse events"
   *  instead of the generic "Expand row" / "Collapse row". Needed whenever a
   *  consumer has more than one expandable row and a test or screen-reader
   *  user must be able to target one by name (see TopicTable, whose rows are
   *  otherwise indistinguishable by button name alone). Omit to keep the
   *  generic label. */
  expandLabel?: (row: T) => string;
}

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
    rowProps,
    expandLabel,
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
                  minWidth={MIN_COLUMN_WIDTH}
                  maxWidth={MAX_COLUMN_WIDTH}
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
                          rowProps={rowProps?.(entry.row)}
                          expandLabel={expandLabel?.(entry.row)}
                          expandColumnWidth={EXPAND_COLUMN_WIDTH}
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
