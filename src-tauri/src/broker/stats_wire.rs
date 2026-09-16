//! The private wire shapes for `broker::stats`, split out solely to keep
//! `stats.rs` under the module size cap (see its module doc for the
//! `Option`-vs-default and sentinel-normalization reasoning these types
//! exist to serve).
//!
//! These mirror Pulsar's JSON field names exactly via
//! `rename_all = "camelCase"` (plus one explicit rename for the `type`
//! keyword clash and one for `blockedConsumerOnUnackedMsgs`, whose name
//! does not follow the camelCase-of-the-field-name pattern) and are never
//! exposed outside `broker::stats`; callers only ever see the public
//! structs in `stats.rs`. Visibility here is `pub(super)`: visible to
//! `broker` and its descendants (which includes `broker::stats`), nothing
//! wider.
//!
//! There is deliberately no `#[serde(deny_unknown_fields)]` anywhere below
//! — an unknown field arriving in a future Pulsar release must never fail
//! the parse.

use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawTopicStats {
    #[serde(default)]
    pub(super) msg_rate_in: Option<f64>,
    #[serde(default)]
    pub(super) msg_rate_out: Option<f64>,
    #[serde(default)]
    pub(super) msg_throughput_in: Option<f64>,
    #[serde(default)]
    pub(super) msg_throughput_out: Option<f64>,
    #[serde(default)]
    pub(super) storage_size: Option<u64>,
    #[serde(default)]
    pub(super) backlog_size: Option<u64>,
    #[serde(default)]
    pub(super) msg_in_counter: Option<u64>,
    #[serde(default)]
    pub(super) oldest_backlog_message_age_seconds: Option<i64>,
    #[serde(default)]
    pub(super) subscriptions: BTreeMap<String, RawSubscriptionStats>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawSubscriptionStats {
    #[serde(default)]
    pub(super) msg_backlog: Option<u64>,
    #[serde(default)]
    pub(super) unacked_messages: Option<u64>,
    #[serde(default)]
    pub(super) msg_rate_out: Option<f64>,
    #[serde(default, rename = "type")]
    pub(super) sub_type: Option<String>,
    #[serde(default)]
    pub(super) consumers: Vec<RawConsumerStats>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RawConsumerStats {
    #[serde(default)]
    pub(super) consumer_name: Option<String>,
    #[serde(default)]
    pub(super) address: Option<String>,
    #[serde(default)]
    pub(super) client_version: Option<String>,
    #[serde(default)]
    pub(super) available_permits: Option<i64>,
    #[serde(default)]
    pub(super) unacked_messages: Option<u64>,
    #[serde(default)]
    pub(super) last_acked_timestamp: Option<i64>,
    #[serde(default)]
    pub(super) last_consumed_timestamp: Option<i64>,
    #[serde(default)]
    pub(super) msg_rate_out: Option<f64>,
    #[serde(default, rename = "blockedConsumerOnUnackedMsgs")]
    pub(super) blocked_on_unacked_msgs: Option<bool>,
}
