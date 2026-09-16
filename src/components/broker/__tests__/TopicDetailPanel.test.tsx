// TopicDetailPanel tests — the last layer over five tasks of backend work
// that keeps three facts apart: BacklogAge's three states (seconds /
// noBacklog / unknown), indeterminate checks vs. anomalies, and a cursor
// entryId of -1 as a real position rather than a gap. Every test here
// guards one of those distinctions from being flattened.
//
// Whole-stage review item 4: `makeDetail`'s default `statsRequestScope` is
// `SHIPPED_SCOPE` — the scope this codebase's `/stats` calls actually send
// in production — so this file renders the panel the way an operator
// actually sees it. Only the "oldestBacklogMessageAge — three distinct
// renderings" describe block overrides it to `ALL_REQUESTED_SCOPE`: that
// block is explicitly about what each of `BacklogAge`'s three states
// renders as, which is only observable at all when the governing flag is
// on (see `src/test/broker-scope-fixtures.ts`).
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TopicDetailPanel } from "../TopicDetailPanel";
import type { TopicDetail } from "@penguin/broker-contracts";
import { SHIPPED_SCOPE } from "@/test/broker-scope-fixtures";

function makeDetail(overrides: Partial<TopicDetail> = {}): TopicDetail {
  return {
    topic: "persistent://public/default/fpms_topup",
    stats: {
      msgRateIn: 0,
      msgRateOut: 0,
      msgThroughputIn: 0,
      msgThroughputOut: 0,
      storageSize: "0",
      backlogSize: "0",
      msgInCounter: "0",
      oldestBacklogMessageAge: { state: "unknown" },
      subscriptions: [],
      statsRequestScope: SHIPPED_SCOPE,
    },
    internal: {
      entriesAddedCounter: "0",
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
          messagesConsumedCounter: "0",
        },
      ],
    },
    anomalies: [],
    indeterminate: [],
    ...overrides,
  };
}

describe("TopicDetailPanel", () => {
  it("shows a real anomaly's measured value, not just that something is wrong", () => {
    // Every test in this file used `anomalies: []`, so the whole non-empty
    // branch was unexercised: a future edit could drop `observedValue`, or
    // print `detail` twice, and nothing would fail. "has a backlog" is the
    // rule that fired; "3400 messages" is what an operator acts on.
    render(
      <TopicDetailPanel
        detail={makeDetail({
          anomalies: [
            {
              kind: "backlogWithNoConsumer",
              topic: "persistent://public/default/fpms_topup",
              subscription: "anti_addiction_deposit_limit_fpmsnt",
              detail: "subscription has a backlog but no connected consumer",
              observedValue: "3400 messages backlogged, 0 consumers attached",
            },
          ],
        })}
        state="ready"
        warnings={[]}
        onRefresh={vi.fn()}
      />,
    );
    expect(screen.getByText(/3400 messages backlogged, 0 consumers attached/)).toBeInTheDocument();
    expect(screen.getByText(/anti_addiction_deposit_limit_fpmsnt/)).toBeInTheDocument();
    expect(screen.queryByText(/no anomalies detected/i)).not.toBeInTheDocument();
  });

  it("gives anomalies and indeterminate checks different roles, not just different words", () => {
    // The visual distinction this panel exists to protect can be lost by
    // semantics alone: an indeterminate section promoted to role="alert"
    // reads as "something is wrong" to a screen reader and to the eye,
    // which is the opposite of what an unrunnable check means.
    render(
      <TopicDetailPanel
        detail={makeDetail({
          anomalies: [
            {
              kind: "consumerBlockedOnUnacked",
              topic: "persistent://public/default/fpms_topup",
              subscription: null,
              detail: "the broker has stopped delivering to this consumer",
              observedValue: "1200 unacked messages (blockedOnUnackedMsgs=true)",
            },
          ],
          indeterminate: [
            {
              kind: "backlogWithNoConsumer",
              topic: "persistent://public/default/fpms_topup",
              subscription: "rg_deposit_accumulate_LOCAL",
              reason: "msgBacklog was not reported, so this check could not run",
            },
          ],
        })}
        state="ready"
        warnings={[]}
        onRefresh={vi.fn()}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/1200 unacked messages/);
    // The indeterminate reason must NOT be inside the alert region — an
    // unrunnable check promoted to role="alert" tells a screen reader that
    // something is wrong, which is the opposite of what it means.
    expect(alert).not.toHaveTextContent(/msgBacklog was not reported/);
    expect(screen.getByText(/msgBacklog was not reported/)).toBeInTheDocument();
  });

  it("shows the cursor position verbatim", () => {
    // "38:-1" is ledger:entry, and -1 means nothing consumed yet. Rewriting
    // it as a number, or blanking it, would destroy that meaning.
    render(<TopicDetailPanel detail={makeDetail()} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText("38:-1")).toBeInTheDocument();
  });

  // Whole-stage review item 4: under `SHIPPED_SCOPE` (the default here),
  // `earliestTimeInBacklog` is `false`, so this cell reads "Not requested"
  // regardless of what `oldestBacklogMessageAge` normalized to — Task 1's
  // `formatScopedBacklogAge` has always worked this way; what changed is
  // that this file's default fixture now actually exercises it, instead of
  // the unrealistic all-flags-true scope every test here used to render
  // under. The "unknown vs zero vs noBacklog" distinction this test used to
  // name is covered, under a scope that actually requested the field, by
  // the "oldestBacklogMessageAge — three distinct renderings" describe
  // block below.
  it('reads "Not requested" for the backlog age under the scope this app actually ships', () => {
    render(<TopicDetailPanel detail={makeDetail()} state="ready" onRefresh={vi.fn()} />);
    expect(screen.getByText(/not requested/i)).toBeInTheDocument();
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
    // This block is explicitly about what each of BacklogAge's three states
    // renders as — only observable when earliestTimeInBacklog was actually
    // requested (under SHIPPED_SCOPE, every state here would collapse into
    // "Not requested" instead; see the test above this describe block).
    const requestedScope = { ...SHIPPED_SCOPE, earliestTimeInBacklog: true };

    it("renders a real age in seconds as a measured number, not a sentinel", () => {
      const detail = makeDetail({
        stats: {
          ...makeDetail().stats,
          oldestBacklogMessageAge: { state: "seconds", seconds: 42 },
          statsRequestScope: requestedScope,
        },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      expect(screen.getByText(/42/)).toBeInTheDocument();
      expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/no backlog/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/not requested/i)).not.toBeInTheDocument();
    });

    it("renders noBacklog as a determinate, healthy fact — not as unknown", () => {
      const detail = makeDetail({
        stats: {
          ...makeDetail().stats,
          oldestBacklogMessageAge: { state: "noBacklog" },
          statsRequestScope: requestedScope,
        },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      // Must read as a positive, measured fact ("no backlog"), never as the
      // same "Unknown" word used for a withheld field.
      expect(screen.getByText(/no backlog/i)).toBeInTheDocument();
      expect(screen.queryByText(/^unknown$/i)).not.toBeInTheDocument();
    });

    it("renders unknown as genuinely unmeasured — distinct from noBacklog", () => {
      const detail = makeDetail({
        stats: {
          ...makeDetail().stats,
          oldestBacklogMessageAge: { state: "unknown" },
          statsRequestScope: requestedScope,
        },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      expect(screen.getByText(/unknown|not measured/i)).toBeInTheDocument();
      expect(screen.queryByText(/no backlog/i)).not.toBeInTheDocument();
    });
  });

  // Fix round 1, item 1: measured directly against the live broker,
  // `getPreciseBacklog=false` still returns a real `backlogSize` — the flag
  // governs precision, not presence. `preciseBacklog` was wrongly folded
  // into the R38 "not requested" mapping originally; this guards against
  // that regressing.
  describe("backlogSize — precision only, never Not requested (fix round 1, item 1)", () => {
    it("renders the real backlogSize even when preciseBacklog is false", () => {
      const detail = makeDetail({
        stats: {
          ...makeDetail().stats,
          backlogSize: "12345",
          statsRequestScope: { ...makeDetail().stats.statsRequestScope, preciseBacklog: false },
        },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      // `formatBigCounter` digit-groups for readability — "12,345", not
      // "12345" — but never via `Number(...)`, which is the whole point of
      // Task 3.
      expect(screen.getByText("12,345")).toBeInTheDocument();
      // Specifically the Backlog size cell, not the page as a whole — under
      // SHIPPED_SCOPE (the default here) the topic-level backlog-age cell
      // legitimately reads "Not requested" too (earliestTimeInBacklog is
      // false), which is unrelated to this test's claim about backlogSize.
      const backlogSizeValue = screen.getByText("Backlog size (bytes)").nextElementSibling;
      expect(backlogSizeValue).toHaveTextContent("12,345");
      expect(backlogSizeValue).not.toHaveTextContent(/not requested/i);
    });
  });

  // Task 3: msgInCounter/storageSize/backlogSize/entriesAddedCounter/
  // messagesConsumedCounter are `u64` counters that cross IPC as decimal
  // strings precisely so a value above JS's 2^53 - 1 safe-integer ceiling
  // renders in full — no scientific notation, no rounding, no truncation.
  describe("a 19-digit counter renders in full (Task 3)", () => {
    const NINETEEN_DIGITS = "9223372036854775807"; // i64::MAX; also < u64::MAX

    it("msgInCounter — no e+, no rounding, no truncation", () => {
      const detail = makeDetail({
        stats: { ...makeDetail().stats, msgInCounter: NINETEEN_DIGITS },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      const rendered = screen.getByText("9,223,372,036,854,775,807");
      expect(rendered).toBeInTheDocument();
      expect(rendered.textContent).not.toMatch(/e\+/i);
    });

    it("entriesAddedCounter — no e+, no rounding, no truncation", () => {
      const detail = makeDetail({
        internal: { ...makeDetail().internal, entriesAddedCounter: NINETEEN_DIGITS },
      });
      render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);
      const rendered = screen.getByText("9,223,372,036,854,775,807");
      expect(rendered).toBeInTheDocument();
      expect(rendered.textContent).not.toMatch(/e\+/i);
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
        entriesAddedCounter: "5",
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

  // Phase A final review, finding 3: the loading branch used to live inside
  // `if (detail === null)`, so once anything had loaded, a later
  // `state === "loading"` (a new topic selected, or a manual refresh)
  // rendered nothing new — the previous topic's stats, anomalies and
  // subscriptions stayed on screen with no indication a fetch was even in
  // flight. `detail={null}` alone could never catch this, since that is the
  // one case where stale content cannot exist. This test uses a populated
  // `detail` instead, the way the finding required.
  it("renders the loading state instead of a previous topic's stale content", () => {
    render(<TopicDetailPanel detail={makeDetail()} state="loading" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
    // The previous topic's cursor position must not still be on screen.
    expect(screen.queryByText("38:-1")).not.toBeInTheDocument();
    expect(screen.queryByText(/rg_deposit_accumulate_LOCAL/)).not.toBeInTheDocument();
  });

  it("still renders the loading state when nothing has loaded yet", () => {
    render(<TopicDetailPanel detail={null} state="loading" onRefresh={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/loading/i);
  });

  // Whole-stage review item 4: the test this file was missing. Every other
  // test above either used the unrealistic all-flags-true scope (before
  // this fix) or a manufactured anomaly/indeterminate array. This test
  // renders under SHIPPED_SCOPE with a subscription shaped like a real,
  // stuck queue — a real backlog, a real attached consumer, and a topic
  // whose backlog age genuinely was not requested — and asserts what an
  // operator actually sees on screen. This is the test that would have
  // caught item 1 (msgBacklog wrongly hidden behind "Not requested") and
  // item 2 (BacklogOlderThanThreshold silently unreachable, with no
  // indeterminate entry to say so) on the day they landed: item 1 shows up
  // here as "3400" failing to appear; item 2 as the indeterminate section
  // being empty when it should carry the age check.
  it("under the scope this app actually ships, an operator sees the real backlog and the age check marked indeterminate", () => {
    const detail = makeDetail({
      stats: {
        ...makeDetail().stats,
        subscriptions: [
          {
            name: "anti_addiction_deposit_limit_fpmsnt",
            msgBacklog: 3400,
            unackedMessages: 12,
            msgRateOut: 0,
            subType: { state: "named", name: "Shared" },
            consumers: [
              {
                consumerName: "worker-1",
                address: "/10.0.0.1:5000",
                clientVersion: "Pulsar-Java-v4.2.4",
                availablePermits: 500,
                unackedMessages: 12,
                lastAckedTimestamp: { state: "unknown" },
                lastConsumedTimestamp: { state: "unknown" },
                msgRateOut: 0,
                blockedOnUnackedMsgs: false,
              },
            ],
          },
        ],
        // Matches what parse_topic_stats actually stamps under
        // TOPIC_STATS_REQUEST_SCOPE: a real payload's -1 sentinel normalizes
        // to noBacklog, which effective_backlog_age (src-tauri/src/broker/
        // anomaly.rs) folds to Unknown for the indeterminate check below,
        // because earliestTimeInBacklog is false.
        oldestBacklogMessageAge: { state: "noBacklog" },
      },
      anomalies: [],
      indeterminate: [
        {
          kind: "backlogOlderThanThreshold",
          topic: "persistent://public/default/fpms_topup",
          subscription: null,
          reason:
            'topic "persistent://public/default/fpms_topup" did not report oldestBacklogMessageAgeSeconds (or reported an undocumented negative value), so whether it has an old backlog could not be determined',
        },
      ],
    });
    render(<TopicDetailPanel detail={detail} state="ready" onRefresh={vi.fn()} />);

    // Item 1: the real backlog must be on screen, not hidden behind "Not
    // requested" — subscriptionBacklogSize does not govern msgBacklog.
    expect(screen.getByText("3400")).toBeInTheDocument();
    // The attached consumer's own count must also be visible — excludeConsumers
    // is false in SHIPPED_SCOPE, so consumer detail genuinely was requested.
    expect(screen.getByText("1 consumer")).toBeInTheDocument();

    // Item 2: an empty anomalies section next to a non-empty indeterminate
    // section must not read as "checked and clear" — the age check has to
    // be visibly marked as never having run.
    expect(screen.getByText(/no anomalies/i)).toBeInTheDocument();
    expect(screen.getByText(/did not report oldestBacklogMessageAgeSeconds/i)).toBeInTheDocument();
    expect(screen.getByText(/could not (be )?(run|perform)/i)).toBeInTheDocument();
  });
});
