import { KnowledgeContractError } from "./errors.js";
import {
  CAPABILITIES,
  type CapabilityDefinition,
  type Surface,
} from "./capabilities.js";
import { validateSearchResponse } from "./response.js";

export type RegistrationStatus = "implemented" | "not_implemented";

/**
 * Capability coverage is intentionally explicit.  A registration can only be
 * reported as implemented after the corresponding surface has a real route;
 * merely generating a name in tools/list or help is not enough.
 */
export const CLI_IMPLEMENTED_CAPABILITIES = new Set<string>([
  "knowledge.repository.register", "knowledge.search", "knowledge.get_hit", "knowledge.coverage", "knowledge.capabilities",
  "knowledge.index", "knowledge.rebuild", "knowledge.snapshot.materialize", "knowledge.watch", "knowledge.repository.remove",
  "knowledge.branch.pin", "knowledge.index_status", "knowledge.set_master_branch", "knowledge.snapshot.list", "knowledge.get_node",
  "knowledge.callers", "knowledge.callees", "knowledge.impact", "knowledge.context", "knowledge.explore", "knowledge.locate",
  "knowledge.explain", "knowledge.flow", "knowledge.affected", "knowledge.path", "knowledge.architecture", "knowledge.service_graph",
  "knowledge.local_graph", "knowledge.repository_graph", "knowledge.communities", "knowledge.timeline", "knowledge.recent",
  "knowledge.compare_branches", "knowledge.files", "knowledge.file_symbols", "knowledge.dead_code", "knowledge.response_sample.capture",
  "knowledge.response_sample.list", "knowledge.incident.create", "knowledge.note.create", "knowledge.note.append", "knowledge.note.list",
  "knowledge.note.reindex", "knowledge.note.write", "knowledge.tag.list", "knowledge.link.create", "knowledge.suggestion.list",
  "knowledge.suggestion.accept", "knowledge.suggestion.reject", "knowledge.evidence.target.list", "knowledge.evidence.status.set",
  "knowledge.evidence.doctor", "knowledge.evidence.repair", "knowledge.why.get", "knowledge.domain.explain",
  "knowledge.onboarding.generate", "knowledge.artifact.export", "knowledge.artifact.import", "knowledge.agent_hook.invoke",
  "knowledge.cli.install", "knowledge.doctor", "knowledge.source.register", "knowledge.source.sync", "knowledge.source.list",
  "knowledge.source.remove", "knowledge.memory.remember", "knowledge.memory.recall", "knowledge.memory.forget",
  "knowledge.api_doc.generate", "knowledge.api_doc.list", "knowledge.api_doc.show", "knowledge.api_doc.diff", "knowledge.api_doc.bind",
  "knowledge.api_doc.unbind", "knowledge.api_doc.draft", "knowledge.api_doc.sync", "knowledge.api_doc.repair",
  "knowledge.graph.query", "knowledge.note.backlinks", "knowledge.evidence.note.list",
  "knowledge.saved_query.list", "knowledge.saved_query.run", "knowledge.saved_query.write", "knowledge.package_dependencies",
  "knowledge.dependency_path", "knowledge.link.list", "knowledge.link.delete", "knowledge.ontology.list", "knowledge.ontology.upsert",
  "knowledge.ontology.link", "knowledge.evidence.note.get", "knowledge.evidence.validate", "knowledge.analyze_repository", "knowledge.api_doc.export",
  "knowledge.memory.improve", "knowledge.evidence.investigation.plan", "knowledge.evidence.investigation.capture",
]);

export const MCP_IMPLEMENTED_CAPABILITIES = new Set<string>([
  "knowledge.search", "knowledge.get_hit", "knowledge.coverage", "knowledge.capabilities", "knowledge.get_node", "knowledge.context",
  "knowledge.explore", "knowledge.compare_branches", "knowledge.index_status", "knowledge.set_master_branch", "knowledge.suggestion.list",
  "knowledge.suggestion.accept", "knowledge.suggestion.reject", "knowledge.architecture", "knowledge.communities", "knowledge.dead_code",
  "knowledge.graph.query", "knowledge.package_dependencies", "knowledge.dependency_path", "knowledge.analyze_repository",
  "knowledge.note.write", "knowledge.source.register", "knowledge.source.sync", "knowledge.source.list", "knowledge.source.remove",
  "knowledge.memory.remember", "knowledge.memory.recall", "knowledge.memory.forget", "knowledge.memory.improve", "knowledge.ontology.list",
  "knowledge.ontology.upsert", "knowledge.ontology.link", "knowledge.why.get", "knowledge.domain.explain", "knowledge.onboarding.generate",
  "knowledge.artifact.export", "knowledge.artifact.import", "knowledge.evidence.note.list", "knowledge.evidence.status.set",
  "knowledge.evidence.doctor", "knowledge.evidence.repair", "knowledge.api_doc.generate", "knowledge.api_doc.list",
  "knowledge.api_doc.show", "knowledge.api_doc.diff", "knowledge.callers", "knowledge.callees", "knowledge.impact",
  "knowledge.locate", "knowledge.flow", "knowledge.affected", "knowledge.path", "knowledge.service_graph", "knowledge.local_graph",
  "knowledge.repository_graph", "knowledge.timeline", "knowledge.recent", "knowledge.files", "knowledge.file_symbols",
  "knowledge.tag.list", "knowledge.response_sample.list", "knowledge.note.create", "knowledge.note.append", "knowledge.note.list",
  "knowledge.note.reindex", "knowledge.note.backlinks", "knowledge.incident.create", "knowledge.link.create", "knowledge.evidence.target.list",
  "knowledge.evidence.note.get", "knowledge.evidence.validate",
  "knowledge.repository.register", "knowledge.index", "knowledge.rebuild", "knowledge.repository.remove", "knowledge.snapshot.list",
  "knowledge.explain", "knowledge.response_sample.capture", "knowledge.link.list", "knowledge.link.delete",
  "knowledge.branch.pin", "knowledge.doctor", "knowledge.saved_query.list", "knowledge.saved_query.run", "knowledge.saved_query.write",
  "knowledge.evidence.investigation.plan", "knowledge.evidence.investigation.capture", "knowledge.api_doc.export",
  "knowledge.snapshot.materialize",
  "knowledge.watch", "knowledge.api_doc.bind", "knowledge.api_doc.unbind", "knowledge.api_doc.draft", "knowledge.api_doc.sync",
  "knowledge.api_doc.repair", "knowledge.agent_hook.invoke", "knowledge.cli.install",
]);

/** Non-canonical spellings are kept in one registry so a surface cannot
 * silently invent a second capability with different semantics. */
export const CAPABILITY_ALIASES = Object.freeze({
  get_node: "knowledge.get_node",
  explore_graph: "knowledge.graph.query",
  index_status: "knowledge.index_status",
  set_master_branch: "knowledge.set_master_branch",
  get_architecture: "knowledge.architecture",
  find_communities: "knowledge.communities",
  find_dead_code: "knowledge.dead_code",
  package_dependencies: "knowledge.package_dependencies",
  dependency_path: "knowledge.dependency_path",
  analyze_repository: "knowledge.analyze_repository",
  write_note: "knowledge.note.write",
  suggest_links: "knowledge.link.create",
  list_suggestions: "knowledge.suggestion.list",
  accept_suggestion: "knowledge.suggestion.accept",
  reject_suggestion: "knowledge.suggestion.reject",
  list_evidence_notes: "knowledge.evidence.note.list",
  set_evidence_status: "knowledge.evidence.status.set",
  repair_evidence: "knowledge.evidence.repair",
  api_doc_generate: "knowledge.api_doc.generate",
  api_doc_bind: "knowledge.api_doc.bind",
  api_doc_unbind: "knowledge.api_doc.unbind",
} as const);

export function canonicalCapabilityId(idOrAlias: string): string {
  return CAPABILITY_ALIASES[idOrAlias as keyof typeof CAPABILITY_ALIASES] ?? idOrAlias;
}

export interface SurfaceContext {
  surface: Surface;
  workspaceRoot?: string;
}

export interface SurfaceRegistration {
  capabilityId: string;
  status: RegistrationStatus;
  invoke(input: unknown, context: SurfaceContext): Promise<unknown>;
  inputSchemaId: string;
  outputSchemaId: string;
  validateOutput(output: unknown): unknown;
}

type OutputValidator = (output: unknown) => unknown;

function validateJsonOutput(output: unknown): unknown {
  const seen = new Set<object>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new KnowledgeContractError("INVALID_OUTPUT", "output contains a non-finite number");
      return value;
    }
    if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      throw new KnowledgeContractError("INVALID_OUTPUT", "output is not JSON-compatible");
    }
    if (typeof value !== "object") throw new KnowledgeContractError("INVALID_OUTPUT", "output has an unsupported type");
    if (seen.has(value)) throw new KnowledgeContractError("INVALID_OUTPUT", "output contains a circular reference");
    seen.add(value);
    if (Array.isArray(value)) value.forEach(visit);
    else Object.entries(value as Record<string, unknown>).forEach(([key, item]) => { if (!key) throw new KnowledgeContractError("INVALID_OUTPUT", "output contains an empty object key"); visit(item); });
    seen.delete(value);
    return value;
  };
  return visit(output);
}

/** Every manifest output schema has a validator. Schemas that need semantic
 * shape validation get a stricter validator; the common validator still
 * rejects values that cannot cross JSON/CLI/MCP boundaries. */
const OUTPUT_VALIDATORS = new Map<string, OutputValidator>(
  CAPABILITIES.map((capability) => [capability.id, validateJsonOutput]),
);
OUTPUT_VALIDATORS.set("knowledge.search", validateSearchResponse);

export function validateCapabilityOutput(capabilityId: string, output: unknown): unknown {
  const validator = OUTPUT_VALIDATORS.get(canonicalCapabilityId(capabilityId));
  if (!validator) throw new KnowledgeContractError("OUTPUT_SCHEMA_NOT_REGISTERED", `no output validator registered for ${capabilityId}`, { capabilityId });
  return validator(output);
}

export function hasCapabilityOutputValidator(capabilityId: string): boolean {
  return OUTPUT_VALIDATORS.has(canonicalCapabilityId(capabilityId));
}

function registration(capability: CapabilityDefinition, implemented: boolean): SurfaceRegistration {
  return {
    capabilityId: capability.id,
    status: implemented ? "implemented" : "not_implemented",
    inputSchemaId: capability.inputSchemaId,
    outputSchemaId: capability.outputSchemaId,
    validateOutput: (output) => validateCapabilityOutput(capability.id, output),
    async invoke() {
      if (implemented) {
        throw new KnowledgeContractError(
          "SURFACE_RUNTIME_UNAVAILABLE",
          capability.id + " requires its surface runtime adapter",
          { capabilityId: capability.id },
        );
      }
      throw new KnowledgeContractError(
        "CAPABILITY_NOT_IMPLEMENTED",
        capability.id + " is not implemented on this surface yet",
        { capabilityId: capability.id },
      );
    },
  };
}

export function createSurfaceRegistrations(
  surface: Surface,
  manifest: readonly CapabilityDefinition[] = CAPABILITIES,
): readonly SurfaceRegistration[] {
  const implemented = surface === "cli" ? CLI_IMPLEMENTED_CAPABILITIES : surface === "mcp" ? MCP_IMPLEMENTED_CAPABILITIES : new Set<string>();
  return manifest
    .filter((capability) => capability.requiredOn.includes(surface))
    .map((capability) => registration(capability, implemented.has(capability.id)));
}

export const listCliRegistrations = (): readonly SurfaceRegistration[] => createSurfaceRegistrations("cli");
export const listMcpRegistrations = (): readonly SurfaceRegistration[] => createSurfaceRegistrations("mcp");
export const listWikiRegistrations = (): readonly SurfaceRegistration[] => createSurfaceRegistrations("wiki");
