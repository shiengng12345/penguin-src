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
  NamespaceSummary,
  OverviewReport,
  Page,
  PageQuery,
  ResultEnvelope,
  TenantSummary,
  TopicDetail,
  TopicSummary,
} from "@penguin/broker-contracts";

export function listConnections(): Promise<BrokerConnection[]> {
  return invoke("broker_list_connections");
}

/** `secret` is sent once and goes straight to the keychain adapter (whose
 *  production implementation stores the plaintext in the app's own SQLite
 *  `app_kv` table, not an OS-level keychain). It is never returned — this
 *  module only ever sees `secretHandleId`. */
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

/** `refresh: true` bypasses reading the snapshot cache and forces a fresh
 *  read from the broker for this tenant/namespace. It does NOT discard the
 *  cached row: the row is deliberately left in place so that if the refetch
 *  itself fails, the last known list can still be served (as `source:
 *  "cache"`, with a warning) instead of leaving the screen blank. A
 *  successful refetch overwrites the row on its own. */
export function listTopics(
  connectionId: string,
  tenant: string,
  namespace: string,
  query: PageQuery,
  refresh = false,
): Promise<ResultEnvelope<Page<TopicSummary>>> {
  return invoke("broker_list_topics", { connectionId, tenant, namespace, query, refresh });
}

/** Same `refresh` semantics as `listTopics`: bypasses the cache read without
 *  discarding the cached row, so a failed refresh still serves the last
 *  known list. */
export function listTenants(
  connectionId: string,
  refresh = false,
): Promise<ResultEnvelope<TenantSummary[]>> {
  return invoke("broker_list_tenants", { connectionId, refresh });
}

export function listNamespaces(
  connectionId: string,
  tenant: string,
  refresh = false,
): Promise<ResultEnvelope<NamespaceSummary[]>> {
  return invoke("broker_list_namespaces", { connectionId, tenant, refresh });
}

/** Never reads or writes the snapshot cache — `stats`/`internalStats` are
 *  the live numbers read during triage, not something a connection
 *  refresh/cache TTL should ever apply to. There is no `refresh` parameter
 *  here for that reason: every call is already live. */
export function getTopicDetail(
  connectionId: string,
  tenant: string,
  namespace: string,
  topic: string,
  persistent: boolean,
): Promise<ResultEnvelope<TopicDetail>> {
  return invoke("broker_get_topic_detail", { connectionId, tenant, namespace, topic, persistent });
}

/** The topic *list* behind this may be served from the cache (it is
 *  structural, same as `listTopics`); every per-topic stats read used to
 *  derive `anomalies`/`indeterminate` is always live. `topicsSampled` /
 *  `topicsTotal` / `truncated` tell the caller whether this covers the
 *  whole namespace or only its first `topicsSampled` topics. */
export function getOverview(connectionId: string): Promise<ResultEnvelope<OverviewReport>> {
  return invoke("broker_get_overview", { connectionId });
}
