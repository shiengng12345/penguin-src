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

/** A subscription's dispatcher `type`. Pulsar's wire value actually
 *  distinguishes three cases a bare `string | null` cannot: a real, named
 *  dispatcher type (`"Shared"`, `"Exclusive"`, `"Failover"`, `"Key_Shared"`),
 *  Pulsar's own documented `"None"` sentinel ("no consumer has ever claimed
 *  a dispatcher type for this subscription" — a determinate fact, not a
 *  missing value), and genuine absence (the field was withheld).
 *
 *  Phase A final review, finding 2: this is the third field group with
 *  exactly the shape `BacklogAge` and `ConsumerTimestamp` were each built to
 *  fix. An earlier version of this field was `string | null` with Pulsar's
 *  `"None"` normalized to `null` at the Rust parse boundary — merging "the
 *  broker withheld this field" with "the broker answered: nobody has
 *  claimed a type," the identical mistake fixed for `oldestBacklogMessageAge`
 *  and the consumer timestamps. Mirrors `BacklogAge`/`ConsumerTimestamp`
 *  field-for-field, including the wire shape (an internally-tagged
 *  `{"state": ...}` object), pinned by
 *  `subscription_type_serialises_to_the_pinned_wire_shape` in
 *  `stats_tests.rs`. */
export type SubscriptionType =
  | { state: "named"; name: string }
  | { state: "unset" }
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
 *  module doc, "fix round 2".
 *
 *  Fix round 1 (Task 1), item 3: `consumers: []` is **also** what Pulsar
 *  sends when the request itself excluded consumer detail
 *  (`?excludeConsumers=true`) — measured directly, that response is
 *  byte-identical to the confirmed-empty case above. Check
 *  `TopicStats.statsRequestScope.excludeConsumers` before treating an empty
 *  `consumers` array here as "confirmed nobody attached"; `src-tauri/src/
 *  broker/anomaly.rs` already does this for `backlogWithNoConsumer`. */
export interface SubscriptionStats {
  name: string;
  msgBacklog: number | null;
  unackedMessages: number | null;
  msgRateOut: number | null;
  subType: SubscriptionType;
  consumers: ConsumerStats[] | null;
}

/** What `PulsarAdminRest::get_topic_stats` (Rust) actually asked the broker
 *  for when it fetched the `TopicStats` this travels alongside (Task 1,
 *  controller ruling R34).
 *
 *  The product spec's §14.1 sketch asked for a generic `Metric<T>` with a
 *  seven-state `quality` tag on every field. That was rejected: of the
 *  seven states, only `notRequested` genuinely varies field-by-field within
 *  one response (`forbidden` is response-level — a 403 the envelope already
 *  carries; `unsupported` needs a per-broker-version capability matrix that
 *  does not exist until Stage B). And the existing three-state unions
 *  (`BacklogAge`, `ConsumerTimestamp`, `SubscriptionType`) already carry
 *  *more* information than a generic `quality` tag would — collapsing
 *  `{ state: "noBacklog" }` (a determinate, healthy fact) into a bare
 *  `quality: "unknown"` would destroy exactly the distinction those types
 *  exist to preserve. This type adds only the one axis those unions cannot
 *  express on their own: whether the underlying REST call even asked.
 *
 *  Mirrors `StatsRequestScope` in `src-tauri/src/broker/stats.rs`
 *  field-for-field; the wire shape (a plain object, not a `{ state: ... }`
 *  tagged union like `BacklogAge` — there is no sentinel here, only plain
 *  booleans) is pinned there by
 *  `stats_request_scope_serialises_to_the_pinned_wire_shape` in
 *  `stats_tests.rs`.
 *
 *  Which `TopicStats`/`SubscriptionStats` fields each flag governs is
 *  itself a mapping that must be code, not a comment (ruling R38) — see
 *  `SCOPE_FLAG_FOR_FIELD` in `src/components/broker/broker-value.ts`.
 *  Deliberately not a list of strings on this response for a panel to match
 *  against: that is the exact defect the Overview panel was fixed for (a
 *  free-text warning a panel can only display, never reason about).
 *
 *  Fix round 1 corrected two things the original task brief got wrong about
 *  §12.3's literal text:
 *  - item 1: `preciseBacklog` is **not** in the R38 field mapping. Measured
 *    directly against the live broker, `getPreciseBacklog=false` and `=true`
 *    both return `backlogSize` — the flag governs precision, not presence,
 *    so "Not requested" must never be shown for that field; the real number
 *    the broker gave us must render.
 *  - item 2: the spec actually lists five parameters, not three —
 *    `excludePublishers`/`excludeConsumers` were missing from the original
 *    paraphrase. Both are added below, requested `false` (this app needs
 *    full instance detail, not the lightweight view `true` gives).
 *
 *  Fix round 1, item 4: this type records **what the request asked for**,
 *  never a measurement of what the broker actually did — a 200 response
 *  does not prove every parameter was honoured (an unfamiliar broker
 *  version may silently ignore one it does not recognise, per §12.3's own
 *  closing caution). Nothing may present this as broker behaviour. */
export interface StatsRequestScope {
  preciseBacklog: boolean;
  subscriptionBacklogSize: boolean;
  earliestTimeInBacklog: boolean;
  /** `excludePublishers` query parameter. No field on this contract
   *  currently reads Pulsar's `publishers` array — recorded for when one
   *  does. */
  excludePublishers: boolean;
  /** `excludeConsumers` query parameter. `SubscriptionStats.consumers`'s
   *  own doc above explains why an excluded list must not be read as a
   *  confirmed-empty one. */
  excludeConsumers: boolean;
}

/** The parsed subset of a Pulsar topic's `stats` payload. `msgRateOut`
 *  proves delivery to a consumer, never business completion — nothing
 *  downstream may present it as "processed".
 *
 *  Task 3: `storageSize`, `backlogSize`, and `msgInCounter` are `u64`
 *  counters on the Rust side that can legitimately exceed JavaScript's
 *  2^53 - 1 safe-integer ceiling on a long-lived, high-traffic topic — a
 *  bare JS `number` would silently round such a value on `JSON.parse`, with
 *  no error. They are therefore `string | null` here, never `number | null`:
 *  `null` is the same withheld-field sentinel every other optional field on
 *  this contract uses, and a present value is the exact decimal digits Rust
 *  parsed, meant to be rendered (via `formatBigCounter` in
 *  `src/components/broker/broker-value.ts`), never passed through
 *  `Number(...)`/`parseInt`/arithmetic. */
export interface TopicStats {
  msgRateIn: number | null;
  msgRateOut: number | null;
  msgThroughputIn: number | null;
  msgThroughputOut: number | null;
  storageSize: string | null;
  backlogSize: string | null;
  msgInCounter: string | null;
  oldestBacklogMessageAge: BacklogAge;
  subscriptions: SubscriptionStats[];
  /** What this call actually asked the broker for (Task 1, R34) — see
   *  `StatsRequestScope`'s own doc. */
  statsRequestScope: StatsRequestScope;
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
  /** Task 3: `u64` on the Rust side, `string | null` here for the same
   *  precision reason as `TopicStats.msgInCounter` — see that field's doc. */
  messagesConsumedCounter: string | null;
}

/** The parsed subset of a Pulsar topic's `internalStats` payload. */
export interface InternalStats {
  /** Task 3: `u64` on the Rust side, `string | null` here — the realistic
   *  field to actually cross JS's 2^53 - 1 ceiling (a cumulative counter on
   *  a long-lived, high-traffic topic). See `TopicStats.msgInCounter`'s
   *  doc. */
  entriesAddedCounter: string | null;
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
