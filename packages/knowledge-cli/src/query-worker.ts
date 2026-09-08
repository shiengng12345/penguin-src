import { parentPort, workerData } from "node:worker_threads";
import type { SearchRequest, SearchResponse } from "@penguin/knowledge-contracts";
import {
  KnowledgeStore,
  resolveRevisionContext,
  searchKnowledgeAsync,
  serviceGraph,
} from "@penguin/knowledge-core";

interface WorkerRequest {
  type: "run";
  id: string;
  capabilityId: "knowledge.search" | "knowledge.warmup";
  input: SearchRequest;
}

if (!parentPort) throw new Error("QUERY_WORKER_PARENT_PORT_REQUIRED");

const config = workerData as { dbPath: string; ledgerPath: string };
const store = KnowledgeStore.open({
  dbPath: config.dbPath,
  ledgerPath: config.ledgerPath,
  allowSchemaMutation: false,
});

async function runSearch(input: SearchRequest): Promise<SearchResponse> {
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
  const response = await searchKnowledgeAsync(request, {
    store,
    ...(scopes.length ? { scopes } : {}),
  });
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

parentPort.on("message", async (request: WorkerRequest) => {
  if (request.type !== "run") return;
  if (request.capabilityId !== "knowledge.search" && request.capabilityId !== "knowledge.warmup") return;
  try {
    // Warmup runs the graph query for its side effect on the OS page cache,
    // which is process-wide: the resident connection then reads those pages
    // from memory instead of disk. Doing it HERE rather than on the main
    // thread matters — better-sqlite3 is synchronous, so a main-thread
    // warmup makes a click that lands mid-warmup wait for it to finish.
    const result = request.capabilityId === "knowledge.warmup"
      ? { warmed: serviceGraph(store).nodes.length }
      : await runSearch(request.input);
    parentPort!.postMessage({ type: "result", id: request.id, ok: true, result });
  } catch (error) {
    parentPort!.postMessage({
      type: "result",
      id: request.id,
      ok: false,
      error: {
        code: (error as { code?: string }).code ?? "INTERNAL",
        message: String((error as Error).message ?? error),
        ...((error as { details?: Record<string, unknown> }).details ? { details: (error as { details: Record<string, unknown> }).details } : {}),
        ...((error as { retryable?: boolean }).retryable !== undefined ? { retryable: Boolean((error as { retryable?: boolean }).retryable) } : {}),
        ...((error as { remediation?: string }).remediation ? { remediation: (error as { remediation: string }).remediation } : {}),
      },
    });
  }
});

parentPort.on("close", () => store.close());
