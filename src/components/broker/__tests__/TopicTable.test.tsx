import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TopicTable } from "../TopicTable";
import type { TopicSummary } from "@penguin/broker-contracts";

const topics: TopicSummary[] = [
  {
    fullName: "persistent://public/default/orders", shortName: "orders",
    tenant: "public", namespace: "default", persistent: true,
    partitions: 0, partitionNames: [],
  },
  {
    fullName: "persistent://public/default/events", shortName: "events",
    tenant: "public", namespace: "default", persistent: true,
    partitions: 3,
    partitionNames: [
      "persistent://public/default/events-partition-0",
      "persistent://public/default/events-partition-1",
      "persistent://public/default/events-partition-2",
    ],
  },
];

const props = {
  topics, total: 2, offset: 0, limit: 25,
  state: "ready" as const, onPageChange: vi.fn(),
};

describe("TopicTable", () => {
  it("renders a partitioned topic as one row, not one row per partition", () => {
    render(<TopicTable {...props} />);
    expect(screen.getAllByRole("row")).toHaveLength(3); // header + 2 topics
    expect(screen.queryByText(/events-partition-0/)).not.toBeInTheDocument();
  });

  it("reveals partitions when the row is expanded", async () => {
    const user = userEvent.setup();
    render(<TopicTable {...props} />);
    await user.click(screen.getByRole("button", { name: /expand events/i }));
    expect(screen.getByText("persistent://public/default/events-partition-0")).toBeInTheDocument();
  });

  it("shows the partition count on the collapsed row", () => {
    render(<TopicTable {...props} />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("guides the user when no connection is active", () => {
    render(<TopicTable {...props} topics={[]} total={0} state="empty" noActiveConnection />);
    expect(screen.getByRole("status")).toHaveTextContent(/connection/i);
  });

  it("gives the topic name cell a title, so the full name is available on hover if truncated", () => {
    // A long, real Pulsar-shaped name (42 chars) — CSS truncation itself
    // isn't assertable in jsdom (no layout engine), but the title attribute
    // that recovers the full value on hover is.
    const longName = "LOCAL.BP.PAYMENT.PAYMENTACCOUNT.CHECKED.V1";
    const longTopics: TopicSummary[] = [
      {
        fullName: `persistent://public/default/${longName}`,
        shortName: longName,
        tenant: "public",
        namespace: "default",
        persistent: true,
        partitions: 0,
        partitionNames: [],
      },
    ];
    render(<TopicTable {...props} topics={longTopics} total={1} />);
    expect(screen.getByTitle(longName)).toHaveTextContent(longName);
  });

  it("gives the topic name column enough width to fit a realistic 42-char topic name, and marks it to grow", () => {
    render(<TopicTable {...props} />);
    const header = screen.getByRole("columnheader", { name: /^topic/i });
    // The `role="columnheader"` div renders directly inside ResizableColumn's
    // own wrapper div, which is the element actually carrying the
    // width/grow styling (see resizable-column.tsx) — one level up.
    const resizableWrapper = header.parentElement;
    expect(resizableWrapper).toHaveAttribute("data-grow", "true");
    expect(resizableWrapper).toHaveStyle({ minWidth: "420px" });

    // A narrow, low-information column must not claim the same share.
    const namespaceHeader = screen.getByRole("columnheader", { name: /namespace/i });
    expect(namespaceHeader.parentElement).not.toHaveAttribute("data-grow", "true");
    expect(namespaceHeader.parentElement).toHaveStyle({ width: "180px" });
  });
});
