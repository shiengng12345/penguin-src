// SubscriptionTable — lag per subscription, with its consumers rendered in
// the expanded row. This is the screen an operator lands on when a queue is
// backing up, so every number on it has to mean exactly what it says.
//
// Built on `DataTable`, same as `TopicTable`/`ConnectionTable`. `msgBacklog`,
// `unackedMessages` and `msgRateOut` are all `T | null` on
// `SubscriptionStats` (`packages/broker-contracts/src/topic-detail.ts`) — a
// null backlog means "we do not know", not "the queue is clear" — so every
// cell goes through `broker-value.ts`'s single "Unknown" presentation
// instead of falling back to `0`, `false`, or a blank cell. `subType` is a
// three-state `SubscriptionType` (fix: Phase A final review, finding 2) —
// Pulsar's own "unset" sentinel must not collapse into the same word as a
// genuinely withheld field. The "Consumers"
// column additionally distinguishes `consumers: null` ("Unknown" — Pulsar
// omitted the key) from `consumers: []` ("No consumers" — Pulsar confirmed
// nobody is attached); `ConsumerTable` carries that same distinction into
// the expanded row.
//
// `msgBacklog` always renders through plain `formatNumber`, regardless of
// `subscriptionBacklogSize` (Task 1, R34/R38 — corrected by the whole-stage
// review's item 1). This call explicitly asks `subscriptionBacklogSize=false`
// (spec §12.3 — computing the subscription-level *byte estimate* precisely
// can take Ledger locks on a busy broker), but measured directly against the
// live broker, `msgBacklog` itself comes back identical whether that flag is
// true or false; only `backlogSize` (which this table does not render)
// differs. An earlier version of this file routed `msgBacklog` through
// `formatScopedNumber` keyed on that flag, which rendered "Not requested" on
// every row of every topic — hiding the exact number this screen exists to
// show. A withheld `msgBacklog` (the broker genuinely did not answer) still
// reads "Unknown" via `formatNumber`, same as every other plain numeric
// field on this table.
//
// `msgRateOut` proves delivery to a consumer, never business completion —
// `DeliveryNotice` (the one place that caveat is worded) sits above the
// table, since the rate column applies to every row on this screen.
//
// There is no separate subscriptions-listing command — `stats.subscriptions`
// already carries the full list, so (like `ConnectionTable`) this table is
// always fully in memory: `total`/`limit` are derived from `subscriptions`
// itself and `onPageChange` has nothing to report.
import type { StatsRequestScope, SubscriptionStats } from "@penguin/broker-contracts";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import type { DataTableState } from "@/components/ui/data-table-types";
import { Button } from "@/components/ui/button";
import { DeliveryNotice } from "./DeliveryNotice";
import { ConsumerTable } from "./ConsumerTable";
import { formatConsumerCount, formatNumber, formatSubscriptionType } from "./broker-value";

export interface SubscriptionTableProps {
  subscriptions: SubscriptionStats[];
  /** `TopicStats.statsRequestScope` from the same `TopicDetail` these
   *  subscriptions came from — required, not defaulted, because the
   *  "Backlog" column's "Not requested" vs "Unknown" distinction (Task 1)
   *  is only correct when it reflects what was actually asked for this
   *  specific fetch. */
  scope: StatsRequestScope;
  state: DataTableState;
  errorMessage?: string;
  onRefresh: () => void;
}

export function SubscriptionTable({
  subscriptions,
  scope,
  state,
  errorMessage,
  onRefresh,
}: SubscriptionTableProps) {
  // "empty" here has a specific noun ("subscriptions"), not DataTable's
  // generic "No rows to show." — same bypass TopicTable uses for its own
  // specifically-worded empty case.
  if (state === "empty") {
    return (
      <div className="flex flex-col gap-2">
        <Header onRefresh={onRefresh} />
        <div
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground"
        >
          No subscriptions on this topic.
        </div>
      </div>
    );
  }

  const columns: DataTableColumn<SubscriptionStats>[] = [
    {
      key: "name",
      header: "Subscription",
      width: 320,
      grow: true,
      render: (s) => <span title={s.name}>{s.name}</span>,
      sortable: true,
    },
    { key: "subType", header: "Type", width: 100, render: (s) => formatSubscriptionType(s.subType) },
    {
      key: "msgBacklog",
      header: "Backlog",
      width: 100,
      // Not scoped by `subscriptionBacklogSize` — see this file's header
      // comment. That flag governs `backlogSize` (a different field this
      // table does not render), not `msgBacklog`; the real number must
      // always show.
      render: (s) => formatNumber(s.msgBacklog),
      sortable: true,
    },
    {
      key: "unackedMessages",
      header: "Unacked",
      width: 100,
      render: (s) => formatNumber(s.unackedMessages),
    },
    {
      key: "msgRateOut",
      header: "Rate out (msg/s)",
      width: 140,
      render: (s) => formatNumber(s.msgRateOut),
    },
    {
      key: "consumers",
      header: "Consumers",
      width: 130,
      render: (s) => formatConsumerCount(s.consumers),
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      <Header onRefresh={onRefresh} />
      <DeliveryNotice variant="block" />
      <DataTable
        columns={columns}
        rows={subscriptions}
        total={subscriptions.length}
        offset={0}
        limit={Math.max(subscriptions.length, 1)}
        rowKey={(s) => s.name}
        state={state}
        errorMessage={errorMessage}
        onPageChange={() => {}}
        expandLabel={(s) => s.name}
        expandedContent={(s) => <ConsumerTable consumers={s.consumers} />}
      />
    </div>
  );
}

function Header({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-medium">Subscriptions</h2>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}
