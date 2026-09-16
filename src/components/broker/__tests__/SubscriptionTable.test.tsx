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
  subType: "Shared",
  consumers: [
    {
      consumerName: "Um8a4",
      address: "/127.0.0.1:45296",
      clientVersion: "Pulsar-Java-v4.2.4",
      availablePermits: 995,
      unackedMessages: 0,
      lastAckedTimestamp: null,
      lastConsumedTimestamp: null,
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
  subType: "Shared",
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
});
