// BrokerTopicsTab — integration coverage for Task 14's actual wiring: the
// topology tree drives which namespace the topic list shows, and clicking a
// topic row opens its detail pane with real subscription/anomaly/
// indeterminate data. Mocks only `@/lib/broker-client` (the same seam every
// other broker hook test in this suite mocks) — `useBrokerTopology`,
// `useTopicDetail`, and the local topic-list fetch inside this component
// are all real.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  NamespaceSummary,
  Page,
  ResultEnvelope,
  TenantSummary,
  TopicDetail,
  TopicSummary,
} from "@penguin/broker-contracts";

const listTenantsMock = vi.fn();
const listNamespacesMock = vi.fn();
const listTopicsMock = vi.fn();
const getTopicDetailMock = vi.fn();

vi.mock("@/lib/broker-client", () => ({
  listTenants: (...args: unknown[]) => listTenantsMock(...args),
  listNamespaces: (...args: unknown[]) => listNamespacesMock(...args),
  listTopics: (...args: unknown[]) => listTopicsMock(...args),
  getTopicDetail: (...args: unknown[]) => getTopicDetailMock(...args),
}));

const { BrokerTopicsTab } = await import("../BrokerTopicsTab");

const TENANTS: TenantSummary[] = [{ name: "public" }, { name: "pulsar" }];
const NAMESPACES: NamespaceSummary[] = [{ tenant: "public", name: "default", full: "public/default" }];

const TOPIC: TopicSummary = {
  fullName: "persistent://public/default/fpms_topup",
  shortName: "fpms_topup",
  tenant: "public",
  namespace: "default",
  persistent: true,
  partitions: 0,
  partitionNames: [],
};

const TOPIC_PAGE: Page<TopicSummary> = { items: [TOPIC], total: 1, offset: 0, limit: 25 };

const DETAIL: TopicDetail = {
  topic: "fpms_topup",
  stats: {
    msgRateIn: 2,
    msgRateOut: 2,
    msgThroughputIn: 200,
    msgThroughputOut: 200,
    storageSize: 1000,
    backlogSize: 0,
    msgInCounter: 500,
    oldestBacklogMessageAge: { state: "noBacklog" },
    subscriptions: [
      { name: "anti_addiction_deposit_limit_fpmsnt", msgBacklog: 3400, unackedMessages: 0, msgRateOut: 1, subType: "Shared", consumers: [] },
      { name: "rg_deposit_accumulate_LOCAL", msgBacklog: 0, unackedMessages: 0, msgRateOut: 1, subType: "Shared", consumers: null },
    ],
  },
  internal: { entriesAddedCounter: 10, numberOfEntries: 10, lastConfirmedEntry: { ledgerId: 1, entryId: -1 }, cursors: [] },
  anomalies: [],
  indeterminate: [
    {
      kind: "consumerBlockedOnUnacked",
      topic: "fpms_topup",
      subscription: "rg_deposit_accumulate_LOCAL",
      reason: "Pulsar did not report blockedOnUnackedMsgs for this consumer",
    },
  ],
};

function ok<T>(data: T, overrides: Partial<ResultEnvelope<T>> = {}): ResultEnvelope<T> {
  return {
    data,
    source: "pulsar-admin-rest",
    observedAt: "2026-09-16T00:00:00.000Z",
    freshnessMs: 0,
    warnings: [],
    ...overrides,
  };
}

beforeEach(() => {
  listTenantsMock.mockReset();
  listNamespacesMock.mockReset();
  listTopicsMock.mockReset();
  getTopicDetailMock.mockReset();
});

async function navigateToTopics(user: ReturnType<typeof userEvent.setup>) {
  listTenantsMock.mockResolvedValueOnce(ok(TENANTS));
  render(<BrokerTopicsTab connectionId="conn-1" />);
  await screen.findByRole("treeitem", { name: "public" });

  listNamespacesMock.mockResolvedValueOnce(ok(NAMESPACES));
  await user.click(screen.getByRole("treeitem", { name: "public" }));
  await screen.findByRole("treeitem", { name: "default" });

  listTopicsMock.mockResolvedValueOnce(ok(TOPIC_PAGE));
  await user.click(screen.getByRole("treeitem", { name: "default" }));
  await screen.findByText("fpms_topup");
}

describe("BrokerTopicsTab", () => {
  it("prompts for a namespace before any topic list is shown", async () => {
    listTenantsMock.mockResolvedValueOnce(ok(TENANTS));
    render(<BrokerTopicsTab connectionId="conn-1" />);
    await screen.findByRole("treeitem", { name: "public" });
    expect(screen.getByText(/select a tenant and namespace/i)).toBeInTheDocument();
  });

  it("the topology tree drives which namespace's topics are listed", async () => {
    const user = userEvent.setup();
    await navigateToTopics(user);
    expect(listTopicsMock).toHaveBeenCalledWith(
      "conn-1",
      "public",
      "default",
      { offset: 0, limit: 25 },
    );
  });

  it("opens a topic's detail pane on row click, with its real subscriptions", async () => {
    const user = userEvent.setup();
    await navigateToTopics(user);

    getTopicDetailMock.mockResolvedValueOnce(ok(DETAIL));
    await user.click(screen.getByText("fpms_topup"));

    await screen.findByText("anti_addiction_deposit_limit_fpmsnt");
    expect(screen.getByText("rg_deposit_accumulate_LOCAL")).toBeInTheDocument();
    expect(getTopicDetailMock).toHaveBeenCalledWith("conn-1", "public", "default", "fpms_topup", true);
  });

  // Non-negotiable 4: `TopicDetail.indeterminate` must reach the panel —
  // it is carried inside `detail` itself, never re-mapped, so this also
  // proves the whole object is passed through rather than a lossy subset.
  it("shows the topic detail's indeterminate checks, distinct from its anomalies", async () => {
    const user = userEvent.setup();
    await navigateToTopics(user);

    getTopicDetailMock.mockResolvedValueOnce(ok(DETAIL));
    await user.click(screen.getByText("fpms_topup"));

    await screen.findByText(/Pulsar did not report blockedOnUnackedMsgs/);
    expect(screen.queryByText(/every anomaly check had enough data to run/i)).not.toBeInTheDocument();
  });

  // Non-negotiable 5: every rate-bearing screen carries the delivery notice.
  // `TopicDetailPanel` renders it twice on purpose (once over its own stats,
  // once over `SubscriptionTable`'s `msgRateOut` column) — both must say so.
  it("carries the delivery-not-completion notice on the topic detail's stats", async () => {
    const user = userEvent.setup();
    await navigateToTopics(user);

    getTopicDetailMock.mockResolvedValueOnce(ok(DETAIL));
    await user.click(screen.getByText("fpms_topup"));

    const notices = await screen.findAllByRole("note");
    expect(notices.length).toBeGreaterThan(0);
    for (const notice of notices) {
      expect(notice).toHaveTextContent(/delivered to a consumer/i);
    }
  });

  // Non-negotiable 2 + 3: a stale topic list still shows its rows AND a
  // notice, and `deriveTopicResult` (pinned directly in
  // `BrokerTopicsTab.test.tsx`) keeps every one of the envelope's warnings —
  // `DataTable`'s shared status region (pre-existing, out of this task's
  // scope) renders one generic "stale" notice rather than the individual
  // warning strings, the same as it always has for `ConnectionTable`.
  it("keeps a stale topic list's rows on screen, marked as stale, rather than blanking them", async () => {
    listTenantsMock.mockResolvedValueOnce(ok(TENANTS));
    const user = userEvent.setup();
    render(<BrokerTopicsTab connectionId="conn-1" />);
    await screen.findByRole("treeitem", { name: "public" });

    listNamespacesMock.mockResolvedValueOnce(ok(NAMESPACES));
    await user.click(screen.getByRole("treeitem", { name: "public" }));
    await screen.findByRole("treeitem", { name: "default" });

    listTopicsMock.mockResolvedValueOnce(
      ok(TOPIC_PAGE, {
        source: "cache",
        warnings: ["Cached topic list is 90000 ms old, past its freshness window.", "one entry was malformed"],
      }),
    );
    await user.click(screen.getByRole("treeitem", { name: "default" }));

    await screen.findByText("fpms_topup");
    const table = screen.getByRole("table");
    expect(within(table).getByText("fpms_topup")).toBeInTheDocument();
    expect(table.closest('[data-state]')).toHaveAttribute("data-state", "stale");
    expect(screen.getByRole("status")).toHaveTextContent(/stale/i);
  });

  it("closes the detail pane and clears it on Close", async () => {
    const user = userEvent.setup();
    await navigateToTopics(user);

    getTopicDetailMock.mockResolvedValueOnce(ok(DETAIL));
    await user.click(screen.getByText("fpms_topup"));
    await screen.findByText("anti_addiction_deposit_limit_fpmsnt");

    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByText("anti_addiction_deposit_limit_fpmsnt")).not.toBeInTheDocument();
  });
});
