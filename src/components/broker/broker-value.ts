// broker-value — the single presentation policy for "we do not know", shared
// by SubscriptionTable and ConsumerTable.
//
// Almost every field on `SubscriptionStats`/`ConsumerStats`
// (`packages/broker-contracts/src/topic-detail.ts`) is `T | null`, and the
// null is load-bearing: it means Pulsar withheld the field, not that the
// value is zero, false, or absent-therefore-blank. The rule this module
// exists to enforce: a `null` must never render as `0`, as an unexplained
// `—`, as an empty cell, or as `false`. One word, "Unknown", used for every
// null on this screen — numbers, text, and the diagnostic
// `blockedOnUnackedMsgs` boolean alike — so an operator never has to guess
// whether a blank or a zero means "measured" or "not measured".
//
// Fix round 1 (task 11): `lastAckedTimestamp`/`lastConsumedTimestamp` used to
// be `number | null` here, with `0` normalized to `null` at the Rust parse
// boundary — which meant this module could only ever say "Unknown" for
// either "definitely never acked" or "we don't know", because the type
// hadn't kept the two apart. That was a defect in the type, not a defensible
// reading of it: it repeated, one field later, the exact mistake `BacklogAge`
// exists to fix for `oldestBacklogMessageAgeSeconds`. Both fields are now
// `ConsumerTimestamp` (mirroring `BacklogAge`), so "Never" is sayable again —
// see `formatConsumerTimestamp` below. "Unknown" remains the one word for
// every other null on this screen: numbers, text, and the diagnostic
// `blockedOnUnackedMsgs` boolean alike.
import type {
  BacklogAge,
  ConsumerTimestamp,
  Position,
  StatsRequestScope,
  SubscriptionType,
} from "@penguin/broker-contracts";

export const UNKNOWN = "Unknown";

/** `subscriptions[].msgBacklog` / `stats.oldestBacklogMessageAge` when the
 *  flag that governs them was set to `false` (Task 1, ruling R34).
 *  Deliberately a different word from `UNKNOWN`: "Unknown" means the broker
 *  was asked and did not answer; "Not requested" means this application
 *  deliberately did not ask. Telling those apart is the entire reason
 *  `StatsRequestScope` exists — collapsing them back into one word is
 *  precisely the lie Task 1 was written to stop (see `formatScopedNumber`'s
 *  mutation-check test in `broker-value.test.tsx`, which pins that these two
 *  strings must render differently). */
export const NOT_REQUESTED = "Not requested";

/** The `TopicStats`/`SubscriptionStats` fields whose presence depends on a
 *  `StatsRequestScope` flag. A union of field names, not a raw string the
 *  UI free-associates with a flag — see `SCOPE_FLAG_FOR_FIELD` below.
 *
 *  Fix round 1, item 1: `stats.backlogSize` (governed by `preciseBacklog`)
 *  is deliberately **not** a member of this union. Measured directly
 *  against the live broker, `getPreciseBacklog=false` and `=true` both
 *  return `backlogSize` — the flag governs the number's precision, not its
 *  presence — so it must always render through plain `formatNumber`, never
 *  "Not requested". An earlier version of this file mapped it here anyway,
 *  which hid a real number the broker gave us; see
 *  `TopicDetailPanel.test.tsx`'s "backlogSize — precision only" test, which
 *  guards against that regressing. */
export type ScopedStatsField = "subscriptionMsgBacklog" | "oldestBacklogMessageAge";

/** Ruling R38: the field↔flag mapping must be code, not a comment. This is
 *  the one place that decides which `StatsRequestScope` flag governs which
 *  field — every formatter below goes through `wasFieldRequested` rather
 *  than inspecting `scope` directly, so a future field can only be wired up
 *  correctly (there is nowhere else to guess the mapping from), and
 *  `broker-value.test.tsx`'s R38 test proves flipping one flag here changes
 *  exactly the field(s) listed against it and none other.
 *
 *  - `subscriptionBacklogSize` ("subscriptionBacklogSize"): governs each
 *    subscription's `msgBacklog` — the parameter spec §12.3 singles out as
 *    unsafe to request unconditionally (it can take Ledger locks on a busy
 *    broker), and the reason Task 1 exists at all.
 *  - `earliestTimeInBacklog` ("getEarliestTimeInBacklog"): governs
 *    `stats.oldestBacklogMessageAge`.
 *
 *  `preciseBacklog` and the fix-round-1 `excludePublishers`/
 *  `excludeConsumers` flags are deliberately absent: `preciseBacklog` never
 *  makes a field absent (see `ScopedStatsField`'s doc); nothing on this
 *  contract currently reads `publishers`; and an excluded `consumers` list
 *  is handled where it actually matters — `derive_anomalies`/
 *  `derive_indeterminate_checks` in `src-tauri/src/broker/anomaly.rs` — not
 *  by a UI "Not requested" label, because presenting an excluded list as a
 *  measured `0`-consumer fact is a backend anomaly-derivation risk, not a
 *  single-cell rendering choice. */
const SCOPE_FLAG_FOR_FIELD: Readonly<Record<ScopedStatsField, keyof StatsRequestScope>> = {
  subscriptionMsgBacklog: "subscriptionBacklogSize",
  oldestBacklogMessageAge: "earliestTimeInBacklog",
};

/** Whether `scope` says `field` was actually requested. The one function
 *  every scoped formatter below calls, so the R38 mapping above is the only
 *  place that can ever be wrong — never re-derived ad hoc at a call site. */
export function wasFieldRequested(scope: StatsRequestScope, field: ScopedStatsField): boolean {
  return scope[SCOPE_FLAG_FOR_FIELD[field]];
}

/** `formatNumber`, but "Not requested" takes priority over "Unknown" when
 *  the governing flag was off — see `NOT_REQUESTED`'s doc for why these
 *  must stay two different strings. */
export function formatScopedNumber(value: number | null, scope: StatsRequestScope, field: ScopedStatsField): string {
  return wasFieldRequested(scope, field) ? formatNumber(value) : NOT_REQUESTED;
}

/** `formatBacklogAge`, scoped by `earliestTimeInBacklog`. When that flag was
 *  off, the parsed `BacklogAge` (however it came out — `seconds`,
 *  `noBacklog`, or `unknown`) must not be trusted as a measured answer:
 *  "Not requested" overrides it rather than deferring to whatever the
 *  three-state value happened to normalize to. */
export function formatScopedBacklogAge(value: BacklogAge, scope: StatsRequestScope): string {
  return wasFieldRequested(scope, "oldestBacklogMessageAge") ? formatBacklogAge(value) : NOT_REQUESTED;
}

/** For `msgBacklog`, `unackedMessages`, `msgRateOut`, `availablePermits` —
 *  every plain numeric field on these two types. */
export function formatNumber(value: number | null): string {
  return value === null ? UNKNOWN : String(value);
}

/** For `consumerName`, `address`, `clientVersion`. */
export function formatText(value: string | null): string {
  return value === null ? UNKNOWN : value;
}

/** `blockedOnUnackedMsgs` in words, never a colour — and never defaulted to
 *  "Not blocked" when the broker didn't actually report it. */
export function formatBlocked(value: boolean | null): string {
  if (value === null) return UNKNOWN;
  return value ? "Blocked" : "Not blocked";
}

/** `lastAckedTimestamp` / `lastConsumedTimestamp`. Three states, three
 *  distinct words — `"unknown"` (the field was withheld) and `"never"`
 *  (Pulsar's own determinate "not yet" sentinel) must not collapse into the
 *  same text, which is the exact defect fix round 1 corrected. */
export function formatConsumerTimestamp(value: ConsumerTimestamp): string {
  switch (value.state) {
    case "unknown":
      return UNKNOWN;
    case "never":
      return "Never";
    case "millis":
      return new Date(value.millis).toLocaleString();
  }
}

/** The subscription-row "Consumers" summary. `null` and `[]` are different,
 *  determinate facts (see `SubscriptionStats.consumers`'s doc comment) and
 *  must read differently: "Unknown" (we couldn't tell who is attached) is
 *  not "No consumers" (Pulsar confirmed nobody is). */
export function formatConsumerCount(consumers: unknown[] | null): string {
  if (consumers === null) return UNKNOWN;
  if (consumers.length === 0) return "No consumers";
  return consumers.length === 1 ? "1 consumer" : `${consumers.length} consumers`;
}

/** `oldestBacklogMessageAge` (Task 12). Three states, three distinct words —
 *  `"noBacklog"` (a determinate, healthy fact: no backlog has ever existed)
 *  must never collapse into the same word as `"unknown"` (the broker did
 *  not report the field at all). Rendering both as the same placeholder is
 *  the exact mistake this type was built to prevent: a healthy, empty
 *  topic would then look indistinguishable from one nobody could measure. */
export function formatBacklogAge(value: BacklogAge): string {
  switch (value.state) {
    case "unknown":
      return UNKNOWN;
    case "noBacklog":
      return "No backlog";
    case "seconds":
      return `${value.seconds}s`;
  }
}

/** `subType` (Phase A final review, finding 2). Three states, three
 *  distinct words — `"unset"` (Pulsar's own determinate "no consumer has
 *  ever claimed a dispatcher type" sentinel) must never collapse into the
 *  same word as `"unknown"` (the field was withheld). Collapsing them was
 *  the exact defect this fix corrected: it claimed the broker withheld the
 *  field on every subscription where the broker had, in fact, answered.
 *  The switch is exhaustive over `SubscriptionType["state"]` — an
 *  unhandled future state is a compile error here, not a silent
 *  fallthrough to a default string. */
export function formatSubscriptionType(value: SubscriptionType): string {
  switch (value.state) {
    case "unknown":
      return UNKNOWN;
    case "unset":
      return "Unset";
    case "named":
      return value.name;
  }
}

/** `CapabilitySnapshot.canWrite`/`canWriteProbed` (Stage 0 Task 2).
 *  `capability.rs` no longer attempts an actual write to learn `canWrite` —
 *  the spec (B-07, §11.9, §14.3) forbids creating or deleting a topic just
 *  to probe permissions. Write capability is inferred from a read-only
 *  admin call instead: a 401/403 there IS a conclusive measurement
 *  (`canWriteProbed: true`), but a successful read is NOT evidence of write
 *  access (`canWriteProbed: false`). This must render as three distinct
 *  states, and in particular `canWriteProbed: false` must read "Not
 *  measured", never "Cannot write" — collapsing the two would present an
 *  inference as a fact, exactly what this project's spec forbids. */
export function formatWriteCapability(canWrite: boolean, canWriteProbed: boolean): string {
  if (!canWriteProbed) return "Not measured";
  return canWrite ? "Can write" : "Cannot write";
}

/** A cursor `Position` (`markDeletePosition`, `readPosition`,
 *  `lastConfirmedEntry`) as Pulsar's own `"ledgerId:entryId"` wire text.
 *  `entryId: -1` is rendered verbatim, never blanked or normalized — it is
 *  the documented fact "this subscription has acknowledged nothing in this
 *  ledger yet", not a missing value. Accepts `null` only because
 *  `InternalStats.lastConfirmedEntry` is the one `Position` field that can
 *  genuinely be absent; `markDeletePosition`/`readPosition` are never
 *  null on `CursorPosition` but pass through the same formatter for one
 *  consistent rendering of the shape. */
export function formatPosition(value: Position | null): string {
  return value === null ? UNKNOWN : `${value.ledgerId}:${value.entryId}`;
}
