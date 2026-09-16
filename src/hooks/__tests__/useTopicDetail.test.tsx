// useTopicDetail — state behind the topic detail pane `BrokerTopicsTab`
// opens on row selection. Same envelope discipline as every other
// broker-command hook: state from `data`/`warnings`, never `source`; every
// warning survives; a null/undefined `topic` (nothing selected) never
// issues a fetch at all.
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ResultEnvelope, TopicDetail, TopicSummary } from "@penguin/broker-contracts";

const getTopicDetailMock = vi.fn();

vi.mock("@/lib/broker-client", () => ({
  getTopicDetail: (...args: unknown[]) => getTopicDetailMock(...args),
}));

const { useTopicDetail, deriveTopicDetailResult } = await import("../useTopicDetail");

const TOPIC: TopicSummary = {
  fullName: "persistent://public/default/fpms_topup",
  shortName: "fpms_topup",
  tenant: "public",
  namespace: "default",
  persistent: true,
  partitions: 0,
  partitionNames: [],
};

const DETAIL: TopicDetail = {
  topic: "fpms_topup",
  stats: {
    msgRateIn: 1,
    msgRateOut: 1,
    msgThroughputIn: 1,
    msgThroughputOut: 1,
    storageSize: 1,
    backlogSize: 0,
    msgInCounter: 1,
    oldestBacklogMessageAge: { state: "noBacklog" },
    subscriptions: [],
  },
  internal: {
    entriesAddedCounter: 1,
    numberOfEntries: 1,
    lastConfirmedEntry: { ledgerId: 1, entryId: 0 },
    cursors: [],
  },
  anomalies: [],
  indeterminate: [],
};

function envelope(overrides: Partial<ResultEnvelope<TopicDetail>> = {}): ResultEnvelope<TopicDetail> {
  return {
    data: DETAIL,
    source: "pulsar-admin-rest",
    observedAt: "2026-09-16T00:00:00.000Z",
    freshnessMs: 0,
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  getTopicDetailMock.mockReset();
});

describe("deriveTopicDetailResult", () => {
  it("is ready when data has no warnings", () => {
    expect(deriveTopicDetailResult(envelope()).state).toBe("ready");
  });

  it("is stale (not error) when data arrives alongside warnings, keeping every one", () => {
    const result = deriveTopicDetailResult(envelope({ warnings: ["a", "b"] }));
    expect(result.state).toBe("stale");
    expect(result.warnings).toEqual(["a", "b"]);
  });

  it("is error only when data is entirely absent", () => {
    const result = deriveTopicDetailResult({
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

describe("useTopicDetail", () => {
  it("fetches nothing when no topic is selected", () => {
    renderHook(() => useTopicDetail("conn-1", null));
    expect(getTopicDetailMock).not.toHaveBeenCalled();
  });

  it("fetches the selected topic's detail with its tenant/namespace/persistent flag", async () => {
    getTopicDetailMock.mockResolvedValueOnce(envelope());
    const { result } = renderHook(() => useTopicDetail("conn-1", TOPIC));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(getTopicDetailMock).toHaveBeenCalledWith("conn-1", "public", "default", "fpms_topup", true);
    expect(result.current.detail).toEqual(DETAIL);
  });

  it("refetches when a different topic is selected", async () => {
    getTopicDetailMock.mockResolvedValue(envelope());
    const { result, rerender } = renderHook(({ topic }) => useTopicDetail("conn-1", topic), {
      initialProps: { topic: TOPIC as TopicSummary | null },
    });
    await waitFor(() => expect(result.current.state).toBe("ready"));

    const OTHER: TopicSummary = { ...TOPIC, shortName: "orders", fullName: "persistent://public/default/orders" };
    rerender({ topic: OTHER });
    await waitFor(() => expect(getTopicDetailMock).toHaveBeenCalledTimes(2));
    expect(getTopicDetailMock).toHaveBeenLastCalledWith("conn-1", "public", "default", "orders", true);
  });

  it("clears the previous detail when the topic is deselected", async () => {
    getTopicDetailMock.mockResolvedValueOnce(envelope());
    const { result, rerender } = renderHook(({ topic }) => useTopicDetail("conn-1", topic), {
      initialProps: { topic: TOPIC as TopicSummary | null },
    });
    await waitFor(() => expect(result.current.detail).not.toBeNull());

    rerender({ topic: null });
    await waitFor(() => expect(result.current.detail).toBeNull());
  });

  it("keeps data on screen on refresh failure that still yields a usable read", async () => {
    getTopicDetailMock.mockResolvedValueOnce(envelope());
    const { result } = renderHook(() => useTopicDetail("conn-1", TOPIC));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    getTopicDetailMock.mockResolvedValueOnce(envelope({ warnings: ["a transient warning"] }));
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state).toBe("stale"));
    expect(result.current.detail).toEqual(DETAIL);
    expect(result.current.warnings).toEqual(["a transient warning"]);
  });

  // Phase A final review, finding 3: `setDetail` only ran on the truthy-data
  // branch and the `catch` block — an *error envelope* (`data: undefined`,
  // no thrown exception) fell through neither, so a failed fetch for a new
  // topic left the previous topic's detail sitting in state, mislabeled as
  // the new topic's. Shared clear-on-failure policy (see
  // useBrokerTopology.ts's header): whenever a fetch does not yield a real
  // `data` value, already-loaded data is cleared rather than retained.
  it("clears stale detail when a fetch resolves to an error envelope, not just when it throws", async () => {
    getTopicDetailMock.mockResolvedValueOnce(envelope());
    const { result } = renderHook(() => useTopicDetail("conn-1", TOPIC));
    await waitFor(() => expect(result.current.detail).toEqual(DETAIL));

    getTopicDetailMock.mockResolvedValueOnce({
      data: undefined,
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
      error: { code: "SOURCE_UNAVAILABLE", message: "topic not found", retryable: false },
    });
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.state).toBe("error"));
    expect(result.current.detail).toBeNull();
  });
});
