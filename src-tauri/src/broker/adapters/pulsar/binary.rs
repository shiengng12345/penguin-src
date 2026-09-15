//! Pulsar binary protocol transport (port 6650).
//!
//! Exists because Admin REST cannot produce (405) and its peek requires an
//! existing subscription and is rejected on partitioned topics. A Reader on
//! this transport reads from a position without a subscription and without
//! acking, which is what a lifecycle observer needs (spec V-C1/V-C3).
//!
//! WebSocket is deliberately NOT used: `broker.conf` ships with
//! `webSocketServiceEnabled=false`, so it works on standalone and fails on a
//! real broker deployment.
//!
//! This file is a spike (Phase 0, task 5): the `pulsar` crate's 6.9 API was
//! confirmed against its real docs, not assumed from memory. Notably `Reader`
//! has no `ack` method at all — structurally it cannot acknowledge, which is
//! exactly the property `read_without_ack` needs.

use futures::StreamExt;
use pulsar::{consumer::InitialPosition, ConsumerOptions, Pulsar, TokioExecutor};

#[derive(Debug, Clone)]
pub struct RawMessage {
    pub message_id: String,
    pub payload: Vec<u8>,
    pub properties: Vec<(String, String)>,
    pub publish_time: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum BinaryError {
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("read failed: {0}")]
    Read(String),
    #[error("produce failed: {0}")]
    Produce(String),
}

async fn client(broker_url: &str) -> Result<Pulsar<TokioExecutor>, BinaryError> {
    Pulsar::builder(broker_url, TokioExecutor)
        .build()
        .await
        .map_err(|e| BinaryError::Connect(e.to_string()))
}

/// Reads up to `max` messages from the earliest position without acking.
///
/// Uses a `Reader`, not a `Consumer`: the `pulsar` crate's `Reader` type has
/// no `ack` method at all, so this transport is structurally incapable of
/// consuming a message off the topic. Each call opens a fresh reader
/// (constructed from `InitialPosition::Earliest`) so repeated reads are
/// independent of each other and of any real subscription's cursor.
pub async fn read_without_ack(
    broker_url: &str,
    topic: &str,
    max: usize,
) -> Result<Vec<RawMessage>, BinaryError> {
    let pulsar = client(broker_url).await?;
    let mut reader = pulsar
        .reader()
        .with_topic(topic)
        .with_options(ConsumerOptions {
            initial_position: InitialPosition::Earliest,
            ..Default::default()
        })
        .into_reader::<Vec<u8>>()
        .await
        .map_err(|e| BinaryError::Read(e.to_string()))?;

    let mut out = Vec::with_capacity(max);
    while out.len() < max {
        match reader.next().await {
            Some(Ok(msg)) => {
                let meta = &msg.payload.metadata;
                out.push(RawMessage {
                    message_id: format!(
                        "{}:{}",
                        msg.message_id().ledger_id,
                        msg.message_id().entry_id
                    ),
                    payload: msg.payload.data.clone(),
                    properties: meta
                        .properties
                        .iter()
                        .map(|kv| (kv.key.clone(), kv.value.clone()))
                        .collect(),
                    publish_time: meta.publish_time as i64,
                });
            }
            Some(Err(e)) => return Err(BinaryError::Read(e.to_string())),
            None => break,
        }
    }
    Ok(out)
}

/// Produces one message. This is the only produce path the module has —
/// Admin REST returns 405 for produce.
pub async fn produce_one(
    broker_url: &str,
    topic: &str,
    payload: Vec<u8>,
    props: Vec<(String, String)>,
) -> Result<String, BinaryError> {
    let pulsar = client(broker_url).await?;
    let mut producer = pulsar
        .producer()
        .with_topic(topic)
        .build()
        .await
        .map_err(|e| BinaryError::Produce(e.to_string()))?;

    let mut builder = producer.create_message().with_content(payload);
    for (k, v) in props {
        builder = builder.with_property(k, v);
    }

    let receipt = builder
        .send_non_blocking()
        .await
        .map_err(|e| BinaryError::Produce(e.to_string()))?
        .await
        .map_err(|e| BinaryError::Produce(e.to_string()))?;

    let id = receipt
        .message_id
        .map(|m| format!("{}:{}", m.ledger_id, m.entry_id))
        .unwrap_or_default();
    Ok(id)
}
