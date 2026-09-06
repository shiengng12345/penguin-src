import type { KnowledgeStore } from "@penguin/knowledge-core";
import { EmbeddingLifecycle } from "@penguin/knowledge-core";

/** Reclaim only expired work; a live worker's leased jobs remain untouched. */
export function recoverEmbeddingWorker(
  store: KnowledgeStore,
  generationId: string,
  now = new Date().toISOString(),
): number {
  const lifecycle = new EmbeddingLifecycle(store);
  return lifecycle.reclaimExpiredJobs(now, generationId);
}
