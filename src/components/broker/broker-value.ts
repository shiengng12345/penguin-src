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
import type { BacklogAge, ConsumerTimestamp, Position, SubscriptionType } from "@penguin/broker-contracts";

export const UNKNOWN = "Unknown";

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
