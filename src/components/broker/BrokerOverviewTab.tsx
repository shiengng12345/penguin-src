// BrokerOverviewTab — wires `useBrokerOverview` to `AnomalyPanel`, so
// `BrokerPage` only needs to render this one component for the Overview
// tab (same split as `ConnectionActions` for the Connections tab).
//
// `getOverview` (Task 8) reads the active connection's own default
// tenant/namespace, not whatever the topology tree happens to have
// selected — the overview is a connection-wide sweep, not scoped to a
// browsed namespace — so this component takes only `connectionId`.
//
// When there is no active connection, this renders the same
// "no active connection" status `TopicTable` uses rather than mounting
// `AnomalyPanel` with a contrived `"empty"` state: "this namespace has no
// topics" would be a lie about a namespace that was never even queried.
import { useBrokerOverview } from "@/hooks/useBrokerOverview";
import { AnomalyPanel } from "./AnomalyPanel";

export interface BrokerOverviewTabProps {
  connectionId: string | null;
}

export function BrokerOverviewTab({ connectionId }: BrokerOverviewTabProps) {
  const { report, state, errorMessage, warnings, refresh } = useBrokerOverview(connectionId);

  if (!connectionId) {
    return (
      <div
        role="status"
        className="rounded-md border border-border bg-muted/40 px-3 py-6 text-center text-sm text-muted-foreground"
      >
        No active connection — open Connections and set one active to see its overview.
      </div>
    );
  }

  return (
    <AnomalyPanel
      // `report` is `null` only before the first fetch resolves or after a
      // hard failure (see `useBrokerOverview`'s doc) — in both cases there
      // is no real report to draw from, so `[]` here is a true statement
      // ("nothing has been reported"), never a stand-in for a report that
      // exists. Once `report` is non-null, `indeterminate` and `anomalies`
      // are read straight off it — rule 4, task-14-brief.md: never
      // substitute `[]` for a real report's `indeterminate`.
      anomalies={report?.anomalies ?? []}
      indeterminate={report?.indeterminate ?? []}
      topicsSampled={report?.topicsSampled}
      topicsTotal={report?.topicsTotal}
      truncated={report?.truncated ?? false}
      state={state}
      errorMessage={errorMessage}
      warnings={warnings}
      onRefresh={refresh}
    />
  );
}
