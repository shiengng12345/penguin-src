// useTopicDetail — state behind `TopicDetailPanel`, the pane the Topics tab
// opens when a topic row is selected.
//
// `getTopicDetail` never reads the cache (ruling D-A2 — see
// `commands/topic_detail.rs`'s module doc), so in practice its envelope
// should always arrive with `warnings: []`. This hook does not assume that
// though: it reduces the envelope the same way `useBrokerTopology` and
// `useBrokerOverview` do, from `data`/`warnings` alone, never from
// `source`, so a future change to that guarantee (or a transport-level
// warning neither of those two commands anticipated) still renders
// correctly instead of silently being misread as `"ready"`.
//
// Takes a `TopicSummary | null` rather than a bespoke `{tenant, namespace,
// topic, persistent}` shape so a caller can pass the row `TopicTable`
// handed it straight through; the effect dependency array below still
// destructures the primitive fields it needs so a fresh object identity
// each render (the row itself doesn't change, but a caller reconstructing
// it would) never causes a spurious refetch loop.
import { useCallback, useEffect, useState } from "react";
import type { ResultEnvelope, TopicDetail, TopicSummary } from "@penguin/broker-contracts";
import { getTopicDetail } from "@/lib/broker-client";
import type { DataTableState } from "@/components/ui/data-table-types";

export interface UseTopicDetailResult {
  detail: TopicDetail | null;
  state: DataTableState;
  errorMessage?: string;
  /** Every warning attached to the current state — never truncated to one,
   *  same rule as every other broker-command hook. */
  warnings: string[];
  refresh: () => void;
}

interface DerivedResult {
  state: DataTableState;
  errorMessage?: string;
  warnings: string[];
}

/** Reduces one `broker_get_topic_detail` envelope to the `(state,
 *  errorMessage, warnings)` triple this hook returns. There is no
 *  `"empty"` case here — unlike a topic *list*, a topic detail is never a
 *  collection that can itself be empty; a topic with zero subscriptions
 *  still has real stats to show, which `TopicDetailPanel`'s own
 *  `SubscriptionTable` renders as its own "empty" sub-state. */
export function deriveTopicDetailResult(envelope: ResultEnvelope<TopicDetail>): DerivedResult {
  if (envelope.data === undefined) {
    return { state: "error", errorMessage: envelope.error?.message, warnings: [] };
  }
  if (envelope.warnings.length > 0) {
    return { state: "stale", warnings: envelope.warnings };
  }
  return { state: "ready", warnings: [] };
}

export function useTopicDetail(
  connectionId: string | null | undefined,
  topic: TopicSummary | null,
): UseTopicDetailResult {
  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [state, setState] = useState<DataTableState>("loading");
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const [warnings, setWarnings] = useState<string[]>([]);

  const fetchDetail = useCallback(async () => {
    if (!connectionId || !topic) {
      setDetail(null);
      setErrorMessage(undefined);
      setWarnings([]);
      setState("loading");
      return;
    }
    setState("loading");
    try {
      const envelope = await getTopicDetail(
        connectionId,
        topic.tenant,
        topic.namespace,
        topic.shortName,
        topic.persistent,
      );
      if (envelope.data) {
        setDetail(envelope.data);
      }
      const result = deriveTopicDetailResult(envelope);
      setState(result.state);
      setErrorMessage(result.errorMessage);
      setWarnings(result.warnings);
    } catch (err) {
      setDetail(null);
      setState("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setWarnings([]);
    }
    // Deliberately destructured to primitive fields — see the file header.
  }, [connectionId, topic?.tenant, topic?.namespace, topic?.shortName, topic?.persistent]);

  useEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  const refresh = useCallback(() => {
    void fetchDetail();
  }, [fetchDetail]);

  return { detail, state, errorMessage, warnings, refresh };
}
