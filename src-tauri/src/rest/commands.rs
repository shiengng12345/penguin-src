// Sprint 10 — REST Tauri commands.
//
// T10A.1: skeleton + stubs.
// T10A.2: real `rest_send_request` via reqwest + secret injection.
// T10A.3: keyring-backed save / resolve / cookies (still stub here).

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::keychain::active_adapter;
use super::{
    RestBody, RestCookie, RestError, RestHeader, RestRequest, RestResponse, SecretHandle, SecretRef,
};

const MAX_RESPONSE_BYTES: usize = 100 * 1024 * 1024;
const KEYCHAIN_SERVICE: &str = "penguin-rest";

struct ResponseBytes {
    bytes: Vec<u8>,
    total_size: u64,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequestPayload {
    pub req: RestRequest,
    #[serde(default)]
    pub secret_refs: Vec<SecretRef>,
    // Optional — when present, response Set-Cookie headers are auto-parsed
    // and persisted to the collection's cookie store. Absent during stateless
    // one-off sends (e.g. unsaved drafts). (DEC #189 — per-collection scope.)
    #[serde(default)]
    pub collection_id: Option<String>,
}

async fn read_response_with_cap(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<ResponseBytes, RestError> {
    let content_length = response.content_length();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| RestError {
        kind: "read-body".to_string(),
        message: e.to_string(),
    })? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            let remaining = max_bytes.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok(ResponseBytes {
                bytes,
                total_size: content_length.unwrap_or((max_bytes as u64) + 1),
                truncated: true,
            });
        }
        bytes.extend_from_slice(&chunk);
    }
    let total_size = content_length.unwrap_or(bytes.len() as u64);
    Ok(ResponseBytes {
        bytes,
        total_size,
        truncated: false,
    })
}

#[tauri::command]
pub async fn rest_send_request(payload: SendRequestPayload) -> Result<RestResponse, RestError> {
    let req = payload.req;

    // 1) Resolve secrets via keychain. Each ref's path is dot-notation —
    //    "headers.Authorization" / "query.api_key". Body-injection paths are
    //    rejected in MVP (needs JSON-path mutation, defer to Phase 10D+).
    let resolved = resolve_secret_refs(&payload.secret_refs)?;

    // 2) Build reqwest client honoring timeout + redirect policy.
    let timeout = Duration::from_millis(req.timeout_ms.unwrap_or(30_000));
    let redirect_policy = if req.follow_redirects {
        reqwest::redirect::Policy::limited(10)
    } else {
        reqwest::redirect::Policy::none()
    };
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(redirect_policy)
        .build()
        .map_err(|e| RestError {
            kind: "client-build".to_string(),
            message: e.to_string(),
        })?;

    // 3) Method.
    let method = match req.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => {
            return Err(RestError {
                kind: "method".to_string(),
                message: format!("unsupported HTTP method: {}", other),
            });
        }
    };

    // 4) URL + query params (secret-aware).
    let mut url = reqwest::Url::parse(&req.url).map_err(|e| RestError {
        kind: "url-parse".to_string(),
        message: e.to_string(),
    })?;
    {
        let mut q = url.query_pairs_mut();
        for qp in &req.query_params {
            if !qp.enabled {
                continue;
            }
            let secret_path = format!("query.{}", qp.key);
            let value = resolved
                .get(&secret_path)
                .cloned()
                .unwrap_or_else(|| qp.value.clone());
            q.append_pair(&qp.key, &value);
        }
    }

    // Host/path snapshot — cookie matching now + Set-Cookie persistence later.
    let request_host = url.host_str().unwrap_or("").to_string();
    let request_path = url.path().to_string();

    // 5) Build request — headers (secret-aware) + body.
    let mut rb = client.request(method, url);
    for h in &req.headers {
        if !h.enabled {
            continue;
        }
        let secret_path = format!("headers.{}", h.key);
        let value = resolved
            .get(&secret_path)
            .cloned()
            .unwrap_or_else(|| h.value.clone());
        rb = rb.header(&h.key, &value);
    }

    // Attach stored cookies so session flows work (server Set-Cookie →
    // next request carries Cookie). A user-provided Cookie header wins —
    // we never merge into an explicit one.
    let user_set_cookie = req
        .headers
        .iter()
        .any(|h| h.enabled && h.key.eq_ignore_ascii_case("cookie"));
    if !user_set_cookie {
        if let Some(collection_id) = payload.collection_id.as_deref() {
            if let Ok(cookies) = super::cookie_store::list_cookies(collection_id) {
                let header = build_cookie_header(&cookies, &request_host, &request_path);
                if !header.is_empty() {
                    rb = rb.header("Cookie", header);
                }
            }
        }
    }

    // Whether the user already declared a content-type. When they did, body
    // modes must NOT override it — a gRPC-Web send sets
    // `application/grpc-web+proto` explicitly, and JSON mode clobbering it with
    // `application/json` is exactly why such requests failed before.
    let user_set_content_type = req
        .headers
        .iter()
        .any(|h| h.enabled && h.key.eq_ignore_ascii_case("content-type"));

    if let Some(body) = &req.body {
        rb = apply_body(rb, body, user_set_content_type)?;
    }

    // 6) Send + measure.
    let start = Instant::now();
    let response = rb.send().await.map_err(|e| {
        let kind = if e.is_timeout() {
            "timeout"
        } else if e.is_connect() {
            "connect"
        } else {
            "network"
        };
        RestError {
            kind: kind.to_string(),
            message: e.to_string(),
        }
    })?;

    let status = response.status().as_u16();
    let resp_headers: Vec<RestHeader> = response
        .headers()
        .iter()
        .map(|(k, v)| RestHeader {
            key: k.to_string(),
            value: v.to_str().unwrap_or("").to_string(),
            enabled: true,
        })
        .collect();

    // Phase 10D — auto-persist Set-Cookie headers to the collection's cookie
    // store. Failures are swallowed (the request itself succeeded; we don't
    // want a cookie write hiccup to nullify the response on the FE).
    if let Some(collection_id) = payload.collection_id.as_deref() {
        for h in &resp_headers {
            if !h.key.eq_ignore_ascii_case("set-cookie") {
                continue;
            }
            if let Some(cookie) = parse_set_cookie(&h.value, &request_host) {
                let _ = super::cookie_store::upsert_cookie(collection_id, &cookie);
            }
        }
    }

    // 7) Body with 100MB cap. Read chunk-by-chunk so pathological responses
    // don't get fully buffered before truncation.
    let response_bytes = read_response_with_cap(response, MAX_RESPONSE_BYTES).await?;
    let total_size = response_bytes.total_size;
    let truncated = response_bytes.truncated;

    // Try UTF-8 first; if binary, base64-encode so JSON IPC stays clean. The
    // FE learns which happened via `body_encoding` so it can deframe binary
    // responses (e.g. gRPC-Web) instead of treating them as truncated text.
    let (body_str, body_encoding) = match String::from_utf8(response_bytes.bytes) {
        Ok(s) => (s, "utf8".to_string()),
        Err(e) => {
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(e.into_bytes());
            (encoded, "base64".to_string())
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;

    Ok(RestResponse {
        status,
        headers: resp_headers,
        body: body_str,
        body_encoding,
        body_bytes: total_size,
        elapsed_ms,
        truncated,
        error: None,
    })
}

/// Parse + validate each secret ref, resolve via keychain. Returns map from
/// `path` → plaintext value. The plaintext lives only on the Rust side for
/// the duration of this function — never re-serialized to the FE.
fn resolve_secret_refs(refs: &[SecretRef]) -> Result<HashMap<String, String>, RestError> {
    let mut out = HashMap::new();
    for sref in refs {
        let (location, key) = parse_secret_path(&sref.path)?;
        if location != "headers" && location != "query" {
            return Err(RestError {
                kind: "invalid-secret-path".to_string(),
                message: format!(
                    "body-path secret injection deferred — got {:?} on path {:?}",
                    location, sref.path
                ),
            });
        }
        if key.is_empty() {
            return Err(RestError {
                kind: "invalid-secret-path".to_string(),
                message: format!("empty key segment on path {:?}", sref.path),
            });
        }
        let plaintext = active_adapter()
            .get(KEYCHAIN_SERVICE, &sref.handle_id)
            .map_err(|e| RestError {
                kind: "auth-locked".to_string(),
                message: e,
            })?
            .ok_or_else(|| RestError {
                kind: "secret-not-found".to_string(),
                message: format!("keychain entry missing for handle id {:?}", sref.handle_id),
            })?;
        out.insert(sref.path.clone(), plaintext);
    }
    Ok(out)
}

/// Path examples: "headers.Authorization" → ("headers", "Authorization").
/// Only first dot splits — header names that legitimately contain dots are
/// rare but we keep everything after the first segment as the key.
fn parse_secret_path(path: &str) -> Result<(&str, &str), RestError> {
    let mut split = path.splitn(2, '.');
    let location = split.next().unwrap_or("");
    let key = split.next().ok_or_else(|| RestError {
        kind: "invalid-secret-path".to_string(),
        message: format!("path missing key segment: {:?}", path),
    })?;
    if location.is_empty() {
        return Err(RestError {
            kind: "invalid-secret-path".to_string(),
            message: format!("path missing location: {:?}", path),
        });
    }
    Ok((location, key))
}

fn apply_body(
    rb: reqwest::RequestBuilder,
    body: &RestBody,
    user_set_content_type: bool,
) -> Result<reqwest::RequestBuilder, RestError> {
    Ok(match body {
        RestBody::Json { content } => {
            // Only default the content-type when the user hasn't set one —
            // otherwise an explicit `application/grpc-web+proto` (or anything
            // else) would be silently overridden.
            let rb = if user_set_content_type {
                rb
            } else {
                rb.header("content-type", "application/json")
            };
            rb.body(content.clone())
        }
        RestBody::Raw { content } => rb.body(content.clone()),
        RestBody::FormUrlencoded { fields } => {
            let pairs: Vec<(&str, &str)> = fields
                .iter()
                .filter(|f| f.enabled)
                .map(|f| (f.key.as_str(), f.value.as_str()))
                .collect();
            rb.form(&pairs)
        }
        // Multipart upload is Phase 10D; skip for now.
        RestBody::Multipart { .. } => rb,
        // Binary body: decode per `encoding` into raw bytes and send those
        // exact bytes. "hex" / "base64" let the user emit arbitrary binary
        // (e.g. a gRPC-Web frame); "utf8" sends the string verbatim (legacy).
        RestBody::Binary { content, encoding } => {
            rb.body(decode_binary_body(content, encoding)?)
        }
        RestBody::None => rb,
    })
}

/// Decode a Binary-mode body string into the exact bytes to send.
/// - "utf8" (or unknown): the string's own UTF-8 bytes, verbatim.
/// - "hex": hex digits, ASCII whitespace ignored (e.g. `00 00 00 00 00`).
/// - "base64": standard base64.
fn decode_binary_body(content: &str, encoding: &str) -> Result<Vec<u8>, RestError> {
    match encoding.to_ascii_lowercase().as_str() {
        "hex" => {
            let cleaned: String = content.chars().filter(|c| !c.is_ascii_whitespace()).collect();
            if cleaned.len() % 2 != 0 {
                return Err(RestError {
                    kind: "invalid-body".to_string(),
                    message: "hex body has an odd number of digits".to_string(),
                });
            }
            (0..cleaned.len())
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&cleaned[i..i + 2], 16).map_err(|_| RestError {
                        kind: "invalid-body".to_string(),
                        message: format!("invalid hex byte near '{}'", &cleaned[i..i + 2]),
                    })
                })
                .collect()
        }
        "base64" => {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .decode(content.trim())
                .map_err(|e| RestError {
                    kind: "invalid-body".to_string(),
                    message: format!("invalid base64 body: {}", e),
                })
        }
        _ => Ok(content.as_bytes().to_vec()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSecretPayload {
    pub collection_id: String,
    pub key: String,
    pub plaintext: String,
}

#[tauri::command]
pub async fn rest_save_secret(payload: SaveSecretPayload) -> Result<SecretHandle, RestError> {
    // Handle ID is opaque — collection-scoped + key. Real impl writes via
    // keyring crate in T10A.3; for now we save through the active_adapter
    // (which is MockKeychain by default + KeyringAdapter once T10A.3 swaps).
    let handle_id = format!("{}::{}", payload.collection_id, payload.key);
    active_adapter()
        .save(KEYCHAIN_SERVICE, &handle_id, &payload.plaintext)
        .map_err(|e| RestError {
            kind: "keychain-write".to_string(),
            message: e,
        })?;
    Ok(SecretHandle {
        kind: "keychain".to_string(),
        id: handle_id,
        masked: mask_secret(&payload.plaintext),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSecretMaskedPayload {
    pub id: String,
}

#[tauri::command]
pub async fn rest_resolve_secret_masked(
    payload: ResolveSecretMaskedPayload,
) -> Result<SecretHandle, RestError> {
    // Fetch the secret only to compute its mask; plaintext immediately drops.
    let plaintext = active_adapter()
        .get(KEYCHAIN_SERVICE, &payload.id)
        .map_err(|e| RestError {
            kind: "keychain-read".to_string(),
            message: e,
        })?;
    let masked = match &plaintext {
        Some(t) => mask_secret(t),
        None => "(missing)".to_string(),
    };
    Ok(SecretHandle {
        kind: "keychain".to_string(),
        id: payload.id,
        masked,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlainSecret {
    pub id: String,
    pub plaintext: String,
}

/// Resolve a secret's plaintext for in-app display + inline editing in the
/// Authorization tab. Departure from the original DEC #195 masked-only
/// contract — accepted because:
/// 1. The IPC channel is process-local, not network.
/// 2. The plaintext was typed by this same user; we're returning their
///    own value to themselves, not exposing a credential they don't own.
/// 3. Postman / Insomnia / every comparable tool shows credentials in
///    plain text. Masking-only was over-cautious and led the user to
///    file the "i can't see / can't edit my own key" complaint.
#[tauri::command]
pub async fn rest_resolve_secret_plain(
    payload: ResolveSecretMaskedPayload,
) -> Result<PlainSecret, RestError> {
    let plaintext = active_adapter()
        .get(KEYCHAIN_SERVICE, &payload.id)
        .map_err(|e| RestError {
            kind: "keychain-read".to_string(),
            message: e,
        })?
        .unwrap_or_default();
    Ok(PlainSecret {
        id: payload.id,
        plaintext,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CookiesScopePayload {
    pub collection_id: String,
}

#[tauri::command]
pub async fn rest_get_cookies(payload: CookiesScopePayload) -> Result<Vec<RestCookie>, RestError> {
    // Phase 10B — real SQLite-backed list (expired cookies filtered out).
    // Auto Set-Cookie parsing from response headers + the Cookies tab UI
    // ship in Phase 10D; this returns whatever the FE has explicitly upserted
    // until then.
    super::cookie_store::list_cookies(&payload.collection_id).map_err(|e| RestError {
        kind: "cookies-read".to_string(),
        message: e,
    })
}

#[tauri::command]
pub async fn rest_clear_cookies(payload: CookiesScopePayload) -> Result<(), RestError> {
    super::cookie_store::clear_cookies(&payload.collection_id).map_err(|e| RestError {
        kind: "cookies-clear".to_string(),
        message: e,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveCookiePayload {
    pub collection_id: String,
    pub cookie: RestCookie,
}

#[tauri::command]
pub async fn rest_save_cookie(payload: SaveCookiePayload) -> Result<(), RestError> {
    // Manual cookie upsert from the Cookies tab + Add row. The same upsert
    // path the response Set-Cookie auto-extractor uses; user edits and
    // server responses live in one bucket.
    super::cookie_store::upsert_cookie(&payload.collection_id, &payload.cookie).map_err(|e| {
        RestError {
            kind: "cookies-write".to_string(),
            message: e,
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCookiePayload {
    pub collection_id: String,
    pub domain: String,
    pub name: String,
}

#[tauri::command]
pub async fn rest_delete_cookie(payload: DeleteCookiePayload) -> Result<(), RestError> {
    super::cookie_store::delete_cookie(&payload.collection_id, &payload.domain, &payload.name)
        .map_err(|e| RestError {
            kind: "cookies-delete".to_string(),
            message: e,
        })
}

/// RFC-6265-lite request matching: the host equals the cookie domain or is a
/// subdomain of it (leading dot tolerated), and the request path sits under
/// the cookie path (default "/"). Expired cookies never reach here —
/// list_cookies filters them.
pub fn build_cookie_header(
    cookies: &[super::RestCookie],
    host: &str,
    path: &str,
) -> String {
    if host.is_empty() {
        return String::new();
    }
    let host_lc = host.to_ascii_lowercase();
    let mut parts: Vec<String> = Vec::new();
    for cookie in cookies {
        let domain = cookie.domain.trim_start_matches('.').to_ascii_lowercase();
        if domain.is_empty() {
            continue;
        }
        let domain_matches =
            host_lc == domain || host_lc.ends_with(&format!(".{domain}"));
        if !domain_matches {
            continue;
        }
        let cookie_path = cookie.path.as_deref().unwrap_or("/");
        if !path.starts_with(cookie_path) {
            continue;
        }
        parts.push(format!("{}={}", cookie.name, cookie.value));
    }
    parts.join("; ")
}

/// Parse a Set-Cookie header value into a RestCookie. Format:
///   <name>=<value>[; Domain=<d>][; Path=<p>][; Expires=<http-date>][; Max-Age=<sec>]
/// We extract name/value/Domain/Path/Expires (or Max-Age). Domain falls back
/// to the request host when the header omits it. Returns None on parse
/// failures — we'd rather silently skip a malformed cookie than crash the
/// response path.
pub fn parse_set_cookie(value: &str, fallback_domain: &str) -> Option<super::RestCookie> {
    let mut parts = value.split(';').map(|s| s.trim());
    let first = parts.next()?;
    let eq = first.find('=')?;
    let name = first[..eq].trim().to_string();
    let val = first[eq + 1..].trim().to_string();
    if name.is_empty() {
        return None;
    }
    let mut domain: Option<String> = None;
    let mut path: Option<String> = None;
    let mut expires_at: Option<u64> = None;
    let mut max_age: Option<i64> = None;
    for attr in parts {
        let lc = attr.to_lowercase();
        if let Some(rest) = lc.strip_prefix("domain=") {
            domain = Some(rest.trim().to_string());
        } else if let Some(rest) = lc.strip_prefix("path=") {
            // preserve case of the path
            let original = &attr[5..];
            let _ = rest; // suppress unused
            path = Some(original.trim().to_string());
        } else if let Some(rest) = lc.strip_prefix("max-age=") {
            max_age = rest.trim().parse::<i64>().ok();
        } else if lc.starts_with("expires=") {
            // RFC 6265 HTTP-date (case preserved from the original attr).
            // Max-Age still wins below per RFC precedence. Unparseable dates
            // leave None (treated as session cookie).
            let original = attr["expires=".len()..].trim();
            if let Ok(when) = httpdate::parse_http_date(original) {
                expires_at = Some(
                    when.duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as u64)
                        // pre-epoch date = "expire immediately" convention
                        .unwrap_or(1),
                );
            }
        }
    }
    if let Some(secs) = max_age {
        if secs > 0 {
            let now_ms = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            expires_at = Some(now_ms + (secs as u64) * 1000);
        } else {
            // Max-Age=0 means "delete now" — flag with 1ms past epoch.
            expires_at = Some(1);
        }
    }
    Some(super::RestCookie {
        domain: domain.unwrap_or_else(|| fallback_domain.to_string()),
        name,
        value: val,
        path,
        expires_at,
    })
}

/// Mask middle of a secret, leaving the last 4 chars visible.
pub fn mask_secret(plaintext: &str) -> String {
    let visible_tail = 4;
    let len = plaintext.chars().count();
    if len <= visible_tail {
        return "•".repeat(len);
    }
    let tail: String = plaintext.chars().skip(len - visible_tail).collect();
    format!("••••{}", tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_binary_hex_ignores_whitespace() {
        // The gRPC-Web empty-message frame: flag 0 + 4-byte length 0.
        assert_eq!(
            decode_binary_body("00 00 00 00 00", "hex").unwrap(),
            vec![0u8, 0, 0, 0, 0]
        );
        assert_eq!(decode_binary_body("deadBEEF", "hex").unwrap(), vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn decode_binary_hex_rejects_malformed() {
        assert!(decode_binary_body("abc", "hex").is_err()); // odd length
        assert!(decode_binary_body("zz", "hex").is_err()); // non-hex digit
    }

    #[test]
    fn decode_binary_base64_roundtrip() {
        // base64 of the 5-null-byte frame.
        assert_eq!(
            decode_binary_body("AAAAAAA=", "base64").unwrap(),
            vec![0u8, 0, 0, 0, 0]
        );
        assert!(decode_binary_body("not base64!!!", "base64").is_err());
    }

    #[test]
    fn decode_binary_utf8_is_verbatim() {
        assert_eq!(decode_binary_body("hi", "utf8").unwrap(), b"hi".to_vec());
        // Unknown encoding falls back to verbatim UTF-8 bytes.
        assert_eq!(decode_binary_body("hi", "weird").unwrap(), b"hi".to_vec());
    }

    #[test]
    fn parse_set_cookie_minimal() {
        let c = parse_set_cookie("session=abc123", "api.example.com").unwrap();
        assert_eq!(c.name, "session");
        assert_eq!(c.value, "abc123");
        assert_eq!(c.domain, "api.example.com");
        assert_eq!(c.path, None);
        assert_eq!(c.expires_at, None);
    }

    #[test]
    fn parse_set_cookie_with_attributes() {
        let c = parse_set_cookie(
            "auth=xyz; Domain=.example.com; Path=/v1; Max-Age=3600",
            "api.example.com",
        )
        .unwrap();
        assert_eq!(c.name, "auth");
        assert_eq!(c.value, "xyz");
        assert_eq!(c.domain, ".example.com");
        assert_eq!(c.path.as_deref(), Some("/v1"));
        // expires_at = now + 3600s — must be in the near future, not None.
        assert!(c.expires_at.unwrap() > 1_700_000_000_000);
    }

    #[test]
    fn parse_set_cookie_lowercase_attributes() {
        // Real-world Set-Cookie headers often use lowercase attribute names
        // (some servers emit them post-normalization). The parser lower-cases
        // before matching; this test locks that behavior against a refactor
        // that drops the to_lowercase().
        let c = parse_set_cookie(
            "session=abc; domain=example.com; path=/api; max-age=60",
            "api.example.com",
        )
        .unwrap();
        assert_eq!(c.name, "session");
        assert_eq!(c.value, "abc");
        assert_eq!(c.domain, "example.com");
        assert_eq!(c.path.as_deref(), Some("/api"));
        assert!(c.expires_at.unwrap() > 1_700_000_000_000);
    }

    #[test]
    fn parse_set_cookie_max_age_zero_marks_expired() {
        let c = parse_set_cookie("kill=now; Max-Age=0", "api.example.com").unwrap();
        assert_eq!(c.expires_at, Some(1));
    }

    #[test]
    fn parse_set_cookie_rejects_malformed() {
        assert!(parse_set_cookie("no-equals-sign", "api.example.com").is_none());
        assert!(parse_set_cookie("=novalue", "api.example.com").is_none());
        assert!(parse_set_cookie("", "api.example.com").is_none());
    }

    #[test]
    fn parse_set_cookie_expires_http_date() {
        // Servers that send only Expires (no Max-Age) must still get a real
        // expiry — this was previously discarded, storing them as immortal.
        let c = parse_set_cookie(
            "sid=e1; Expires=Wed, 21 Oct 2015 07:28:00 GMT",
            "api.example.com",
        )
        .unwrap();
        assert_eq!(c.expires_at, Some(1_445_412_480_000));
    }

    #[test]
    fn parse_set_cookie_max_age_wins_over_expires() {
        // RFC 6265 §4.1.2.2: Max-Age has precedence when both are present.
        let c = parse_set_cookie(
            "sid=e1; Expires=Wed, 21 Oct 2015 07:28:00 GMT; Max-Age=3600",
            "api.example.com",
        )
        .unwrap();
        assert!(c.expires_at.unwrap() > 1_700_000_000_000);
    }

    fn cookie(domain: &str, path: Option<&str>, name: &str, value: &str) -> crate::rest::RestCookie {
        crate::rest::RestCookie {
            domain: domain.to_string(),
            name: name.to_string(),
            value: value.to_string(),
            path: path.map(String::from),
            expires_at: None,
        }
    }

    #[test]
    fn cookie_header_matches_domain_and_subdomain() {
        let cookies = vec![
            cookie(".example.com", None, "root", "1"),
            cookie("api.example.com", None, "exact", "2"),
            cookie("other.com", None, "foreign", "3"),
        ];
        let header = build_cookie_header(&cookies, "api.example.com", "/v1/users");
        assert_eq!(header, "root=1; exact=2");
        // "notexample.com" must NOT match ".example.com" (suffix needs a dot)
        assert_eq!(build_cookie_header(&cookies, "notexample.com", "/"), "");
    }

    #[test]
    fn cookie_header_respects_path_scope() {
        let cookies = vec![
            cookie("api.example.com", Some("/admin"), "adm", "1"),
            cookie("api.example.com", Some("/"), "all", "2"),
        ];
        assert_eq!(build_cookie_header(&cookies, "api.example.com", "/v1"), "all=2");
        assert_eq!(
            build_cookie_header(&cookies, "api.example.com", "/admin/x"),
            "adm=1; all=2"
        );
    }

    #[test]
    fn parse_secret_path_extracts_location_and_key() {
        let (loc, key) = parse_secret_path("headers.Authorization").unwrap();
        assert_eq!(loc, "headers");
        assert_eq!(key, "Authorization");
    }

    #[test]
    fn parse_secret_path_rejects_missing_dot() {
        let err = parse_secret_path("nodot").unwrap_err();
        assert_eq!(err.kind, "invalid-secret-path");
    }

    #[test]
    fn parse_secret_path_rejects_empty_location() {
        let err = parse_secret_path(".key").unwrap_err();
        assert_eq!(err.kind, "invalid-secret-path");
    }

    #[test]
    fn mask_secret_short_string() {
        assert_eq!(mask_secret("ab"), "••");
    }

    #[test]
    fn mask_secret_long_string() {
        assert_eq!(mask_secret("supersecret123"), "••••t123");
    }
}
