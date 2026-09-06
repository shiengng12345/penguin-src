export { createNote, createIncident, appendNote, writeNoteBody, readNote, listNotes, reindexNotesDir, noteSlug, type NoteType } from "./notes-fs.js";
export { computeEvidenceHashes, mergeEvidenceDocument, renderEvidenceMarkdown, upsertEvidenceNote, type EvidenceTarget, type TargetEvidencePacket, type EvidenceCaptureResult, type EvidenceDocument } from "./evidence.js";
export { listDanglingNoteLinks, type DanglingNoteLink } from "./fusion.js";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { listNotes, type EvidenceFileSummary } from "./notes-fs.js";
import { parseNote } from "./notes.js";

export interface PublicNoteListItem {
  path: string;
  nodeId: string | null;
  title: string;
  source: { kind: "markdown" | "canvas"; path: string };
  timestamp: string | null;
  scope: { repoId: string | null };
  revision: null;
  sensitivity: "sensitive" | "normal" | "unknown";
  permission: { mcpAccess: "allowed" | "denied" | "unknown" };
  provenanceGaps: string[];
}

/** Read-only projection used by both CLI and MCP. It never exposes note bodies
 * and makes missing provenance explicit instead of dropping the fields. */
export function listPublicNotes(input: { store: KnowledgeStore; notesDir: string }): PublicNoteListItem[] {
  return listNotes(input.notesDir).map((path) => {
    const absolute = join(input.notesDir, path);
    let timestamp: string | null = null;
    let parsed: ReturnType<typeof parseNote> | null = null;
    const provenanceGaps: string[] = [];
    try { timestamp = statSync(absolute).mtime.toISOString(); } catch { provenanceGaps.push("source_timestamp_unavailable"); }
    try { parsed = parseNote({ path, source: readFileSync(absolute, "utf8") }); } catch { provenanceGaps.push("note_metadata_unavailable"); }
    const node = parsed
      ? input.store.db.prepare("SELECT id,repo_id AS repoId FROM nodes WHERE identity_key=? AND node_type IN ('note','credential') LIMIT 1").get(parsed.identityKey) as { id: string; repoId: string | null } | undefined
      : undefined;
    if (!node) provenanceGaps.push("index_node_unavailable");
    return {
      path,
      nodeId: node?.id ?? null,
      title: parsed?.title ?? path,
      source: { kind: path.toLowerCase().endsWith(".canvas") ? "canvas" : "markdown", path },
      timestamp,
      scope: { repoId: node?.repoId ?? null },
      revision: null,
      sensitivity: parsed ? (parsed.sensitive ? "sensitive" : "normal") : "unknown",
      permission: { mcpAccess: parsed?.mcpAccess ?? "unknown" },
      provenanceGaps,
    };
  });
}

export function publicEvidenceSummaries(rows: EvidenceFileSummary[]): Array<EvidenceFileSummary & {
  source: { kind: "markdown"; path: string };
  timestamp: string | null;
  scope: { targetId: string | null; environment: string | null };
  revision: null;
  sensitivity: "sensitive" | "normal";
  permission: { mcpAccess: string };
  provenanceGaps: string[];
}> {
  return rows.map((row) => ({
    ...row,
    source: { kind: "markdown", path: row.path },
    timestamp: row.lastSeen ?? row.firstSeen ?? null,
    scope: { targetId: row.targetId || null, environment: row.environment || null },
    revision: null,
    sensitivity: row.sensitive ? "sensitive" : "normal",
    permission: { mcpAccess: row.mcpAccess },
    provenanceGaps: [
      ...(row.lastSeen || row.firstSeen ? [] : ["source_timestamp_unavailable"]),
      ...(row.nodeId ? [] : ["index_node_unavailable"]),
      ...(row.targetId ? [] : ["target_scope_unavailable"]),
    ],
  }));
}
export { listEvidenceNotes, setEvidenceStatus, evidenceDoctor, repairEvidence, type EvidenceFileSummary, type EvidenceLifecycle, type EvidenceDoctorReport } from "./notes-fs.js";
