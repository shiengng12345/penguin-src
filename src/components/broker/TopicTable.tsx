// TopicTable — lists topics for the active broker connection.
//
// Built on `DataTable` (Task 16), same as `ConnectionTable`. A partitioned
// topic (e.g. `events` with 3 partitions) is already folded into ONE row by
// the Rust side (`topic_folding::fold_topics`, spec V-A6) before this
// component ever sees it — `TopicSummary.partitionNames` carries the
// expanded names, and this table reveals them via `expandedContent` rather
// than rendering one row per partition.
//
// Each row's expand toggle needs its own accessible name ("Expand events",
// not a generic "Expand row") because a table can hold many expandable
// topics at once and a user — or a test — must be able to target one by
// name. `DataTable` didn't have a seam for that until this task, which is
// why it now also takes `expandLabel` alongside `rowProps` (see
// `data-table.tsx`).
import type { TopicSummary } from "@penguin/broker-contracts";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import type { DataTableState } from "@/components/ui/data-table-types";

export interface TopicTableProps {
  topics: TopicSummary[];
  total: number;
  offset: number;
  limit: number;
  state: DataTableState;
  errorMessage?: string;
  onPageChange: (offset: number) => void;
  /** No connection is active — there is nothing to list, and no amount of
   *  retrying will fix it. Distinct from `state === "empty"` (an active
   *  connection whose namespace genuinely has zero topics): the guidance
   *  here points the operator at Connections, not at Pulsar. */
  noActiveConnection?: boolean;
}

export function TopicTable({
  topics,
  total,
  offset,
  limit,
  state,
  errorMessage,
  onPageChange,
  noActiveConnection,
}: TopicTableProps) {
  if (noActiveConnection) {
    return (
      <div
        role="status"
        className="rounded-md border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground"
      >
        No active connection — open Connections and set one active to see its topics.
      </div>
    );
  }

  const columns: DataTableColumn<TopicSummary>[] = [
    {
      key: "shortName",
      header: "Topic",
      // The primary identifier: real Pulsar topic names in this namespace
      // run well past 40 characters (e.g.
      // `LOCAL.BP.PAYMENT.PAYMENTACCOUNT.CHECKED.V1`, 42 chars), and two
      // topics that only differ near the end must stay distinguishable
      // without opening the row. `grow` lets it take whatever row width the
      // narrower columns below don't need; `width` is only its floor, and a
      // `title` covers the rare case a narrow window still truncates it.
      width: 420,
      grow: true,
      render: (t) => <span title={t.shortName}>{t.shortName}</span>,
      sortable: true,
    },
    {
      key: "namespace",
      header: "Namespace",
      width: 180,
      render: (t) => `${t.tenant}/${t.namespace}`,
      sortable: true,
    },
    {
      key: "persistent",
      header: "Type",
      width: 120,
      render: (t) => (t.persistent ? "Persistent" : "Non-persistent"),
    },
    {
      key: "partitions",
      header: "Partitions",
      width: 100,
      render: (t) => (t.partitions > 0 ? String(t.partitions) : "—"),
      sortable: true,
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={topics}
      total={total}
      offset={offset}
      limit={limit}
      rowKey={(t) => t.fullName}
      state={state}
      errorMessage={errorMessage}
      onPageChange={onPageChange}
      expandLabel={(t) => t.shortName}
      expandedContent={(t) =>
        t.partitions > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {t.partitionNames.map((name) => (
              <li key={name} className="truncate font-mono text-xs">
                {name}
              </li>
            ))}
          </ul>
        ) : (
          <span className="text-xs text-muted-foreground">Not partitioned.</span>
        )
      }
    />
  );
}
