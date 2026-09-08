/** JSON-schema-shaped inputs shared by every surface. The schema is a
 * contract/documentation boundary; handlers still perform strict semantic
 * validation before touching the store. Unknown capability inputs use an
 * intentionally open object until their typed schema is promoted here. */
export type KnowledgeInputSchema = {
  type: "object";
  required?: string[];
  anyOf?: Array<{ required: string[] }>;
  allOf?: Array<Record<string, unknown>>;
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: boolean;
};

const object = (properties: KnowledgeInputSchema["properties"] = {}, required: string[] = [], additionalProperties = false): KnowledgeInputSchema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties });
const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const number = () => ({ type: "number" });
const boolean = (description?: string) => ({ type: "boolean", ...(description ? { description } : {}) });

const ownerRootMutationSchema = (): KnowledgeInputSchema => ({
  ...object({
    root_path: string("Absolute owner-approved repository root; required unless path is provided"),
    path: string("Compatibility alias for root_path; required unless root_path is provided"),
    confirmed: boolean("Must be true; use knowledge.doctor mutation_preflight for read-only validation"),
  }, ["confirmed"]),
  anyOf: [{ required: ["root_path"] }, { required: ["path"] }],
});

const searchRevision = {
  type: "object",
  properties: {
    repoId: string(),
    repoName: string(),
    branch: string(),
    snapshotId: string(),
    commitSha: string(),
    workingTree: boolean(),
  },
  additionalProperties: false,
};

const searchScope = {
  type: "object",
  properties: {
    workspaceId: string(),
    revisions: { type: "array", items: searchRevision },
    paths: { type: "array", items: string() },
    languages: { type: "array", items: string() },
    kinds: { type: "array", items: string() },
  },
  additionalProperties: false,
};

const searchOptions = {
  type: "object",
  properties: {
    caseSensitive: boolean(),
    wholeWord: boolean(),
    includeGenerated: boolean(),
    includeVendor: boolean(),
    includeExcludedMetadata: boolean(),
    semantic: { type: "string", enum: ["off", "fallback", "blend"] },
    compact: boolean(),
    explain: boolean(),
  },
  additionalProperties: false,
};

const searchPage = {
  type: "object",
  properties: { limit: number(), cursor: string() },
  additionalProperties: false,
};

const SCHEMAS: Record<string, KnowledgeInputSchema> = {
  "knowledge.repository.register": ownerRootMutationSchema(),
  "knowledge.index": ownerRootMutationSchema(),
  "knowledge.rebuild": ownerRootMutationSchema(),
  "knowledge.capabilities": object({ contract_version: string(), compact: boolean() }),
  "knowledge.search": object({ query: string("Non-empty deterministic or semantic query"), mode: { type: "string", enum: ["auto", "exact", "phrase", "substring", "path", "regex", "lexical", "structural"] }, scope: searchScope, options: searchOptions, page: searchPage }, ["query"]),
  "knowledge.get_hit": object({ snapshot_id: string(), file_path: string(), start_line: number(), end_line: number(), start_byte: number(), context_lines: number(), original_revision_id: string(), caller_workspace_id: string() }, ["snapshot_id", "file_path"]),
  "knowledge.graph.query": object({ request: { type: "object" }, start: { type: "object" }, traverse: { type: "array" }, project: { type: "array" }, limit: number(), scope: { type: "object" } }, ["start", "traverse", "project", "limit"]),
  "knowledge.context": object({ target: string(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), depth: number(), limit: number(), cursor: string(), allow_fallback: boolean() }, ["target"]),
  "knowledge.get_node": object({ id: string("Stable node id"), identity_key: string("Canonical identity key"), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string() }),
  "knowledge.explore": object({ target: string(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), depth: number(), limit: number(), allow_fallback: boolean(), include_sources: { type: "boolean", description: "false returns relations only; each omission is named in sourcesOmitted" }, max_source_lines: number() }, ["target"]),
  "knowledge.explain": object({ target: string("Node id, identity key, or symbol name"), symbol: string("Compatibility alias for target"), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string() }, ["target"]),
  "knowledge.locate": object({ target: string(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), depth: number(), limit: number(), allow_fallback: boolean() }, ["target"]),
  "knowledge.flow": object({ target: string(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean(), limit: { type: "number", description: "Maximum returned hops per page; defaults to 20 and is capped at 100" }, cursor: string("Signed continuation cursor returned by the previous flow page"), compact: boolean("Remove duplicate flow projections while retaining canonical hops and evidence") }, ["target"]),
  "knowledge.affected": object({
    target: string("Node target; mutually exclusive with file, files, and path"),
    node: string("Node target; mutually exclusive with file, files, and path"),
    symbol: string("Node target; mutually exclusive with file, files, and path"),
    files: { type: "array", items: string(), description: "Repo-relative file paths; mutually exclusive with target, node, and symbol" },
    file: string("Repo-relative file path; mutually exclusive with target, node, and symbol"),
    path: string("Repo-relative file path; mutually exclusive with target, node, and symbol"),
    repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean(),
  }),
  "knowledge.path": object({ from: string(), to: string(), source: string(), target: string(), depth: number(), limit: number(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean() }, ["from", "to"]),
  "knowledge.callers": object({ target: string(), node: string(), symbol: string(), depth: number(), limit: number(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean() }),
  "knowledge.callees": object({ target: string(), node: string(), symbol: string(), depth: number(), limit: number(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean() }),
  "knowledge.impact": object({ target: string(), node: string(), symbol: string(), depth: number(), limit: number(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean() }),
  "knowledge.index_status": object({
    mode: { type: "string", enum: ["detailed", "compact"] },
    reset_manifest_path: string("Optional immutable reset manifest beside the active knowledge database; returns its read-only owner status projection"),
  }),
  "knowledge.semantic_status": object({ scopeKey: string("Optional repo scope key; omit for the aggregate owner-local status") }),
  "knowledge.semantic_control": {
    ...object({
      action: { type: "string", enum: ["pause", "resume", "retry", "cancel"] },
      scopeKey: string("Required repo scope key"),
      generationId: string("Required for retry and cancel; forbidden for pause and resume"),
      operationToken: { type: "string", minLength: 8, description: "Required caller-generated correlation/idempotency token" },
    }, ["action", "scopeKey", "operationToken"]),
    allOf: [
      {
        if: { properties: { action: { enum: ["retry", "cancel"] } }, required: ["action"] },
        then: { required: ["generationId"] },
      },
      {
        if: { properties: { action: { enum: ["pause", "resume"] } }, required: ["action"] },
        then: { not: { required: ["generationId"] } },
      },
    ],
  },
  "knowledge.set_master_branch": object({ repo: string(), branch: string() }, ["repo", "branch"]),
  "knowledge.note.write": object({ action: string(), title: string(), identity_key: string(), text: string(), src: string(), dst: string(), edge_type: string() }, ["action"]),
  "knowledge.note.list": object({ repo: string("Repo name or id"), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean(), limit: number(), cursor: string() }),
  "knowledge.source.register": object({ type: string(), location: string(), config: { type: "object" }, allow_hosts: { type: "array", items: string() } }, ["type", "location"]),
  "knowledge.source.sync": object({ id: string() }, ["id"]),
  "knowledge.source.remove": object({ id: string(), confirmed: boolean() }, ["id"]),
  "knowledge.saved_query.write": object({ name: string(), request: { type: "object" }, confirmed: boolean() }, ["name", "request"]),
  "knowledge.saved_query.run": object({ name: string(), cursor: string(), limit: number() }, ["name"]),
  "knowledge.package_dependencies": object({ subject: string(), direction: { type: "string", enum: ["dependencies", "dependents", "both"] }, transitive: boolean(), max_depth: number(), limit: number() }, ["subject"]),
  "knowledge.dependency_path": object({ from: string(), to: string(), max_depth: number() }, ["from", "to"]),
  "knowledge.analyze_repository": object({ query: string(), repo: string(), focus: string(), limit: number() }, ["query"]),
  "knowledge.memory.remember": object({ class: string(), repo_id: string(), workspace_id: string(), global: boolean(), subject: string(), body: string(), source: { type: "array" }, confidence: number(), retention: string() }, ["subject", "body"]),
  "knowledge.memory.recall": object({ repo_id: string(), workspace_id: string() }),
  "knowledge.memory.forget": object({ id: string(), confirmed: boolean() }, ["id"]),
  // Declared because they are now implemented: an agent asking for one repo's
  // dead code used to get every repo's, with nothing saying so.
  "knowledge.architecture": object({ repo: string("Repo name or id"), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean() }),
  "knowledge.dead_code": object({ limit: number(), cursor: string(), repo: string("Repo name or id — without it the answer spans every indexed repo"), path: string("Repo-relative path prefix, e.g. apps/promotion/src"), branch: string(), compact: boolean() }),
  "knowledge.artifact.import": object({ artifact_base64: string(), base_database_base64: string(), capability_hash: string(), confirmed: boolean() }, ["artifact_base64"]),
  "knowledge.coverage": object({ repo: string("Repo name or id"), branch: string(), commit_sha: string(), snapshot_id: string(), path: string("Repo-relative path prefix"), kind: { type: "string", enum: ["excluded", "failed", "stale", "unresolved"] }, limit: number(), cursor: string() }),
  "knowledge.endpoints": object({
    repo: string("Repo name or id"),
    branch: string(),
    commit_sha: string(),
    snapshot_id: string(),
    protocol: { type: "string", enum: ["grpc", "http", "kafka", "rest", "graphql"] },
    service: string("Exact gRPC service name, package suffix accepted"),
    method: string("Exact endpoint method name, case-insensitive"),
    path: string("Repo-relative endpoint evidence path or prefix"),
    handled_only: boolean("Return only endpoints with a handler in the selected revision"),
    provenance_kind: { type: "string", enum: ["definition", "client", "handler", "test"] },
    limit: number(),
    cursor: string(),
    compact: boolean("Omit duplicated compatibility mirrors and report the byte reduction"),
  }),
  "knowledge.file_symbols": object({ repo: string("Repo name or id"), branch: string("Branch name"), path: string("Repo-relative file path"), commit_sha: string(), snapshot_id: string(), limit: number(), cursor: string() }, ["path"]),
  "knowledge.service_graph": object({ repo: string("Repo name or id"), branch: string(), commit_sha: string(), snapshot_id: string(), include_direct_neighbours: boolean(), layout: { type: "string", enum: ["hierarchical", "force"] } }),
  "knowledge.local_graph": object({ node: string("Stable node id"), target: string("Compatibility alias for node"), depth: number() }),
  "knowledge.repository_graph": object({ repo: string("Repo name or id"), branch: string(), commit_sha: string(), snapshot_id: string(), allow_fallback: boolean(), limit: { type: "number", description: "Maximum returned nodes; defaults to 50 and is capped at 150" }, edge_limit: { type: "number", description: "Maximum returned edges; defaults to 200 and is capped at 1000" } }, ["repo"]),
  "knowledge.files": object({ repo: string("Repo name or id"), branch: string(), commit_sha: string(), snapshot_id: string(), limit: number(), cursor: string() }, ["repo"]),
  "knowledge.onboarding.generate": object({ repo: string("Repo name or id") }),
  "knowledge.doctor": object({
    deep: boolean("Run the expensive full SQLite integrity and foreign-key scans; false by default"),
    reconcile: {
      type: "object",
      description: "Independently compare checkout source truth with the persisted index for one configured root",
      properties: {
        root_path: string("Absolute configured corpus root; omit to check all registered repositories"),
        path: string("Compatibility alias for root_path"),
        strict: boolean("Return ok=false when any repository is incomplete or has a reconciliation gap"),
      },
      additionalProperties: false,
    },
    mutation_preflight: {
      type: "object",
      description: "Read-only validation for owner-local register/index/rebuild inputs; never performs the mutation",
      required: ["action"],
      anyOf: [{ required: ["root_path"] }, { required: ["path"] }],
      properties: {
        action: { type: "string", enum: ["register", "index", "rebuild"] },
        root_path: string("Absolute owner-approved repository root"),
        path: string("Compatibility alias for root_path"),
      },
      additionalProperties: false,
    },
  }),
};

const OPEN_SCHEMA = object({}, [], true);

export function canonicalInputSchema(capabilityId: string): KnowledgeInputSchema {
  return SCHEMAS[capabilityId] ?? OPEN_SCHEMA;
}

export function listCanonicalInputSchemas(): Readonly<Record<string, KnowledgeInputSchema>> {
  return SCHEMAS;
}
