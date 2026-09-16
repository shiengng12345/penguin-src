// broker-value.test.ts — direct unit tests for the shared "we do not know"
// presentation policy in broker-value.ts.
//
// formatWriteCapability (Stage 0 Task 2): capability.rs's `probe_write` used
// to create-then-delete a real topic just to learn `can_write`, which the
// product spec forbids (B-07, §11.9, §14.3). Write capability is now
// inferred from read-only responses instead, and `canWriteProbed` exists
// precisely so the UI can tell "measured as unwritable" apart from "never
// measured" — this must never collapse into a single "cannot write" string.
import { describe, expect, it } from "vitest";
import type { StatsRequestScope } from "@penguin/broker-contracts";
import {
  formatScopedBacklogAge,
  formatScopedNumber,
  formatWriteCapability,
  NOT_REQUESTED,
  UNKNOWN,
  wasFieldRequested,
  type ScopedStatsField,
} from "../broker-value";

describe("formatWriteCapability", () => {
  it('reads "Not measured" when the read probe never conclusively answered', () => {
    // canWrite is always false when unprobed — this is the case a
    // successful read (or an inconclusive failure) leaves behind.
    expect(formatWriteCapability(false, false)).toBe("Not measured");
  });

  it('never reads "cannot write" for an unmeasured connection', () => {
    const text = formatWriteCapability(false, false).toLowerCase();
    expect(text).not.toContain("cannot write");
    expect(text).not.toContain("can't write");
  });

  it('reads "Cannot write" only when a 401/403 conclusively measured it', () => {
    expect(formatWriteCapability(false, true)).toBe("Cannot write");
  });

  it('reads "Can write" for the one state where a write was conclusively possible', () => {
    expect(formatWriteCapability(true, true)).toBe("Can write");
  });
});

// Task 1 (R34/R38): StatsRequestScope, and the code (not comment) that maps
// each of its flags to the TopicStats/SubscriptionStats fields it governs.
const ALL_REQUESTED: StatsRequestScope = {
  preciseBacklog: true,
  subscriptionBacklogSize: true,
  earliestTimeInBacklog: true,
};

describe("wasFieldRequested — the R38 field<->flag mapping", () => {
  const fields: ScopedStatsField[] = ["topicBacklogSize", "subscriptionMsgBacklog", "oldestBacklogMessageAge"];

  it("every field reads as requested when every flag is on", () => {
    for (const field of fields) {
      expect(wasFieldRequested(ALL_REQUESTED, field)).toBe(true);
    }
  });

  // R38's own requirement: flipping exactly one flag off must change exactly
  // the field(s) that flag governs, and leave every other field's answer
  // untouched. Written as three separate cases (one per flag) rather than a
  // single loop so a mapping mistake names the specific flag it broke.
  it("flipping subscriptionBacklogSize off changes only subscriptionMsgBacklog", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, subscriptionBacklogSize: false };
    expect(wasFieldRequested(scope, "subscriptionMsgBacklog")).toBe(false);
    expect(wasFieldRequested(scope, "topicBacklogSize")).toBe(true);
    expect(wasFieldRequested(scope, "oldestBacklogMessageAge")).toBe(true);
  });

  it("flipping preciseBacklog off changes only topicBacklogSize", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, preciseBacklog: false };
    expect(wasFieldRequested(scope, "topicBacklogSize")).toBe(false);
    expect(wasFieldRequested(scope, "subscriptionMsgBacklog")).toBe(true);
    expect(wasFieldRequested(scope, "oldestBacklogMessageAge")).toBe(true);
  });

  it("flipping earliestTimeInBacklog off changes only oldestBacklogMessageAge", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, earliestTimeInBacklog: false };
    expect(wasFieldRequested(scope, "oldestBacklogMessageAge")).toBe(false);
    expect(wasFieldRequested(scope, "topicBacklogSize")).toBe(true);
    expect(wasFieldRequested(scope, "subscriptionMsgBacklog")).toBe(true);
  });
});

describe("formatScopedNumber / formatScopedBacklogAge — Not requested vs Unknown", () => {
  it('renders "Not requested" when the governing flag is off, regardless of the value', () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, subscriptionBacklogSize: false };
    expect(formatScopedNumber(42, scope, "subscriptionMsgBacklog")).toBe(NOT_REQUESTED);
    expect(formatScopedNumber(null, scope, "subscriptionMsgBacklog")).toBe(NOT_REQUESTED);
  });

  it('renders the ordinary "Unknown" when the flag is on and the value is genuinely absent', () => {
    expect(formatScopedNumber(null, ALL_REQUESTED, "subscriptionMsgBacklog")).toBe(UNKNOWN);
  });

  it('renders the real number when the flag is on and the value is present', () => {
    expect(formatScopedNumber(3400, ALL_REQUESTED, "subscriptionMsgBacklog")).toBe("3400");
  });

  it('"Not requested" and "Unknown" are two visibly different strings for the same null value', () => {
    const notRequestedScope: StatsRequestScope = { ...ALL_REQUESTED, subscriptionBacklogSize: false };
    const notRequested = formatScopedNumber(null, notRequestedScope, "subscriptionMsgBacklog");
    const unknown = formatScopedNumber(null, ALL_REQUESTED, "subscriptionMsgBacklog");
    expect(notRequested).not.toBe(unknown);
  });

  it('an unrequested oldestBacklogMessageAge reads "Not requested" even though the parsed value says noBacklog', () => {
    // The whole point of Task 1's second half: `earliestTimeInBacklog: false`
    // means the broker's own -1/"noBacklog" answer for this call cannot be
    // trusted as measured. "Not requested" must override it, not defer to
    // whatever BacklogAge happened to normalize to.
    const scope: StatsRequestScope = { ...ALL_REQUESTED, earliestTimeInBacklog: false };
    expect(formatScopedBacklogAge({ state: "noBacklog" }, scope)).toBe(NOT_REQUESTED);
  });

  it("renders the ordinary noBacklog/unknown/seconds words when the flag is on", () => {
    expect(formatScopedBacklogAge({ state: "noBacklog" }, ALL_REQUESTED)).toBe("No backlog");
    expect(formatScopedBacklogAge({ state: "unknown" }, ALL_REQUESTED)).toBe(UNKNOWN);
    expect(formatScopedBacklogAge({ state: "seconds", seconds: 5 }, ALL_REQUESTED)).toBe("5s");
  });
});
