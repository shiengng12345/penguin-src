// Sprint 10 Phase 10A — REST module types (mirror Rust shapes in
// src-tauri/src/rest/mod.rs). All Tauri command payloads + responses use
// these shapes.

export type RestMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export interface RestHeader {
  key: string;
  value: string;
  enabled: boolean;
}

export interface RestQueryParam {
  key: string;
  value: string;
  enabled: boolean;
}

// A typed key→value row for the "key-value" body editor. `type` picks how the
// string `value` is coerced into JSON (string/number/boolean/null, or
// object/array where `value` is a JSON snippet) — so the form covers anything
// JSON can express. Converted to a { mode: "json", content } body on send.
export type RestBodyValueType = "string" | "number" | "boolean" | "null" | "object" | "array";

export interface RestBodyField {
  id: string;
  key: string;
  type: RestBodyValueType;
  value: string;
  enabled: boolean;
}

export type RestBody =
  | { mode: "json"; content: string }
  | { mode: "raw"; content: string }
  // Frontend-only editing mode: typed key→value rows serialized to a JSON body
  // on send (the Rust side only sees { mode: "json", content }).
  | { mode: "key-value"; fields: RestBodyField[] }
  | { mode: "form-urlencoded"; fields: RestHeader[] }
  | { mode: "multipart"; fields: RestHeader[] }
  // `content` interpreted per `encoding`: "utf8" = verbatim string bytes;
  // "hex"/"base64" decode to raw bytes so arbitrary binary can be sent
  // (e.g. a gRPC-Web frame). Absent encoding defaults to "utf8" on the backend.
  | { mode: "binary"; content: string; encoding?: "utf8" | "hex" | "base64" }
  | { mode: "none" };

export type RestAuth =
  | { kind: "none" }
  | { kind: "bearer"; tokenHandleId?: string }
  | { kind: "basic"; username: string; passwordHandleId?: string }
  | { kind: "api-key"; in: "header" | "query"; name: string; valueHandleId?: string };

export interface RestRequest {
  method: RestMethod;
  url: string;
  headers: RestHeader[];
  queryParams: RestQueryParam[];
  body?: RestBody;
  timeoutMs?: number;
  followRedirects: boolean;
}

export interface RestResponse {
  status: number;
  headers: RestHeader[];
  body: string;
  // "utf8": `body` is verbatim text. "base64": `body` is a base64-wrapped
  // binary response that must be decoded before use (e.g. a gRPC-Web frame).
  bodyEncoding: "utf8" | "base64";
  bodyBytes: number;
  elapsedMs: number;
  truncated: boolean;
  error?: RestError;
}

export interface RestError {
  kind: string; // "network" | "timeout" | "auth-locked" | "invalid-secret-path" | "size-exceeded" | "method" | "url-parse" | ...
  message: string;
}

/// Sprint 10 DEC #195 — flat secret reference, Rust injects via path.
export interface SecretRef {
  path: string; // "headers.Authorization" / "query.api_key"
  handleId: string;
}

/// FE-facing secret handle — NEVER carries plaintext.
export interface SecretHandle {
  kind: "keychain";
  id: string;
  masked: string; // e.g. "••••1234"
}

export interface RestCookie {
  domain: string;
  name: string;
  value: string;
  path?: string;
  expiresAt?: number;
}

// ---- Stored data shapes (FE-side persistence model) ----

export interface RestProject {
  id: string;
  name: string;
  createdAt: number;
}

export interface RestEnvironment {
  id: string;
  projectId: string;
  name: string;
}

export interface RestCollection {
  id: string;
  projectId: string;
  envId: string | null;
  parentId: string | null; // folder nesting reserved schema but UI hides in 10A
  name: string;
  createdAt: number;
  updatedAt: number;
}

/// Saved REST request bound to a collection. id-stable so editing in place
/// doesn't break references.
export interface RestRequestRecord {
  id: string;
  collectionId: string;
  name: string;
  method: RestMethod;
  url: string;
  headers: RestHeader[];
  queryParams: RestQueryParam[];
  body?: RestBody;
  auth?: RestAuth;
  timeoutMs?: number;
  followRedirects: boolean;
  createdAt: number;
  updatedAt: number;
}

/// Env var scope (DEC #179 — 3 scopes for Phase 10A).
export type RestEnvVarScope = "global" | "env" | "collection";

export interface RestEnvVar {
  id: string;
  scope: RestEnvVarScope;
  scopeId: string; // env id, collection id, or "global"
  key: string;
  value: string | null;
  isSecret: boolean;
  secretHandleId: string | null;
  updatedAt: number;
}
