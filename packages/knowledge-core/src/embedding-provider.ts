import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface EmbeddingProvider { id: string; modelId: string; modelHash: string; dimensions: number; maxTokens: number; embed(texts: string[]): Promise<Float32Array[]>; health(): Promise<{ ok: boolean; reason?: string }>; }

export interface RemoteEmbeddingProviderOptions {
  id: string; modelId: string; endpoint: string; dimensions: number; maxTokens: number;
  allowedHosts: string[]; acknowledgeCodeExfiltration: boolean; fetcher?: typeof fetch;
}

/** Opt-in remote embeddings: HTTPS, explicit host allow-list, and an explicit
 * acknowledgement that source text leaves the local machine. */
export function createRemoteEmbeddingProvider(options: RemoteEmbeddingProviderOptions): EmbeddingProvider & { dataExfiltrationWarning: string } {
  let endpoint: URL;
  try { endpoint = new URL(options.endpoint); } catch { throw new Error("REMOTE_EMBEDDING_ENDPOINT_INVALID"); }
  const host = endpoint.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (endpoint.protocol !== "https:" || !options.allowedHosts.map((item) => item.toLowerCase().replace(/\.$/, "")).includes(host)) throw new Error("REMOTE_EMBEDDING_ENDPOINT_NOT_ALLOWLISTED");
  if (!options.acknowledgeCodeExfiltration) throw new Error("REMOTE_EMBEDDING_CODE_EXFILTRATION_ACK_REQUIRED");
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0 || !Number.isInteger(options.maxTokens) || options.maxTokens <= 0) throw new Error("REMOTE_EMBEDDING_DIMENSIONS_INVALID");
  const fetcher = options.fetcher ?? fetch;
  const modelHash = createHash("sha256").update(`${options.id}:${options.modelId}:${endpoint.toString()}`).digest("hex");
  const dataExfiltrationWarning = "Remote embedding sends source text to an explicitly allow-listed provider; verify policy before enabling.";
  return {
    id: options.id, modelId: options.modelId, modelHash, dimensions: options.dimensions, maxTokens: options.maxTokens, dataExfiltrationWarning,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: options.modelId, input: texts }) });
      if (!response.ok) throw new Error(`REMOTE_EMBEDDING_FAILED_${response.status}`);
      const body = await response.json() as { embeddings?: unknown };
      if (!Array.isArray(body.embeddings) || body.embeddings.length !== texts.length || body.embeddings.some((row) => !Array.isArray(row) || row.length !== options.dimensions || row.some((item) => typeof item !== "number" || !Number.isFinite(item)))) throw new Error("REMOTE_EMBEDDING_RESPONSE_INVALID");
      return body.embeddings.map((row) => Float32Array.from(row as number[]));
    },
    async health() { return { ok: true }; },
  };
}

export interface LocalModelManifest {
  modelId: string;
  modelFile: string;
  sha256: string;
  dimensions: number;
  maxTokens: number;
}

export interface LocalModelDescriptor extends LocalModelManifest {
  directory: string;
  modelHash: string;
  modelPath: string;
}

/**
 * Validate a user-provided local model directory without downloading or
 * contacting a registry. The file hash is the only model identity allowed in
 * embedding keys; a changed file therefore cannot silently reuse old vectors.
 */
export function inspectLocalModelDirectory(directory: string): LocalModelDescriptor {
  const manifestPath = join(directory, "manifest.json");
  let manifest: LocalModelManifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as LocalModelManifest; } catch { throw new Error("LOCAL_MODEL_MANIFEST_INVALID"); }
  if (!manifest || typeof manifest.modelId !== "string" || !manifest.modelId || typeof manifest.modelFile !== "string" || !/^[a-zA-Z0-9._-]+$/.test(manifest.modelFile) || !/^[a-f0-9]{64}$/i.test(manifest.sha256) || !Number.isInteger(manifest.dimensions) || manifest.dimensions <= 0 || !Number.isInteger(manifest.maxTokens) || manifest.maxTokens <= 0) throw new Error("LOCAL_MODEL_MANIFEST_INVALID");
  const modelPath = join(directory, manifest.modelFile);
  let modelBytes: Buffer;
  try { modelBytes = readFileSync(modelPath); } catch { throw new Error("LOCAL_MODEL_FILE_MISSING"); }
  const modelHash = createHash("sha256").update(modelBytes).digest("hex");
  if (modelHash !== manifest.sha256.toLowerCase()) throw new Error("LOCAL_MODEL_HASH_MISMATCH");
  return { ...manifest, sha256: modelHash, directory, modelHash, modelPath };
}

export class UnavailableEmbeddingProvider implements EmbeddingProvider { id = "none"; modelId = "none"; modelHash = "none"; dimensions = 0; maxTokens = 0; async embed(): Promise<Float32Array[]> { throw new Error("SEMANTIC_UNAVAILABLE"); } async health(): Promise<{ ok: boolean; reason: string }> { return { ok: false, reason: "no local embedding provider configured" }; } }
