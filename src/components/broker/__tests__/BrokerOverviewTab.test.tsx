// BrokerOverviewTab — integration coverage for the Overview tab's wiring:
// `useBrokerOverview` -> `AnomalyPanel`. Mocks only `@/lib/broker-client`
// (the same seam `useBrokerTopology.test.tsx` mocks), so this exercises the
// real hook and the real panel together, without needing
// `useBrokerConnections`'s SQLite-backed chain — this component never
// touches it, only `connectionId`.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OverviewReport, ResultEnvelope } from "@penguin/broker-contracts";

const getOverviewMock = vi.fn();

vi.mock("@/lib/broker-client", () => ({
  getOverview: (...args: unknown[]) => getOverviewMock(...args),
}));

const { BrokerOverviewTab } = await import("../BrokerOverviewTab");

function envelope(overrides: Partial<ResultEnvelope<OverviewReport>> = {}): ResultEnvelope<OverviewReport> {
  return {
    data: {
      tenant: "public",
      namespace: "default",
      topicsSampled: 10,
      topicsTotal: 10,
      truncated: false,
      anomalies: [],
      indeterminate: [],
      topicsUnavailable: 0,
    },
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

describe("BrokerOverviewTab", () => {
  it("guides the user when no connection is active, without pretending a namespace was checked", () => {
    render(<BrokerOverviewTab connectionId={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no active connection/i);
    expect(screen.queryByText(/no anomalies/i)).not.toBeInTheDocument();
  });

  it("shows a concrete anomaly the overview command found", async () => {
    getOverviewMock.mockResolvedValueOnce(
      envelope({
        data: {
          tenant: "public",
          namespace: "default",
          topicsSampled: 10,
          topicsTotal: 10,
          truncated: false,
          anomalies: [
            {
              kind: "backlogWithNoConsumer",
              topic: "persistent://public/default/fpms_topup",
              subscription: "anti_addiction_deposit_limit_fpmsnt",
              detail: "subscription has a backlog but no connected consumer",
              observedValue: "3400 messages",
            },
          ],
          indeterminate: [],
          topicsUnavailable: 0,
        },
      }),
    );
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() => expect(screen.getByText(/3400 messages/)).toBeInTheDocument());
  });

  // Non-negotiable 4 (task-14-brief.md): a real report's `indeterminate`
  // must reach the panel, and its presence must suppress the "no anomalies"
  // wording — the wiring must not quietly substitute `[]`.
  it("wires a real report's indeterminate checks through, and does not claim all-clear", async () => {
    getOverviewMock.mockResolvedValueOnce(
      envelope({
        data: {
          tenant: "public",
          namespace: "default",
          topicsSampled: 10,
          topicsTotal: 10,
          truncated: false,
          anomalies: [],
          indeterminate: [
            {
              kind: "consumerBlockedOnUnacked",
              topic: "persistent://public/default/fpms_topup",
              subscription: "rg_deposit_accumulate_LOCAL",
              reason: "Pulsar did not report blockedOnUnackedMsgs for this consumer",
            },
          ],
          topicsUnavailable: 0,
        },
      }),
    );
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() =>
      expect(screen.getByText(/Pulsar did not report blockedOnUnackedMsgs/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/no anomalies/i)).not.toBeInTheDocument();
  });

  it("shows the truncation notice when the sample did not cover the whole namespace", async () => {
    // `truncated: true` with no warnings is unreachable in production:
    // `build_overview` always pushes a truncation warning when it
    // truncates, which forces `deriveOverviewResult` to `"stale"`. The
    // warning is included here so this test exercises the combination that
    // can actually happen.
    getOverviewMock.mockResolvedValueOnce(
      envelope({
        data: {
          tenant: "public",
          namespace: "default",
          topicsSampled: 100,
          topicsTotal: 250,
          truncated: true,
          anomalies: [],
          indeterminate: [],
          topicsUnavailable: 0,
        },
        warnings: ["Sampled 100 of 250 topics in public/default (cap: 100)"],
      }),
    );
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() => expect(screen.getByRole("note")).toHaveTextContent(/100 of 250/));
  });

  // Phase A final review, finding 1: a per-topic stats failure reaches the
  // panel as a free-text warning, but that must no longer let the panel
  // also claim "every check ran and found nothing wrong" underneath it —
  // this test used to assert exactly that false claim was present. A real
  // envelope carrying this warning also carries `topicsUnavailable: 1`
  // (`sample_overview` increments it at the same point it pushes the
  // warning), so the fixture reflects a real response, not a hand-picked
  // partial one.
  it("keeps a partial sample's findings AND its warning on screen, without claiming every check ran", async () => {
    getOverviewMock.mockResolvedValueOnce(
      envelope({
        data: {
          tenant: "public",
          namespace: "default",
          topicsSampled: 10,
          topicsTotal: 10,
          truncated: false,
          anomalies: [],
          indeterminate: [],
          topicsUnavailable: 1,
        },
        warnings: ['topic "orders": stats unavailable (timed out)'],
      }),
    );
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() => expect(screen.getByText(/timed out/)).toBeInTheDocument());
    expect(screen.queryByText(/no anomalies found\. every check ran/i)).not.toBeInTheDocument();
    expect(screen.getByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("re-fetches on refresh", async () => {
    getOverviewMock.mockResolvedValue(envelope());
    const user = userEvent.setup();
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() => expect(getOverviewMock).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(getOverviewMock).toHaveBeenCalledTimes(2));
  });
});
