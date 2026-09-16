//! Pulsar binary protocol transport (port 6650).
//!
//! Exists because Admin REST cannot produce (405). `produce_one` is the only
//! function this module exposes to the shipped app.
//!
//! WebSocket is deliberately NOT used: `broker.conf` ships with
//! `webSocketServiceEnabled=false`, so it works on standalone and fails on a
//! real broker deployment.
//!
//! ## `read_without_ack` was moved out of the shipped library (Stage 0, task 4)
//!
//! This module used to also carry a `read_without_ack` Reader-based read
//! path (Phase 0, task 5's spike: a `Reader` has no `ack` method at all, so
//! it is structurally incapable of consuming). Spec §1.3 warns that a Reader
//! is itself built on a Consumer with a non-durable subscription, and
//! B-01/B-03 require that the *shipped app* never construct a Consumer,
//! Reader or TableView — "no command calls it" was judged too weak a
//! guarantee, because the function still compiled into the library. It now
//! lives only in `src-tauri/tests/broker_binary.rs`, alongside its own
//! `RawMessage`/reader plumbing, where it is reachable solely by the test
//! binary that exercises it, never by the app's lib target.
//!
//! For a Consumer/Reader/TableView to become constructible from the shipped
//! app again, someone would have to add a new function *here* (or anywhere
//! under `src/`) that builds one — an intentional, reviewable source change,
//! not something that falls out of adding a Tauri command or an accidental
//! re-export. `cargo build --lib` / `cargo doc` over this crate contain no
//! such symbol; see the task 4 report for how that was checked.
//!
//! Connection cleanup (checked against the 6.9.0 source, not the docs site):
//! `Producer<Exe>` exposes an explicit, awaitable `close()` that sends
//! `close_producer` to the broker, and `produce_one` calls it.

use pulsar::{Pulsar, TokioExecutor};

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

    // The broker's send receipt may omit a message id (e.g. on a degraded
    // ack). Do not fabricate one — the replay phase writes this id into an
    // audit trail, so an inferred placeholder would present as a real
    // confirmation when the broker gave none.
    let id = match receipt.message_id {
        Some(m) => format!("{}:{}", m.ledger_id, m.entry_id),
        None => {
            return Err(BinaryError::Produce(
                "broker acknowledged send but returned no message id".to_string(),
            ))
        }
    };

    // Explicit, awaited close: `Producer::close()` sends `close_producer` to
    // the broker synchronously, unlike relying on `Drop` (which only spawns
    // a fire-and-forget cleanup task — see the module-level Drop note).
    // A close failure doesn't invalidate the id we already have, so it's
    // logged via the error return rather than silently discarded — but the
    // produce itself already succeeded, so we still return the id.
    if let Err(e) = producer.close().await {
        eprintln!("broker/pulsar/binary: producer close failed (non-fatal): {e}");
    }

    Ok(id)
}
