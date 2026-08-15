import { parentPort, workerData } from "node:worker_threads";
import type { SearchRequest, SearchResponse } from "@penguin/knowledge-contracts";
import { KnowledgeStore, resolveRevisionContext, searchKnowledge } from "@penguin/knowledge-core";

interface WorkerRequest {
  type: "run";
  id: string;
  capabilityId: "knowledge.search";
  input: SearchRequest;
}

if (!parentPort) throw new Error("QUERY_WORKER_PARENT_PORT_REQUIRED");

const config = workerData as { dbPath: string; ledgerPath: string };
const store = KnowledgeStore.open({
  dbPath: config.dbPath,
  ledgerPath: config.ledgerPath,
  allowSchemaMutation: false,
});

function runSearch(input: SearchRequest): SearchResponse {
  const requested = input.scope?.revisions ?? [];
  const scopes: Array<{ repoId?: string; snapshotId: string }> = [];
  const scopeWarnings: Array<{ code: string; message: string }> = [];

  for (const revision of requested) {
    if (typeof revision.snapshotId === "string") {
      scopes.push({
        ...(revision.repoId ? { repoId: revision.repoId } : {}),
        snapshotId: revision.snapshotId,
      });
      continue;
    }
    const repoSelector = revision.repoId ?? revision.repoName;
    const repoRow = repoSelector
      ? store.db.prepare("SELECT id FROM repos WHERE id=? OR name=? LIMIT 1")
        .get(repoSelector, revision.repoName ?? revision.repoId) as { id: string } | undefined
      : undefined;
    if (!repoRow) {
      scopeWarnings.push({
        code: "SCOPE_UNRESOLVED",
        message: `scope entry did not match a repo: ${JSON.stringify(revision)}`,
      });
      continue;
    }
    const resolution = resolveRevisionContext(store, {
      repoId: repoRow.id,
      ...(revision.branch ? { branch: revision.branch } : {}),
    });
    if (resolution.status !== "resolved") {
      scopeWarnings.push({ code: "SCOPE_UNRESOLVED", message: resolution.reason });
      continue;
    }
    const branchRow = resolution.context.branchId
      ? store.db.prepare("SELECT current_snapshot_id AS currentSnapshotId FROM branches WHERE id=?")
        .get(resolution.context.branchId) as { currentSnapshotId: string | null } | undefined
      : undefined;
    scopes.push({
      repoId: repoRow.id,
      snapshotId: branchRow?.currentSnapshotId ?? resolution.context.snapshotId,
    });
  }

  const { revisions: _rawRevisions, ...restScope } = input.scope ?? {};
  const request = requested.length
    ? { ...input, scope: scopes.length ? { ...restScope, revisions: scopes } : restScope }
    : input;
  const response = searchKnowledge(request, { store, ...(scopes.length ? { scopes } : {}) });
  return scopeWarnings.length
    ? {
      ...response,
      diagnostics: {
        ...response.diagnostics,
        warnings: [...response.diagnostics.warnings, ...scopeWarnings],
      },
    }
    : response;
}

parentPort.on("message", (request: WorkerRequest) => {
  if (request.type !== "run" || request.capabilityId !== "knowledge.search") return;
  try {
    const result = runSearch(request.input);
    parentPort!.postMessage({ type: "result", id: request.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      type: "result",
      id: request.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code ?? "INTERNAL",
        message: String((error as Error).message ?? error),
      },
    });
  }
});

parentPort.on("close", () => store.close());
