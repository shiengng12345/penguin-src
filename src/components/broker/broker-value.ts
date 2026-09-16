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
// `lastAckedTimestamp`/`lastConsumedTimestamp` get the same "Unknown" rather
// than a more specific "Never": the Rust parse boundary already folds
// Pulsar's own 0-means-never sentinel and a genuinely withheld field into
// the same `null` (see the doc comment on `ConsumerStats.lastAckedTimestamp`),
// so this layer cannot tell those two cases apart either. Claiming "Never"
// would assert a specific, positive fact ("this consumer has certainly never
// acked") that the data doesn't actually support — "Unknown" is the honest
// reading of a genuinely ambiguous null.
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

/** `lastAckedTimestamp` / `lastConsumedTimestamp`. See the module doc for why
 *  `null` reads as "Unknown" rather than "Never" or an epoch date. */
export function formatTimestamp(value: number | null): string {
  if (value === null) return UNKNOWN;
  return new Date(value).toLocaleString();
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
