// ConsumerTable — the consumers attached to one subscription, rendered
// inside SubscriptionTable's expanded row.
//
// `consumers: null` and `consumers: []` are different, determinate facts on
// `SubscriptionStats` (see `packages/broker-contracts/src/topic-detail.ts`):
// null means Pulsar omitted the `consumers` key entirely — we do not know
// who, if anyone, is attached; `[]` means Pulsar sent the key with zero
// entries — confirmed, nobody is. Showing the same empty table for both
// would erase exactly the distinction those two shapes exist to preserve, so
// each gets its own `role="status"` message instead of a `DataTable` at all;
// only a populated list reaches the table below.
//
// `blockedOnUnackedMsgs` is rendered in words via `formatBlocked` — never a
// colour — because it is the single most diagnostic consumer signal in the
// payload (the broker itself stopped delivering) and a `null` here must
// never read as "Not blocked".
//
// Whole-stage review item 3: an empty `consumers` array is not always the
// confirmed-nobody-attached fact it looks like — `scope.excludeConsumers`
// makes Pulsar send that same `[]` for a request that never asked for
// consumer detail at all (spec §12.3: 「被排除的列表不是「列表为空」」). The empty
// branch below checks `wasFieldRequested` before claiming "No consumers".
import type { ConsumerStats, StatsRequestScope } from "@penguin/broker-contracts";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { DeliveryNotice } from "./DeliveryNotice";
import {
  formatBlocked,
  formatConsumerTimestamp,
  formatNumber,
  formatText,
  NOT_REQUESTED,
  wasFieldRequested,
} from "./broker-value";

export interface ConsumerTableProps {
  consumers: ConsumerStats[] | null;
  /** `TopicStats.statsRequestScope` from the same `TopicDetail` this
   *  subscription's consumers came from — see `SubscriptionTable`'s own
   *  `scope` prop doc; required for the identical reason. */
  scope: StatsRequestScope;
}

const STATUS_CLASS =
  "rounded border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground";

export function ConsumerTable({ consumers, scope }: ConsumerTableProps) {
  if (consumers === null) {
    return (
      <div role="status" className={STATUS_CLASS}>
        Consumer list unknown — Pulsar did not report who is attached to this subscription.
      </div>
    );
  }

  if (consumers.length === 0) {
    if (!wasFieldRequested(scope, "subscriptionConsumers")) {
      return (
        <div role="status" className={STATUS_CLASS}>
          {NOT_REQUESTED} — this call excluded consumer detail (excludeConsumers), so an empty
          list here does not mean nobody is attached.
        </div>
      );
    }
    return (
      <div role="status" className={STATUS_CLASS}>
        No consumers attached to this subscription.
      </div>
    );
  }

  const columns: DataTableColumn<ConsumerStats>[] = [
    {
      key: "consumerName",
      header: "Consumer",
      width: 160,
      grow: true,
      render: (c) => formatText(c.consumerName),
    },
    { key: "address", header: "Address", width: 160, render: (c) => formatText(c.address) },
    {
      key: "clientVersion",
      header: "Client version",
      width: 160,
      render: (c) => formatText(c.clientVersion),
    },
    {
      key: "availablePermits",
      header: "Permits",
      width: 90,
      render: (c) => formatNumber(c.availablePermits),
    },
    {
      key: "unackedMessages",
      header: "Unacked",
      width: 90,
      render: (c) => formatNumber(c.unackedMessages),
    },
    {
      key: "msgRateOut",
      header: "Rate out (msg/s)",
      width: 130,
      render: (c) => formatNumber(c.msgRateOut),
    },
    {
      key: "lastAckedTimestamp",
      header: "Last acked",
      width: 160,
      render: (c) => formatConsumerTimestamp(c.lastAckedTimestamp),
    },
    {
      key: "lastConsumedTimestamp",
      header: "Last consumed",
      width: 160,
      render: (c) => formatConsumerTimestamp(c.lastConsumedTimestamp),
    },
    {
      key: "blockedOnUnackedMsgs",
      // Not "Blocked" — the cell itself renders that exact word for `true`,
      // and a column header reading the same word would collide with it
      // under a case-insensitive text query (and, for a screen reader user,
      // in practice too).
      header: "Blocking status",
      width: 120,
      render: (c) => formatBlocked(c.blockedOnUnackedMsgs),
    },
  ];

  return (
    <div className="flex flex-col gap-1">
      <DeliveryNotice variant="inline" />
      <DataTable
        columns={columns}
        rows={consumers}
        total={consumers.length}
        offset={0}
        limit={Math.max(consumers.length, 1)}
        // No stable id on ConsumerStats — address is the closest thing to
        // one in practice (a Pulsar client connection's socket address),
        // with consumerName as a fallback for the rare payload missing it.
        // Fix round 1 (task 11): the last resort used to be
        // `JSON.stringify(c)`, which can collide — two consumers with both
        // identity fields null and every other field equal produce the same
        // key. `consumers.indexOf(c)` is honest about being positional
        // instead of manufacturing an identity the data doesn't have.
        rowKey={(c) => c.address ?? c.consumerName ?? `consumer-${consumers.indexOf(c)}`}
        state="ready"
        // This list is already the full, in-memory `consumers` array handed
        // down from the parent subscription — there is nothing further to
        // page in from Rust.
        onPageChange={() => {}}
      />
    </div>
  );
}
