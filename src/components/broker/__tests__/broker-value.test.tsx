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
  formatBigCounter,
  formatConsumerCount,
  formatScopedBacklogAge,
  formatWriteCapability,
  NOT_REQUESTED,
  UNKNOWN,
  wasFieldRequested,
  type ScopedStatsField,
} from "../broker-value";

// Task 3: `formatBigCounter` — the five `u64` counters (`storageSize`,
// `backlogSize`, `msgInCounter`, `entriesAddedCounter`,
// `messagesConsumedCounter`) cross IPC as decimal strings specifically so a
// value above JS's 2^53 - 1 safe-integer ceiling (9,007,199,254,740,991)
// never gets read into a `Number` at all. This suite pins that
// `formatBigCounter` never does that conversion either.
describe("formatBigCounter — a 19-digit u64 counter renders in full", () => {
  it("renders null as Unknown, same as every other withheld field", () => {
    expect(formatBigCounter(null)).toBe(UNKNOWN);
  });

  it("digit-groups a small value without altering its digits", () => {
    expect(formatBigCounter("0")).toBe("0");
    expect(formatBigCounter("12345")).toBe("12,345");
  });

  it("renders a value above 2^53 - 1 exactly, with every digit preserved", () => {
    // u64::MAX. Number(u64MAX) in JavaScript rounds to
    // 18446744073709551616 (off by one) — proof this must never touch
    // `Number`/`parseInt`.
    const u64Max = "18446744073709551615";
    expect(formatBigCounter(u64Max)).toBe("18,446,744,073,709,551,615");
  });

  it("never emits scientific notation for a 19-digit value", () => {
    // This is exactly what `String(Number("9223372036854775807"))` produces
    // today: "9223372036854776000" — the last six digits silently
    // corrupted, with no error. `formatBigCounter` must not do that
    // conversion at all.
    const nineteenDigits = "9223372036854775807";
    const rendered = formatBigCounter(nineteenDigits);
    expect(rendered).toBe("9,223,372,036,854,775,807");
    expect(rendered).not.toMatch(/e\+/i);
    expect(rendered.replace(/,/g, "")).toBe(nineteenDigits);
  });
});

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
  excludePublishers: false,
  excludeConsumers: false,
};

describe("wasFieldRequested — the R38 field<->flag mapping", () => {
  const fields: ScopedStatsField[] = ["oldestBacklogMessageAge", "subscriptionConsumers"];

  it("every field reads as requested when every flag is on", () => {
    for (const field of fields) {
      expect(wasFieldRequested(ALL_REQUESTED, field)).toBe(true);
    }
  });

  it("flipping earliestTimeInBacklog off changes only oldestBacklogMessageAge", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, earliestTimeInBacklog: false };
    expect(wasFieldRequested(scope, "oldestBacklogMessageAge")).toBe(false);
    expect(wasFieldRequested(scope, "subscriptionConsumers")).toBe(true);
  });

  // Whole-stage review item 3: `subscriptionConsumers` is mapped to
  // `excludeConsumers` in the INVERTED sense — the flag being `true` means
  // the field was NOT requested (Pulsar's own `excludeConsumers` query
  // parameter excludes consumer detail when true). Every other entry in
  // this mapping reads "flag true == requested"; this is the one exception,
  // and it must be exercised on its own, not lumped in with the "every
  // field on" case above.
  it("flipping excludeConsumers on (the inverted sense) changes only subscriptionConsumers", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, excludeConsumers: true };
    expect(wasFieldRequested(scope, "subscriptionConsumers")).toBe(false);
    expect(wasFieldRequested(scope, "oldestBacklogMessageAge")).toBe(true);
  });

  // Whole-stage review item 1: `subscriptionBacklogSize` must not affect
  // `oldestBacklogMessageAge` — the two flags are unrelated. This is the
  // negative-space guard for the fix that removed `subscriptionMsgBacklog`
  // from `ScopedStatsField` entirely (it was wrongly wired to this flag;
  // see `ScopedStatsField`'s doc in `broker-value.ts`).
  it("flipping subscriptionBacklogSize off changes nothing in this mapping", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, subscriptionBacklogSize: false };
    for (const field of fields) {
      expect(wasFieldRequested(scope, field)).toBe(true);
    }
  });

  // Fix round 1, item 1: `preciseBacklog` must not be able to affect the
  // mapped field either — it governs `backlogSize`'s precision only, and
  // `backlogSize` is not (and must never become) a `ScopedStatsField` member.
  // This is the negative-space guard: flipping the flag the old, wrong
  // mapping used to key off of must be a complete no-op here.
  it("flipping preciseBacklog off changes neither mapped field", () => {
    const scope: StatsRequestScope = { ...ALL_REQUESTED, preciseBacklog: false };
    for (const field of fields) {
      expect(wasFieldRequested(scope, field)).toBe(true);
    }
  });
});

// Whole-stage review item 3: spec §12.3 says "被排除的列表不是「列表为空」。若请求不含
// Consumer 明细，DTO 必须标记 notRequested，不能推断 Consumer 数为 0。" R43 wired
// `excludeConsumers` into `broker::anomaly`'s consumer-dependent checks, but
// `broker-value.ts` explicitly declined the DTO/UI half of that sentence —
// `formatConsumerCount` returned "No consumers" for an excluded (not empty)
// list, asserting a consumer count of 0 from a list that carries no
// information.
describe('formatConsumerCount — "Not requested" for an excluded consumer list', () => {
  const EXCLUDE_CONSUMERS_SCOPE: StatsRequestScope = { ...ALL_REQUESTED, excludeConsumers: true };

  it('renders "Not requested" for an excluded (empty) consumer list, never "No consumers"', () => {
    // Measured directly against the live broker (fix round 1, item 3, see
    // broker::stats's StatsRequestScope doc): `excludeConsumers=true`
    // returns `consumers: []`, byte-identical to Pulsar's own confirmed
    // "nobody attached" fact. That `[]` must not be presented as a measured
    // count of zero when this call declined to ask.
    expect(formatConsumerCount([], EXCLUDE_CONSUMERS_SCOPE)).toBe(NOT_REQUESTED);
  });

  it('renders "No consumers" for a genuinely confirmed-empty list when consumers were requested', () => {
    expect(formatConsumerCount([], ALL_REQUESTED)).toBe("No consumers");
  });

  it("still renders Unknown for a withheld (null) consumers key regardless of excludeConsumers", () => {
    // consumers: null means the key itself was omitted — a different,
    // genuinely-unknown fact from "we excluded it on purpose". Both scopes
    // must read this the same way: the broker never sent the key at all.
    expect(formatConsumerCount(null, EXCLUDE_CONSUMERS_SCOPE)).toBe(UNKNOWN);
    expect(formatConsumerCount(null, ALL_REQUESTED)).toBe(UNKNOWN);
  });

  it("still renders the real count for a non-empty list when consumers were requested", () => {
    expect(formatConsumerCount([{}], ALL_REQUESTED)).toBe("1 consumer");
    expect(formatConsumerCount([{}, {}], ALL_REQUESTED)).toBe("2 consumers");
  });
});

describe("formatScopedBacklogAge — Not requested vs Unknown", () => {
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
