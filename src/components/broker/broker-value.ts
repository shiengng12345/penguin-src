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
 *  precisely the lie Task 1 was written to stop (see `formatScopedBacklogAge`'s
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
 *  guards against that regressing.
 *
 *  Whole-stage review item 1: `subscriptionMsgBacklog` (governed by
 *  `subscriptionBacklogSize`) was removed from this union for the identical
 *  reason `backlogSize`/`preciseBacklog` were excluded above — it is the
 *  same defect, one field later, in the same commit. Measured directly
 *  against the live broker (persistent/public/default/fpms_topup),
 *  `subscriptionBacklogSize=false` and `=true` both return the identical
 *  `msgBacklog` value; only the subscription-level *byte estimate*
 *  (`backlogSize`, which this contract does not map at all — spec §12.3:
 *  「subscriptionBacklogSize | false；订阅级字节估算不进入默认轮询」) differs. The
 *  earlier mapping rendered "Not requested" on every row of every topic's
 *  Backlog column, hiding the exact number this screen exists to show. See
 *  `SubscriptionTable.test.tsx`'s "msgBacklog always renders the broker's
 *  real number" tests, which guard against that regressing.
 *
 *  Whole-stage review item 3: `subscriptionConsumers` (governed by
 *  `excludeConsumers`) is added by this fix. Spec §12.3: 「被排除的列表不是「列表
 *  为空」。若请求不含 Consumer 明细，DTO 必须标记 `notRequested`，不能推断 Consumer
 *  数为 0。」 `src-tauri/src/broker/anomaly.rs` already folds an excluded
 *  consumer list into the anomaly engine's `None` handling (fix round 1,
 *  item 3) — but this UI still asserted a confirmed 0-consumer fact
 *  (`formatConsumerCount`'s "No consumers", `ConsumerTable`'s "No consumers
 *  attached…") from a list that, when excluded, carries no information at
 *  all. Unlike every other member of this union, the governing flag here is
 *  read in the INVERTED sense — see `SCOPE_FLAG_FOR_FIELD`'s doc below. */
export type ScopedStatsField = "oldestBacklogMessageAge" | "subscriptionConsumers";

/** One `ScopedStatsField`'s mapping to the `StatsRequestScope` flag that
 *  governs it, and the sense in which that flag reads as "requested".
 *  `requestedWhenFlagIs` exists because `excludeConsumers` (unlike every
 *  other flag `StatsRequestScope` carries) is worded as an *exclusion*: the
 *  flag being `true` means the field was NOT requested. Baking that
 *  inversion into the mapping — rather than special-casing it at a call
 *  site — keeps `wasFieldRequested` the one function every formatter goes
 *  through, per ruling R38 below. */
interface ScopeFlagMapping {
  flag: keyof StatsRequestScope;
  requestedWhenFlagIs: boolean;
}

/** Ruling R38: the field↔flag mapping must be code, not a comment. This is
 *  the one place that decides which `StatsRequestScope` flag governs which
 *  field — every formatter below goes through `wasFieldRequested` rather
 *  than inspecting `scope` directly, so a future field can only be wired up
 *  correctly (there is nowhere else to guess the mapping from), and
 *  `broker-value.test.tsx`'s R38 test proves flipping one flag here changes
 *  exactly the field(s) listed against it and none other.
 *
 *  - `earliestTimeInBacklog` ("getEarliestTimeInBacklog"): governs
 *    `stats.oldestBacklogMessageAge`. Measured directly against the live
 *    broker: `getEarliestTimeInBacklog=false` and `=true` both return
 *    `oldestBacklogMessageAgeSeconds=-1` on a quiescent topic — spec
 *    §12.3 is explicit that this parameter governs whether the field is
 *    computed at all (unlike `subscriptionBacklogSize`, which governs a
 *    *different* field's precision while the field this UI reads stays
 *    present either way).
 *  - `excludeConsumers` ("excludeConsumers"), INVERTED
 *    (`requestedWhenFlagIs: false`): governs `SubscriptionStats.consumers`
 *    for the purpose of `formatConsumerCount`/`ConsumerTable`'s empty
 *    branch. `excludeConsumers=true` was excluded from `broker::anomaly`'s
 *    prior measurement re-used here (fix round 1, item 3's doc on
 *    `StatsRequestScope.exclude_consumers` in `src-tauri/src/broker/stats.rs`):
 *    that flag makes Pulsar return `consumers: []`, byte-identical to a
 *    confirmed-empty list.
 *
 *  `preciseBacklog` and `subscriptionBacklogSize` are deliberately absent:
 *  `preciseBacklog` never makes a field absent (see `ScopedStatsField`'s
 *  doc); `subscriptionBacklogSize` governs `backlogSize`, not `msgBacklog`
 *  (see `ScopedStatsField`'s doc, whole-stage review item 1). Nothing on
 *  this contract currently reads `publishers`, so `excludePublishers` is
 *  also absent. */
const SCOPE_FLAG_FOR_FIELD: Readonly<Record<ScopedStatsField, ScopeFlagMapping>> = {
  oldestBacklogMessageAge: { flag: "earliestTimeInBacklog", requestedWhenFlagIs: true },
  subscriptionConsumers: { flag: "excludeConsumers", requestedWhenFlagIs: false },
};

/** Whether `scope` says `field` was actually requested. The one function
 *  every scoped formatter below calls, so the R38 mapping above is the only
 *  place that can ever be wrong — never re-derived ad hoc at a call site. */
export function wasFieldRequested(scope: StatsRequestScope, field: ScopedStatsField): boolean {
  const { flag, requestedWhenFlagIs } = SCOPE_FLAG_FOR_FIELD[field];
  return scope[flag] === requestedWhenFlagIs;
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

/** For `storageSize`, `backlogSize`, `msgInCounter` (`TopicStats`) and
 *  `entriesAddedCounter`, `messagesConsumedCounter` (`InternalStats`/
 *  `CursorPosition`) — the five `u64` counters Task 3 exists for. These
 *  arrive as `string | null`, not `number | null`, precisely so this
 *  function never has to touch `Number(...)`/`parseInt`/`+value`: any of
 *  those would round a value above 2^53 - 1 exactly the way `JSON.parse`
 *  already refused to. The digits are grouped with commas for readability —
 *  by regex over the decimal-string text, not by parsing it into a number —
 *  so a 19-digit counter still renders in full, with no `e+` and no
 *  truncation, whatever its magnitude. */
export function formatBigCounter(value: string | null): string {
  if (value === null) return UNKNOWN;
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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
 *  not "No consumers" (Pulsar confirmed nobody is).
 *
 *  Whole-stage review item 3: an excluded `[]` (`scope.excludeConsumers ===
 *  true`) is a THIRD, different fact from both of those — this call chose
 *  not to ask, so `[]` here carries no information at all, and must read
 *  "Not requested" rather than "No consumers".
 *
 *  `consumers === null` is still checked FIRST, ahead of the scope check —
 *  deliberately the opposite priority from `formatScopedBacklogAge`, where
 *  the governing flag always wins even over a withheld value. That is
 *  correct there because `earliestTimeInBacklog` governs
 *  `oldestBacklogMessageAge`'s presence outright. `excludeConsumers` is
 *  narrower: measured directly against the live broker, it only ever
 *  forces the array to `[]` — it does not explain a `consumers` key that is
 *  missing entirely. A `null` alongside `excludeConsumers: true` is an
 *  unmodelled combination, not the documented excluded-list behaviour, so
 *  it must read as the more severe "Unknown", never "Not requested". */
export function formatConsumerCount(consumers: unknown[] | null, scope: StatsRequestScope): string {
  if (consumers === null) return UNKNOWN;
  if (!wasFieldRequested(scope, "subscriptionConsumers")) return NOT_REQUESTED;
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
