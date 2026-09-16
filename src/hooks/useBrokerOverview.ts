// useBrokerOverview — state behind the Overview tab's `AnomalyPanel`.
//
// `broker_get_overview` (Task 8) is a single fetch, not two independent
// lists like `useBrokerTopology`'s tenants/namespaces — so there is no
// `combine()`/`subjects` here, but the same envelope discipline applies:
// `data` and `warnings` can arrive together (a stale topic-list cache
// behind the sample, or a per-topic stats warning) and that is a partial
// success, not a failure. Only `data === undefined` is the real failure.
//
// `deriveOverviewResult` is exported, unit-testable on its own, for the
// same reason `BrokerPage`'s `deriveTopicResult` and `useBrokerTopology`'s
// internal `deriveResult` are: this is the one place `ResultEnvelope`
// meets `DataTableState`/`AnomalyPanelProps`, and it must never branch on
// `envelope.source`.
//
// `report.indeterminate` and `report.anomalies` are handed to the caller
// verbatim inside `report` — never defaulted, never truncated — so a
// consumer reads them straight off `report` rather than through a second,
// lossy mapping this hook could get wrong. Only when `report` itself is
// `null` (nothing fetched yet, or the fetch failed outright) does a caller
// have no real report to draw from at all.
//
// `report` is cleared whenever a fetch does not yield a real `data` value —
// see `useBrokerTopology.ts`'s header for the shared policy this hook
// follows (Phase A final review, finding 3). Before that fix `report` was
// only cleared when `invoke` threw, so an error *envelope* on a refresh
// left the previous report on screen next to the new error.
import { useCallback, useEffect, useState } from "react";
import type { OverviewReport, ResultEnvelope } from "@penguin/broker-contracts";
import { getOverview } from "@/lib/broker-client";
import type { DataTableState } from "@/components/ui/data-table-types";

export interface UseBrokerOverviewResult {
  report: OverviewReport | null;
  state: DataTableState;
  errorMessage?: string;
  /** Every warning attached to the current `state` — never truncated to
   *  one, same rule as `useBrokerTopology.warnings`. Empty for
   *  `"ready"`/`"empty"`/`"loading"`/`"error"`. */
  warnings: string[];
  refresh: () => void;
}

interface DerivedResult {
  state: DataTableState;
  errorMessage?: string;
  warnings: string[];
}

/** Reduces one `broker_get_overview` envelope to the `(state, errorMessage,
 *  warnings)` triple this hook returns. `data` present + `warnings`
 *  non-empty is a partial success (a stale topic-list cache under the
 *  sample, or one topic's stats being unavailable) — never `"error"`.
 *  `"empty"` is reserved for a genuinely empty namespace (`topicsSampled
 *  === 0`), which `AnomalyPanel` renders as "nothing was checked" rather
 *  than "checked and clean" — those are different claims. */
export function deriveOverviewResult(envelope: ResultEnvelope<OverviewReport>): DerivedResult {
  if (envelope.data === undefined) {
    return { state: "error", errorMessage: envelope.error?.message, warnings: [] };
  }
  if (envelope.warnings.length > 0) {
    return { state: "stale", warnings: envelope.warnings };
  }
  return { state: envelope.data.topicsSampled === 0 ? "empty" : "ready", warnings: [] };
}

export function useBrokerOverview(connectionId: string | null | undefined): UseBrokerOverviewResult {
  const [report, setReport] = useState<OverviewReport | null>(null);
  const [state, setState] = useState<DataTableState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);

  const fetchOverview = useCallback(async () => {
    if (!connectionId) {
      setReport(null);
      setErrorMessage(undefined);
      setWarnings([]);
      setState("empty");
      return;
    }
    setState("loading");
    try {
      const envelope = await getOverview(connectionId);
      // A broker failure that still yields a usable sample is a partial
      // success (rule 3, task-14-brief.md) — `report` is populated from
      // `data` whenever it is present, independently of `warnings`.
      if (envelope.data !== undefined) {
        setReport(envelope.data);
      } else {
        // An error envelope, not a thrown exception — must clear the same
        // way `catch` below does. See the shared clear-on-failure policy in
        // useBrokerTopology.ts's header.
        setReport(null);
      }
      const result = deriveOverviewResult(envelope);
      setState(result.state);
      setErrorMessage(result.errorMessage);
      setWarnings(result.warnings);
    } catch (err) {
      setReport(null);
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setWarnings([]);
    }
  }, [connectionId]);

  useEffect(() => {
    void fetchOverview();
  }, [fetchOverview]);

  const refresh = useCallback(() => {
    void fetchOverview();
  }, [fetchOverview]);

  return { report, state, errorMessage, warnings, refresh };
}
