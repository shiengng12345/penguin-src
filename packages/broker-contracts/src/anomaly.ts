// packages/broker-contracts/src/anomaly.ts
//
// Mirrors src-tauri/src/broker/anomaly.rs field-for-field, camelCase on the
// wire (Rust's `#[serde(rename_all = "camelCase")]` on both the enum and the
// structs below) — the two must agree, or the Overview panel and the Rust
// derivation disagree about what "wrong" means.
//
// The Overview surface answers "what is wrong", never "how many topics
// exist" (ruling D-A3). `Anomaly` is the unit that answers that question;
// `IndeterminateCheck` is the companion signal for "we could not tell" —
// never mixed into `Anomaly` itself, because it is not a claim that
// something is wrong, only that a check had no evidence to run on. See the
// Rust module doc for the full reasoning.

/** The closed set of problems the broker module can report about a topic.
 *  `capabilityProbeFailed` is never produced by `derive_anomalies` (its
 *  evidence lives in a `CapabilitySnapshot`, not `TopicStats`) — only the
 *  Rust `broker_get_overview` command, which holds the connection, emits
 *  it. It is part of this union because callers switch on one closed set
 *  of anomaly kinds regardless of which check produced them. */
export type AnomalyKind =
  | "backlogWithNoConsumer"
  | "consumerBlockedOnUnacked"
  | "backlogOlderThanThreshold"
  | "capabilityProbeFailed";

/** One concrete, evidenced problem found on a topic. `subscription` is
 *  `null` for a topic-scoped check (e.g. `backlogOlderThanThreshold`, which
 *  Pulsar reports per topic, not per subscription).
 *
 *  `observedValue` is always the actual figure observed — a count, an age
 *  in seconds, a boolean flag as reported — never a restatement of the rule
 *  that fired. Neither this field nor `detail` may imply a message was
 *  successfully processed: `msgRateOut` (the field these checks partly draw
 *  on) proves delivery to a consumer, never business completion. */
export interface Anomaly {
  kind: AnomalyKind;
  topic: string;
  subscription: string | null;
  detail: string;
  observedValue: string;
}

/** One check that could not be evaluated because its required input was
 *  absent — Pulsar sent no value at all (or, for `backlogOlderThanThreshold`,
 *  an undocumented negative value the Rust side cannot interpret). Note
 *  what this is *not*: Pulsar's own `-1` "no backlog has ever existed"
 *  sentinel is a determinate, healthy fact (`BacklogAge::NoBacklog` on the
 *  Rust side, fix round 1), not an unknown, and never produces one of
 *  these. Never a duplicate of an `Anomaly` either: reporting one of these
 *  is saying "we could not tell", not "something is wrong". An empty
 *  `anomalies` array is only really "clean" once a caller has also checked
 *  `indeterminate` is empty. */
export interface IndeterminateCheck {
  kind: AnomalyKind;
  topic: string;
  subscription: string | null;
  reason: string;
}

/** What the Overview screen renders. `truncated` plus the two counts are
 *  what stop "no anomalies" being misread as "the namespace is clean" when
 *  only the first `topicsSampled` of `topicsTotal` topics were actually
 *  fetched and checked. `indeterminate` is the same kind of guard for
 *  individual checks within the topics that were sampled: it is never
 *  optional, because an empty array is itself a real, meaningful answer
 *  ("every check ran") and an optional field would let a caller forget to
 *  ask the question at all.
 *
 *  `topicsUnavailable` (Phase A final review, finding 1) is the same kind
 *  of guard for a third way a sweep can be incomplete: one sampled topic's
 *  stats fetch can fail without failing the whole overview (see
 *  `src-tauri/src/broker/commands/topic_detail.rs`'s `sample_overview`),
 *  and that failure previously reached the UI only as free text buried in
 *  `warnings` — something a panel could display but never reason about.
 *  Non-optional for the same reason as `indeterminate`: `0` is a real
 *  answer ("every sampled topic's stats were readable"), and an optional
 *  field would let a caller forget to check. */
export interface OverviewReport {
  tenant: string;
  namespace: string;
  topicsSampled: number;
  topicsTotal: number;
  truncated: boolean;
  anomalies: Anomaly[];
  indeterminate: IndeterminateCheck[];
  topicsUnavailable: number;
}
