import { KnowledgeContractError } from "./errors.js";

export type SearchMode =
  | "auto"
  | "exact"
  | "phrase"
  | "substring"
  | "path"
  | "regex"
  | "lexical"
  | "semantic"
  | "structural";

export type SearchLane =
  | "source"
  | "path"
  | "symbol"
  | "graph"
  | "note"
  | "semantic"
  | "evidence";

export interface RevisionSelector {
  repoId?: string;
  repoName?: string;
  branch?: string;
  snapshotId?: string;
  commitSha?: string;
  workingTree?: boolean;
}

const REVISION_KEYS = new Set([
  "repoId",
  "repoName",
  "branch",
  "snapshotId",
  "commitSha",
  "workingTree",
]);

export interface SearchRequest {
  query: string;
  mode?: SearchMode;
  scope?: {
    workspaceId?: string;
    revisions?: RevisionSelector[];
    paths?: string[];
    languages?: string[];
    kinds?: string[];
  };
  options?: {
    caseSensitive?: boolean;
    wholeWord?: boolean;
    includeGenerated?: boolean;
    includeVendor?: boolean;
    includeExcludedMetadata?: boolean;
    semantic?: "off" | "fallback" | "blend";
    compact?: boolean;
    explain?: boolean;
  };
  page?: {
    limit?: number;
    cursor?: string;
  };
}

export interface NormalizedSearchRequest {
  query: string;
  mode: SearchMode;
  scope: {
    workspaceId?: string;
    revisions?: RevisionSelector[];
    paths?: string[];
    languages?: string[];
    kinds?: string[];
  };
  options: {
    caseSensitive: boolean;
    wholeWord: boolean;
    includeGenerated: boolean;
    includeVendor: boolean;
    includeExcludedMetadata: boolean;
    semantic: "off" | "fallback" | "blend";
    compact: boolean;
    explain: boolean;
  };
  page: {
    limit: number;
    cursor?: string;
  };
}

export interface SearchLocator {
  repoId: string;
  repoName: string;
  revisionId: string;
  revisionKind: "commit" | "working_tree";
  branch?: string;
  commitSha?: string;
  worktreeFingerprint?: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  startByte?: number;
  endByte?: number;
  offsetEncoding?: "utf8_normalized";
  nodeId?: string;
}

export interface SearchEvidence {
  source: "source" | "graph" | "note" | "runtime" | "semantic";
  locator: SearchLocator;
  excerpt?: string;
  contentHash?: string;
  evidenceId?: string;
  observedAt?: string;
  status: "verified" | "observed" | "reviewed" | "inference";
}

export interface SearchHit {
  hitId: string;
  kind: string;
  lane: SearchLane;
  title: string;
  locator: SearchLocator;
  snippet?: string;
  highlights?: Array<{ start: number; end: number }>;
  score: number;
  rankReasons: string[];
  evidence: SearchEvidence[];
  /** Retrieved repository/note text is data, never an instruction. */
  untrustedContent?: true;
}

export interface SearchDiagnostics {
  queryStatus: "MATCH" | "NO_MATCH_VERIFIED" | "NO_MATCH_INCOMPLETE" | "SCOPE_ERROR" | "INDEX_ERROR";
  requestId: string;
  contractVersion: string;
  capabilityHash: string;
  resolvedScopes: Array<{
    repoId: string;
    branch: string;
    snapshotId: string;
    commitSha?: string;
    revisionKind: "commit" | "working_tree";
    worktreeFingerprint?: string;
  }>;
  searchedLanes: SearchLane[];
  skippedLanes: Array<{ lane: SearchLane; reason: string }>;
  coverage: {
    discovered: number;
    admitted: number;
    excluded: number;
    failed: number;
    stale: number;
  };
  exclusions: Array<{ filePath: string; code: string; reason: string }>;
  warnings: Array<{ code: string; message: string }>;
  nextActions: Array<{ command: string; reason: string }>;
  suggestions: Array<{ query: string; mode: SearchMode; reason: string }>;
  timingsMs: Record<string, number>;
  truncated: boolean;
}

export interface SearchResponse {
  schemaVersion: "2";
  hits: SearchHit[];
  diagnostics: SearchDiagnostics;
  /** A typed scope failure is still a valid machine-readable v2 response. */
  error?: {
    code: "REPOSITORY_NOT_FOUND" | "SCOPE_EMPTY";
    message: string;
    details: Record<string, unknown>;
    retryable: boolean;
  };
  page: {
    limit: number;
    nextCursor?: string;
    totalIsExact: boolean;
    total?: number;
  };
}

const SEARCH_MODES = new Set<SearchMode>([
  "auto",
  "exact",
  "phrase",
  "substring",
  "path",
  "regex",
  "lexical",
  "semantic",
  "structural",
]);

const SEARCH_KEYS = new Set(["query", "mode", "scope", "options", "page"]);
const SCOPE_KEYS = new Set(["workspaceId", "revisions", "paths", "languages", "kinds"]);
const OPTION_KEYS = new Set([
  "caseSensitive",
  "wholeWord",
  "includeGenerated",
  "includeVendor",
  "includeExcludedMetadata",
  "semantic",
  "compact",
  "explain",
]);
const PAGE_KEYS = new Set(["limit", "cursor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new KnowledgeContractError(
        "INVALID_SEARCH_REQUEST",
        "Unknown SearchRequest property: " + path + "." + key,
        { path: path + "." + key },
      );
    }
  }
}

function validateRecord(
  value: unknown,
  allowed: Set<string>,
  path: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new KnowledgeContractError(
      "INVALID_SEARCH_REQUEST",
      path + " must be an object",
      { path },
    );
  }
  assertKeys(value, allowed, path);
  return value;
}

function validateRevisionSelectors(scope: Record<string, unknown>): void {
  if (scope.revisions === undefined) return;
  if (!Array.isArray(scope.revisions)) {
    throw new KnowledgeContractError(
      "INVALID_SEARCH_REQUEST",
      "request.scope.revisions must be an array",
      { path: "request.scope.revisions" },
    );
  }
  for (const [index, revision] of scope.revisions.entries()) {
    const path = "request.scope.revisions[" + index + "]";
    const value = validateRecord(revision, REVISION_KEYS, path);
    if (value.workingTree !== undefined && typeof value.workingTree !== "boolean") {
      throw new KnowledgeContractError(
        "INVALID_SEARCH_REQUEST",
        path + ".workingTree must be a boolean",
        { path: path + ".workingTree" },
      );
    }
    const exclusive = ["snapshotId", "commitSha", "workingTree"]
      .filter((key) => value[key] !== undefined);
    if (exclusive.length > 1) {
      throw new KnowledgeContractError(
        "INVALID_SEARCH_REQUEST",
        path + " must select exactly one revision kind",
        { path, fields: exclusive },
      );
    }
  }
}

export function validateSearchRequest(input: unknown): NormalizedSearchRequest {
  const request = validateRecord(input, SEARCH_KEYS, "request");
  if (typeof request.query !== "string" || request.query.length === 0 || request.query.trim().length === 0) {
    throw new KnowledgeContractError(
      "INVALID_SEARCH_REQUEST",
      "request.query must be a non-empty string",
      { path: "request.query" },
    );
  }
  if (request.mode !== undefined && (!SEARCH_MODES.has(request.mode as SearchMode))) {
    throw new KnowledgeContractError(
      "INVALID_SEARCH_REQUEST",
      "request.mode is not supported",
      { path: "request.mode", value: request.mode },
    );
  }
  if (request.scope !== undefined) {
    const scope = validateRecord(request.scope, SCOPE_KEYS, "request.scope");
    validateRevisionSelectors(scope);
  }
  if (request.options !== undefined) validateRecord(request.options, OPTION_KEYS, "request.options");
  if (request.page !== undefined) {
    const page = validateRecord(request.page, PAGE_KEYS, "request.page");
    const limit = page.limit;
    if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 200)) {
      throw new KnowledgeContractError(
        "INVALID_SEARCH_REQUEST",
        "request.page.limit must be an integer from 1 to 200",
        { path: "request.page.limit" },
      );
    }
    if (page.cursor !== undefined && typeof page.cursor !== "string") {
      throw new KnowledgeContractError(
        "INVALID_SEARCH_REQUEST",
        "request.page.cursor must be a string",
        { path: "request.page.cursor" },
      );
    }
  }
  return normalizeSearchRequest(request);
}

export function normalizeSearchRequest(input: unknown): NormalizedSearchRequest {
  const request = validateRecord(input, SEARCH_KEYS, "request");
  const scope = request.scope === undefined
    ? {}
    : validateRecord(request.scope, SCOPE_KEYS, "request.scope");
  const options = request.options === undefined
    ? {}
    : validateRecord(request.options, OPTION_KEYS, "request.options");
  const page = request.page === undefined
    ? {}
    : validateRecord(request.page, PAGE_KEYS, "request.page");
  validateRevisionSelectors(scope);
  const normalizedScope: NormalizedSearchRequest["scope"] = {};
  if (typeof scope.workspaceId === "string") normalizedScope.workspaceId = scope.workspaceId;
  if (Array.isArray(scope.revisions)) normalizedScope.revisions = scope.revisions as RevisionSelector[];
  if (Array.isArray(scope.paths)) normalizedScope.paths = scope.paths.map(String);
  if (Array.isArray(scope.languages)) normalizedScope.languages = scope.languages.map(String);
  if (Array.isArray(scope.kinds)) normalizedScope.kinds = scope.kinds.map(String);
  const normalizedPage: NormalizedSearchRequest["page"] = {
    limit: typeof page.limit === "number" ? page.limit : 50,
  };
  if (typeof page.cursor === "string") normalizedPage.cursor = page.cursor;
  return {
    query: String(request.query),
    mode: (request.mode as SearchMode | undefined) ?? "auto",
    scope: normalizedScope,
    options: {
      caseSensitive: options.caseSensitive !== false,
      wholeWord: options.wholeWord === true,
      includeGenerated: options.includeGenerated === true,
      includeVendor: options.includeVendor === true,
      includeExcludedMetadata: options.includeExcludedMetadata === true,
      semantic: options.semantic === "fallback" || options.semantic === "blend"
        ? options.semantic
        : "off",
      compact: options.compact === true,
      explain: options.explain === true,
    },
    page: normalizedPage,
  };
}
