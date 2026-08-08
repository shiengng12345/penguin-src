// Sprint 10 Phase 10A — REST API module
//
// File layout (DEC #193):
//   mod.rs       — shared types (RestRequest / RestResponse / SecretHandle / SecretRef)
//   commands.rs  — 4 Tauri commands (rest_send_request + 4 secret/cookie ones)
//   keychain.rs  — keyring crate wrapper + injectable adapter trait for testing
//
// Service boundary: Rust owns request execution + cookie jar + secret read.
// FE owns collection CRUD + request authoring + response rendering.
//
// Secret IPC contract (DEC #195): plaintext NEVER traverses IPC. FE passes
// `secretRefs: { path, handleId }[]` alongside request; Rust resolves each
// handle via keychain right before send and injects via path notation
// (`headers.Authorization`, `query.api_key`, `body.token`).

use serde::{Deserialize, Serialize};

pub mod commands;
pub mod cookie_store;
pub mod keychain;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestHeader {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestQueryParam {
    pub key: String,
    pub value: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "kebab-case")]
pub enum RestBody {
    Json {
        content: String,
    },
    Raw {
        content: String,
    },
    FormUrlencoded {
        fields: Vec<RestHeader>,
    },
    Multipart {
        fields: Vec<RestHeader>,
    }, // file upload spec — 10D
    // `content` is interpreted per `encoding`: "utf8" sends the string's UTF-8
    // bytes literally (legacy default); "hex" / "base64" decode to raw bytes so
    // the user can emit arbitrary binary — e.g. a gRPC-Web frame `0000000000`.
    Binary {
        content: String,
        #[serde(default = "default_body_encoding")]
        encoding: String,
    },
    None,
}

fn default_body_encoding() -> String {
    "utf8".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestRequest {
    pub method: String, // GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS
    pub url: String,
    #[serde(default)]
    pub headers: Vec<RestHeader>,
    #[serde(default)]
    pub query_params: Vec<RestQueryParam>,
    #[serde(default)]
    pub body: Option<RestBody>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestResponse {
    pub status: u16,
    pub headers: Vec<RestHeader>,
    pub body: String,
    // How `body` is encoded: "utf8" (verbatim text) or "base64" (binary
    // response wrapped so JSON IPC stays clean). The FE must consult this
    // before treating `body` as text — e.g. a gRPC-Web response is binary and
    // arrives base64, and can only be deframed after decoding.
    #[serde(default = "default_utf8_encoding")]
    pub body_encoding: String,
    pub body_bytes: u64,
    pub elapsed_ms: u64,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub error: Option<RestError>,
}

fn default_utf8_encoding() -> String {
    "utf8".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestError {
    pub kind: String, // "network" / "auth-locked" / "invalid-secret-path" / "size-exceeded" / "timeout"
    pub message: String,
}

/// Sprint 10 DEC #195 — flat secret reference, Rust injects via path.
/// Path examples: "headers.Authorization", "query.api_key", "body.token"
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretRef {
    pub path: String,
    pub handle_id: String,
}

/// FE-facing secret handle — never carries plaintext.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretHandle {
    pub kind: String,   // "keychain"
    pub id: String,     // opaque ID for the keychain item
    pub masked: String, // e.g. "••••1234"
}

/// Cookie record (DEC #189 — per-collection scope).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestCookie {
    pub domain: String,
    pub name: String,
    pub value: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub expires_at: Option<u64>,
}
