import { canonicalJson, sha256Hex } from "./canonical.js";

export interface ChunkIdentityInput {
  repoId: string;
  snapshotId: string;
  canonicalFilePath: string;
  nodeId?: string;
  startByte: number;
  endByte: number;
  contentHash: string;
  chunkerVersion: string;
}

export interface ChunkIdentity {
  id: string;
  identityHash: string;
  provenance: ChunkIdentityInput;
}

export interface EmbeddingSpaceIdentity {
  providerId: string;
  modelId: string;
  weightsDigest: string;
  tokenizerDigest: string;
  /** Hash of role prefixes and inference preprocessing that shape vectors. */
  preprocessingDigest?: string;
  dimensions: number;
  pooling: string;
  normalization: string;
  chunkerVersion: string;
}

export interface EmbeddingSpaceIdentityResult extends Omit<EmbeddingSpaceIdentity, "preprocessingDigest"> {
  preprocessingDigest: string;
  id: string;
  identityHash: string;
}

function requireText(value: string, code: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(code);
  return value;
}

function requireDigest(value: string, code: string): string {
  requireText(value, code);
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(code);
  return value.toLowerCase();
}

export function chunkIdentity(input: ChunkIdentityInput): ChunkIdentity {
  const normalized: ChunkIdentityInput = {
    repoId: requireText(input.repoId, "SEMANTIC_CHUNK_REPO_INVALID"),
    snapshotId: requireText(input.snapshotId, "SEMANTIC_CHUNK_SNAPSHOT_INVALID"),
    canonicalFilePath: requireText(input.canonicalFilePath.replaceAll("\\", "/").replace(/^\.\//, ""), "SEMANTIC_CHUNK_PATH_INVALID"),
    ...(input.nodeId === undefined ? {} : { nodeId: requireText(input.nodeId, "SEMANTIC_CHUNK_NODE_INVALID") }),
    startByte: input.startByte,
    endByte: input.endByte,
    contentHash: requireDigest(input.contentHash, "SEMANTIC_CHUNK_CONTENT_HASH_INVALID"),
    chunkerVersion: requireText(input.chunkerVersion, "SEMANTIC_CHUNKER_VERSION_INVALID"),
  };
  if (!Number.isInteger(normalized.startByte) || normalized.startByte < 0 || !Number.isInteger(normalized.endByte) || normalized.endByte <= normalized.startByte) {
    throw new Error("SEMANTIC_CHUNK_RANGE_INVALID");
  }
  const identityHash = sha256Hex(canonicalJson(normalized));
  return { id: `chunk_${identityHash}`, identityHash, provenance: normalized };
}

export function embeddingSpaceIdentity(input: EmbeddingSpaceIdentity): EmbeddingSpaceIdentityResult {
  const normalized: Required<EmbeddingSpaceIdentity> = {
    providerId: requireText(input.providerId, "SEMANTIC_PROVIDER_ID_INVALID"),
    modelId: requireText(input.modelId, "SEMANTIC_MODEL_ID_INVALID"),
    weightsDigest: requireDigest(input.weightsDigest, "SEMANTIC_WEIGHTS_DIGEST_INVALID"),
    tokenizerDigest: requireDigest(input.tokenizerDigest, "SEMANTIC_TOKENIZER_DIGEST_INVALID"),
    preprocessingDigest: input.preprocessingDigest === undefined
      ? sha256Hex(canonicalJson({ version: "legacy-default-v1" }))
      : requireDigest(input.preprocessingDigest, "SEMANTIC_PREPROCESSING_DIGEST_INVALID"),
    dimensions: input.dimensions,
    pooling: requireText(input.pooling, "SEMANTIC_POOLING_INVALID"),
    normalization: requireText(input.normalization, "SEMANTIC_NORMALIZATION_INVALID"),
    chunkerVersion: requireText(input.chunkerVersion, "SEMANTIC_CHUNKER_VERSION_INVALID"),
  };
  if (!Number.isInteger(normalized.dimensions) || normalized.dimensions <= 0) throw new Error("SEMANTIC_DIMENSIONS_INVALID");
  const identityHash = sha256Hex(canonicalJson(normalized));
  return { ...normalized, id: `space_${identityHash}`, identityHash };
}
