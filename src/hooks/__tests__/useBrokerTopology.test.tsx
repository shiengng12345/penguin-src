// useBrokerTopology — proves the hook's envelope interpretation, the part
// TopologyTree.test.tsx (presentational, props-driven) cannot exercise.
//
// Tasks 2-4 built four distinct outcomes on the wire and each means
// something different on screen: a fresh cache hit renders quietly; a stale
// cache, a clock-skewed cache, and a broker failure served from the last
// known cache all render the SAME way from the operator's point of view —
// rows on screen plus a warning naming what's wrong with them — because
// hiding data an operator can still reason about is worse than marking it.
// Only a response with no `data` at all is the real failure. These tests
// pin that: `data.length > 0` and a warning must both survive into the
// hook's return value at once, for all three "usable but suspect" cases,
// and a hard failure must still be visibly different (`state: "error"`) from
// all of them.
//
// Fix round 1 adds: every warning must survive, not just the first
// (`list_namespaces_through_cache` can push a malformed-entry warning into
// the same array that already carries a staleness footnote); and
// `"partial"` must actually be reachable for the one case that's genuinely
// different from "everything failed" — one of the two independent fetches
// (tenants, namespaces) hard-failing while the other still has something to
// show.
//
// Fix round 2 adds `subjects`: which of the two independently-fetched lists
// (tenants, namespaces) actually produced the reported `state`. Without it,
// a namespace-only "empty" or "loading" result was indistinguishable from a
// tenant-only one, and `TopologyTree` had no way to avoid rendering "No
// tenants found." above a populated tenant list just because the selected
// tenant's namespace list happened to be empty.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResultEnvelope, NamespaceSummary, TenantSummary } from "@penguin/broker-contracts";

const listTenantsMock = vi.fn();
const listNamespacesMock = vi.fn();

vi.mock("@/lib/broker-client", () => ({
  listTenants: (...args: unknown[]) => listTenantsMock(...args),
  listNamespaces: (...args: unknown[]) => listNamespacesMock(...args),
}));

const { useBrokerTopology } = await import("../useBrokerTopology");

const TENANTS: TenantSummary[] = [{ name: "public" }, { name: "pulsar" }];
const NAMESPACES: NamespaceSummary[] = [
  { tenant: "public", name: "default", full: "public/default" },
];

function tenantsEnvelope(overrides: Partial<ResultEnvelope<TenantSummary[]>> = {}): ResultEnvelope<TenantSummary[]> {
  return {
    data: TENANTS,
    source: "pulsar-admin-rest",
    observedAt: "2026-09-16T00:00:00.000Z",
    freshnessMs: 0,
    warnings: [],
    ...overrides,
  };
}

function failedEnvelope<T>(message: string): ResultEnvelope<T> {
  return {
    data: undefined,
    source: "pulsar-admin-rest",
    observedAt: "2026-09-16T00:00:00.000Z",
    freshnessMs: 0,
    warnings: [],
    error: { code: "SOURCE_UNAVAILABLE", message, retryable: true },
  };
}

beforeEach(() => {
  listTenantsMock.mockReset();
  listNamespacesMock.mockReset();
});

describe("useBrokerTopology", () => {
  it("renders a fresh cache hit normally — data, no warning, state ready", async () => {
    listTenantsMock.mockResolvedValueOnce(
      tenantsEnvelope({ source: "cache", freshnessMs: 1_000, warnings: [] }),
    );
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.tenants).toEqual(TENANTS);
    expect(result.current.warnings).toEqual([]);
  });

  it("renders a stale cache's rows AND its warning — not one or the other", async () => {
    listTenantsMock.mockResolvedValueOnce(
      tenantsEnvelope({
        source: "cache",
        freshnessMs: 400_000,
        warnings: ["Cached tenant list is 400000 ms old, past its freshness window; showing the last known list."],
      }),
    );
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.state).toBe("stale"));
    // The rows must still be there — deleting this line is the exact defect
    // this test exists to catch.
    expect(result.current.tenants).toEqual(TENANTS);
    expect(result.current.warnings.join(" ")).toMatch(/old|stale/i);
  });

  it("does not present a clock-skewed row as fresh, but still keeps the rows", async () => {
    listTenantsMock.mockResolvedValueOnce(
      tenantsEnvelope({
        source: "cache",
        freshnessMs: 0,
        warnings: [
          "Cached tenant list is stamped 5000 ms ahead of this machine's clock; its age cannot be measured. Showing it anyway — check the clocks.",
        ],
      }),
    );
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.state).toBe("stale"));
    expect(result.current.state).not.toBe("ready");
    expect(result.current.tenants).toEqual(TENANTS);
    expect(result.current.warnings.join(" ")).toMatch(/ahead|clock/i);
  });

  it("treats a broker failure served from a usable cache as a partial success, not an error screen", async () => {
    listTenantsMock.mockResolvedValueOnce(
      tenantsEnvelope({
        source: "cache",
        freshnessMs: 12_000,
        warnings: ["admin REST request timed out after 10000ms"],
      }),
    );
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.tenants).toEqual(TENANTS));
    // This is the crux: data is present, so this must not read as "error".
    expect(result.current.state).not.toBe("error");
    expect(result.current.state).toBe("stale");
    expect(result.current.warnings.join(" ")).toMatch(/timed out/i);
  });

  it("treats no data at all as the genuine failure case", async () => {
    listTenantsMock.mockResolvedValueOnce(failedEnvelope<TenantSummary[]>("connection refused"));
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.tenants).toEqual([]);
    expect(result.current.warnings.join(" ")).toMatch(/connection refused/i);
  });

  // Fix round 1, item 1: a single envelope can carry more than one warning
  // at once (the cache-read-through policy appends a data-integrity warning
  // — a malformed "tenant/namespace" entry — into the same array that
  // already holds the staleness footnote). Both must reach the hook's
  // output; keeping only `warnings[0]` would silently drop the
  // data-integrity signal behind the freshness one.
  it("keeps every warning on an envelope, not just the first", async () => {
    listTenantsMock.mockResolvedValueOnce(
      tenantsEnvelope({
        source: "cache",
        freshnessMs: 400_000,
        warnings: [
          "Cached tenant list is 400000 ms old, past its freshness window; showing the last known list.",
          'namespace "weird" did not contain the expected "tenant/namespace" separator; treating it as a bare name with no tenant',
        ],
      }),
    );
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.state).toBe("stale"));
    expect(result.current.warnings).toHaveLength(2);
    expect(result.current.warnings.some((w) => /old/i.test(w))).toBe(true);
    expect(result.current.warnings.some((w) => /separator/i.test(w))).toBe(true);
  });

  it("fetches namespaces for the selected tenant and passes connectionId explicitly", async () => {
    listTenantsMock.mockResolvedValueOnce(tenantsEnvelope());
    listNamespacesMock.mockResolvedValueOnce({
      data: NAMESPACES,
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
    } satisfies ResultEnvelope<NamespaceSummary[]>);
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      result.current.selectTenant("public");
    });

    await waitFor(() => expect(result.current.namespaces).toEqual(NAMESPACES));
    expect(result.current.selectedTenant).toBe("public");
    expect(listNamespacesMock).toHaveBeenCalledWith("conn-1", "public", false);
  });

  it("surfaces a stale namespace warning even while the tenant list itself is fine", async () => {
    listTenantsMock.mockResolvedValueOnce(tenantsEnvelope());
    listNamespacesMock.mockResolvedValueOnce({
      data: NAMESPACES,
      source: "cache",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 90_000,
      warnings: ["Cached namespace list is 90000 ms old, past its freshness window; showing the last known list."],
    } satisfies ResultEnvelope<NamespaceSummary[]>);
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      result.current.selectTenant("public");
    });

    await waitFor(() => expect(result.current.namespaces).toEqual(NAMESPACES));
    expect(result.current.state).toBe("stale");
    expect(result.current.warnings.join(" ")).toMatch(/namespace/i);
    // Fix round 2 re-check: the tenant list is fine, only the namespace
    // fetch is stale — the subject reported must name the list that's
    // actually stale, not both, and not neither.
    expect(result.current.subjects).toEqual(["namespaces"]);
  });

  // Fix round 2, item 1: a selected tenant with zero namespaces is a
  // genuinely different fact from "there are no tenants" — the tenant list
  // is right there, populated, on screen. `subjects` must say "namespaces",
  // not "tenants", so `TopologyTree` never renders "No tenants found."
  // above a populated tenant list.
  it("reports the namespaces subject as empty without contradicting a populated tenant list", async () => {
    listTenantsMock.mockResolvedValueOnce(tenantsEnvelope());
    listNamespacesMock.mockResolvedValueOnce({
      data: [],
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
    } satisfies ResultEnvelope<NamespaceSummary[]>);
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      result.current.selectTenant("public");
    });

    await waitFor(() => expect(result.current.state).toBe("empty"));
    expect(result.current.subjects).toEqual(["namespaces"]);
    // The crux: the tenant list did NOT become empty just because the
    // selected tenant's namespaces did.
    expect(result.current.tenants).toEqual(TENANTS);
  });

  // Fix round 2, item 2: the namespace fetch goes to "loading" the moment
  // `selectTenant` is called, while the tenant fetch is already settled
  // ("ready"). The reported subject must track which fetch is actually in
  // flight.
  it("reports the namespaces subject as loading while only the namespace fetch is in flight", async () => {
    listTenantsMock.mockResolvedValueOnce(tenantsEnvelope());
    let resolveNamespaces: (envelope: ResultEnvelope<NamespaceSummary[]>) => void = () => {};
    listNamespacesMock.mockImplementationOnce(
      () =>
        new Promise<ResultEnvelope<NamespaceSummary[]>>((resolve) => {
          resolveNamespaces = resolve;
        }),
    );
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      result.current.selectTenant("public");
    });

    await waitFor(() => expect(result.current.state).toBe("loading"));
    expect(result.current.subjects).toEqual(["namespaces"]);

    // Let the pending fetch settle so it doesn't leak into the next test.
    await act(async () => {
      resolveNamespaces({
        data: NAMESPACES,
        source: "pulsar-admin-rest",
        observedAt: "2026-09-16T00:00:00.000Z",
        freshnessMs: 0,
        warnings: [],
      });
    });
  });

  // Fix round 1, item 2: the namespace fetch hard-failing while the tenant
  // list is fine is NOT "everything failed" — the tenant list is still
  // real and still on screen. That is `"partial"`, distinct from
  // `"error"` (reserved for when both fail, or there is only one fetch and
  // it failed).
  it("marks the tree partial, not error, when only the namespace fetch hard-fails", async () => {
    listTenantsMock.mockResolvedValueOnce(tenantsEnvelope());
    listNamespacesMock.mockResolvedValueOnce(failedEnvelope<NamespaceSummary[]>("namespace list unavailable"));
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      result.current.selectTenant("public");
    });

    await waitFor(() => expect(result.current.state).toBe("partial"));
    // The tenant list that DID succeed must still be there underneath.
    expect(result.current.tenants).toEqual(TENANTS);
    expect(result.current.warnings.join(" ")).toMatch(/namespace list unavailable/i);
  });

  it("reserves error for when both fetches fail", async () => {
    listTenantsMock.mockResolvedValueOnce(failedEnvelope<TenantSummary[]>("tenants unavailable"));
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("error"));

    listNamespacesMock.mockResolvedValueOnce(failedEnvelope<NamespaceSummary[]>("namespaces unavailable"));
    act(() => {
      result.current.selectTenant("public");
    });

    await waitFor(() =>
      expect(result.current.warnings.some((w) => /namespaces unavailable/i.test(w))).toBe(true),
    );
    expect(result.current.state).toBe("error");
  });

  it("refresh re-fetches tenants and the selected tenant's namespaces bypassing the cache", async () => {
    listTenantsMock.mockResolvedValue(tenantsEnvelope());
    listNamespacesMock.mockResolvedValue({
      data: NAMESPACES,
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
    } satisfies ResultEnvelope<NamespaceSummary[]>);
    const { result } = renderHook(() => useBrokerTopology("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      result.current.selectTenant("public");
    });
    await waitFor(() => expect(result.current.namespaces).toEqual(NAMESPACES));

    listTenantsMock.mockClear();
    listNamespacesMock.mockClear();

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(listTenantsMock).toHaveBeenCalledWith("conn-1", true));
    expect(listNamespacesMock).toHaveBeenCalledWith("conn-1", "public", true);
  });
});
