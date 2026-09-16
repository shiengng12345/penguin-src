// TopicDetailPanel — the screen an operator opens when one specific topic
// looks wrong. Composes SubscriptionTable (Task 11), DeliveryNotice
// (Task 9), and `getTopicDetail` (Task 8) into one read-only view.
//
// Three distinctions this panel must not flatten (five tasks of backend
// work exist to keep them apart):
//
// 1. `oldestBacklogMessageAge` has three states, not two. `noBacklog`
//    ("no backlog has ever existed") is a determinate, healthy fact;
//    `unknown` means the broker did not tell us. Both rendering as "—"
//    would make a healthy topic indistinguishable from an unmeasurable
//    one. `formatBacklogAge` (broker-value.ts) gives each its own word.
// 2. `indeterminate` is rendered in its own section, visually distinct
//    from `anomalies`, and never hidden just because `anomalies` is
//    empty — an `IndeterminateCheck` says a check could not run, not that
//    something is wrong. Silence on both is the only "all clear"; silence
//    on `anomalies` alone, next to a non-empty `indeterminate`, must not
//    read that way.
// 3. Cursor positions (`markDeletePosition`, `readPosition`,
//    `lastConfirmedEntry`) go through `formatPosition`, which renders
//    `entryId: -1` verbatim — a real "nothing acknowledged yet" fact, not
//    a gap to blank out.
//
// This panel is entirely read-only (Phase A) — no mutation, no
// WritePermit — and every rate on it sits under a `DeliveryNotice`: these
// numbers prove delivery to a consumer, never business completion.
//
// Phase A final review, finding 3: `state === "loading"` is checked before
// `detail === null`, not only inside it. The loading branch used to live
// entirely inside the `detail === null` case, so once any topic had ever
// loaded, a later "loading" (a new topic selected, or a manual refresh)
// rendered nothing — the previous topic's stats, anomalies and
// subscriptions stayed on screen with no sign a new fetch was in flight,
// mislabeled as belonging to whatever topic was actually loading. Loading
// now always takes priority and blanks the panel, the same way
// `AnomalyPanel` handles its own `state === "loading"`.
import type { Anomaly, IndeterminateCheck, TopicDetail } from "@penguin/broker-contracts";
import type { DataTableState } from "@/components/ui/data-table-types";
import { Button } from "@/components/ui/button";
import { DeliveryNotice } from "./DeliveryNotice";
import { SubscriptionTable } from "./SubscriptionTable";
import { formatNumber, formatPosition, formatScopedBacklogAge, formatScopedNumber } from "./broker-value";
import { ALERT_CLASS, INDETERMINATE_CLASS, STATUS_CLASS } from "./broker-panel-styles";

export interface TopicDetailPanelProps {
  detail: TopicDetail | null;
  state: DataTableState;
  errorMessage?: string;
  /** Every warning attached to the current `state` (see
   *  `useBrokerTopology`'s `deriveResult` for the pattern this follows).
   *  `getTopicDetail` never reads the cache, so a `"cache"` source/warning
   *  should never actually reach this panel — but the prop still exists so
   *  a caller that surfaces a `ResultEnvelope`'s warnings has somewhere to
   *  put them without inventing a second, parallel notice. */
  warnings?: string[];
  onRefresh: () => void;
}

export function TopicDetailPanel({
  detail,
  state,
  errorMessage,
  warnings = [],
  onRefresh,
}: TopicDetailPanelProps) {
  if (state === "loading") {
    // The header never names a topic here, even if `detail` still holds a
    // previous topic's data: while loading, this component cannot vouch
    // for which topic that stale `detail` actually belongs to (a switch to
    // a different topic and a same-topic refresh both pass through here).
    return (
      <div className="flex flex-col gap-2">
        <PanelHeader topic={null} onRefresh={onRefresh} />
        <div role="status" className={STATUS_CLASS}>
          Loading topic detail…
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="flex flex-col gap-2">
        <PanelHeader topic={null} onRefresh={onRefresh} />
        <div role="alert" className={ALERT_CLASS}>
          {errorMessage ?? "Failed to load topic detail."}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PanelHeader topic={detail.topic} onRefresh={onRefresh} />

      {state === "error" && (
        <div role="alert" className={ALERT_CLASS}>
          {errorMessage ?? "Failed to load the latest topic detail."}
        </div>
      )}
      {(state === "stale" || state === "partial") && warnings.length > 0 && (
        <div role="status" className={STATUS_CLASS}>
          <ul className="list-disc pl-4">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      <StatsSection detail={detail} />
      <AnomaliesSection anomalies={detail.anomalies} />
      <IndeterminateSection checks={detail.indeterminate} />
      <InternalStatsSection detail={detail} />

      <SubscriptionTable
        subscriptions={detail.stats.subscriptions}
        scope={detail.stats.statsRequestScope}
        state={detail.stats.subscriptions.length === 0 ? "empty" : "ready"}
        onRefresh={onRefresh}
      />
    </div>
  );
}

function PanelHeader({ topic, onRefresh }: { topic: string | null; onRefresh: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="text-sm font-medium" title={topic ?? undefined}>
        {topic ?? "Topic detail"}
      </h2>
      <Button type="button" size="sm" variant="outline" onClick={onRefresh}>
        Refresh
      </Button>
    </div>
  );
}

/** Topic-level stats and rates. Every rate sits under a `DeliveryNotice`:
 *  `msgRateIn`/`msgRateOut`/throughput are all delivery counts, never a
 *  claim of business completion. `oldestBacklogMessageAge` goes through
 *  `formatBacklogAge`, which is the only place that three-state distinction
 *  is allowed to be collapsed to text. */
function StatsSection({ detail }: { detail: TopicDetail }) {
  const { stats } = detail;
  const rows: Array<[string, string]> = [
    ["Msg rate in (msg/s)", formatNumber(stats.msgRateIn)],
    ["Msg rate out (msg/s)", formatNumber(stats.msgRateOut)],
    ["Throughput in (bytes/s)", formatNumber(stats.msgThroughputIn)],
    ["Throughput out (bytes/s)", formatNumber(stats.msgThroughputOut)],
    ["Storage size (bytes)", formatNumber(stats.storageSize)],
    // Backlog size and oldest-backlog-age are both governed by a
    // `StatsRequestScope` flag (Task 1, R34/R38) — "Not requested" takes
    // priority over whatever the raw value parsed to when this call
    // deliberately did not ask for a precise answer.
    ["Backlog size (bytes)", formatScopedNumber(stats.backlogSize, stats.statsRequestScope, "topicBacklogSize")],
    ["Msg in counter", formatNumber(stats.msgInCounter)],
    [
      "Oldest backlog message age",
      formatScopedBacklogAge(stats.oldestBacklogMessageAge, stats.statsRequestScope),
    ],
  ];

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Stats</h3>
      <DeliveryNotice variant="block" />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        {rows.map(([label, value]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** `anomalies` — concrete, evidenced problems. Empty is worded as "no
 *  anomalies detected in the checks that ran" rather than a bare "clean",
 *  because that claim is only true once `IndeterminateSection` below is
 *  also checked: `anomalies` empty and `indeterminate` non-empty means some
 *  checks never ran, not that everything is fine. */
function AnomaliesSection({ anomalies }: { anomalies: Anomaly[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Anomalies</h3>
      {anomalies.length === 0 ? (
        <div role="status" className={STATUS_CLASS}>
          No anomalies detected in the checks that ran.
        </div>
      ) : (
        <ul role="alert" className={`${ALERT_CLASS} flex flex-col gap-1`}>
          {anomalies.map((anomaly, index) => (
            <li key={`${anomaly.kind}-${anomaly.subscription ?? "topic"}-${index}`}>
              <span className="font-medium">{anomaly.kind}</span>
              {anomaly.subscription && <span> ({anomaly.subscription})</span>}: {anomaly.detail} — observed{" "}
              {anomaly.observedValue}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `indeterminate` — checks that could not be evaluated because their input
 *  was withheld. Deliberately styled differently from `AnomaliesSection`
 *  (amber, not destructive-red; its own heading) and worded as "could not
 *  run" / "could not be verified", never as a problem found — an
 *  `IndeterminateCheck` is the opposite claim from an `Anomaly`. Rendered
 *  even when `anomalies` is empty, and even when `checks` itself is empty
 *  (confirming every check ran is itself a meaningful, positive fact). */
function IndeterminateSection({ checks }: { checks: IndeterminateCheck[] }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Checks that could not run</h3>
      {checks.length === 0 ? (
        <div role="status" className={STATUS_CLASS}>
          Every anomaly check had enough data to run.
        </div>
      ) : (
        <ul role="status" className={`${INDETERMINATE_CLASS} flex flex-col gap-1`}>
          {checks.map((check, index) => (
            <li key={`${check.kind}-${check.subscription ?? "topic"}-${index}`}>
              <span className="font-medium">{check.kind}</span>
              {check.subscription && <span> ({check.subscription})</span>} could not be evaluated:{" "}
              {check.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** `internalStats` — where each subscription's cursor actually sits in the
 *  ledger, as opposed to `stats`'s throughput/backlog counts. Every
 *  position goes through `formatPosition`, which renders `entryId: -1`
 *  verbatim rather than blanking it. */
function InternalStatsSection({ detail }: { detail: TopicDetail }) {
  const { internal } = detail;
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Ledger and cursors</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Entries added</dt>
          <dd>{formatNumber(internal.entriesAddedCounter)}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Number of entries</dt>
          <dd>{formatNumber(internal.numberOfEntries)}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">Last confirmed entry</dt>
          <dd>{formatPosition(internal.lastConfirmedEntry)}</dd>
        </div>
      </dl>

      {internal.cursors.length === 0 ? (
        <div role="status" className={STATUS_CLASS}>
          No cursors reported for this topic.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th className="pr-4 font-normal">Subscription</th>
                <th className="pr-4 font-normal">Mark-delete position</th>
                <th className="pr-4 font-normal">Read position</th>
                <th className="pr-4 font-normal">Messages consumed</th>
              </tr>
            </thead>
            <tbody>
              {internal.cursors.map((cursor) => (
                <tr key={cursor.subscription}>
                  <td className="pr-4">{cursor.subscription}</td>
                  <td className="pr-4">{formatPosition(cursor.markDeletePosition)}</td>
                  <td className="pr-4">{formatPosition(cursor.readPosition)}</td>
                  <td className="pr-4">{formatNumber(cursor.messagesConsumedCounter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
