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
import type { ConsumerTimestamp } from "@penguin/broker-contracts";

export const UNKNOWN = "Unknown";

/** For `msgBacklog`, `unackedMessages`, `msgRateOut`, `availablePermits` —
 *  every plain numeric field on these two types. */
export function formatNumber(value: number | null): string {
  return value === null ? UNKNOWN : String(value);
}

/** For `subType`, `consumerName`, `address`, `clientVersion`. */
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
