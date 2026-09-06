import {
  validateSemanticControlRequest,
  validateSemanticControlResult,
  type SemanticControlResult,
} from "@penguin/knowledge-contracts";
import { EmbeddingLifecycle } from "./embedding-lifecycle.js";
import {
  applySemanticRuntimeState,
  listSemanticStatuses,
  resolveSemanticScopeKey,
} from "./semantic-status.js";
import type { KnowledgeStore } from "./store.js";

export interface ExecuteSemanticControlOptions {
  store: KnowledgeStore;
  request: unknown;
  runtimeState: { restartRequired: boolean };
  wake?: () => unknown | Promise<unknown>;
}

/** Canonical owner-local semantic control use case shared by every transport. */
export async function executeSemanticControl(
  options: ExecuteSemanticControlOptions,
): Promise<SemanticControlResult> {
  const request = validateSemanticControlRequest(options.request);
  const scope = resolveSemanticScopeKey(options.store, request.scopeKey);
  if (!scope.resolvedScopeKey) {
    throw Object.assign(new Error(`semantic scope was not found: ${request.scopeKey}`), {
      code: scope.ambiguousRepoIds?.length ? "SCOPE_AMBIGUOUS" : "SCOPE_NOT_FOUND",
      details: {
        requestedScopeKey: request.scopeKey,
        validScopeKeys: scope.validScopeKeys,
        validRepositoryNames: scope.validRepositoryNames,
        ...(scope.ambiguousRepoIds ? { candidateRepoIds: scope.ambiguousRepoIds } : {}),
      },
    });
  }

  const normalizedRequest = { ...request, scopeKey: scope.resolvedScopeKey };
  const statusesBeforeMutation = listSemanticStatuses(options.store, normalizedRequest.scopeKey);
  const statusBeforeMutation = normalizedRequest.generationId
    ? statusesBeforeMutation.find((candidate) => candidate.generationId === normalizedRequest.generationId)
    : statusesBeforeMutation[0];
  if (!statusBeforeMutation || statusBeforeMutation.state === "not_queued") {
    throw Object.assign(
      new Error(`semantic status was not found for ${normalizedRequest.scopeKey}`),
      { code: "SEMANTIC_STATUS_NOT_FOUND" },
    );
  }

  new EmbeddingLifecycle(options.store).applyControl(normalizedRequest);
  const worker = (normalizedRequest.action === "resume" || normalizedRequest.action === "retry")
    && options.wake
    ? await options.wake()
    : undefined;
  const statuses = applySemanticRuntimeState(
    listSemanticStatuses(options.store, normalizedRequest.scopeKey),
    options.runtimeState,
  );
  const status = normalizedRequest.generationId
    ? statuses.find((candidate) => candidate.generationId === normalizedRequest.generationId)
    : statuses[0];
  if (!status) {
    throw Object.assign(
      new Error(`semantic status disappeared for ${normalizedRequest.scopeKey}`),
      { code: "SEMANTIC_STATUS_NOT_FOUND" },
    );
  }

  return validateSemanticControlResult({
    accepted: true,
    action: normalizedRequest.action,
    scopeKey: normalizedRequest.scopeKey,
    generationId: normalizedRequest.generationId ?? null,
    operationToken: normalizedRequest.operationToken,
    status,
    ...(worker === undefined ? {} : { worker }),
  });
}
