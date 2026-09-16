// Unit tests for `deriveTopicResult`, the pure envelope-to-(state, error)
// derivation `BrokerTopicsTab`'s topic list renders from. (Task 14 moved
// this — and the fetch effect around it — out of `BrokerPage.tsx` and into
// this file's composition root, alongside `useBrokerTopology` and
// `useTopicDetail`; the logic and this test suite are unchanged.)
// Deliberately does NOT render `<BrokerTopicsTab>` itself for this suite —
// see `BrokerTopicsTab.wiring.test.tsx` for the mounted, mocked-broker-client
// integration coverage added in Task 14.
//
// Fix round 1, item 5: `fetchTopics` used to decide `"stale"` from
// `envelope.source === "cache"` alone. Before Task 3, `source: "cache"` was
// unreachable, so that branch never ran and the bug was invisible. Task 3
// made cache hits real, and a *fresh* cache hit also arrives as
// `source: "cache"` with `warnings: []` — the old code stamped a staleness
// banner on it anyway. This suite pins the fix: state comes from `data` and
// `warnings`, never from `source`.
import { describe, expect, it } from "vitest";
import type { Page, ResultEnvelope, TopicSummary } from "@penguin/broker-contracts";
import { deriveTopicResult } from "../BrokerTopicsTab";

const TOPIC: TopicSummary = {
  fullName: "persistent://public/default/orders",
  shortName: "orders",
  tenant: "public",
  namespace: "default",
  persistent: true,
  partitions: 0,
  partitionNames: [],
};

const PAGE: Page<TopicSummary> = { items: [TOPIC], total: 1, offset: 0, limit: 25 };

function envelope(overrides: Partial<ResultEnvelope<Page<TopicSummary>>> = {}): ResultEnvelope<Page<TopicSummary>> {
  return {
    data: PAGE,
    source: "pulsar-admin-rest",
    observedAt: "2026-09-16T00:00:00.000Z",
    freshnessMs: 0,
    warnings: [],
    ...overrides,
  };
}

describe("deriveTopicResult", () => {
  it("renders a fresh cache hit as ready with no banner — not every cache hit is stale", () => {
    const result = deriveTopicResult(envelope({ source: "cache", freshnessMs: 1_000, warnings: [] }));
    expect(result.state).toBe("ready");
    expect(result.error).toBeUndefined();
  });

  it("still marks a genuinely stale cache hit as stale", () => {
    const result = deriveTopicResult(
      envelope({
        source: "cache",
        freshnessMs: 90_000,
        warnings: ["Cached topic list is 90000 ms old, past its freshness window; showing the last known list."],
      }),
    );
    expect(result.state).toBe("stale");
    expect(result.error).toMatch(/90000 ms old/);
  });

  it("keeps every warning, not just the first", () => {
    const result = deriveTopicResult(
      envelope({ source: "cache", warnings: ["first warning", "second warning"] }),
    );
    expect(result.error).toContain("first warning");
    expect(result.error).toContain("second warning");
  });

  it("treats no data at all as the failure case regardless of source", () => {
    const result = deriveTopicResult({
      data: undefined,
      source: "pulsar-admin-rest",
      observedAt: "2026-09-16T00:00:00.000Z",
      freshnessMs: 0,
      warnings: [],
      error: { code: "SOURCE_UNAVAILABLE", message: "connection refused", retryable: true },
    });
    expect(result.state).toBe("error");
    expect(result.error).toBe("connection refused");
  });

  it("still reports empty (not stale) for a fresh, genuinely empty list", () => {
    const result = deriveTopicResult(
      envelope({ data: { items: [], total: 0, offset: 0, limit: 25 }, warnings: [] }),
    );
    expect(result.state).toBe("empty");
  });
});
