// The trigram lane is a pure ACCELERATOR for literal/substring source search:
// candidateBlobIds prefilters blobs, and the downstream verifier re-checks
// every hit against the real text. Turning the lane off therefore makes
// literal search SLOWER (bounded full scan), never WRONG — which is what
// lets it be optional at all. It is also the single most expensive structure
// in the DB (~1.1GB: 23M rows + two indexes for one feature).
//
// Default semantics:
// - explicit meta value ("on"/"off") always wins;
// - no meta value + existing trigram rows → ON (an existing DB keeps its
//   current behavior instead of silently degrading);
// - no meta value + empty table → OFF (new DBs never pay the 1.1GB).
import type { KnowledgeStore } from "./store.js";

export const TRIGRAM_LANE_META_KEY = "source_trigram_lane";

export function trigramLaneEnabled(store: KnowledgeStore): boolean {
  const row = store.db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(TRIGRAM_LANE_META_KEY) as { value: string } | undefined;
  if (row) return row.value === "on";
  return Boolean(store.db.prepare("SELECT 1 FROM source_blob_trigrams LIMIT 1").get());
}

export function setTrigramLane(store: KnowledgeStore, enabled: boolean): void {
  store.db
    .prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(TRIGRAM_LANE_META_KEY, enabled ? "on" : "off");
}

/** Delete all trigram rows (the lane's data). Only meaningful when the lane
 * is off; reclaim the pages afterwards with VACUUM. Returns rows deleted. */
export function pruneTrigramLane(store: KnowledgeStore): number {
  const result = store.db.prepare("DELETE FROM source_blob_trigrams").run();
  return result.changes;
}

export function trigramLaneStatus(store: KnowledgeStore): {
  enabled: boolean;
  explicit: "on" | "off" | null;
  rows: number;
} {
  const row = store.db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(TRIGRAM_LANE_META_KEY) as { value: string } | undefined;
  const rows = (store.db.prepare("SELECT COUNT(*) AS n FROM source_blob_trigrams").get() as { n: number }).n;
  return {
    enabled: trigramLaneEnabled(store),
    explicit: row ? (row.value === "on" ? "on" : "off") : null,
    rows,
  };
}
