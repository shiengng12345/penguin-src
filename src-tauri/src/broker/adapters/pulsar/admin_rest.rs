//! Pulsar Admin REST transport. Handles topology, stats and schema reads.
//!
//! It deliberately does NOT produce — Admin REST answers a produce request
//! with 405 (spec V-E5) — and its peek cannot serve as an event stream
//! either. Both of those live on the binary transport in `binary.rs`.
//!
//! `BrokerAdmin` is a read-only trait, so this adapter never touches
//! `WriteGuard`/`WritePermit` (see `security.rs`) — there is nothing here to
//! authorize.

use crate::broker::envelope::{is_success, map_http_error, map_reqwest_error, BrokerError, BrokerErrorCode};
use crate::broker::ports::{BrokerAdmin, TopicRef};
use crate::broker::security::EndpointGuard;

pub struct PulsarAdminRest {
    client: reqwest::Client,
    base: String,
    token: Option<String>,
    guard: EndpointGuard,
}

/// Generous upper bound on an Admin REST response body. Pulsar's admin
/// endpoints return topology lists and per-topic stats JSON; even a large
/// production cluster's `/stats` payload or a tenant/namespace/topic listing
/// stays in the low megabytes. 16 MiB leaves comfortable headroom above any
/// real response while still bounding how much memory a misbehaving or
/// compromised broker — or an enormous `/stats` call — can force this
/// process to buffer.
const MAX_RESPONSE_BYTES: u64 = 16 * 1024 * 1024;

/// Manual `Debug`: the derived form would print `token` verbatim. Bearer
/// tokens must never appear in a `Debug` dump, a log line, or an error
/// message — this is the one place a `derive` would have silently defeated
/// that.
impl std::fmt::Debug for PulsarAdminRest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PulsarAdminRest")
            .field("base", &self.base)
            .field("token", &self.token.as_ref().map(|_| "***"))
            .field("guard", &self.guard)
            .finish()
    }
}

impl PulsarAdminRest {
    /// `tls_verify: false` maps to `danger_accept_invalid_certs(true)`. There
    /// is no `Default` for this type and no fallback value for the
    /// parameter, so a caller can only reach the insecure path by passing
    /// `false` explicitly — never by omission.
    pub fn new(
        admin_url: String,
        timeout_ms: u64,
        tls_verify: bool,
        token: Option<String>,
    ) -> Result<Self, BrokerError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(timeout_ms))
            .danger_accept_invalid_certs(!tls_verify)
            // Redirects are refused, never followed. `admin_url` is whatever
            // a user typed into a connection form — untrusted input — and
            // `EndpointGuard::check` only ever validates the URL this
            // adapter itself built. A `Location` header points somewhere the
            // guard never saw, which is exactly the SSRF shape the guard
            // exists to prevent. Do not re-enable redirects without giving
            // the guard a way to see and approve the target first.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| map_reqwest_error(&e))?;
        let guard = EndpointGuard::new(&admin_url)?;
        Ok(Self {
            client,
            base: admin_url.trim_end_matches('/').to_string(),
            token,
            guard,
        })
    }

    /// Best-effort extraction of Pulsar's `{"reason": "..."}` error body
    /// shape. Used identically on every endpoint's error path, including
    /// `broker_version`'s — a non-JSON success body does not mean the error
    /// body is non-JSON too, so that endpoint gets no less scrutiny than the
    /// rest.
    fn extract_reason(body: &str) -> Option<String> {
        serde_json::from_str::<serde_json::Value>(body)
            .ok()
            .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string))
    }

    /// Sends a GET to `path` under `base`, checking the endpoint guard
    /// against the fully-built URL before the request ever goes out, and
    /// returns the raw response body on success. Every `BrokerAdmin` method
    /// on this adapter routes through here (or `get_json`, which wraps it),
    /// so there is exactly one place that builds a URL and exactly one place
    /// that decides whether it may be sent.
    async fn get_raw(&self, path: &str) -> Result<String, BrokerError> {
        let url = format!("{}{}", self.base, path);
        self.guard.check(&url)?;

        let mut req = self.client.get(&url);
        if let Some(token) = &self.token {
            req = req.bearer_auth(token);
        }

        let mut res = req.send().await.map_err(|e| map_reqwest_error(&e))?;
        let status = res.status().as_u16();

        // Belt-and-suspenders alongside `redirect::Policy::none()` on the
        // client (see `new`): a 3xx reaches us as an ordinary response
        // rather than being silently followed, so refuse it explicitly here
        // too rather than letting it fall through the generic non-2xx path
        // below as if it were an ordinary failure. The guard never saw the
        // `Location` this would point to.
        if (300..400).contains(&status) {
            return Err(BrokerError {
                code: BrokerErrorCode::Forbidden,
                message: format!(
                    "endpoint refused: server responded with a redirect ({status}) for {path}; \
                     this module does not follow redirects because the endpoint guard cannot \
                     validate a target it never sees"
                ),
                retryable: false,
            });
        }

        // Reject up front when the server is honest about an oversized body.
        if let Some(len) = res.content_length() {
            if len > MAX_RESPONSE_BYTES {
                return Err(BrokerError {
                    code: BrokerErrorCode::MalformedResponse,
                    message: format!(
                        "response exceeded {MAX_RESPONSE_BYTES} bytes (Content-Length: {len}) for {path}"
                    ),
                    retryable: false,
                });
            }
        }

        // Enforce the bound on the actual bytes read regardless: chunked
        // responses carry no Content-Length at all, and a lying or
        // compromised server could under-declare it, so the header check
        // above is an optimization, not the real guarantee.
        let mut body = Vec::new();
        while let Some(chunk) = res.chunk().await.map_err(|e| map_reqwest_error(&e))? {
            if body.len() + chunk.len() > MAX_RESPONSE_BYTES as usize {
                return Err(BrokerError {
                    code: BrokerErrorCode::MalformedResponse,
                    message: format!("response exceeded {MAX_RESPONSE_BYTES} bytes for {path}"),
                    retryable: false,
                });
            }
            body.extend_from_slice(&chunk);
        }

        // Validate UTF-8 explicitly instead of `Response::text()`'s lossy
        // decode. Lossy decoding would turn a garbled body into a
        // plausible-looking string with replacement characters — harmless
        // for the JSON paths (the parse just fails with MalformedResponse),
        // but `broker_version` only trims its body and returns it as fact.
        // A corrupted version string presented as the broker's real version
        // is exactly the "inference presented as fact" this project's spec
        // forbids, so an invalid body must become an error, not a string.
        let body = String::from_utf8(body).map_err(|_| BrokerError {
            code: BrokerErrorCode::MalformedResponse,
            message: format!("response body for {path} was not valid UTF-8"),
            retryable: false,
        })?;

        if !is_success(status) {
            let reason = Self::extract_reason(&body);
            return Err(map_http_error(status, reason.as_deref(), path));
        }

        Ok(body)
    }

    async fn get_json<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, BrokerError> {
        let body = self.get_raw(path).await?;
        serde_json::from_str(&body).map_err(|e| BrokerError {
            code: BrokerErrorCode::MalformedResponse,
            message: e.to_string(),
            retryable: false,
        })
    }
}

#[async_trait::async_trait]
impl BrokerAdmin for PulsarAdminRest {
    async fn broker_version(&self) -> Result<String, BrokerError> {
        // This endpoint returns a bare string on success, not JSON — but its
        // error path is handled by the same `get_raw` every other endpoint
        // uses, so a non-2xx here is just as carefully mapped as anywhere
        // else.
        let body = self.get_raw("/admin/v2/brokers/version").await?;
        Ok(body.trim().to_string())
    }

    async fn list_clusters(&self) -> Result<Vec<String>, BrokerError> {
        self.get_json("/admin/v2/clusters").await
    }

    async fn list_tenants(&self) -> Result<Vec<String>, BrokerError> {
        self.get_json("/admin/v2/tenants").await
    }

    async fn list_namespaces(&self, tenant: &str) -> Result<Vec<String>, BrokerError> {
        self.get_json(&format!("/admin/v2/namespaces/{tenant}")).await
    }

    async fn list_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError> {
        // Returns expanded partitions (V-A6). Callers fold with list_partitioned_topics.
        self.get_json(&format!("/admin/v2/persistent/{tenant}/{namespace}")).await
    }

    async fn list_partitioned_topics(&self, tenant: &str, namespace: &str) -> Result<Vec<String>, BrokerError> {
        self.get_json(&format!("/admin/v2/persistent/{tenant}/{namespace}/partitioned"))
            .await
    }

    async fn get_topic_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        self.get_json(&format!("/admin/v2/{}/stats", topic.rest_path())).await
    }

    async fn get_topic_internal_stats(&self, topic: &TopicRef) -> Result<serde_json::Value, BrokerError> {
        self.get_json(&format!("/admin/v2/{}/internalStats", topic.rest_path())).await
    }

    async fn list_subscriptions(&self, topic: &TopicRef) -> Result<Vec<String>, BrokerError> {
        self.get_json(&format!("/admin/v2/{}/subscriptions", topic.rest_path())).await
    }
}
