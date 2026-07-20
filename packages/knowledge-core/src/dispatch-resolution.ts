export type DispatchStatus = "verified" | "candidate" | "unavailable";
export type DispatchEvidenceKind = "ast_exact" | "type_resolution" | "framework_adapter" | "runtime_observation";
export interface DispatchImplementation { identityKey: string; filePath?: string; framework?: "nestjs" | "spring" | "go" | "rust" | "generic"; providerToken?: string; }
export interface DispatchRequest { revisionId: string; environment?: string; receiverType?: string; method: string; implementations: DispatchImplementation[]; resolvedType?: string; dependencyToken?: string; providers?: DispatchImplementation[]; }
export interface DispatchTarget extends DispatchImplementation { evidence: DispatchEvidenceKind; revisionId: string; environment?: string; }
export interface DispatchResolution { status: DispatchStatus; hopType: "interface_method" | "dependency_injection" | "runtime_observation"; targets: DispatchTarget[]; explanation: string; revisionId: string; environment?: string; }
export interface RuntimeDispatchObservation { revisionId: string; environment: string; targetIdentityKey: string; observedAt: string; }
export interface FrameworkDispatchAdapter { id: "nestjs" | "spring" | "go" | "rust"; resolve(request: DispatchRequest): DispatchImplementation[]; }

const BUILTIN_FRAMEWORK_ADAPTERS: FrameworkDispatchAdapter[] = [
  { id: "nestjs", resolve: (request) => (request.providers ?? []).filter((item) => item.framework === "nestjs") },
  { id: "spring", resolve: (request) => (request.providers ?? []).filter((item) => item.framework === "spring") },
  { id: "go", resolve: (request) => request.implementations.filter((item) => item.framework === "go") },
  { id: "rust", resolve: (request) => request.implementations.filter((item) => item.framework === "rust") },
];

/** Framework registration/assignment is an adapter boundary, not a heuristic direct call. */
export function resolveFrameworkDispatch(request: DispatchRequest, adapters: FrameworkDispatchAdapter[] = BUILTIN_FRAMEWORK_ADAPTERS): DispatchResolution {
  const implementations = adapters.flatMap((adapter) => adapter.resolve(request));
  return resolveDispatch({ ...request, implementations, providers: implementations, dependencyToken: request.dependencyToken });
}

/** Resolve an interface/DI hop without turning an ambiguous dispatch into a direct call. */
export function resolveDispatch(request: DispatchRequest): DispatchResolution {
  const pool = request.dependencyToken ? (request.providers ?? []).filter((provider) => provider.providerToken === request.dependencyToken) : request.implementations;
  const candidates = request.resolvedType ? pool.filter((implementation) => implementation.identityKey.includes(`::${request.resolvedType}::`) || implementation.identityKey === request.resolvedType) : pool;
  const targets = candidates.map((target) => ({ ...target, evidence: request.resolvedType ? "type_resolution" as const : "framework_adapter" as const, revisionId: request.revisionId, ...(request.environment ? { environment: request.environment } : {}) }));
  const hopType = request.dependencyToken ? "dependency_injection" : "interface_method";
  if (targets.length === 1) return { status: "verified", hopType, targets, explanation: "one revision-scoped dispatch target", revisionId: request.revisionId, environment: request.environment };
  if (targets.length > 1) return { status: "candidate", hopType, targets, explanation: "multiple legal dispatch targets", revisionId: request.revisionId, environment: request.environment };
  return { status: "unavailable", hopType, targets: [], explanation: "no dispatch target resolved", revisionId: request.revisionId, environment: request.environment };
}

/** Runtime evidence may upgrade only the matching revision and environment. */
export function applyRuntimeDispatchObservation(resolution: DispatchResolution, observation: RuntimeDispatchObservation): DispatchResolution {
  if (resolution.revisionId !== observation.revisionId || resolution.environment !== observation.environment) return resolution;
  const target = resolution.targets.find((candidate) => candidate.identityKey === observation.targetIdentityKey);
  if (!target) return resolution;
  return { ...resolution, status: "verified", hopType: "runtime_observation", targets: [{ ...target, evidence: "runtime_observation" }], explanation: `observed target at ${observation.observedAt}` };
}
