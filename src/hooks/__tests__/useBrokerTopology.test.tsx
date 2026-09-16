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
    expect(result.current.error).toBeUndefined();
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
    expect(result.current.error).toMatch(/old|stale/i);
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
    expect(result.current.error).toMatch(/ahead|clock/i);
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
    expect(result.current.error).toMatch(/timed out/i);
  });

  it("treats no data at all as the genuine failure case", async () => {
    listTenantsMock.mockResolvedValueOnce({
      data: undefined,
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
      error: { code: "SOURCE_UNAVAILABLE", message: "connection refused", retryable: true },
    } satisfies ResultEnvelope<TenantSummary[]>);
    const { result } = renderHook(() => useBrokerTopology("conn-1"));

    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.tenants).toEqual([]);
    expect(result.current.error).toMatch(/connection refused/i);
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
    expect(result.current.error).toMatch(/namespace/i);
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
