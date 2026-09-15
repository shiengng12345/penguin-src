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
//! CONTROLLER RULING on the Task 14 brief: the brief's `probe_write` created
//! a scratch topic and deleted it to learn `can_write`, unconditionally —
//! including on a `read_only` connection. That is itself a write, and doing
//! it on a read-only connection defeats the exact guarantee `read_only`
//! exists to provide (this project measured that local Pulsar accepts every
//! write from anyone; our own code is the only thing enforcing the flag).
//! Fixed here: when `read_only` is true, the probe never runs at all —
//! `can_write` is reported `false` with `can_write_probed: false` and a
//! warning, so the UI can tell "measured as not writable" apart from
//! "never measured". The probe itself, when it does run, is gated behind
//! `WriteGuard::authorize` like any other write path in this module.
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

use crate::broker::envelope::{is_success, map_reqwest_error, BrokerError};
use crate::broker::ports::BrokerAdmin;
use crate::broker::security::{EndpointGuard, WriteGuard, WritePermit};
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
    /// True only when the write probe actually ran and returned a
    /// conclusive answer. False both when it was skipped (`read_only`) and
    /// when it could not be completed (e.g. the broker was unreachable for
    /// that one call) — either way `can_write` must not be trusted as a
    /// measured fact. Mirrored in `packages/broker-contracts/src/capability.ts`.
    pub can_write_probed: bool,
    pub has_metrics: bool,
    pub warnings: Vec<String>,
    pub source: String,
}

/// Outcome of attempting (or deliberately not attempting) the write probe.
/// Kept separate from `discover`'s async plumbing so the read-only/warning
/// logic in [`summarize_write_probe`] is a pure function and unit-testable
/// without a live broker.
#[derive(Debug, Clone, PartialEq)]
enum WriteProbeOutcome {
    /// Never attempted: the connection is read-only.
    SkippedReadOnly,
    /// The probe ran and got a conclusive HTTP answer for the create step.
    Measured { can_write: bool, cleanup_failed: bool, create_status: u16, latency_ms: u64 },
    /// The probe could not be run to a conclusion at all (e.g. the client
    /// could not even be built, or the request never got a response).
    Inconclusive { reason: String },
}

/// Turns a [`WriteProbeOutcome`] into the three snapshot fields it affects.
/// Pure and synchronous on purpose — see the module doc for why cleanup on
/// every path matters, including a successful create whose delete fails.
fn summarize_write_probe(outcome: &WriteProbeOutcome) -> (bool, bool, Option<String>) {
    match outcome {
        WriteProbeOutcome::SkippedReadOnly => (
            false,
            false,
            Some(
                "can_write was not probed: the connection is read-only, so no write was \
                 attempted. This is \"not measured\", not \"measured as unwritable\"."
                    .to_string(),
            ),
        ),
        WriteProbeOutcome::Measured { can_write, cleanup_failed, .. } => {
            let warning = cleanup_failed.then(|| {
                format!(
                    "the write probe {} a scratch topic but failed to delete it afterward; \
                     it may still exist on the broker (prefix `broker-probe-write-`) and need \
                     manual cleanup",
                    if *can_write { "created" } else { "attempted to create" }
                )
            });
            (*can_write, true, warning)
        }
        WriteProbeOutcome::Inconclusive { reason } => {
            (false, false, Some(format!("can_write was not probed: {reason}")))
        }
    }
}

pub async fn discover(
    admin_url: &str,
    broker_url: &str,
    timeout_ms: u64,
    tls_verify: bool,
    token: Option<String>,
    read_only: bool,
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

    let write_guard = WriteGuard::new(read_only);
    let write_outcome = match write_guard.authorize("capability-probe-write") {
        Ok(permit) => probe_write(admin_url, timeout_ms, tls_verify, token.as_deref(), &permit).await,
        Err(_) => WriteProbeOutcome::SkippedReadOnly,
    };
    if let WriteProbeOutcome::Measured { create_status, latency_ms, .. } = &write_outcome {
        endpoints.insert(
            "write_probe".to_string(),
            EndpointProbe {
                path: "/admin/v2/persistent/public/default/broker-probe-write-*".to_string(),
                method: "PUT".to_string(),
                status: Some(*create_status),
                ok: is_success(*create_status) || *create_status == 409,
                latency_ms: Some(*latency_ms),
                reason: None,
            },
        );
    }
    let (can_write, can_write_probed, write_warning) = summarize_write_probe(&write_outcome);
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
        source: "pulsar-admin-rest".to_string(),
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

/// Creates a `broker-probe-write-`-prefixed scratch topic and immediately
/// deletes it, to learn whether the connection's credentials can write.
/// Called only after `WriteGuard::authorize` has issued a [`WritePermit`] —
/// `_permit`'s only job is to make that fact checkable by the compiler, not
/// to carry data.
///
/// Cleanup runs on every path that could have created something: a plain
/// success (204), a "topic already existed" response (409, from some earlier
/// interrupted run), and any other non-auth status the broker might return
/// for a half-applied create. It is skipped only for 401/403, where nothing
/// could have been created in the first place. If the delete itself fails —
/// including after a successful create — the scratch topic may survive, and
/// that fact is surfaced as `cleanup_failed` rather than swallowed.
async fn probe_write(
    admin_url: &str,
    timeout_ms: u64,
    tls_verify: bool,
    token: Option<&str>,
    _permit: &WritePermit,
) -> WriteProbeOutcome {
    let guard = match EndpointGuard::new(admin_url) {
        Ok(g) => g,
        Err(e) => return WriteProbeOutcome::Inconclusive { reason: e.message },
    };
    let client = match build_client(timeout_ms, tls_verify) {
        Ok(c) => c,
        Err(e) => return WriteProbeOutcome::Inconclusive { reason: e.message },
    };

    let base = admin_url.trim_end_matches('/');
    let topic_name = format!("broker-probe-write-{}-{}", std::process::id(), now_ms());
    let topic_url = format!("{base}/admin/v2/persistent/public/default/{topic_name}");
    if let Err(e) = guard.check(&topic_url) {
        return WriteProbeOutcome::Inconclusive { reason: e.message };
    }

    let started = std::time::Instant::now();
    let mut create_req = client.put(&topic_url);
    if let Some(t) = token {
        create_req = create_req.bearer_auth(t);
    }
    let create_status = match create_req.send().await {
        Ok(res) => res.status().as_u16(),
        Err(e) => return WriteProbeOutcome::Inconclusive { reason: e.to_string() },
    };
    let latency_ms = started.elapsed().as_millis() as u64;

    // 204 = created; 409 = a same-named scratch topic from an earlier,
    // interrupted run already exists — either way the credential could
    // write. 401/403 mean nothing was created at all.
    let can_write = matches!(create_status, 204 | 409);
    let should_attempt_cleanup = !matches!(create_status, 401 | 403);

    let mut cleanup_failed = false;
    if should_attempt_cleanup {
        let mut delete_req = client.delete(format!("{topic_url}?force=true"));
        if let Some(t) = token {
            delete_req = delete_req.bearer_auth(t);
        }
        cleanup_failed = match delete_req.send().await {
            // 204 deleted; 404 already gone (fine either way).
            Ok(res) => !matches!(res.status().as_u16(), 204 | 404),
            Err(_) => true,
        };
    }

    WriteProbeOutcome::Measured { can_write, cleanup_failed, create_status, latency_ms }
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

    #[test]
    fn read_only_skips_the_probe_and_says_so() {
        let (can_write, probed, warning) = summarize_write_probe(&WriteProbeOutcome::SkippedReadOnly);
        assert!(!can_write, "an unprobed connection must never claim can_write: true");
        assert!(!probed, "read-only discovery must record that the probe did not run");
        let warning = warning.expect("a skipped probe must explain itself to the UI");
        assert!(warning.to_lowercase().contains("read-only"));
        assert!(warning.to_lowercase().contains("not measured") || warning.to_lowercase().contains("not probed"));
    }

    #[test]
    fn a_clean_measured_write_carries_no_cleanup_warning() {
        let outcome = WriteProbeOutcome::Measured {
            can_write: true,
            cleanup_failed: false,
            create_status: 204,
            latency_ms: 5,
        };
        let (can_write, probed, warning) = summarize_write_probe(&outcome);
        assert!(can_write);
        assert!(probed, "an actually-run probe must be marked as probed regardless of the answer");
        assert!(warning.is_none());
    }

    #[test]
    fn a_failed_cleanup_after_a_successful_create_is_surfaced_not_swallowed() {
        let outcome = WriteProbeOutcome::Measured {
            can_write: true,
            cleanup_failed: true,
            create_status: 204,
            latency_ms: 5,
        };
        let (can_write, probed, warning) = summarize_write_probe(&outcome);
        assert!(can_write, "the measurement itself is still valid even if cleanup afterward failed");
        assert!(probed);
        let warning = warning.expect("a failed cleanup must produce a warning, never silence");
        assert!(warning.contains("broker-probe-write-"), "must name the prefix an operator can search for");
    }

    #[test]
    fn a_write_that_was_refused_outright_needs_no_cleanup_warning() {
        let outcome = WriteProbeOutcome::Measured {
            can_write: false,
            cleanup_failed: false,
            create_status: 403,
            latency_ms: 5,
        };
        let (can_write, probed, warning) = summarize_write_probe(&outcome);
        assert!(!can_write);
        assert!(probed, "a definitive 403 IS a measurement, just a negative one");
        assert!(warning.is_none());
    }

    #[test]
    fn an_inconclusive_probe_is_not_probed_either() {
        let outcome = WriteProbeOutcome::Inconclusive { reason: "connection refused".to_string() };
        let (can_write, probed, warning) = summarize_write_probe(&outcome);
        assert!(!can_write);
        assert!(!probed, "a probe that never got a real answer must not be reported as measured");
        assert!(warning.unwrap().contains("connection refused"));
    }
}
