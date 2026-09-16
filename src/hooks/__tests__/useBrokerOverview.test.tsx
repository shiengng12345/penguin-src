// useBrokerOverview — proves the envelope interpretation behind the
// Overview tab, the same shape of test `useBrokerTopology.test.tsx` runs
// for the topology tree: a single-fetch command whose `data` and
// `warnings` can arrive together (a partial success, never an error), and
// whose `indeterminate` must survive into the returned `report` verbatim —
// never defaulted to `[]` when a real report exists (task-14-brief.md,
// non-negotiable 4).
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OverviewReport, ResultEnvelope } from "@penguin/broker-contracts";

const getOverviewMock = vi.fn();

vi.mock("@/lib/broker-client", () => ({
  getOverview: (...args: unknown[]) => getOverviewMock(...args),
}));

const { useBrokerOverview, deriveOverviewResult } = await import("../useBrokerOverview");

const REPORT: OverviewReport = {
  tenant: "public",
  namespace: "default",
  topicsSampled: 10,
  topicsTotal: 10,
  truncated: false,
  anomalies: [],
  indeterminate: [],
  topicsUnavailable: 0,
};

function envelope(overrides: Partial<ResultEnvelope<OverviewReport>> = {}): ResultEnvelope<OverviewReport> {
  return {
    data: REPORT,
    source: "pulsar-admin-rest",
    observedAt: "2026-09-16T00:00:00.000Z",
    freshnessMs: 0,
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  getOverviewMock.mockReset();
});

describe("deriveOverviewResult", () => {
  it("is ready when data has no warnings and topics were sampled", () => {
    expect(deriveOverviewResult(envelope()).state).toBe("ready");
  });

  it("is stale (not error) when data arrives alongside warnings", () => {
    const result = deriveOverviewResult(envelope({ warnings: ["one topic's stats were unavailable"] }));
    expect(result.state).toBe("stale");
    expect(result.warnings).toEqual(["one topic's stats were unavailable"]);
  });

  it("keeps every warning, not just the first", () => {
    const result = deriveOverviewResult(envelope({ warnings: ["first", "second"] }));
    expect(result.warnings).toEqual(["first", "second"]);
  });

  it("is empty when the namespace genuinely has no topics, not stale", () => {
    const result = deriveOverviewResult(
      envelope({ data: { ...REPORT, topicsSampled: 0, topicsTotal: 0 } }),
    );
    expect(result.state).toBe("empty");
  });

  it("is error only when data is entirely absent, regardless of source", () => {
    const result = deriveOverviewResult({
      data: undefined,
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
      error: { code: "SOURCE_UNAVAILABLE", message: "connection refused", retryable: true },
    });
    expect(result.state).toBe("error");
    expect(result.errorMessage).toBe("connection refused");
  });
});

describe("useBrokerOverview", () => {
  it("populates report from a successful fetch", async () => {
    getOverviewMock.mockResolvedValueOnce(envelope());
    const { result } = renderHook(() => useBrokerOverview("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.report).toEqual(REPORT);
  });

  // The exact trap non-negotiable 4 exists to catch: a real report whose
  // `anomalies` is empty but `indeterminate` is not must reach the caller
  // with `indeterminate` intact, never collapsed to `[]`.
  it("carries a real report's indeterminate checks through untouched", async () => {
    const withIndeterminate: OverviewReport = {
      ...REPORT,
      indeterminate: [
        {
          kind: "consumerBlockedOnUnacked",
          topic: "persistent://public/default/fpms_topup",
          subscription: "rg_deposit_accumulate_LOCAL",
          reason: "Pulsar did not report blockedOnUnackedMsgs for this consumer",
        },
      ],
    };
    getOverviewMock.mockResolvedValueOnce(envelope({ data: withIndeterminate }));
    const { result } = renderHook(() => useBrokerOverview("conn-1"));
    await waitFor(() => expect(result.current.report).not.toBeNull());
    expect(result.current.report?.indeterminate).toHaveLength(1);
    expect(result.current.report?.indeterminate[0]?.reason).toMatch(/blockedOnUnackedMsgs/);
  });

  it("keeps a partial sample's rows AND its warning on refresh failure", async () => {
    getOverviewMock.mockResolvedValueOnce(envelope());
    const { result } = renderHook(() => useBrokerOverview("conn-1"));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    getOverviewMock.mockResolvedValueOnce(
      envelope({ warnings: ['topic "orders": stats unavailable (timed out)'] }),
    );
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state).toBe("stale"));
    expect(result.current.report).toEqual(REPORT);
    expect(result.current.warnings.join(" ")).toMatch(/timed out/);
  });

  it("does not query when there is no active connection", () => {
    renderHook(() => useBrokerOverview(null));
    expect(getOverviewMock).not.toHaveBeenCalled();
  });
});
