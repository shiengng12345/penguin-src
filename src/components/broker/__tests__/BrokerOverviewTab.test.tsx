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
        },
      }),
    );
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() => expect(screen.getByRole("note")).toHaveTextContent(/100 of 250/));
  });

  it("keeps a partial sample's findings AND its warning on screen, not an error banner", async () => {
    getOverviewMock.mockResolvedValueOnce(
      envelope({ warnings: ['topic "orders": stats unavailable (timed out)'] }),
    );
    render(<BrokerOverviewTab connectionId="conn-1" />);
    await waitFor(() => expect(screen.getByText(/no anomalies/i)).toBeInTheDocument());
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
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
