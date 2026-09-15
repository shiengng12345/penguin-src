//! Transport-agnostic ports. Only the Pulsar adapter implements them today;
//! the trait exists so a second broker kind does not require reshaping callers.
//! Phase 0 implements BrokerAdmin only — the other two are signatures for
//! Phases B and C and are deliberately not wired up yet.

use crate::broker::envelope::BrokerError;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicRef {
    pub tenant: String,
    pub namespace: String,
    pub topic: String,
    pub persistent: bool,
}

impl TopicRef {
    /// Path segment used by Admin REST: `persistent/public/default/orders`.
    pub fn rest_path(&self) -> String {
        let domain = if self.persistent { "persistent" } else { "non-persistent" };
        format!("{domain}/{}/{}/{}", self.tenant, self.namespace, self.topic)
    }
}

#[async_trait::async_trait]
pub trait BrokerAdmin: Send + Sync {
    async fn broker_version(&self) -> Result<String, BrokerError>;
    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError>;
    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError>;
    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<String>, BrokerError>;
    /// Returns the raw expanded list. Folding into logical topics is the caller's job.
    async fn list_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError>;
    async fn list_partitioned_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError>;
    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError>;
    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<String>, BrokerError>;
}
