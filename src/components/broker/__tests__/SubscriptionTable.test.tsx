import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SubscriptionTable } from "../SubscriptionTable";
import type { SubscriptionStats } from "@penguin/broker-contracts";

const withConsumer: SubscriptionStats = {
  name: "rg_deposit_accumulate_LOCAL",
  msgBacklog: 0,
  unackedMessages: 0,
  msgRateOut: 12.5,
  subType: { state: "named", name: "Shared" },
  consumers: [
    {
      consumerName: "Um8a4",
      address: "/127.0.0.1:45296",
      clientVersion: "Pulsar-Java-v4.2.4",
      availablePermits: 995,
      unackedMessages: 0,
      lastAckedTimestamp: { state: "unknown" },
      lastConsumedTimestamp: { state: "unknown" },
      msgRateOut: 12.5,
      blockedOnUnackedMsgs: false,
    },
  ],
};

const stranded: SubscriptionStats = {
  name: "anti_addiction_deposit_limit_fpmsnt",
  msgBacklog: 3400,
  unackedMessages: 0,
  msgRateOut: 0,
  subType: { state: "named", name: "Shared" },
  consumers: [],
};

function setup(subscriptions: SubscriptionStats[] = [withConsumer, stranded]) {
  const props = { subscriptions, state: "ready" as const, onRefresh: vi.fn() };
  render(<SubscriptionTable {...props} />);
  return props;
}

describe("SubscriptionTable", () => {
  it("lists each subscription with its backlog", () => {
    setup();
    expect(screen.getByText("rg_deposit_accumulate_LOCAL")).toBeInTheDocument();
    expect(screen.getByText("3400")).toBeInTheDocument();
  });

  it("says a subscription has no consumers rather than showing a blank", () => {
    // A blank cell is indistinguishable from a rendering bug. The whole point
    // of this screen is spotting the subscription nobody is draining.
    setup();
    expect(screen.getByText(/no consumers/i)).toBeInTheDocument();
  });

  it("expands a subscription to reveal its consumers", async () => {
    const user = userEvent.setup();
    setup();
    expect(screen.queryByText("Um8a4")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /expand rg_deposit_accumulate_LOCAL/i }));
    expect(screen.getByText("Um8a4")).toBeInTheDocument();
    expect(screen.getByText("Pulsar-Java-v4.2.4")).toBeInTheDocument();
  });

  it("surfaces a blocked consumer in words, not a colour", async () => {
    const user = userEvent.setup();
    const blocked: SubscriptionStats = {
      ...withConsumer,
      consumers: [{ ...withConsumer.consumers![0], blockedOnUnackedMsgs: true }],
    };
    setup([blocked]);
    await user.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
  });

  it("carries the delivery-not-completion notice wherever it shows a rate", () => {
    // msgRateOut is on this screen, so the disclosure has to be too.
    setup();
    expect(screen.getByRole("note").textContent ?? "").toMatch(/deliver/i);
  });

  it("shows an empty state when a topic has no subscriptions at all", () => {
    render(<SubscriptionTable subscriptions={[]} state="empty" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no subscriptions/i);
  });

  // --- Null cases: the whole point of this task. ---------------------------

  it("does not render a null backlog as zero", () => {
    // A null msgBacklog means "we don't know", not "the queue is clear".
    // Rendering it as 0 tells an operator exactly the opposite of the truth.
    // Every other numeric field is set to a non-zero value here so a stray
    // real zero elsewhere on the row can't be mistaken for this one.
    const unknownBacklog: SubscriptionStats = {
      ...withConsumer,
      msgBacklog: null,
      unackedMessages: 5,
    };
    render(<SubscriptionTable subscriptions={[unknownBacklog]} state="ready" onRefresh={vi.fn()} />);
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.getByText(/unknown/i)).toBeInTheDocument();
  });

  it("does not render a null blockedOnUnackedMsgs as unblocked", async () => {
    // The single most diagnostic consumer signal. A null here must never
    // read as "not blocked" — that is the most dangerous lie this screen
    // could tell.
    const user = userEvent.setup();
    const unknownBlocked: SubscriptionStats = {
      ...withConsumer,
      consumers: [{ ...withConsumer.consumers![0], blockedOnUnackedMsgs: null }],
    };
    render(<SubscriptionTable subscriptions={[unknownBlocked]} state="ready" onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /expand/i }));
    expect(screen.queryByText(/^not blocked$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^blocked$/i)).not.toBeInTheDocument();
    // Other nullable consumer fields in this fixture (last acked/consumed
    // timestamps) also read "Unknown", so more than one match is expected —
    // the point is that at least one (the blocked-status cell) does too.
    expect(screen.getAllByText(/unknown/i).length).toBeGreaterThan(0);
  });

  it("distinguishes a subscription whose consumer list is unknown from one confirmed to have none", async () => {
    const user = userEvent.setup();
    const unknownConsumers: SubscriptionStats = { ...stranded, name: "unknown_consumers_sub", consumers: null };
    render(
      <SubscriptionTable subscriptions={[unknownConsumers, stranded]} state="ready" onRefresh={vi.fn()} />,
    );

    // Collapsed rows already read differently: "Unknown" vs "No consumers".
    expect(screen.getByText(/no consumers/i)).toBeInTheDocument();
    expect(screen.getAllByText(/unknown/i).length).toBeGreaterThan(0);

    // Expanding the null-consumers subscription must not show the same
    // (empty) table a confirmed-empty subscription would show.
    await user.click(screen.getByRole("button", { name: /expand unknown_consumers_sub/i }));
    expect(screen.getByText(/consumer list unknown/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /expand anti_addiction_deposit_limit_fpmsnt/i }));
    expect(screen.getByText(/no consumers attached/i)).toBeInTheDocument();
  });

  // --- Fix round 1 -----------------------------------------------------

  it("keeps the delivery notice visible after expanding into the consumer view", async () => {
    // Only the collapsed-state notice was ever asserted before — a refactor
    // could drop ConsumerTable's own notice from the populated branch and
    // nothing would fail. msgRateOut is a column in the expanded consumer
    // table too, so the notice must still be reachable once expanded.
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole("button", { name: /expand rg_deposit_accumulate_LOCAL/i }));
    const notes = screen.getAllByRole("note");
    expect(notes.length).toBeGreaterThan(1);
    expect(notes.some((n) => (n.textContent ?? "").match(/deliver/i))).toBe(true);
  });

  it("renders a withheld, a never-acked, and a real last-acked timestamp as three different things", async () => {
    // This is the identical defect fixed for oldestBacklogMessageAgeSeconds
    // one task earlier, applied to lastAckedTimestamp: "we don't know" and
    // "definitely never acked" must not collapse into the same word.
    const user = userEvent.setup();
    const threeStates: SubscriptionStats = {
      ...withConsumer,
      consumers: [
        {
          ...withConsumer.consumers![0],
          consumerName: "withheld",
          lastAckedTimestamp: { state: "unknown" },
        },
        {
          ...withConsumer.consumers![0],
          consumerName: "never-acked",
          lastAckedTimestamp: { state: "never" },
        },
        {
          ...withConsumer.consumers![0],
          consumerName: "real-timestamp",
          // 2023-11-14T22:13:20.000Z — any locale's rendering of this epoch
          // millisecond value falls in 2023 regardless of timezone offset.
          lastAckedTimestamp: { state: "millis", millis: 1_700_000_000_000 },
        },
      ],
    };
    render(<SubscriptionTable subscriptions={[threeStates]} state="ready" onRefresh={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /expand/i }));

    expect(screen.getByText("withheld")).toBeInTheDocument();
    expect(screen.getByText("never-acked")).toBeInTheDocument();
    expect(screen.getByText("real-timestamp")).toBeInTheDocument();
    expect(screen.getAllByText(/^unknown$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^never$/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/2023/).length).toBeGreaterThan(0);
  });

  // Finding 2 of the Phase A final review: `subType` is a three-state
  // SubscriptionType, mirroring `BacklogAge`/`ConsumerTimestamp`. Pulsar's
  // own "None" sentinel ("no consumer has ever claimed a dispatcher type")
  // must render as its own word, distinct from "Unknown" (the field was
  // withheld) — collapsing the two would claim the broker withheld the
  // field when the broker actually answered.
  it("renders a named type, Pulsar's unset sentinel, and a withheld type as three different things", () => {
    const named: SubscriptionStats = { ...stranded, name: "named_sub", subType: { state: "named", name: "Shared" } };
    const unset: SubscriptionStats = { ...stranded, name: "unset_sub", subType: { state: "unset" } };
    const unknown: SubscriptionStats = { ...stranded, name: "unknown_sub", subType: { state: "unknown" } };
    render(<SubscriptionTable subscriptions={[named, unset, unknown]} state="ready" onRefresh={vi.fn()} />);

    expect(screen.getByText("Shared")).toBeInTheDocument();
    expect(screen.getByText(/^unset$/i)).toBeInTheDocument();
    expect(screen.getByText(/^unknown$/i)).toBeInTheDocument();
  });
});
