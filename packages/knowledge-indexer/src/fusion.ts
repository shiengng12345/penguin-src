import type { KnowledgeStore } from "@penguin/knowledge-core";
import type { ParsedNote } from "./notes.js";

interface NoteEdge {
  dst: string | null;
  rawTarget: string | null;
  edgeType: string;
  confidence?: number;
}

export interface DanglingNoteLink {
  sourceNodeId: string;
  sourcePath: string | null;
  sourceLine: number;
  rawTarget: string;
  targetAnchor: string | null;
  resolutionStatus: string;
}

/** Return unresolved, ambiguous, or anchor-unresolved links without hiding the
 * raw target. This is intentionally read-only; repair is an explicit note
 * reindex mutation so Markdown remains the source of truth. */
export function listDanglingNoteLinks(store: KnowledgeStore, limit = 100): DanglingNoteLink[] {
  return store.db.prepare(`SELECT nl.source_node_id AS sourceNodeId, ni.path AS sourcePath,
      nl.source_line AS sourceLine, nl.raw_target AS rawTarget,
      nl.target_anchor AS targetAnchor, nl.resolution_status AS resolutionStatus
    FROM note_links nl LEFT JOIN notes_index ni ON ni.node_id=nl.source_node_id
    WHERE nl.target_node_id IS NULL OR nl.resolution_status <> 'resolved'
    ORDER BY sourcePath, sourceLine, rawTarget LIMIT ?`).all(Math.max(1, Math.min(limit, 1000))) as DanglingNoteLink[];
}

// Candidate node ids for a wikilink target under a given resolution tier.
function noteCandidates(store: KnowledgeStore, title: string): string[] {
  const direct = store.db.prepare(`SELECT n.id FROM nodes n LEFT JOIN notes_index ni ON ni.node_id=n.id
    WHERE n.node_type='note' AND (n.identity_key=? OR n.title=? OR ni.path=?)`).all(title, title, title) as { id: string }[];
  const aliases = store.db.prepare("SELECT n.id,ni.frontmatter FROM nodes n JOIN notes_index ni ON ni.node_id=n.id WHERE n.node_type='note'").all() as Array<{ id: string; frontmatter: string }>;
  for (const row of aliases) {
    try {
      const parsed = JSON.parse(row.frontmatter) as { aliases?: unknown };
      const values = Array.isArray(parsed.aliases) ? parsed.aliases.map(String) : parsed.aliases ? [String(parsed.aliases)] : [];
      if (values.includes(title)) direct.push({ id: row.id });
    } catch { /* malformed frontmatter remains searchable but is not an alias */ }
  }
  return [...new Set(direct.map((r) => r.id))];
}

function symbolCandidates(store: KnowledgeStore, name: string): string[] {
  // by leaf title, or qualified identity_key ending in ::name / .name
  return (
    store.db
      .prepare(
        `SELECT id FROM nodes
         WHERE node_type='symbol' AND (title=? OR identity_key LIKE ? OR identity_key LIKE ?)`,
      )
      .all(name, `%::${name}`, `%.${name}`) as { id: string }[]
  ).map((r) => r.id);
}

function entityNodeId(store: KnowledgeStore, value: string): string {
  // Entity nodes are upserted with a normalized identity so mentions dedupe.
  return store.upsertNode({
    nodeType: "entity",
    identityKey: `entity:${value.toLowerCase()}`,
    title: value,
  });
}

// Resolve a note's captured wikilinks + entities into graph edges (§5).
// Priority (no namespace): note title → symbol name → entity. Namespaced
// (api:/repo:/trace:) targets their kind directly. Unique hit → dst set;
// none → dst NULL + raw_target kept (auto-links later via backfill); many →
// ambiguous (dst NULL, counted, never guessed). Also creates entity_mention
// edges, and backfills prior unresolved links now that this note node exists.
export function resolveNoteLinks(input: {
  store: KnowledgeStore;
  noteNodeId: string;
  noteTitle: string;
  noteIdentityKey: string;
  parsed: ParsedNote;
}): { linked: number; unresolved: number; ambiguous: number } {
  const { store, noteNodeId, parsed } = input;
  const edges: NoteEdge[] = [];
  let linked = 0;
  let unresolved = 0;
  let ambiguous = 0;
  const resolutions: Array<{ rawTarget: string; targetAnchor: string | null; sourceLine: number; nodeId: string | null; status: "resolved" | "anchor_unresolved" | "ambiguous" | "unresolved" }> = [];

  for (const link of parsed.wikilinks) {
    const target = link.rawTarget;
    let candidates: string[];
    if (link.namespace === "api") {
      candidates = symbolCandidates(store, target);
    } else if (link.namespace === "trace" || link.namespace === "entity") {
      candidates = [entityNodeId(store, target)];
    } else {
      // priority ladder: first tier with any hit wins
      candidates = noteCandidates(store, target);
      if (candidates.length === 0) candidates = symbolCandidates(store, target);
    }

    if (candidates.length === 1) {
      edges.push({ dst: candidates[0], rawTarget: target, edgeType: "wikilink" });
      const anchor = link.targetAnchor;
      const anchorExists = !anchor || Boolean(store.db.prepare("SELECT 1 FROM fts_notes WHERE node_id=? AND (body LIKE ? OR body LIKE ?) LIMIT 1").get(candidates[0], `%# ${anchor}%`, `%${anchor}%`));
      resolutions.push({ rawTarget: target, targetAnchor: anchor, sourceLine: link.sourceLine, nodeId: candidates[0], status: anchorExists ? "resolved" : "anchor_unresolved" });
      linked += 1;
    } else if (candidates.length > 1) {
      edges.push({ dst: null, rawTarget: target, edgeType: "wikilink", confidence: 0.5 });
      resolutions.push({ rawTarget: target, targetAnchor: link.targetAnchor, sourceLine: link.sourceLine, nodeId: null, status: "ambiguous" });
      ambiguous += 1;
    } else {
      edges.push({ dst: null, rawTarget: target, edgeType: "wikilink" });
      resolutions.push({ rawTarget: target, targetAnchor: link.targetAnchor, sourceLine: link.sourceLine, nodeId: null, status: "unresolved" });
      unresolved += 1;
    }
  }

  // entity mentions: upsert entity node + mention edge
  for (const ent of parsed.entities) {
    const id = entityNodeId(store, ent.value);
    edges.push({ dst: id, rawTarget: ent.value, edgeType: "entity_mention" });
  }

  store.replaceNoteEdges(noteNodeId, edges);
  const updateLink = store.db.prepare("UPDATE note_links SET target_node_id=?, resolution_status=? WHERE source_node_id=? AND source_line=? AND raw_target=? AND (target_anchor IS ? OR target_anchor=?)");
  for (const resolution of resolutions) updateLink.run(resolution.nodeId, resolution.status, noteNodeId, resolution.sourceLine, resolution.rawTarget, resolution.targetAnchor, resolution.targetAnchor);

  // backfill: other notes' unresolved [[thisTitle]] / [[thisIdentity]] now link here
  store.linkUnresolvedTargets({
    nodeId: noteNodeId,
    matches: [...new Set([input.noteTitle, input.noteIdentityKey])],
  });

  return { linked, unresolved, ambiguous };
}
