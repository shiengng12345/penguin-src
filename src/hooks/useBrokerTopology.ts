// useBrokerTopology — tenant/namespace navigation state behind TopologyTree.
//
// This is the first hook to read a `ResultEnvelope` from the broker
// commands (Task 4's `listTenants` / `listNamespaces`), so it is where the
// envelope contract meets React. The one thing it must get right: a
// response can carry `data` AND `warnings` at the same time — that is not
// an edge case, it is the normal stale-cache, clock-skew, and
// broker-failure-with-usable-cache path (Tasks 2-4). Hiding data an
// operator can still reason about is worse than marking it, so `tenants` /
// `namespaces` are populated from `envelope.data` whenever it is present,
// completely independently of whether there is also something to warn
// about. `state` carries how trustworthy that data is; `warnings` carries
// every reason there is to say so — ALL of them, not just the first: Task
// 4's `list_namespaces_through_cache` can push a data-integrity warning
// (a malformed "tenant/namespace" entry) into the very same array that
// already carries a staleness footnote, and both need to reach the
// operator. `data` present with `warnings` empty is the only clean case;
// `data` absent is the only genuine failure.
//
// Shared failed-fetch policy (Phase A final review, finding 3), stated
// once here and followed by `useBrokerOverview` and `useTopicDetail` too:
// whenever a fetch does not yield a real `data` value — an error envelope
// (`data: undefined`) or a thrown exception alike — already-loaded state
// is cleared, never left showing a previous, now-superseded answer next to
// an error. `tenants`/`namespaces` below are set from `envelope.data ??
// []` on every fetch, so a failed one clears them the same way the
// `catch` block does; the other two hooks apply the identical rule to
// their own single value (`report`, `detail`). This was a real
// inconsistency until this fix: this hook already cleared, but the other
// two only cleared on a thrown exception, silently retaining a prior
// topic's detail (or a prior overview report) underneath a fresh error —
// exactly the "looks like an answer but is not one" defect this whole
// phase exists to prevent. Reusing an old value while calling it fresh is
// worse than showing nothing, so clear is the one policy, not retain.
//
// `subjects` (fix round 2) names which of the two independently-fetched
// lists — tenants, namespaces — actually produced the reported `state`.
// Tenants and namespaces are fetched separately and can be in completely
// different states at once (tenants ready, namespaces still loading; or
// tenants stale, namespaces genuinely empty), and a status message that
// doesn't know which list it's describing ends up either lying ("No
// tenants found." over a populated tenant list, when it was the selected
// tenant's namespace list that was empty) or going vague. `FetchResult` is
// constructed once per slice and always knows its own subject; `combine`
// carries that through instead of discarding it.
import { useCallback, useEffect, useState } from "react";
import type { NamespaceSummary, ResultEnvelope, TenantSummary } from "@penguin/broker-contracts";
import { listNamespaces, listTenants } from "@/lib/broker-client";
import type { DataTableState } from "@/components/ui/data-table-types";

/** Which independently-fetched list a `FetchResult` (or a slice of a
 *  combined result) describes. */
export type TopologySubject = "tenants" | "namespaces";

export interface UseBrokerTopologyResult {
  tenants: TenantSummary[];
  namespaces: NamespaceSummary[];
  selectedTenant: string | null;
  selectedNamespace: string | null;
  selectTenant: (tenant: string) => void;
  selectNamespace: (namespace: string) => void;
  state: DataTableState;
  /** Which list(s) produced `state`. Empty when it takes both fetches to
   *  explain the state (`"partial"`/`"error"` when both contribute, or
   *  there was only ever one fetch and it's the obvious subject — see
   *  `combine`). A single-element array is the common, actionable case:
   *  "namespaces" is empty/loading/stale while tenants is fine. */
  subjects: TopologySubject[];
  /** Every warning attached to the current state, from both the tenants and
   *  the namespaces fetch — concatenated, never truncated to one. Empty
   *  when `state` is `"ready"`/`"empty"`/`"loading"`. Carries the hard
   *  failure's message too when `state === "error"`/`"partial"`. */
  warnings: string[];
  refresh: () => void;
}

interface FetchResult {
  state: DataTableState;
  subject: TopologySubject;
  warnings: string[];
}

interface CombinedResult {
  state: DataTableState;
  subjects: TopologySubject[];
  warnings: string[];
}

function loadingResult(subject: TopologySubject): FetchResult {
  return { state: "loading", subject, warnings: [] };
}

/** Reduces one envelope to the (state, subject, warnings) triple its caller
 *  renders. `data` present + `warnings` non-empty is a partial success
 *  (stale cache, clock skew, or a broker failure served from the last known
 *  cache) — never `"error"`. Only `data === undefined` is the genuine
 *  failure, and even then the message is carried the same way (as a
 *  one-element `warnings` array) rather than a separate field, so callers
 *  never have to read two different places depending on which case they're
 *  in. */
function deriveResult<T extends { length: number }>(
  envelope: ResultEnvelope<T>,
  subject: TopologySubject,
): FetchResult {
  if (envelope.data === undefined) {
    return { state: "error", subject, warnings: [envelope.error?.message ?? "Failed to load."] };
  }
  if (envelope.warnings.length > 0) {
    return { state: "stale", subject, warnings: envelope.warnings };
  }
  return { state: envelope.data.length === 0 ? "empty" : "ready", subject, warnings: [] };
}

/** Combines the tenants and namespaces fetch results into the single
 *  `state`/`subjects`/`warnings` triple TopologyTree renders. Every warning
 *  from both sides is concatenated — never one winner's message picked over
 *  the other's, so a stale tenant list next to a namespace list carrying a
 *  malformed-entry warning surfaces both, not just one.
 *
 *  State precedence is NOT a flat "worst wins" over both slices, because a
 *  hard failure in exactly one of the two is a different situation from a
 *  hard failure in both (or the only fetch there is): the other list is
 *  still real, still on screen, and the operator can still work from it.
 *  That is `"partial"` — reserved for exactly that mix. `"error"` is
 *  reserved for when both fetches failed, or there is only one fetch
 *  (no tenant selected yet) and it failed.
 *
 *  For the remaining states, `subjects` names exactly which slice(s) are in
 *  that state — usually one, since tenants and namespaces settle
 *  independently. If both happen to land in the same state at once (e.g.
 *  both genuinely stale at the same moment), naming one over the other
 *  would be arbitrary, so both are reported and the caller falls back to
 *  neutral wording rather than picking a side. */
function combine(tenants: FetchResult, namespaces: FetchResult | null): CombinedResult {
  const candidates = namespaces ? [tenants, namespaces] : [tenants];
  const warnings = candidates.flatMap((c) => c.warnings);

  if (namespaces) {
    const tenantsFailed = tenants.state === "error";
    const namespacesFailed = namespaces.state === "error";
    if (tenantsFailed !== namespacesFailed) return { state: "partial", subjects: [], warnings };
    if (tenantsFailed && namespacesFailed) return { state: "error", subjects: [], warnings };
  } else if (tenants.state === "error") {
    return { state: "error", subjects: [tenants.subject], warnings };
  }

  const order: DataTableState[] = ["stale", "loading", "empty", "ready"];
  for (const wanted of order) {
    const matching = candidates.filter((c) => c.state === wanted);
    if (matching.length > 0) {
      return { state: wanted, subjects: matching.map((c) => c.subject), warnings };
    }
  }
  return { state: tenants.state, subjects: [tenants.subject], warnings };
}

export function useBrokerTopology(connectionId: string | null | undefined): UseBrokerTopologyResult {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
  const [tenantsResult, setTenantsResult] = useState<FetchResult>(loadingResult("tenants"));
  const [namespacesResult, setNamespacesResult] = useState<FetchResult | null>(null);

  const fetchTenants = useCallback(
    async (refresh = false) => {
      if (!connectionId) {
        setTenants([]);
        setTenantsResult({ state: "empty", subject: "tenants", warnings: [] });
        return;
      }
      setTenantsResult(loadingResult("tenants"));
      try {
        const envelope = await listTenants(connectionId, refresh);
        setTenants(envelope.data ?? []);
        setTenantsResult(deriveResult(envelope, "tenants"));
      } catch (err) {
        setTenants([]);
        setTenantsResult({
          state: "error",
          subject: "tenants",
          warnings: [err instanceof Error ? err.message : String(err)],
        });
      }
    },
    [connectionId],
  );

  const fetchNamespaces = useCallback(
    async (tenant: string, refresh = false) => {
      if (!connectionId) return;
      setNamespacesResult(loadingResult("namespaces"));
      try {
        const envelope = await listNamespaces(connectionId, tenant, refresh);
        setNamespaces(envelope.data ?? []);
        setNamespacesResult(deriveResult(envelope, "namespaces"));
      } catch (err) {
        setNamespaces([]);
        setNamespacesResult({
          state: "error",
          subject: "namespaces",
          warnings: [err instanceof Error ? err.message : String(err)],
        });
      }
    },
    [connectionId],
  );

  // A new (or cleared) connection invalidates whatever tenant/namespace was
  // selected against the old one — an id from `pulsar-conn` means nothing
  // once the active connection is `pulsar-conn-2`.
  useEffect(() => {
    setSelectedTenant(null);
    setSelectedNamespace(null);
    setNamespaces([]);
    setNamespacesResult(null);
    void fetchTenants();
    // fetchTenants is recreated only when connectionId changes, so this
    // still runs exactly once per connection.
  }, [connectionId, fetchTenants]);

  const selectTenant = useCallback(
    (tenant: string) => {
      setSelectedTenant(tenant);
      setSelectedNamespace(null);
      void fetchNamespaces(tenant);
    },
    [fetchNamespaces],
  );

  const selectNamespace = useCallback((namespace: string) => {
    setSelectedNamespace(namespace);
  }, []);

  const refresh = useCallback(() => {
    void fetchTenants(true);
    if (selectedTenant) void fetchNamespaces(selectedTenant, true);
  }, [fetchTenants, fetchNamespaces, selectedTenant]);

  const combined = combine(tenantsResult, namespacesResult);

  return {
    tenants,
    namespaces,
    selectedTenant,
    selectedNamespace,
    selectTenant,
    selectNamespace,
    state: combined.state,
    subjects: combined.subjects,
    warnings: combined.warnings,
    refresh,
  };
}
