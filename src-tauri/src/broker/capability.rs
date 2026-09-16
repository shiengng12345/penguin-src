//! Capability discovery — measures what a broker actually allows.
//!
//! Most fields here are observed per-connection, never configured — in
//! particular `can_write` is what the server permits; `read_only` (on the
//! connection) is what the user permits, and collapsing the two removes the
//! only real write guard we have. Five fields are the exception: `can_peek`,
//! `peek_requires_subscription`, `peek_on_partitioned_allowed`,
//! `web_socket_enabled`, and `batch_frame_seen` are currently constants,
//! measured once against local Pulsar 4.2.4 and baked in rather than probed
//! per connection (see the note at each assignment below, and the mirrored
//! doc comment on `CapabilitySnapshot` in
//! `packages/broker-contracts/src/capability.ts`). That's fine for now —
//! nothing renders them yet — but Phase B must probe them per-connection
//! before treating them as measurements; don't read the struct's presence
//! as proof they already are.
//!
//! ## Write capability: inferred, never probed (Stage 0 Task 2)
//!
//! Earlier revisions of this module (Task 14's `probe_write`) learned
//! `can_write` by PUTting a `broker-probe-write-<pid>-<ts>` topic into
//! existence and DELETEing it back out — a real write against the broker,
//! unconditionally, including on a `read_only` connection. Against local
//! Pulsar (unauthenticated, accepts every write — spec V-E8) that "worked"
//! and nothing ever flagged it; against a super-admin-scoped credential
//! pointed at someone's QAT cluster, it would genuinely create and delete a
//! topic there. The product spec forbids this three separate ways: B-07 (no
//! topic create/delete), §11.9 (auto-creation strictly forbidden), and
//! §14.3 (`connections.testObserve` must not create a Producer or Consumer,
//! let alone a topic).
//!
//! `probe_write` and its PUT/DELETE calls are gone — there are no write
//! verbs left in this file, under any `read_only` setting. Write capability
//! is instead inferred from the read-only admin call `discover` already
//! makes (`list_clusters`):
//!
//! - It came back `401`/`403` → the credential cannot even read, so it
//!   certainly cannot write. `can_write: false`, `can_write_probed: true` —
//!   a refusal IS a measurement.
//! - Anything else (the read succeeded, or failed for some unrelated
//!   reason) is not evidence of write capability either way — a credential
//!   that can read is not thereby proven able to write. `can_write: false`,
//!   `can_write_probed: false`, plus a warning saying so in words. The UI
//!   must read this as "not measured", never as "cannot write".
//!
//! `WriteGuard`/`WritePermit` (`security.rs`) are kept even though this
//! removes their only call site — see the note at the top of `security.rs`
//! for why that is deliberate rather than silent dead code.
//!
//! Divergence from the brief's binary-reachability check: the brief probed
//! `:6650` with `binary::read_without_ack` against a scratch topic name.
//! Pulsar standalone defaults to `allowAutoTopicCreation=true`, so opening a
//! `Reader` on a topic that doesn't exist yet silently creates it — a broker
//! write, with no way to delete it back out (`Reader` has no admin handle).
//! That has the same defect as `probe_write` (a "read" that mutates the
//! broker even when `read_only` is set) plus a permanent scratch-topic leak.
//! Instead this measures reachability with a bare `Pulsar::builder(...).build()`
//! — the client's own connection handshake, which touches no topic at all —
//! giving the same V-C3 signal with zero side effects.

use crate::broker::envelope::{map_reqwest_error, BrokerError, BrokerErrorCode, BrokerSource};
use crate::broker::ports::BrokerAdmin;
use crate::broker::security::EndpointGuard;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One probed endpoint. Mirrors `EndpointProbe` in @penguin/broker-contracts —
/// the connection detail drawer renders these rows.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointProbe {
    pub path: String,
    pub method: String,
    pub status: Option<u16>,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySnapshot {
    pub probed_at: i64,
    pub broker_version: Option<String>,
    pub clusters: Vec<String>,
    /// Keyed by logical operation name ("broker_version", "list_clusters", …).
    pub endpoints: HashMap<String, EndpointProbe>,
    pub can_peek: bool,
    pub peek_requires_subscription: bool,
    pub peek_on_partitioned_allowed: bool,
    pub batch_frame_seen: bool,
    pub binary_protocol_reachable: bool,
    pub web_socket_enabled: bool,
    pub can_produce: bool,
    pub can_write: bool,
    /// True only when a read-only admin call came back `401`/`403`, which
    /// conclusively proves the credential cannot write either. False in
    /// every other case, including a successful read — a successful read is
    /// not evidence of write access, so it must not be reported as measured.
    /// This stage never attempts an actual write to find out either way.
    /// Mirrored in `packages/broker-contracts/src/capability.ts`.
    pub can_write_probed: bool,
    pub has_metrics: bool,
    pub warnings: Vec<String>,
    pub source: BrokerSource,
}

/// Infers `can_write`/`can_write_probed` from the read-only admin call
/// `discover` already made (`list_clusters`), instead of attempting an
/// actual write. Pure and synchronous on purpose — unit-testable without a
/// live broker. See the module doc for why this replaced Task 14's
/// `probe_write`.
fn infer_write_capability(clusters_result: &Result<Vec<String>, BrokerError>) -> (bool, bool, Option<String>) {
    match clusters_result {
        Err(e) if matches!(e.code, BrokerErrorCode::AuthenticationFailed | BrokerErrorCode::Forbidden) => {
            // A read refusal IS a measurement: a credential that cannot even
            // read certainly cannot write.
            (false, true, None)
        }
        _ => (
            false,
            false,
            Some(
                "can_write was not probed: this stage never attempts a write. A successful \
                 read does not imply write access, so this is \"not measured\", not \"measured \
                 as unwritable\"."
                    .to_string(),
            ),
        ),
    }
}

pub async fn discover(
    admin_url: &str,
    broker_url: &str,
    timeout_ms: u64,
    tls_verify: bool,
    token: Option<String>,
    // Retained for signature stability and because it remains a meaningful
    // property of the connection (Stage C's send path still reads it via
    // `WriteGuard`). No longer read here: `discover` performs no write under
    // any value of this flag, so there is nothing left for it to gate. See
    // the module doc.
    _read_only: bool,
) -> Result<CapabilitySnapshot, BrokerError> {
    let admin = crate::broker::adapters::pulsar::admin_rest::PulsarAdminRest::new(
        admin_url.to_string(),
        timeout_ms,
        tls_verify,
        token.clone(),
    )?;

    let mut warnings = Vec::new();
    let mut endpoints: HashMap<String, EndpointProbe> = HashMap::new();

    // A failure here is terminal: without a version we know nothing about
    // the broker, and every later probe would be measuring nothing.
    let version_started = std::time::Instant::now();
    let broker_version = admin.broker_version().await?;
    endpoints.insert(
        "broker_version".to_string(),
        EndpointProbe {
            path: "/admin/v2/brokers/version".to_string(),
            method: "GET".to_string(),
            status: Some(200),
            ok: true,
            latency_ms: Some(version_started.elapsed().as_millis() as u64),
            reason: None,
        },
    );

    let clusters_started = std::time::Instant::now();
    let clusters_result = admin.list_clusters().await;
    let clusters_latency = clusters_started.elapsed().as_millis() as u64;
    let clusters = clusters_result.clone().unwrap_or_default();
    endpoints.insert(
        "list_clusters".to_string(),
        EndpointProbe {
            path: "/admin/v2/clusters".to_string(),
            method: "GET".to_string(),
            status: clusters_result.as_ref().ok().map(|_| 200),
            ok: clusters_result.is_ok(),
            latency_ms: Some(clusters_latency),
            reason: clusters_result.as_ref().err().map(|e| e.message.clone()),
        },
    );
    if let Err(e) = &clusters_result {
        warnings.push(format!("list_clusters failed: {}", e.message));
    }

    // Reachability of the binary protocol decides whether Phases C and E can
    // work at all against this connection. See the module doc for why this
    // is a bare connection handshake and not a topic read.
    let binary_protocol_reachable =
        pulsar::Pulsar::builder(broker_url.to_string(), pulsar::TokioExecutor)
            .build()
            .await
            .is_ok();
    if !binary_protocol_reachable {
        warnings.push(format!(
            "binary protocol unreachable at {broker_url}; timeline and replay will be unavailable"
        ));
    }

    // No write is ever attempted here (Stage 0 Task 2 — see module doc).
    // `can_write` is inferred from the read-only `list_clusters` call above.
    let (can_write, can_write_probed, write_warning) = infer_write_capability(&clusters_result);
    if let Some(w) = write_warning {
        warnings.push(w);
    }

    let has_metrics = match build_client(timeout_ms, tls_verify) {
        Ok(client) => {
            let metrics_url = format!("{}/metrics/", admin_url.trim_end_matches('/'));
            match EndpointGuard::new(admin_url).and_then(|g| g.check(&metrics_url)) {
                Ok(()) => client.get(&metrics_url).send().await.map(|r| r.status().is_success()).unwrap_or(false),
                Err(_) => false,
            }
        }
        Err(_) => false,
    };

    Ok(CapabilitySnapshot {
        probed_at: now_ms(),
        broker_version: Some(broker_version),
        clusters,
        endpoints,
        can_peek: true, // V-B1 — constant: measured once against local Pulsar 4.2.4, not probed per connection
        peek_requires_subscription: true,  // V-B3 — constant for Pulsar's Admin REST; measured once against 4.2.4, not probed per connection
        peek_on_partitioned_allowed: false, // V-B4 — 405 on 4.2.4; constant, measured once, not probed per connection
        batch_frame_seen: false,            // V-B5 — constant until Phase B actually probes for a batch frame; not yet measured per connection
        binary_protocol_reachable,
        web_socket_enabled: false, // V-C1 — informational; not a code path; constant, measured once against 4.2.4, not probed per connection
        can_produce: binary_protocol_reachable, // produce only ever goes over binary (V-E5)
        can_write,
        can_write_probed,
        has_metrics,
        warnings,
        source: BrokerSource::AdminRest,
    })
}

fn build_client(timeout_ms: u64, tls_verify: bool) -> Result<reqwest::Client, BrokerError> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(!tls_verify)
        // Same reasoning as `PulsarAdminRest::new`: never follow a redirect
        // the endpoint guard never saw.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| map_reqwest_error(&e))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(code: BrokerErrorCode) -> BrokerError {
        BrokerError { code, message: "boom".to_string(), retryable: false }
    }

    #[test]
    fn a_401_on_the_read_probe_is_a_conclusive_negative_write_measurement() {
        let (can_write, probed, warning) = infer_write_capability(&Err(err(BrokerErrorCode::AuthenticationFailed)));
        assert!(!can_write, "a credential that cannot even read certainly cannot write");
        assert!(probed, "a definitive 401 IS a measurement, just a negative one");
        assert!(warning.is_none(), "a conclusive negative needs no further explanation");
    }

    #[test]
    fn a_403_on_the_read_probe_is_a_conclusive_negative_write_measurement() {
        let (can_write, probed, warning) = infer_write_capability(&Err(err(BrokerErrorCode::Forbidden)));
        assert!(!can_write);
        assert!(probed, "a definitive 403 IS a measurement, just a negative one");
        assert!(warning.is_none());
    }

    #[test]
    fn a_successful_read_is_not_evidence_of_write_capability() {
        let (can_write, probed, warning) = infer_write_capability(&Ok(vec!["standalone".to_string()]));
        assert!(!can_write, "can_write must default to false absent an actual write attempt");
        assert!(!probed, "a successful read must NOT be reported as a write measurement");
        let warning = warning.expect("the UI must be told this is unmeasured, not silently false");
        assert!(warning.to_lowercase().contains("not probed") || warning.to_lowercase().contains("not measured"));
    }

    #[test]
    fn a_read_failure_for_an_unrelated_reason_is_also_not_measured() {
        let (can_write, probed, warning) = infer_write_capability(&Err(err(BrokerErrorCode::Timeout)));
        assert!(!can_write);
        assert!(!probed, "only a 401/403 refusal is conclusive; any other failure is inconclusive");
        // The machine-readable guarantee is `probed == false`, asserted above.
        // This only checks a warning accompanies it, deliberately WITHOUT
        // matching on the wording.
        //
        // A substring assertion was tried here and rejected: the warning ends
        // with `so this is "not measured", not "measured as unwritable"`, so
        // a check for `contains("not measured")` passes even when the opening
        // claim is mutated to the opposite meaning. That is the same defect
        // this module exists to prevent — a test that looks like a guard and
        // matches something incidental. The flag is the contract; the prose
        // is for a human, and pinning prose here would give false confidence.
        //
        // The underlying failure reason reaches the operator separately:
        // `discover` pushes `list_clusters failed: {message}` as its own
        // warning entry before calling this function.
        assert!(warning.is_some(), "an inconclusive probe must warn");
    }

    // The B-07/§11.9/§14.3 compile-level guard ("no HTTP PUT or DELETE call
    // left in this file, under a reqwest-style builder") is intentionally
    // NOT a Rust test embedded here: writing the checked-for call syntax as
    // a string literal would make this file match its own grep, defeating
    // the point. It is instead a plain shell check, run as part of
    // verification and pasted into the task report — see the report for the
    // exact command and its output, which must be zero.
}
