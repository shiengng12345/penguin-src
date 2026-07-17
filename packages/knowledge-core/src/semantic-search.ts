import type { EmbeddingProvider } from "./embedding-provider.js";
import { createHash } from "node:crypto";
import { sanitizeUntrustedText } from "./content-safety.js";
export interface SemanticDocument { id: string; text: string; locator: unknown; }
export interface SemanticHit { id: string; locator: unknown; similarity: number; status: "inference"; modelId: string; }
const QUERY_CACHE_LIMIT = 256;
const queryCache = new Map<string, Float32Array>();
const documentCache = new Map<string, Float32Array>();
function cosine(a: Float32Array, b: Float32Array): number { let dot = 0; let aa = 0; let bb = 0; for (let i = 0; i < Math.min(a.length, b.length); i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; } return aa && bb ? dot / Math.sqrt(aa * bb) : 0; }
export async function semanticSearch(provider: EmbeddingProvider, query: string, documents: SemanticDocument[], limit = 50): Promise<SemanticHit[]> {
  const normalized = sanitizeUntrustedText(query.trim().replace(/\s+/g, " ")).text;
  const cacheKey = `${provider.modelHash}:${normalized}`;
  let queryVector = queryCache.get(cacheKey);
  if (!queryVector) {
    queryVector = (await provider.embed([normalized]))[0];
    if (!queryVector) throw new Error("SEMANTIC_PROVIDER_INVALID_RESPONSE");
    queryCache.set(cacheKey, queryVector);
    while (queryCache.size > QUERY_CACHE_LIMIT) queryCache.delete(queryCache.keys().next().value!);
  }
  const safeDocuments = documents.map((document) => ({ ...document, text: sanitizeUntrustedText(document.text).text }));
  const documentVectors = new Array<Float32Array>(safeDocuments.length);
  const missing: Array<{ index: number; key: string; text: string }> = [];
  safeDocuments.forEach((document, index) => {
    const contentHash = createHash("sha256").update(document.text).digest("hex");
    const key = `${provider.modelHash}:${contentHash}`;
    const cached = documentCache.get(key);
    if (cached) documentVectors[index] = cached;
    else missing.push({ index, key, text: document.text });
  });
  if (missing.length) {
    const embedded = await provider.embed(missing.map((item) => item.text));
    if (embedded.length !== missing.length) throw new Error("SEMANTIC_PROVIDER_INVALID_RESPONSE");
    missing.forEach((item, index) => { documentCache.set(item.key, embedded[index]); documentVectors[item.index] = embedded[index]; });
    while (documentCache.size > QUERY_CACHE_LIMIT * 8) documentCache.delete(documentCache.keys().next().value!);
  }
  return safeDocuments.map((document, index) => ({ id: document.id, locator: document.locator, similarity: cosine(queryVector!, documentVectors[index] ?? new Float32Array()), status: "inference" as const, modelId: provider.modelId })).sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, limit);
}
