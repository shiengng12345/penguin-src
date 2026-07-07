import type { KnowledgeStore } from "@penguin/knowledge-core";
import type { ParsedNote } from "./notes.js";

interface NoteEdge {
  dst: string | null;
  rawTarget: string | null;
  edgeType: string;
  confidence?: number;
}

// Candidate node ids for a wikilink target under a given resolution tier.
function noteCandidates(store: KnowledgeStore, title: string): string[] {
  return (
    store.db
      .prepare("SELECT id FROM nodes WHERE node_type='note' AND title=?")
      .all(title) as { id: string }[]
  ).map((r) => r.id);
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
      linked += 1;
    } else if (candidates.length > 1) {
      edges.push({ dst: null, rawTarget: target, edgeType: "wikilink", confidence: 0.5 });
      ambiguous += 1;
    } else {
      edges.push({ dst: null, rawTarget: target, edgeType: "wikilink" });
      unresolved += 1;
    }
  }

  // entity mentions: upsert entity node + mention edge
  for (const ent of parsed.entities) {
    const id = entityNodeId(store, ent.value);
    edges.push({ dst: id, rawTarget: ent.value, edgeType: "entity_mention" });
  }

  store.replaceNoteEdges(noteNodeId, edges);

  // backfill: other notes' unresolved [[thisTitle]] / [[thisIdentity]] now link here
  store.linkUnresolvedTargets({
    nodeId: noteNodeId,
    matches: [...new Set([input.noteTitle, input.noteIdentityKey])],
  });

  return { linked, unresolved, ambiguous };
}
