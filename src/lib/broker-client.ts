// Thin typed wrapper over the broker Tauri commands (Task 14,
// src-tauri/src/broker/commands.rs). The webview never talks to Pulsar
// directly and never holds a token — only a connection id.
//
// `broker_upsert_connection` takes a full `ConnectionDto` on the Rust side,
// not the trimmed `BrokerConnectionDraft` the Phase 0 brief sketched: `id`
// is required (the frontend generates ids, same as every other upsert
// command in this codebase), and `lastStatus` / `createdAt` / `updatedAt`
// are plain (non-Option) fields with no `#[serde(default)]`, so they must be
// present in the JSON even though the command ignores them and recomputes
// them from the existing row (or `now_ms()` for a new one). `upsertConnection`
// fills in those ignored placeholders so callers only ever deal with the
// clean `BrokerConnectionDraft` shape.
import { invoke } from "@tauri-apps/api/core";
import type {
  BrokerConnection,
  BrokerConnectionDraft,
  CapabilitySnapshot,
  Page,
  PageQuery,
  ResultEnvelope,
  TopicSummary,
} from "@penguin/broker-contracts";

export function listConnections(): Promise<BrokerConnection[]> {
  return invoke("broker_list_connections");
}

/** `secret` is sent once and goes straight to the keychain. It is never returned. */
export function upsertConnection(
  id: string,
  draft: BrokerConnectionDraft,
  existing?: BrokerConnection,
): Promise<BrokerConnection> {
  const { secret, ...rest } = draft;
  const wireDraft = {
    id,
    ...rest,
    // Ignored by the Rust command (it recomputes these from the existing
    // row, or from `now_ms()` for a brand-new connection) but required by
    // `ConnectionDto`'s deserializer, which has no defaults for them.
    lastStatus: existing?.lastStatus ?? "unknown",
    lastCheckedAt: existing?.lastCheckedAt ?? null,
    brokerVersion: existing?.brokerVersion ?? null,
    capabilities: existing?.capabilities ?? null,
    createdAt: existing?.createdAt ?? 0,
    updatedAt: existing?.updatedAt ?? 0,
  };
  return invoke("broker_upsert_connection", { draft: wireDraft, secret: secret ?? null });
}

export function deleteConnection(connectionId: string): Promise<void> {
  return invoke("broker_delete_connection", { connectionId });
}

export function testConnection(connectionId: string): Promise<ResultEnvelope<CapabilitySnapshot>> {
  return invoke("broker_test_connection", { connectionId });
}

export function listTopics(
  connectionId: string,
  tenant: string,
  namespace: string,
  query: PageQuery,
): Promise<ResultEnvelope<Page<TopicSummary>>> {
  return invoke("broker_list_topics", { connectionId, tenant, namespace, query });
}
