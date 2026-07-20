/** JSON-schema-shaped inputs shared by every surface. The schema is a
 * contract/documentation boundary; handlers still perform strict semantic
 * validation before touching the store. Unknown capability inputs use an
 * intentionally open object until their typed schema is promoted here. */
export type KnowledgeInputSchema = {
  type: "object";
  required?: string[];
  properties?: Record<string, Record<string, unknown>>;
  additionalProperties?: boolean;
};

const object = (properties: KnowledgeInputSchema["properties"] = {}, required: string[] = [], additionalProperties = false): KnowledgeInputSchema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties });
const string = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const number = () => ({ type: "number" });
const boolean = () => ({ type: "boolean" });

const SCHEMAS: Record<string, KnowledgeInputSchema> = {
  "knowledge.search": object({ query: string("Non-empty deterministic or semantic query"), mode: { type: "string", enum: ["auto", "exact", "phrase", "substring", "path", "regex", "lexical", "semantic", "structural"] }, scope: { type: "object" }, options: { type: "object" }, page: { type: "object" } }, ["query"]),
  "knowledge.get_hit": object({ snapshot_id: string(), file_path: string(), start_line: number(), end_line: number(), start_byte: number(), context_lines: number(), original_revision_id: string(), caller_workspace_id: string() }, ["snapshot_id", "file_path"]),
  "knowledge.graph.query": object({ request: { type: "object" }, start: { type: "object" }, traverse: { type: "array" }, project: { type: "array" }, limit: number(), scope: { type: "object" } }, ["start", "traverse", "project", "limit"]),
  "knowledge.context": object({ target: string(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), depth: number(), limit: number() }, ["target"]),
  "knowledge.explore": object({ target: string(), repo: string(), branch: string(), commit_sha: string(), snapshot_id: string(), depth: number(), limit: number() }, ["target"]),
  "knowledge.index_status": object({ mode: { type: "string", enum: ["detailed", "compact"] } }),
  "knowledge.set_master_branch": object({ repo: string(), branch: string() }, ["repo", "branch"]),
  "knowledge.note.write": object({ action: string(), title: string(), identity_key: string(), text: string(), src: string(), dst: string(), edge_type: string() }, ["action"]),
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
  "knowledge.artifact.import": object({ artifact_base64: string(), base_database_base64: string(), capability_hash: string(), confirmed: boolean() }, ["artifact_base64"]),
};

const OPEN_SCHEMA = object({}, [], true);

export function canonicalInputSchema(capabilityId: string): KnowledgeInputSchema {
  return SCHEMAS[capabilityId] ?? OPEN_SCHEMA;
}

export function listCanonicalInputSchemas(): Readonly<Record<string, KnowledgeInputSchema>> {
  return SCHEMAS;
}
