import type { EmbeddingProvider, LocalEmbeddingDescriptor } from "./embedding-provider.js";
import { inspectLocalEmbeddingDirectory } from "./embedding-provider.js";
import { embeddingSpaceIdentity, type EmbeddingSpaceIdentityResult } from "./semantic-identity.js";
import { canonicalJson, sha256Hex } from "./canonical.js";
import { SEMANTIC_CHUNKER_VERSION } from "./semantic-chunks.js";
import { statSync } from "node:fs";
import { join } from "node:path";

export interface LocalEmbeddingBackend {
  load(descriptor: LocalEmbeddingDescriptor): Promise<{
    embed(texts: string[]): Promise<Float32Array[]>;
    embedDocuments?(texts: string[]): Promise<Float32Array[]>;
    embedQuery?(text: string): Promise<Float32Array>;
    health?(): Promise<{ ok: boolean; reason?: string }>;
  }>;
}

export interface LocalEmbeddingProviderOptions {
  directory: string;
  backend: LocalEmbeddingBackend;
  chunkerVersion?: string;
  /**
   * Full model/tokenizer hashing is expensive for a large ONNX file. File
   * metadata is checked on every request and the full digest is rechecked at
   * this interval (or immediately when metadata changes).
   */
  identityCheckIntervalMs?: number;
}

export interface VerifiedLocalEmbeddingProvider extends EmbeddingProvider {
  descriptor: LocalEmbeddingDescriptor;
  spaceId: string;
  spaceIdentity: EmbeddingSpaceIdentityResult;
}

function preprocessingDigest(descriptor: LocalEmbeddingDescriptor): string {
  return sha256Hex(canonicalJson({
    version: "transformers-feature-extraction-v1",
    dtype: descriptor.dtype ?? "q8",
    documentPrefix: descriptor.documentPrefix ?? "search_document: ",
    queryPrefix: descriptor.queryPrefix ?? "search_query: ",
  }));
}

function embeddingSpaceFromDescriptor(
  descriptor: LocalEmbeddingDescriptor,
  chunkerVersion = SEMANTIC_CHUNKER_VERSION,
): EmbeddingSpaceIdentityResult {
  return embeddingSpaceIdentity({
    providerId: descriptor.providerId,
    modelId: descriptor.modelId,
    weightsDigest: descriptor.weightsDigest,
    tokenizerDigest: descriptor.tokenizerDigest,
    preprocessingDigest: preprocessingDigest(descriptor),
    dimensions: descriptor.dimensions,
    pooling: descriptor.pooling,
    normalization: descriptor.normalization,
    chunkerVersion,
  });
}

function localEmbeddingFileFingerprint(descriptor: LocalEmbeddingDescriptor): string {
  return [
    join(descriptor.directory, "manifest.json"),
    descriptor.modelPath,
    descriptor.tokenizerPath,
  ].map((path) => {
    const stat = statSync(path);
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }).join("|");
}

export function localEmbeddingSpaceIdentity(
  directory: string,
  chunkerVersion = SEMANTIC_CHUNKER_VERSION,
): EmbeddingSpaceIdentityResult {
  const descriptor = inspectLocalEmbeddingDirectory(directory);
  return embeddingSpaceFromDescriptor(descriptor, chunkerVersion);
}

function assertVectorBatch(vectors: Float32Array[], count: number, dimensions: number): Float32Array[] {
  if (vectors.length !== count || vectors.some((vector) => !(vector instanceof Float32Array) || vector.length !== dimensions || [...vector].some((value) => !Number.isFinite(value)))) throw new Error("LOCAL_EMBEDDING_RESPONSE_INVALID");
  return vectors;
}

function normalizeL2(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const magnitude = Math.sqrt(sum);
  if (!magnitude) return vector;
  return Float32Array.from(vector, (value) => value / magnitude);
}

/**
 * Open a verified local model through an injected inference backend. Keeping
 * the backend explicit prevents a test/hash-only model from being mistaken
 * for a production inference implementation; the future ONNX/llama adapter
 * must satisfy this same contract.
 */
export async function createLocalEmbeddingProvider(options: LocalEmbeddingProviderOptions): Promise<VerifiedLocalEmbeddingProvider> {
  const descriptor = inspectLocalEmbeddingDirectory(options.directory);
  const space = embeddingSpaceFromDescriptor(descriptor, options.chunkerVersion);
  const loaded = await options.backend.load(descriptor);
  const identityCheckIntervalMs = options.identityCheckIntervalMs ?? 60_000;
  if (!Number.isFinite(identityCheckIntervalMs) || identityCheckIntervalMs < 0) throw new Error("LOCAL_EMBEDDING_IDENTITY_INTERVAL_INVALID");
  let currentDescriptor = descriptor;
  let lastFingerprint = localEmbeddingFileFingerprint(descriptor);
  let lastFullCheckAt = Date.now();
  const verifyIdentity = (): void => {
    const now = Date.now();
    const fingerprint = localEmbeddingFileFingerprint(descriptor);
    if (fingerprint === lastFingerprint && now - lastFullCheckAt < identityCheckIntervalMs) return;
    currentDescriptor = inspectLocalEmbeddingDirectory(descriptor.directory);
    const currentSpace = embeddingSpaceFromDescriptor(currentDescriptor, options.chunkerVersion);
    if (currentSpace.identityHash !== space.identityHash) throw new Error("LOCAL_EMBEDDING_IDENTITY_CHANGED");
    lastFingerprint = localEmbeddingFileFingerprint(currentDescriptor);
    lastFullCheckAt = now;
  };
  const normalizeBatch = (vectors: Float32Array[], count: number): Float32Array[] => {
    const checked = assertVectorBatch(vectors, count, descriptor.dimensions);
    return descriptor.normalization.toLowerCase() === "l2" ? checked.map(normalizeL2) : checked;
  };
  const provider: VerifiedLocalEmbeddingProvider = {
    id: descriptor.providerId,
    modelId: descriptor.modelId,
    modelHash: space.identityHash,
    dimensions: descriptor.dimensions,
    maxTokens: descriptor.maxTokens,
    descriptor,
    spaceId: space.id,
    spaceIdentity: space,
    async embed(texts: string[]): Promise<Float32Array[]> {
      // Detect replacement/tampering after provider construction; vectors must
      // never be written under an identity that no longer describes the file.
      verifyIdentity();
      return normalizeBatch(await loaded.embed(texts), texts.length);
    },
    async health() {
      try {
        verifyIdentity();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: reason.includes("HASH_MISMATCH") ? "MODEL_HASH_MISMATCH" : reason };
      }
      return loaded.health ? loaded.health() : { ok: true };
    },
  };
  if (loaded.embedDocuments) {
    provider.embedDocuments = async (texts: string[]): Promise<Float32Array[]> => {
      verifyIdentity();
      return normalizeBatch(await loaded.embedDocuments!(texts), texts.length);
    };
  }
  if (loaded.embedQuery) {
    provider.embedQuery = async (text: string): Promise<Float32Array> => {
      verifyIdentity();
      return normalizeBatch([await loaded.embedQuery!(text)], 1)[0];
    };
  }
  return provider;
}
