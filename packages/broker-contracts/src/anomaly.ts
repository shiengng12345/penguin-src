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
 *  absent (Pulsar sent no value, or — for `backlogOlderThanThreshold` —
 *  either no value or its own "never happened" sentinel, which the Rust
 *  parser normalizes to the same absence). Never a duplicate of an
 *  `Anomaly`: reporting one of these is saying "we could not tell", not
 *  "something is wrong". An empty `anomalies` array is only really "clean"
 *  once a caller has also checked this list is empty. */
export interface IndeterminateCheck {
  kind: AnomalyKind;
  topic: string;
  subscription: string | null;
  reason: string;
}

/** What the Overview screen renders. `truncated` plus the two counts are
 *  what stop "no anomalies" being misread as "the namespace is clean" when
 *  only the first `topicsSampled` of `topicsTotal` topics were actually
 *  fetched and checked. */
export interface OverviewReport {
  tenant: string;
  namespace: string;
  topicsSampled: number;
  topicsTotal: number;
  truncated: boolean;
  anomalies: Anomaly[];
}
