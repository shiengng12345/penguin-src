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
// about. `state` carries how trustworthy that data is; `error` carries the
// human-readable reason when there is one. They are read together — this
// hook never collapses "here is data, and here is something you should
// know about it" down to a single error flag, and never treats
// `warnings.length > 0` as a failure. `error` present with `data` absent is
// the only genuine failure case.
import { useCallback, useEffect, useState } from "react";
import type { NamespaceSummary, ResultEnvelope, TenantSummary } from "@penguin/broker-contracts";
import { listNamespaces, listTenants } from "@/lib/broker-client";
import type { DataTableState } from "@/components/ui/data-table-types";

export interface UseBrokerTopologyResult {
  tenants: TenantSummary[];
  namespaces: NamespaceSummary[];
  selectedTenant: string | null;
  selectedNamespace: string | null;
  selectTenant: (tenant: string) => void;
  selectNamespace: (namespace: string) => void;
  state: DataTableState;
  error?: string;
  refresh: () => void;
}

interface FetchResult {
  state: DataTableState;
  error?: string;
}

const LOADING: FetchResult = { state: "loading" };

/** Reduces one envelope to the (state, error) pair its caller renders.
 *  `data` present + `warnings` non-empty is a partial success (stale cache,
 *  clock skew, or a broker failure served from the last known cache) —
 *  never `"error"`. Only `data === undefined` is the genuine failure. */
function deriveResult<T extends { length: number }>(envelope: ResultEnvelope<T>): FetchResult {
  if (envelope.data === undefined) {
    return { state: "error", error: envelope.error?.message ?? "Failed to load." };
  }
  if (envelope.warnings.length > 0) {
    return { state: "stale", error: envelope.warnings[0] };
  }
  return { state: envelope.data.length === 0 ? "empty" : "ready", error: undefined };
}

/** Combines the tenants and namespaces fetch results into the single
 *  `state`/`error` pair TopologyTree renders, worst-first: a hard error
 *  anywhere wins over a stale/partial warning, which wins over still
 *  loading, which wins over an empty list, which wins over ready. This
 *  means a fine tenant list next to a stale namespace list still surfaces
 *  as "stale" — the operator needs to know part of what's on screen is
 *  suspect, even if the rest is fresh. */
function combine(tenants: FetchResult, namespaces: FetchResult | null): FetchResult {
  const order: DataTableState[] = ["error", "stale", "partial", "loading", "empty", "ready"];
  const candidates = namespaces ? [tenants, namespaces] : [tenants];
  for (const wanted of order) {
    const hit = candidates.find((c) => c.state === wanted);
    if (hit) return hit;
  }
  return tenants;
}

export function useBrokerTopology(connectionId: string | null | undefined): UseBrokerTopologyResult {
  const [tenants, setTenants] = useState<TenantSummary[]>([]);
  const [namespaces, setNamespaces] = useState<NamespaceSummary[]>([]);
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [selectedNamespace, setSelectedNamespace] = useState<string | null>(null);
  const [tenantsResult, setTenantsResult] = useState<FetchResult>(LOADING);
  const [namespacesResult, setNamespacesResult] = useState<FetchResult | null>(null);

  const fetchTenants = useCallback(
    async (refresh = false) => {
      if (!connectionId) {
        setTenants([]);
        setTenantsResult({ state: "empty" });
        return;
      }
      setTenantsResult(LOADING);
      try {
        const envelope = await listTenants(connectionId, refresh);
        setTenants(envelope.data ?? []);
        setTenantsResult(deriveResult(envelope));
      } catch (err) {
        setTenants([]);
        setTenantsResult({ state: "error", error: err instanceof Error ? err.message : String(err) });
      }
    },
    [connectionId],
  );

  const fetchNamespaces = useCallback(
    async (tenant: string, refresh = false) => {
      if (!connectionId) return;
      setNamespacesResult(LOADING);
      try {
        const envelope = await listNamespaces(connectionId, tenant, refresh);
        setNamespaces(envelope.data ?? []);
        setNamespacesResult(deriveResult(envelope));
      } catch (err) {
        setNamespaces([]);
        setNamespacesResult({ state: "error", error: err instanceof Error ? err.message : String(err) });
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
    error: combined.error,
    refresh,
  };
}
