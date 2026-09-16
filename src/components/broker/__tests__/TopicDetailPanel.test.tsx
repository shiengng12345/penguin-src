// TopicDetailPanel tests — the last layer over five tasks of backend work
// that keeps three facts apart: BacklogAge's three states (seconds /
// noBacklog / unknown), indeterminate checks vs. anomalies, and a cursor
// entryId of -1 as a real position rather than a gap. Every test here
// guards one of those distinctions from being flattened.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopicDetailPanel } from "../TopicDetailPanel";
import type { TopicDetail } from "@penguin/broker-contracts";

function makeDetail(overrides: Partial<TopicDetail> = {}): TopicDetail {
  return {
    topic: "persistent://public/default/fpms_topup",
    stats: {
      msgRateIn: 0,
      msgRateOut: 0,
      msgThroughputIn: 0,
      msgThroughputOut: 0,
      storageSize: 0,
      backlogSize: 0,
      msgInCounter: 0,
      oldestBacklogMessageAge: { state: "unknown" },
      subscriptions: [],
    },
    internal: {
      entriesAddedCounter: 0,
      numberOfEntries: 0,
      // Deliberately a different ledger/entry than the cursor below, so
      // "38:-1" (asserted with a singular getByText) can only match the
      // cursor's markDeletePosition, not a coincidental second occurrence.
      lastConfirmedEntry: { ledgerId: 40, entryId: 5 },
      cursors: [
        {
          subscription: "rg_deposit_accumulate_LOCAL",
          markDeletePosition: { ledgerId: 38, entryId: -1 },
          readPosition: { ledgerId: 38, entryId: 0 },
          messagesConsumedCounter: 0,
        },
      ],
    },
    anomalies: [],
    indeterminate: [],
    ...overrides,
  };
}

describe("TopicDetailPanel", () => {
  it("shows the cursor position verbatim", () => {
    // "38:-1" is ledger:entry, and -1 means nothing consumed yet. Rewriting
    // it as a number, or blanking it, would destroy that meaning.
    render(<TopicDetailPanel detail={makeDetail()} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText("38:-1")).toBeInTheDocument();
  });

  it("says unknown for an absent backlog age rather than showing zero", () => {
    // Absent means we do not know. Zero would read as "brand new".
    render(<TopicDetailPanel detail={makeDetail()} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/unknown|not measured/i)).toBeInTheDocument();
  });

  it("carries the delivery-not-completion notice", () => {
    render(<TopicDetailPanel detail={makeDetail()} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByRole("note").textContent ?? "").toMatch(/deliver/i);
  });

  it("shows an error state without pretending it has data", () => {
    render(
      <TopicDetailPanel
        detail={null}
        state="error"
        errorMessage="Namespace does not exist"
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Namespace does not exist");
  });

  describe("oldestBacklogMessageAge — three distinct renderings", () => {
    it("renders a real age in seconds as a measured number, not a sentinel", () => {
      const detail = makeDetail({
        stats: { ...makeDetail().stats, oldestBacklogMessageAge: { state: "seconds", seconds: 42 } },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      expect(screen.getByText(/42/)).toBeInTheDocument();
      expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no backlog/i)).not.toBeInTheDocument();
    });

    it("renders noBacklog as a determinate, healthy fact — not as unknown", () => {
      const detail = makeDetail({
        stats: { ...makeDetail().stats, oldestBacklogMessageAge: { state: "noBacklog" } },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      // Must read as a positive, measured fact ("no backlog"), never as the
      // same "Unknown" word used for a withheld field.
      expect(screen.getByText(/no backlog/i)).toBeInTheDocument();
      expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
    });

    it("renders unknown as genuinely unmeasured — distinct from noBacklog", () => {
      const detail = makeDetail({
        stats: { ...makeDetail().stats, oldestBacklogMessageAge: { state: "unknown" } },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      expect(screen.getByText(/unknown|not measured/i)).toBeInTheDocument();
      expect(screen.queryByText(/no backlog/i)).not.toBeInTheDocument();
    });
  });

  it("does not read as all-clear when anomalies is empty but indeterminate is not", () => {
    // Silence on `anomalies` alone must never be read as "checked and
    // clear" when `indeterminate` says some checks never ran at all.
    const detail = makeDetail({
      anomalies: [],
      indeterminate: [
        {
          kind: "backlogOlderThanThreshold",
          topic: "persistent://public/default/fpms_topup",
          subscription: null,
          reason: "oldestBacklogMessageAge was unknown",
        },
      ],
    });
    render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);

    // The anomalies section is genuinely empty...
    expect(screen.getByText(/no anomalies/i)).toBeInTheDocument();
    // ...but the indeterminate section is visible, distinct, and worded as
    // "could not run" rather than "something is wrong".
    const indeterminateReason = screen.getByText(/oldestBacklogMessageAge was unknown/i);
    expect(indeterminateReason).toBeInTheDocument();
    expect(screen.getByText(/could not (be )?(run|perform)/i)).toBeInTheDocument();
  });

  it("renders a cursor entryId of -1 as a real position, not a blank", () => {
    const detail = makeDetail({
      internal: {
        entriesAddedCounter: 5,
        numberOfEntries: 5,
        lastConfirmedEntry: { ledgerId: 251, entryId: -1 },
        cursors: [
          {
            subscription: "anti_addiction_deposit_limit_fpmsnt",
            markDeletePosition: { ledgerId: 251, entryId: -1 },
            readPosition: { ledgerId: 251, entryId: -1 },
            messagesConsumedCounter: null,
          },
        ],
      },
    });
    render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
    const positions = screen.getAllByText("251:-1");
    expect(positions.length).toBeGreaterThan(0);
  });

  it("renders the loading state without showing stale content", () => {
    render(<TopicDetailPanel detail={null} state="loading" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });
});
