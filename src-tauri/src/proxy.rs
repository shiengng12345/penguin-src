use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

const MAX_PROXY_RESPONSE_BYTES: usize = 25 * 1024 * 1024;
const PROXY_TIMEOUT_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpProxyRequest {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub body_base64: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpProxyResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub body_base64: String,
    pub error: Option<String>,
}

// In-flight proxied requests, keyed by the caller-supplied request id. The
// frontend's AbortSignal fires http_proxy_abort, which drops the request
// mid-flight via tokio::select.
fn proxy_aborts() -> &'static std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>> {
    static ABORTS: std::sync::OnceLock<
        std::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<()>>>,
    > = std::sync::OnceLock::new();
    ABORTS.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[tauri::command]
pub(crate) fn http_proxy_abort(request_id: String) {
    if let Some(tx) = proxy_aborts().lock().unwrap().remove(&request_id) {
        let _ = tx.send(());
    }
}

#[tauri::command]
pub(crate) async fn http_proxy(req: HttpProxyRequest) -> HttpProxyResponse {
    eprintln!(
        "[penguin-http-proxy] entered method={} url={}",
        req.method,
        req.url,
    );
    let request_id = req.request_id.clone();
    let rx = request_id.as_ref().map(|id| {
        let (tx, rx) = tokio::sync::oneshot::channel();
        proxy_aborts().lock().unwrap().insert(id.clone(), tx);
        rx
    });

    let result = match rx {
        Some(rx) => tokio::select! {
            resp = http_proxy_inner(req) => resp,
            _ = rx => HttpProxyResponse {
                status: 0,
                headers: HashMap::new(),
                body: String::new(),
                body_base64: String::new(),
                error: Some("Request cancelled".to_string()),
            },
        },
        None => http_proxy_inner(req).await,
    };

    if let Some(id) = request_id {
        proxy_aborts().lock().unwrap().remove(&id);
    }
    result
}

async fn read_response_with_cap(
    mut response: reqwest::Response,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len().saturating_add(chunk.len()) > max_bytes {
            let remaining = max_bytes.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, false))
}

async fn http_proxy_inner(req: HttpProxyRequest) -> HttpProxyResponse {
    let client = match reqwest::Client::builder()
        // gRPC-Web carries its own binary framing. Do not let reqwest/CDN
        // content-encoding negotiation hide a malformed compressed body or
        // fail before the frontend can inspect the raw response bytes.
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .timeout(std::time::Duration::from_secs(PROXY_TIMEOUT_SECS))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return HttpProxyResponse {
                status: 0,
                headers: HashMap::new(),
                body: String::new(),
                body_base64: String::new(),
                error: Some(e.to_string()),
            };
        }
    };

    let method = match req.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    };

    let grpc_web_request = req.headers.iter().any(|(key, value)| {
        key.eq_ignore_ascii_case("content-type")
            && value
                .split(';')
                .next()
                .map(|content_type| content_type.trim().eq_ignore_ascii_case("application/grpc-web+proto")
                    || content_type.trim().eq_ignore_ascii_case("application/grpc-web-text"))
                .unwrap_or(false)
    });
    let mut request_builder = client.request(method, &req.url);
    if grpc_web_request {
        // Tencent CDN serves this gRPC-Web route correctly over HTTP/2. Pin
        // only gRPC-Web calls; REST/JSON proxy requests keep normal ALPN
        // negotiation and remain compatible with HTTP/1.1-only servers.
        eprintln!("[penguin-http-proxy] grpc-web request version=HTTP/2");
        request_builder = request_builder.version(reqwest::Version::HTTP_2);
    }

    for (k, v) in &req.headers {
        request_builder = request_builder.header(k, v);
    }
    request_builder = request_builder.header("accept-encoding", "identity");

    let body: Option<Vec<u8>> = if let Some(ref b64) = req.body_base64 {
        match base64::engine::general_purpose::STANDARD.decode(b64) {
            Ok(b) => Some(b),
            Err(e) => {
                return HttpProxyResponse {
                    status: 0,
                    headers: HashMap::new(),
                    body: String::new(),
                    body_base64: String::new(),
                    error: Some(format!("Invalid base64 body: {}", e)),
                };
            }
        }
    } else {
        req.body.as_ref().map(|b| b.as_bytes().to_vec())
    };

    let request_builder = if let Some(b) = body {
        request_builder.body(b)
    } else {
        request_builder
    };
    let retry_builder = if grpc_web_request {
        request_builder.try_clone()
    } else {
        None
    };

    eprintln!("[penguin-http-proxy] sending request");
    let response = match request_builder.send().await {
        Ok(r) => r,
        Err(http2_error) if grpc_web_request => {
            eprintln!(
                "[penguin-http-proxy] HTTP/2 send failed, retrying HTTP/1.1 error={}",
                http2_error
            );
            match retry_builder {
                Some(builder) => match builder.version(reqwest::Version::HTTP_11).send().await {
                    Ok(r) => {
                        eprintln!("[penguin-http-proxy] fallback response version=HTTP/1.1");
                        r
                    }
                    Err(http1_error) => {
                        eprintln!("[penguin-http-proxy] HTTP/1.1 fallback failed error={}", http1_error);
                        return HttpProxyResponse {
                            status: 0,
                            headers: HashMap::new(),
                            body: String::new(),
                            body_base64: String::new(),
                            error: Some(format!(
                                "HTTP/2 request failed: {}; HTTP/1.1 fallback failed: {}",
                                http2_error, http1_error
                            )),
                        };
                    }
                },
                None => {
                    return HttpProxyResponse {
                        status: 0,
                        headers: HashMap::new(),
                        body: String::new(),
                        body_base64: String::new(),
                        error: Some(http2_error.to_string()),
                    };
                }
            }
        }
        Err(e) => {
            eprintln!("[penguin-http-proxy] send failed error={}", e);
            return HttpProxyResponse {
                status: 0,
                headers: HashMap::new(),
                body: String::new(),
                body_base64: String::new(),
                error: Some(e.to_string()),
            };
        }
    };

    let status = response.status().as_u16();
    let http_version = format!("{:?}", response.version());
    let response_content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let response_content_encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    eprintln!(
        "[penguin-http-proxy] response headers received status={} http_version={} content_type={} content_encoding={}",
        status,
        http_version,
        response_content_type,
        response_content_encoding,
    );
    let mut headers = HashMap::new();
    for (k, v) in response.headers() {
        if let Ok(v_str) = v.to_str() {
            headers.insert(k.as_str().to_string(), v_str.to_string());
        }
    }

    // Capture framing metadata before consuming the body. If the HTTP parser
    // rejects chunk framing, this metadata must survive the error path.
    let content_type = headers.get("content-type").cloned().unwrap_or_default();
    let content_encoding = headers.get("content-encoding").cloned().unwrap_or_default();
    let content_length = headers.get("content-length").cloned().unwrap_or_default();
    let transfer_encoding = headers.get("transfer-encoding").cloned().unwrap_or_default();
    let connection = headers.get("connection").cloned().unwrap_or_default();
    eprintln!(
        "[penguin-http-proxy] framing content_length={} transfer_encoding={} connection={}",
        content_length, transfer_encoding, connection,
    );
    headers.insert("x-penguin-http-status".to_string(), status.to_string());
    headers.insert("x-penguin-http-version".to_string(), http_version.clone());
    headers.insert("x-penguin-content-type".to_string(), content_type.clone());
    headers.insert("x-penguin-content-encoding".to_string(), content_encoding.clone());
    headers.insert("x-penguin-content-length".to_string(), content_length);
    headers.insert("x-penguin-transfer-encoding".to_string(), transfer_encoding);
    headers.insert("x-penguin-connection".to_string(), connection);

    let (bytes, truncated) = match read_response_with_cap(response, MAX_PROXY_RESPONSE_BYTES).await
    {
        Ok(result) => result,
        Err(e) => {
            eprintln!("[penguin-http-proxy] body read failed error={}", e);
            return HttpProxyResponse {
                status,
                headers,
                body: String::new(),
                body_base64: String::new(),
                error: Some(e.to_string()),
            };
        }
    };
    eprintln!("[penguin-http-proxy] response body read bytes={}", bytes.len());

    let body_str = String::from_utf8_lossy(&bytes).to_string();
    let body_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let prefix_hex: String = bytes
        .iter()
        .take(32)
        .map(|byte| format!("{byte:02x}"))
        .collect();
    eprintln!(
        "[penguin-http-proxy] status={} content_type={} content_encoding={} bytes={} prefix={}",
        status,
        content_type,
        content_encoding,
        bytes.len(),
        prefix_hex,
    );
    headers.insert("x-penguin-response-bytes".to_string(), bytes.len().to_string());
    headers.insert("x-penguin-response-prefix".to_string(), prefix_hex);

    HttpProxyResponse {
        status,
        headers,
        body: body_str,
        body_base64,
        error: if truncated {
            Some(format!(
                "Response exceeded proxy limit of {} bytes",
                MAX_PROXY_RESPONSE_BYTES
            ))
        } else {
            None
        },
    }
}
