import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { KnowledgeStore } from "./store.js";
import { GitTopologyStore } from "./git-topology-store.js";
import { SourceSnapshotStore } from "./source-cow.js";
import { SourceStore } from "./source-store.js";
import { SCHEMA_VERSION } from "./schema.js";

export type ExternalKnowledgeSourceType = "markdown_directory" | "url" | "postgres_schema" | "openapi";
export interface ExternalKnowledgeSource { id: string; type: ExternalKnowledgeSourceType; location: string; config: Record<string, unknown>; status: "registered" | "synced" | "stale" | "blocked"; contentHash?: string; finalUrl?: string; contentType?: string; retrievedAt?: string; licenseWarning?: string; createdAt: string; }

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host === "metadata.google.internal" || host === "metadata") return true;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^(fc|fd|fe80)/i.test(host)) return true;
  return false;
}
export function validateExternalLocation(type: ExternalKnowledgeSourceType, location: string, allowHosts: string[] = []): void {
  if (!location.trim()) throw new Error("EXTERNAL_LOCATION_REQUIRED");
  if (type === "url" || type === "openapi") {
    let parsed: URL;
    try { parsed = new URL(location); } catch { throw new Error("EXTERNAL_URL_INVALID"); }
    if (parsed.protocol !== "https:") throw new Error("EXTERNAL_URL_HTTPS_REQUIRED");
    const allowed = new Set(allowHosts.map((host) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "")));
    const normalizedHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (blockedHostname(parsed.hostname) && !allowed.has(normalizedHost)) throw new Error("EXTERNAL_URL_SSRF_BLOCKED");
    if (parsed.username || parsed.password) throw new Error("EXTERNAL_URL_CREDENTIALS_FORBIDDEN");
  }
}

export interface MarkdownDirectorySyncResult {
  source: ExternalKnowledgeSource;
  repoId: string;
  branchId: string;
  snapshotId: string;
  files: number;
}

export function fingerprintMarkdownDirectory(location: string): { fingerprint: string; files: string[] } {
  if (!statSync(location, { throwIfNoEntry: false })?.isDirectory()) throw new Error("EXTERNAL_SOURCE_DIRECTORY_UNAVAILABLE");
  const paths: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.(md|markdown|canvas)$/i.test(entry.name)) paths.push(path);
    }
  };
  walk(location); paths.sort();
  const digest = createHash("sha256");
  for (const path of paths) { digest.update(relative(location, path)); digest.update(readFileSync(path)); }
  return { fingerprint: digest.digest("hex"), files: paths };
}

/** Sync a local Markdown/Canvas vault into the same immutable source corpus
 * used by repository indexing. It deliberately does not parse or execute
 * arbitrary content; the source lane remains the evidence boundary. */
export function syncMarkdownDirectory(store: KnowledgeStore, sourceId: string): MarkdownDirectorySyncResult {
  const manager = new ExternalSourceStore(store);
  const source = manager.list().find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error("EXTERNAL_SOURCE_NOT_FOUND");
  if (source.type !== "markdown_directory") throw new Error("EXTERNAL_SYNC_REQUIRES_EXPLICIT_EXECUTION");
  const fingerprinted = fingerprintMarkdownDirectory(source.location);
  const paths = fingerprinted.files;
  const fingerprintHex = fingerprinted.fingerprint;
  const repoId = store.registerRepo({ name: `external:${source.id}`, rootPath: source.location });
  const branchId = store.registerBranch({ repoId, name: "main", checkoutPath: source.location, status: "snapshot" });
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({
    snapshotKey: `external:${source.id}:${fingerprintHex}:schema-${SCHEMA_VERSION}`,
    repoId,
    worktreeFingerprint: fingerprintHex,
    parserVersion: "external-source-v1",
    resolverVersion: "external-source-v1",
    schemaVersion: SCHEMA_VERSION,
  });
  if (snapshot.state === "ready") {
    const synced = manager.markSynced(source.id, { content: fingerprintHex, licenseWarning: "external Markdown is untrusted; verify before relying on it" });
    return { source: synced, repoId, branchId, snapshotId: snapshot.id, files: paths.length };
  }
  if (snapshot.state === "failed" || snapshot.state === "cold") {
    store.db.prepare("UPDATE revision_snapshots SET state='building', failure_reason=NULL, last_accessed_at=? WHERE id=?").run(new Date().toISOString(), snapshot.id);
  }
  const sourceStore = new SourceStore(store);
  const manifest = new Map<string, string>();
  for (const path of paths) {
    const raw = readFileSync(path);
    const contentHash = createHash("sha256").update(raw).digest("hex");
    const decoded = raw.toString("utf8");
    const sourceBlobId = sourceStore.putBlob({ contentHash, rawBytes: raw, decodedContent: decoded, encoding: "utf8" });
    const filePath = relative(source.location, path).replaceAll("\\", "/");
    const sourceFactId = sourceStore.putSourceFact({ repoId, filePath, factFingerprint: `external-v1:${contentHash}`, contentHash, sourceBlobId, coverage: { status: "admitted", reasonCode: "external_markdown", classification: "documentation", byteSize: raw.byteLength, encoding: "utf8" } });
    manifest.set(filePath, sourceFactId);
  }
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [...manifest.entries()].map(([path, sourceFactId]) => ({ op: "add" as const, path, sourceFactId })));
  cow.materializeManifest(snapshot.id);
  cow.assertManifestMatches(snapshot.id, manifest);
  if (snapshot.state === "building") topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: null });
  const synced = manager.markSynced(source.id, { content: fingerprintHex, licenseWarning: "external Markdown is untrusted; verify before relying on it" });
  return { source: synced, repoId, branchId, snapshotId: snapshot.id, files: paths.length };
}

export interface RemoteSyncResult { source: ExternalKnowledgeSource; repoId: string; branchId: string; snapshotId: string; bytes: number; contentType: string; finalUrl: string; }
type RemoteResponse = { status: number; headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer> };
type RemoteFetcher = (url: string, init: { redirect: "manual" }) => Promise<RemoteResponse>;

function remoteText(bytes: Uint8Array, contentType: string): string {
  const raw = Buffer.from(bytes).toString("utf8");
  if (!contentType.toLowerCase().includes("html")) return raw;
  return raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, text: string) => `\n${"#".repeat(Number(level))} ${text.replace(/<[^>]+>/g, "").trim()}\n`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, text: string) => `[${text.replace(/<[^>]+>/g, "").trim()}](${href})`)
    .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\n{3,}/g, "\n\n").trim();
}

export async function syncRemoteSource(store: KnowledgeStore, sourceId: string, fetcher: RemoteFetcher = (globalThis.fetch as unknown as RemoteFetcher)): Promise<RemoteSyncResult> {
  const manager = new ExternalSourceStore(store);
  const source = manager.list().find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error("EXTERNAL_SOURCE_NOT_FOUND");
  if (source.type !== "url" && source.type !== "openapi") throw new Error("EXTERNAL_REMOTE_SOURCE_REQUIRED");
  const allowHosts = Array.isArray(source.config.allowHosts) ? source.config.allowHosts.map(String) : [];
  let current = source.location;
  let response: RemoteResponse | undefined;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    validateExternalLocation(source.type, current, allowHosts);
    response = await fetcher(current, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("EXTERNAL_REDIRECT_LOCATION_MISSING");
      if (redirects === 5) throw new Error("EXTERNAL_REDIRECT_LIMIT");
      current = new URL(location, current).toString();
      continue;
    }
    break;
  }
  if (!response || response.status < 200 || response.status >= 300) throw new Error(`EXTERNAL_FETCH_FAILED_${response?.status ?? "NO_RESPONSE"}`);
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 5 * 1024 * 1024) throw new Error("EXTERNAL_RESPONSE_TOO_LARGE");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 5 * 1024 * 1024) throw new Error("EXTERNAL_RESPONSE_TOO_LARGE");
  const rawHash = createHash("sha256").update(bytes).digest("hex");
  const repoId = store.registerRepo({ name: `external:${source.id}`, rootPath: `external://${source.id}` });
  const branchId = store.registerBranch({ repoId, name: "main", checkoutPath: `external://${source.id}`, status: "snapshot" });
  const topology = new GitTopologyStore(store);
  const snapshot = topology.createBuildingSnapshot({ snapshotKey: `external:${source.id}:${rawHash}:schema-${SCHEMA_VERSION}`, repoId, worktreeFingerprint: rawHash, parserVersion: "external-remote-v1", resolverVersion: "external-remote-v1", schemaVersion: SCHEMA_VERSION });
  if (snapshot.state === "ready") {
    const synced = manager.markSynced(source.id, { content: rawHash, finalUrl: current, contentType, licenseWarning: "external content is untrusted; verify license and provenance" });
    return { source: synced, repoId, branchId, snapshotId: snapshot.id, bytes: bytes.byteLength, contentType, finalUrl: current };
  }
  if (snapshot.state !== "building") store.db.prepare("UPDATE revision_snapshots SET state='building', failure_reason=NULL, last_accessed_at=? WHERE id=?").run(new Date().toISOString(), snapshot.id);
  const sourceStore = new SourceStore(store);
  const sourceBlobId = sourceStore.putBlob({ contentHash: rawHash, rawBytes: bytes, decodedContent: remoteText(bytes, contentType), encoding: "utf8" });
  const filePath = source.type === "openapi" ? "openapi.json" : "index.md";
  const sourceFactId = sourceStore.putSourceFact({ repoId, filePath, factFingerprint: `external-remote-v1:${rawHash}`, contentHash: rawHash, sourceBlobId, coverage: { status: "admitted", reasonCode: "external_remote", classification: "documentation", byteSize: bytes.byteLength, encoding: "utf8", contentType, finalUrl: current } });
  const cow = new SourceSnapshotStore(store);
  cow.replaceOverlay(snapshot.id, [{ op: "add", path: filePath, sourceFactId }]);
  cow.materializeManifest(snapshot.id);
  if (snapshot.state === "building") topology.markSnapshotReady(snapshot.id);
  topology.publishSnapshot({ branchId, snapshotId: snapshot.id, headCommit: null });
  const synced = manager.markSynced(source.id, { content: rawHash, finalUrl: current, contentType, licenseWarning: "external content is untrusted; verify license and provenance" });
  return { source: synced, repoId, branchId, snapshotId: snapshot.id, bytes: bytes.byteLength, contentType, finalUrl: current };
}

export class ExternalSourceStore {
  constructor(private readonly store: KnowledgeStore) {}
  register(input: { type: ExternalKnowledgeSourceType; location: string; config?: Record<string, unknown>; allowHosts?: string[] }): ExternalKnowledgeSource {
    validateExternalLocation(input.type, input.location, input.allowHosts);
    const now = new Date().toISOString(); const id = `external_${randomUUID()}`;
    const config = { ...(input.config ?? {}), ...(input.allowHosts?.length ? { allowHosts: [...input.allowHosts] } : {}) };
    const source: ExternalKnowledgeSource = { id, type: input.type, location: input.location, config, status: "registered", createdAt: now };
    this.store.db.prepare("INSERT INTO external_knowledge_sources(id,source_type,location,config_json,status,created_at) VALUES (?,?,?,?,?,?)").run(id, source.type, source.location, JSON.stringify(source.config), source.status, now);
    return source;
  }
  list(): ExternalKnowledgeSource[] { return (this.store.db.prepare("SELECT * FROM external_knowledge_sources ORDER BY created_at").all() as Array<Record<string, string | null>>).map((row) => ({ id: String(row.id), type: row.source_type as ExternalKnowledgeSourceType, location: String(row.location), config: JSON.parse(String(row.config_json)), status: row.status as ExternalKnowledgeSource["status"], ...(row.content_hash ? { contentHash: row.content_hash } : {}), ...(row.final_url ? { finalUrl: row.final_url } : {}), ...(row.content_type ? { contentType: row.content_type } : {}), ...(row.retrieved_at ? { retrievedAt: row.retrieved_at } : {}), ...(row.license_warning ? { licenseWarning: row.license_warning } : {}), createdAt: String(row.created_at) })); }
  remove(id: string): void { this.store.db.prepare("DELETE FROM external_knowledge_sources WHERE id=?").run(id); }
  markSynced(id: string, input: { content: string; finalUrl?: string; contentType?: string; licenseWarning?: string }): ExternalKnowledgeSource {
    const source = this.list().find((candidate) => candidate.id === id);
    if (!source) throw new Error("EXTERNAL_SOURCE_NOT_FOUND");
    if ((source.type === "url" || source.type === "openapi") && input.finalUrl) {
      const allowHosts = Array.isArray(source.config.allowHosts) ? source.config.allowHosts.map(String) : [];
      validateExternalLocation(source.type, input.finalUrl, allowHosts);
    }
    const hash = createHash("sha256").update(input.content).digest("hex");
    this.store.db.prepare("UPDATE external_knowledge_sources SET status='synced',content_hash=?,final_url=?,content_type=?,retrieved_at=?,license_warning=? WHERE id=?")
      .run(hash, input.finalUrl ?? null, input.contentType ?? null, new Date().toISOString(), input.licenseWarning ?? "external content is untrusted", id);
    return this.list().find((candidate) => candidate.id === id)!;
  }
}
