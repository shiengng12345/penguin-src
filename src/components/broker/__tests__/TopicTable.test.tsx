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
  it("expanding a row to see its partitions does not also open the topic", async () => {
    // The expand arrow lives inside the row, and the row carries an onClick
    // that opens the detail pane. Without stopPropagation the click reaches
    // both: someone peeking at a partitioned topic's partition names would
    // trigger a getTopicDetail fetch and an unwanted pane, every time.
    const onSelectTopic = vi.fn();
    render(<TopicTable {...props} onSelectTopic={onSelectTopic} />);

    await userEvent.click(screen.getByRole("button", { name: /expand events/i }));

    // The partitions are revealed...
    expect(screen.getByText(/events-partition-0/)).toBeInTheDocument();
    // ...and the topic was NOT opened.
    expect(onSelectTopic).not.toHaveBeenCalled();

    // A click on the row itself still opens it — the guard must not have
    // disabled selection wholesale.
    await userEvent.click(screen.getByText("events"));
    expect(onSelectTopic).toHaveBeenCalledTimes(1);
  });

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

  // Task 14: clicking a topic row is how the Topics tab's detail pane opens.
  describe("onSelectTopic", () => {
    it("reports the clicked topic", async () => {
      const user = userEvent.setup();
      const onSelectTopic = vi.fn();
      render(<TopicTable {...props} onSelectTopic={onSelectTopic} />);
      await user.click(screen.getByText("orders"));
      expect(onSelectTopic).toHaveBeenCalledWith(topics[0]);
    });

    it("marks the selected row without disturbing the row's own table semantics", () => {
      render(
        <TopicTable
          {...props}
          onSelectTopic={vi.fn()}
          selectedTopicFullName="persistent://public/default/orders"
        />,
      );
      const rows = screen.getAllByRole("row");
      // rows[0] is the header row; rows[1] is "orders".
      expect(rows[1]).toHaveAttribute("aria-current", "true");
      expect(rows[2]).not.toHaveAttribute("aria-current");
    });

    it("is reachable by keyboard (Enter) when a selection handler is given", async () => {
      const user = userEvent.setup();
      const onSelectTopic = vi.fn();
      render(<TopicTable {...props} onSelectTopic={onSelectTopic} />);
      const rows = screen.getAllByRole("row");
      rows[1]?.focus();
      await user.keyboard("{Enter}");
      expect(onSelectTopic).toHaveBeenCalledWith(topics[0]);
    });

    it("does not attach any row interaction when no handler is given", () => {
      render(<TopicTable {...props} />);
      const rows = screen.getAllByRole("row");
      expect(rows[1]).not.toHaveAttribute("tabIndex");
    });
  });
});
