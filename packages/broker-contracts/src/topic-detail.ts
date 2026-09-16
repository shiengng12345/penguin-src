// packages/broker-contracts/src/topic-detail.ts
//
// Mirrors src-tauri/src/broker/commands/topic_detail.rs field-for-field,
// camelCase on the wire — the two must agree, or the topic detail screen
// and the Rust command disagree about what was actually measured.
//
// `TopicStats`/`SubscriptionStats`/`ConsumerStats` mirror
// src-tauri/src/broker/stats.rs; `InternalStats`/`Position`/`CursorPosition`
// mirror src-tauri/src/broker/internal_stats.rs. Every `Option<T>` on the
// Rust side that has no `#[serde(skip_serializing_if)]` serialises `None`
// as JSON `null` (never an omitted key), so every optional field here is
// `T | null`, not `T | undefined` — a caller that only checks
// `"field" in obj` would be fooled by a present-but-null key.
import type { Anomaly, IndeterminateCheck } from "./anomaly.js";

/** The age of a topic's oldest backlog message. Pulsar's
 *  `oldestBacklogMessageAgeSeconds` conflates three cases a bare
 *  `number | null` cannot distinguish: a real, known age; the documented
 *  `-1` sentinel ("no backlog has ever existed" — a determinate, healthy
 *  fact); and genuine absence (the field was withheld, or carried an
 *  undocumented negative value). Collapsing `noBacklog` and `unknown` into
 *  one falsy value would make every quiescent topic — which commonly sends
 *  `-1` — read as "could not tell" on the anomaly panel, indistinguishable
 *  from a topic that actually withheld the field. Mirrors `BacklogAge` in
 *  `src-tauri/src/broker/stats.rs` exactly; the wire shape (an
 *  internally-tagged `{"state": ...}` object) is pinned there by
 *  `backlog_age_serialises_to_the_pinned_wire_shape` in `stats_tests.rs`,
 *  the same way `BrokerSource` is pinned in `envelope.rs`. */
export type BacklogAge =
  | { state: "seconds"; seconds: number }
  | { state: "noBacklog" }
  | { state: "unknown" };

/** A consumer's `lastAckedTimestamp`/`lastConsumedTimestamp`. Mirrors
 *  `BacklogAge` exactly, for the identical reason: Pulsar's wire value
 *  actually distinguishes three cases a bare `number | null` cannot — a real
 *  epoch-millisecond timestamp, Pulsar's own documented `0` sentinel ("this
 *  consumer has never acked/consumed" — a determinate fact, not a missing
 *  value), and genuine absence (the field was withheld).
 *
 *  Fix round 1 (task 11): an earlier version of this field was `number |
 *  null` with `0` normalized to `null` at the Rust parse boundary, which
 *  collapsed "definitely never acked" and "we don't know" into the same
 *  `null` — repeating, one field later, the exact mistake `BacklogAge` was
 *  built to fix for `oldestBacklogMessageAgeSeconds`. Paired with
 *  `blockedOnUnackedMsgs`, "attached but has never acked" is exactly the
 *  signal an operator wants from this pairing, and it was unreportable under
 *  the old shape. Mirrors `ConsumerTimestamp` in
 *  `src-tauri/src/broker/stats.rs` field-for-field; the wire shape is pinned
 *  by `consumer_timestamp_serialises_to_the_pinned_wire_shape` in
 *  `stats_tests.rs`. */
export type ConsumerTimestamp =
  | { state: "millis"; millis: number }
  | { state: "never" }
  | { state: "unknown" };

/** One entry in a subscription's `consumers` array. Every field but
 *  `blockedOnUnackedMsgs`, `lastAckedTimestamp` and `lastConsumedTimestamp`
 *  is `Option` on the Rust side because an absent identity/diagnostic field
 *  is a plausible real gap, not a sentinel; `blockedOnUnackedMsgs` is
 *  `boolean | null` specifically because it is the single most diagnostic
 *  consumer field (the broker itself stopped delivering) and must never be
 *  inferred from a default. */
export interface ConsumerStats {
  consumerName: string | null;
  address: string | null;
  clientVersion: string | null;
  availablePermits: number | null;
  unackedMessages: number | null;
  lastAckedTimestamp: ConsumerTimestamp;
  lastConsumedTimestamp: ConsumerTimestamp;
  msgRateOut: number | null;
  blockedOnUnackedMsgs: boolean | null;
}

/** One entry in a topic's `subscriptions` map.
 *
 *  `consumers: null` means Pulsar omitted the `consumers` key entirely —
 *  we do not know who, if anyone, is attached. `consumers: []` is a
 *  different, determinate fact: Pulsar sent the key with zero entries,
 *  i.e. "confirmed nobody attached". Collapsing the two (as a bare
 *  defaulted array would) lets `backlogWithNoConsumer` fire from data that
 *  was never actually observed — see `src-tauri/src/broker/anomaly.rs`'s
 *  module doc, "fix round 2". */
export interface SubscriptionStats {
  name: string;
  msgBacklog: number | null;
  unackedMessages: number | null;
  msgRateOut: number | null;
  subType: string | null;
  consumers: ConsumerStats[] | null;
}

/** The parsed subset of a Pulsar topic's `stats` payload. `msgRateOut`
 *  proves delivery to a consumer, never business completion — nothing
 *  downstream may present it as "processed". */
export interface TopicStats {
  msgRateIn: number | null;
  msgRateOut: number | null;
  msgThroughputIn: number | null;
  msgThroughputOut: number | null;
  storageSize: number | null;
  backlogSize: number | null;
  msgInCounter: number | null;
  oldestBacklogMessageAge: BacklogAge;
  subscriptions: SubscriptionStats[];
}

/** A parsed Pulsar `"ledgerId:entryId"` position. `entryId: -1` is kept
 *  verbatim (not normalized to `null`) — on the live `fpms_topup` topic a
 *  cursor at `251:-1` means "this subscription has acknowledged nothing in
 *  ledger 251", a real, actionable fact, not an absence of data. */
export interface Position {
  ledgerId: number;
  entryId: number;
}

/** One entry in the `cursors` map of an `internalStats` payload — where a
 *  subscription's cursor actually sits in the ledger, as opposed to
 *  `stats`'s throughput and backlog counts. This is what separates
 *  "consuming slowly" from "not consuming at all". */
export interface CursorPosition {
  subscription: string;
  markDeletePosition: Position;
  readPosition: Position;
  messagesConsumedCounter: number | null;
}

/** The parsed subset of a Pulsar topic's `internalStats` payload. */
export interface InternalStats {
  entriesAddedCounter: number | null;
  numberOfEntries: number | null;
  lastConfirmedEntry: Position | null;
  cursors: CursorPosition[];
}

/** What `broker_get_topic_detail` returns: one topic's `stats` and
 *  `internalStats`, plus every anomaly and indeterminate check
 *  `src-tauri/src/broker/anomaly.rs` could derive from them.
 *
 *  There is no separate "subscriptions" or "consumers" command —
 *  `broker_list_subscriptions` was sketched in the design doc and
 *  deliberately not built, because `stats.subscriptions` already carries
 *  the full subscription list with its consumers; a separate command would
 *  issue a second, identical HTTP request for a subset of this same data. */
export interface TopicDetail {
  topic: string;
  stats: TopicStats;
  internal: InternalStats;
  anomalies: Anomaly[];
  indeterminate: IndeterminateCheck[];
}
