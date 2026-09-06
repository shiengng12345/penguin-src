import type { SearchHit } from "@penguin/knowledge-contracts";
import type { KnowledgeStore } from "./store.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import { VectorStore, type VectorHit } from "./vector-store.js";
import { sanitizeUntrustedText } from "./content-safety.js";
import type { ResolvedRevisionScope } from "./source-search.js";

export interface HybridSearchConfig {
  rrfK: number;
  lexicalLimit: number;
  vectorLimit: number;
  exactPin: boolean;
  activeSpaceId?: string;
  rankerVersion: string;
}

export interface RetrievalProvenance {
  lanes: Array<{ lane: "exact" | "source" | "symbol" | "graph" | "vector"; rank: number; score?: number }>;
  embeddingSpaceId?: string;
  chunkId?: string;
  retrievalFingerprint: string;
}

export interface PersistedVectorSearchInput {
  store: KnowledgeStore;
  provider: EmbeddingProvider;
  query: string;
  scopes: ResolvedRevisionScope[];
  pathPrefixes?: string[];
  limit?: number;
  signal?: AbortSignal;
}

export interface PersistedVectorSearchResult {
  hits: SearchHit[];
  queryEmbeddings: number;
  activeGenerations: string[];
}

function pathMatches(path: string, prefixes: string[] | undefined): boolean {
  if (!prefixes?.length) return true;
  return prefixes.some((prefix) => {
    const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
    return path === normalized || path.startsWith(`${normalized}/`);
  });
}

function fingerprint(value: unknown): string {
  let text = JSON.stringify(value);
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, "0");
}

const CODE_TOKEN_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "code", "does", "file", "for", "from",
  "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "was", "where", "which",
]);

function normalizeCodeToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 4) return token.slice(0, -1);
  return token;
}

// Code questions often describe a concept with a natural-language word while
// the implementation uses its evidence/storage vocabulary. Canonicalizing
// both sides keeps this as a symmetric, bounded rerank signal rather than a
// query-specific boost or an assertion that a vector hit is proof.
const CODE_TOKEN_ALIASES = new Map([
  ["authoritative", "evidence"], ["truth", "evidence"], ["verified", "evidence"],
  ["relationship", "edge"], ["link", "edge"], ["links", "edge"],
  ["kept", "store"], ["stored", "store"], ["storage", "store"], ["persisted", "store"],
  ["rejected", "reject"], ["rejects", "reject"], ["invalid", "reject"],
  ["computed", "calculate"], ["calculated", "calculate"], ["calculation", "calculate"],
]);

const GENERIC_PATH_TOKENS = new Set(["src", "packages", "test", "tests", "file", "code", "data", "value"]);

function canonicalCodeToken(token: string): string {
  const normalized = normalizeCodeToken(token);
  return CODE_TOKEN_ALIASES.get(normalized) ?? normalized;
}

function codeTokens(value: string): Set<string> {
  const expanded = value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .toLowerCase();
  const tokens = new Set<string>();
  for (const raw of expanded.match(/[a-z0-9]+/gu) ?? []) {
    const token = canonicalCodeToken(raw);
    if (token.length < 2 || CODE_TOKEN_STOP_WORDS.has(token)) continue;
    tokens.add(token);
    // gRPC is the conventional spelling of RPC over HTTP/2. Preserve both
    // forms so natural-language RPC questions can find GrpcMethod handlers.
    if (token === "grpc") tokens.add("rpc");
    // Controller/handler/route paths are strong endpoint ownership evidence.
    if (token === "controller" || token === "handler" || token === "route") tokens.add("endpoint");
  }
  return tokens;
}

function codeTokenAffinity(query: string, document: string): number {
  const queryTokens = codeTokens(query);
  if (!queryTokens.size) return 0;
  const documentTokens = codeTokens(document);
  let matches = 0;
  for (const token of queryTokens) if (documentTokens.has(token)) matches += 1;
  return matches / queryTokens.size;
}

function pathTokenAffinity(query: string, filePath: string): number {
  const queryTokens = codeTokens(query);
  if (!queryTokens.size) return 0;
  const pathTokens = codeTokens(filePath);
  for (const token of queryTokens) {
    if (!GENERIC_PATH_TOKENS.has(token) && pathTokens.has(token)) return 1;
  }
  return 0;
}

interface ResolvedVectorCandidate {
  vector: VectorHit;
  row: {
    repoId: string;
    repoName: string;
    snapshotId: string;
    canonicalFilePath: string | null;
    startByte: number | null;
    endByte: number | null;
    contentHash: string;
    filePath: string;
    effectiveSnapshotId: string | null;
    sourceText: string | null;
  };
  affinity: number;
  pathAffinity: number;
  rerankScore: number;
}

type VectorCandidateRow = ResolvedVectorCandidate["row"] & { chunkId: string };

function resolvedVectorCandidate(hit: VectorHit, row: VectorCandidateRow, query: string): ResolvedVectorCandidate | null {
  if (!row || !row.repoId || !row.snapshotId || !row.filePath) return null;
  const source = row.sourceText && row.startByte !== null && row.endByte !== null
    ? Buffer.from(row.sourceText, "utf8").subarray(row.startByte, row.endByte).toString("utf8")
    : "";
  const affinity = codeTokenAffinity(query, `${row.filePath}\n${row.canonicalFilePath ?? ""}\n${source}`);
  const pathAffinity = pathTokenAffinity(query, row.filePath);
  // Vector similarity remains the evidence score. Bounded code-token and
  // distinctive-path affinities only rerank the over-fetched candidate set,
  // making identifiers, paths, snake_case, and camelCase useful without
  // allowing lexical evidence to masquerade as semantic proof.
  return {
    vector: hit,
    row,
    affinity,
    pathAffinity,
    rerankScore: hit.similarity + Math.min(0.12, affinity * 0.12) + pathAffinity * 0.06,
  };
}

function resolveVectorCandidates(store: KnowledgeStore, hits: VectorHit[], query: string): ResolvedVectorCandidate[] {
  if (!hits.length) return [];
  const ids = [...new Set(hits.map((hit) => hit.chunkId))];
  const rows = store.db.prepare(`
    SELECT c.repo_id AS repoId,c.snapshot_id AS snapshotId,c.canonical_file_path AS canonicalFilePath,
           c.start_byte AS startByte,c.end_byte AS endByte,c.text_hash AS contentHash,
           c.id AS chunkId,
           COALESCE(e.file_path,c.canonical_file_path) AS filePath,
           COALESCE(e.snapshot_id,c.snapshot_id) AS effectiveSnapshotId,
           COALESCE(r.name,c.repo_id) AS repoName,b.decoded_content AS sourceText
      FROM semantic_chunks c
      LEFT JOIN effective_snapshot_sources e ON e.source_blob_id=c.source_blob_id AND e.snapshot_id=c.snapshot_id
      LEFT JOIN source_blobs b ON b.id=c.source_blob_id
      LEFT JOIN repos r ON r.id=c.repo_id
     WHERE c.id IN (${ids.map(() => "?").join(",")})
  `).all(...ids) as VectorCandidateRow[];
  const byId = new Map(rows.map((row) => [row.chunkId, row]));
  return hits
    .map((hit) => {
      const row = byId.get(hit.chunkId);
      return row ? resolvedVectorCandidate(hit, row, query) : null;
    })
    .filter((candidate): candidate is ResolvedVectorCandidate => candidate !== null);
}

function vectorCandidateToSearchHit(candidate: ResolvedVectorCandidate, rank: number, spaceId?: string): SearchHit {
  const { vector: hit, row } = candidate;
  const locator = {
    repoId: row.repoId,
    repoName: row.repoName,
    revisionId: row.effectiveSnapshotId ?? row.snapshotId,
    revisionKind: "commit" as const,
    filePath: row.filePath,
    ...(row.startByte == null ? {} : { startByte: row.startByte }),
    ...(row.endByte == null ? {} : { endByte: row.endByte }),
    offsetEncoding: "utf8_normalized" as const,
  };
  const provenance: RetrievalProvenance = {
    lanes: [{ lane: "vector", rank, score: hit.similarity }],
    ...(spaceId ? { embeddingSpaceId: spaceId } : {}),
    chunkId: hit.chunkId,
    retrievalFingerprint: fingerprint([hit.chunkId, hit.generationId ?? null, hit.spaceId ?? null, rank]),
  };
  return {
    hitId: `vector_${fingerprint([hit.chunkId, hit.generationId ?? null])}`,
    kind: "source_occurrence",
    lane: "vector",
    title: row.filePath,
    locator,
    score: hit.similarity,
    rankReasons: [
      `persisted vector similarity ${hit.similarity.toFixed(4)}`,
      ...(candidate.affinity > 0 ? [`code-token affinity ${candidate.affinity.toFixed(3)} used for bounded candidate reranking`] : []),
      ...(candidate.pathAffinity > 0 ? ["distinctive path affinity used for bounded candidate reranking"] : []),
      "vector is a recall candidate; exact/source lanes retain truth precedence",
    ],
    untrustedContent: true,
    evidence: [{ source: "semantic", locator, contentHash: row.contentHash, status: "inference" }],
    ...(provenance ? { retrievalProvenance: provenance } : {}),
  } as SearchHit & { retrievalProvenance: RetrievalProvenance };
}

/** Query one vector per request and read only ready rows from active spaces. */
export async function searchPersistedVectors(input: PersistedVectorSearchInput): Promise<PersistedVectorSearchResult> {
  if (input.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
  const normalized = sanitizeUntrustedText(input.query.trim().replace(/\s+/gu, " ")).text;
  const queryVector = input.provider.embedQuery
    ? await input.provider.embedQuery(normalized)
    : (await input.provider.embed([normalized]))[0];
  if (!queryVector) throw new Error("SEMANTIC_PROVIDER_INVALID_RESPONSE");
  const vectorStore = new VectorStore(input.store);
  const raw: Array<{ hit: VectorHit; scopeKey: string }> = [];
  const activeGenerations: string[] = [];
  const requestedLimit = input.limit ?? 50;
  // Over-fetch before file diversification. Otherwise several adjacent
  // chunks from one large implementation file can occupy the whole page and
  // hide a stronger result from another file.
  // File diversification happens after provenance resolution.  A small
  // candidate page can discard the only chunk for a relevant file before
  // diversification (especially when a few implementation files contain
  // many adjacent chunks), so keep a bounded but materially wider recall
  // window.  The public result remains capped at `requestedLimit`.
  const vectorCandidateLimit = Math.max(50, requestedLimit * 10);
  for (const scope of input.scopes) {
    if (input.signal?.aborted) throw Object.assign(new Error("SEARCH_CANCELLED"), { code: "SEARCH_CANCELLED" });
    const scopeKey = `repo:${scope.repoId ?? ""}`;
    const active = input.store.db.prepare("SELECT generation_id AS generationId FROM semantic_active_spaces WHERE scope_key=?").get(scopeKey) as { generationId: string } | undefined;
    if (!active) continue;
    activeGenerations.push(active.generationId);
    for (const hit of vectorStore.search(input.provider.modelHash, queryVector, vectorCandidateLimit, { generationId: active.generationId, activeScopeKey: scopeKey, snapshotIds: [scope.snapshotId] })) raw.push({ hit, scopeKey });
  }
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const hitsPerFile = new Map<string, number>();
  const candidates = resolveVectorCandidates(input.store, raw.map((item) => item.hit), normalized)
    .sort((a, b) => b.rerankScore - a.rerankScore || b.vector.similarity - a.vector.similarity || a.vector.chunkId.localeCompare(b.vector.chunkId));
  const debugTerms = (process.env.PENGUIN_SEMANTIC_DEBUG_QUERIES ?? "")
    .split("|")
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const semanticDebugEnabled = process.env.PENGUIN_SEMANTIC_DEBUG === "1"
    && (!debugTerms.length || debugTerms.some((term) => normalized.toLowerCase().includes(term)));
  if (semanticDebugEnabled) {
    process.stderr.write(`${JSON.stringify({
      query: normalized,
      candidates: candidates.map((candidate) => ({
        path: candidate.row.filePath,
        similarity: candidate.vector.similarity,
        affinity: candidate.affinity,
        pathAffinity: candidate.pathAffinity,
        rerankScore: candidate.rerankScore,
      })),
    })}\n`);
  }
  for (const [index, candidate] of candidates.entries()) {
    const hit = vectorCandidateToSearchHit(candidate, index + 1, candidate.vector.spaceId);
    if (!pathMatches(hit.locator.filePath, input.pathPrefixes) || seen.has(hit.hitId)) continue;
    const fileCount = hitsPerFile.get(hit.locator.filePath) ?? 0;
    if (fileCount >= 1) continue;
    seen.add(hit.hitId);
    hitsPerFile.set(hit.locator.filePath, fileCount + 1);
    hits.push(hit);
  }
  return { hits: hits.slice(0, requestedLimit), queryEmbeddings: 1, activeGenerations: [...new Set(activeGenerations)] };
}

export function fuseHybridHits(deterministic: SearchHit[], vectors: SearchHit[], config: HybridSearchConfig): SearchHit[] {
  const scores = new Map<string, number>();
  const laneRanks = new Map<string, RetrievalProvenance["lanes"]>();
  deterministic.forEach((hit, index) => { const rank = index + 1; scores.set(hit.hitId, (scores.get(hit.hitId) ?? 0) + 1 / (config.rrfK + rank)); laneRanks.set(hit.hitId, [{ lane: hit.lane === "path" ? "exact" : hit.lane === "source" ? "source" : hit.lane === "symbol" ? "symbol" : hit.lane === "graph" ? "graph" : "source", rank, score: hit.score }]); });
  vectors.forEach((hit, index) => { const rank = index + 1; scores.set(hit.hitId, (scores.get(hit.hitId) ?? 0) + 1 / (config.rrfK + rank)); const previous = laneRanks.get(hit.hitId) ?? []; laneRanks.set(hit.hitId, [...previous, { lane: "vector", rank, score: hit.score }]); });
  const baseHits = new Map<string, SearchHit>();
  for (const hit of deterministic) baseHits.set(hit.hitId, hit);
  for (const hit of vectors) if (!baseHits.has(hit.hitId)) baseHits.set(hit.hitId, hit);
  const unique = [...baseHits.values()].map((hit) => {
    const previous = (hit as SearchHit & { retrievalProvenance?: Partial<RetrievalProvenance> }).retrievalProvenance;
    const lanes = laneRanks.get(hit.hitId) ?? [];
    const retrievalProvenance: RetrievalProvenance = {
      lanes,
      ...(previous?.embeddingSpaceId ? { embeddingSpaceId: previous.embeddingSpaceId } : {}),
      ...(previous?.chunkId ? { chunkId: previous.chunkId } : {}),
      retrievalFingerprint: fingerprint([
        hit.hitId,
        config.rankerVersion,
        previous?.embeddingSpaceId ?? null,
        previous?.chunkId ?? null,
        lanes,
      ]),
    };
    return {
      ...hit,
      score: scores.get(hit.hitId) ?? 0,
      rankReasons: [...hit.rankReasons, `rrf(${config.rrfK}) hybrid fusion`],
      retrievalProvenance,
    } as SearchHit & { retrievalProvenance: RetrievalProvenance };
  });
  return unique.sort((a, b) => {
    if (config.exactPin && a.lane !== "vector" && b.lane === "vector") return -1;
    if (config.exactPin && a.lane === "vector" && b.lane !== "vector") return 1;
    return b.score - a.score || a.hitId.localeCompare(b.hitId);
  });
}
