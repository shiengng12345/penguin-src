import { createHash } from "node:crypto";

export type Surface = "cli" | "mcp" | "wiki";

export interface CapabilityDefinition {
  id: string;
  version: number;
  title: string;
  coreOperation: string;
  requiredOn: readonly Surface[];
  supportsCompact: boolean;
  supportsCursor: boolean;
  mutating: boolean;
  confirmation: "required" | "not_required";
  inputSchemaId: string;
  outputSchemaId: string;
}

const CAPABILITY_ID_LIST = [
  "knowledge.repository.register",
  "knowledge.search",
  "knowledge.get_hit",
  "knowledge.coverage",
  "knowledge.capabilities",
  "knowledge.index",
  "knowledge.rebuild",
  "knowledge.snapshot.materialize",
  "knowledge.watch",
  "knowledge.repository.remove",
  "knowledge.branch.pin",
  "knowledge.index_status",
  "knowledge.set_master_branch",
  "knowledge.snapshot.list",
  "knowledge.get_node",
  "knowledge.callers",
  "knowledge.callees",
  "knowledge.impact",
  "knowledge.context",
  "knowledge.explore",
  "knowledge.locate",
  "knowledge.explain",
  "knowledge.flow",
  "knowledge.affected",
  "knowledge.path",
  "knowledge.architecture",
  "knowledge.service_graph",
  "knowledge.local_graph",
  "knowledge.graph.query",
  "knowledge.repository_graph",
  "knowledge.communities",
  "knowledge.timeline",
  "knowledge.recent",
  "knowledge.compare_branches",
  "knowledge.files",
  "knowledge.file_symbols",
  "knowledge.dead_code",
  "knowledge.package_dependencies",
  "knowledge.dependency_path",
  "knowledge.analyze_repository",
  "knowledge.response_sample.capture",
  "knowledge.response_sample.list",
  "knowledge.incident.create",
  "knowledge.note.create",
  "knowledge.note.append",
  "knowledge.note.list",
  "knowledge.note.reindex",
  "knowledge.note.write",
  "knowledge.note.backlinks",
  "knowledge.tag.list",
  "knowledge.link.create",
  "knowledge.link.list",
  "knowledge.link.delete",
  "knowledge.source.register",
  "knowledge.source.sync",
  "knowledge.source.list",
  "knowledge.source.remove",
  "knowledge.memory.remember",
  "knowledge.memory.recall",
  "knowledge.memory.forget",
  "knowledge.memory.improve",
  "knowledge.ontology.list",
  "knowledge.ontology.upsert",
  "knowledge.ontology.link",
  "knowledge.suggestion.list",
  "knowledge.suggestion.accept",
  "knowledge.suggestion.reject",
  "knowledge.evidence.target.list",
  "knowledge.evidence.investigation.plan",
  "knowledge.evidence.investigation.capture",
  "knowledge.evidence.note.get",
  "knowledge.evidence.note.list",
  "knowledge.evidence.status.set",
  "knowledge.evidence.doctor",
  "knowledge.evidence.repair",
  "knowledge.evidence.validate",
  "knowledge.api_doc.generate",
  "knowledge.api_doc.list",
  "knowledge.api_doc.show",
  "knowledge.api_doc.diff",
  "knowledge.api_doc.bind",
  "knowledge.api_doc.unbind",
  "knowledge.api_doc.draft",
  "knowledge.api_doc.sync",
  "knowledge.api_doc.repair",
  "knowledge.api_doc.export",
  "knowledge.saved_query.list",
  "knowledge.saved_query.run",
  "knowledge.saved_query.write",
  "knowledge.why.get",
  "knowledge.domain.explain",
  "knowledge.onboarding.generate",
  "knowledge.artifact.export",
  "knowledge.artifact.import",
  "knowledge.agent_hook.invoke",
  "knowledge.cli.install",
  "knowledge.doctor",
] as const;

const WIKI_CAPABILITY_IDS = new Set([
  "knowledge.search",
  "knowledge.get_hit",
  "knowledge.coverage",
  "knowledge.capabilities",
  "knowledge.index_status",
  "knowledge.get_node",
  "knowledge.callers",
  "knowledge.callees",
  "knowledge.context",
  "knowledge.explore",
  "knowledge.locate",
  "knowledge.flow",
  "knowledge.affected",
  "knowledge.path",
  "knowledge.architecture",
  "knowledge.service_graph",
  "knowledge.local_graph",
  "knowledge.graph.query",
  "knowledge.repository_graph",
  "knowledge.communities",
  "knowledge.timeline",
  "knowledge.compare_branches",
  "knowledge.files",
  "knowledge.file_symbols",
  "knowledge.note.list",
  "knowledge.note.write",
  "knowledge.note.backlinks",
  "knowledge.tag.list",
  "knowledge.link.list",
  "knowledge.memory.remember",
  "knowledge.memory.recall",
  "knowledge.memory.forget",
  "knowledge.memory.improve",
  "knowledge.ontology.list",
  "knowledge.ontology.upsert",
  "knowledge.ontology.link",
  "knowledge.evidence.note.get",
  "knowledge.evidence.note.list",
  "knowledge.evidence.status.set",
  "knowledge.evidence.doctor",
  "knowledge.saved_query.list",
  "knowledge.saved_query.run",
  "knowledge.saved_query.write",
  "knowledge.why.get",
  "knowledge.domain.explain",
  "knowledge.onboarding.generate",
]);

const MUTATING_IDS = new Set([
  "knowledge.repository.register",
  "knowledge.index",
  "knowledge.rebuild",
  "knowledge.snapshot.materialize",
  "knowledge.watch",
  "knowledge.repository.remove",
  "knowledge.branch.pin",
  "knowledge.set_master_branch",
  "knowledge.response_sample.capture",
  "knowledge.incident.create",
  "knowledge.note.create",
  "knowledge.note.append",
  "knowledge.note.reindex",
  "knowledge.note.write",
  "knowledge.link.create",
  "knowledge.link.delete",
  "knowledge.source.register",
  "knowledge.source.sync",
  "knowledge.source.remove",
  "knowledge.memory.remember",
  "knowledge.memory.forget",
  "knowledge.memory.improve",
  "knowledge.ontology.upsert",
  "knowledge.ontology.link",
  "knowledge.suggestion.accept",
  "knowledge.suggestion.reject",
  "knowledge.evidence.investigation.",
  "knowledge.evidence.status.",
  "knowledge.evidence.repair",
  "knowledge.api_doc.bind",
  "knowledge.api_doc.unbind",
  "knowledge.api_doc.draft",
  "knowledge.api_doc.sync",
  "knowledge.api_doc.repair",
  "knowledge.saved_query.write",
  "knowledge.artifact.import",
  "knowledge.cli.install",
]);

const MUTATING_PREFIXES = [
  "knowledge.evidence.investigation.",
  "knowledge.evidence.status.",
];

function isMutating(id: string): boolean {
  return MUTATING_IDS.has(id) || MUTATING_PREFIXES.some((prefix) => id.startsWith(prefix));
}

function createCapability(id: string): CapabilityDefinition {
  const mutating = isMutating(id);
  const requiredOn: Surface[] = ["cli", "mcp"];
  if (WIKI_CAPABILITY_IDS.has(id)) requiredOn.push("wiki");
  return {
    id,
    version: 2,
    title: id,
    coreOperation: id,
    requiredOn,
    supportsCompact: !mutating,
    supportsCursor: !mutating,
    mutating,
    confirmation: mutating ? "required" : "not_required",
    inputSchemaId: id + ".input.v2",
    outputSchemaId: id + ".output.v2",
  };
}

export const CAPABILITIES: readonly CapabilityDefinition[] =
  CAPABILITY_ID_LIST.map(createCapability);

export type CapabilityId = (typeof CAPABILITY_ID_LIST)[number];

export function capabilityHash(
  manifest: readonly CapabilityDefinition[],
): string {
  const stable = manifest.map((capability) => ({
    id: capability.id,
    version: capability.version,
    title: capability.title,
    coreOperation: capability.coreOperation,
    requiredOn: [...capability.requiredOn],
    supportsCompact: capability.supportsCompact,
    supportsCursor: capability.supportsCursor,
    mutating: capability.mutating,
    confirmation: capability.confirmation,
    inputSchemaId: capability.inputSchemaId,
    outputSchemaId: capability.outputSchemaId,
  }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function requiredCapabilitiesForSurface(
  surface: Surface,
): readonly string[] {
  return CAPABILITIES
    .filter((capability) => capability.requiredOn.includes(surface))
    .map((capability) => capability.id);
}

export function listRequiredSurfaceCapabilities(
  manifest: readonly CapabilityDefinition[],
  surface: Surface,
): readonly string[] {
  return manifest
    .filter((capability) => capability.requiredOn.includes(surface))
    .map((capability) => capability.id);
}
