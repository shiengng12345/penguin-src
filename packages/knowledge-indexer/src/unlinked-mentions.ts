import { createHash, randomUUID } from "node:crypto";
import { existsSync, openSync, fsyncSync, closeSync, writeFileSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { reindexNotesDir } from "./notes-fs.js";

export interface UnlinkedMention {
  noteNodeId: string;
  notePath: string;
  targetNodeId: string;
  candidate: string;
  line: number;
  reason: "title" | "alias";
  expectedContentHash: string;
}

function hash(source: string): string { return createHash("sha256").update(source).digest("hex"); }

function searchableLines(body: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let fence = false;
  for (const [index, raw] of body.split(/\r?\n/).entries()) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) { fence = !fence; continue; }
    if (!fence) out.push({ line: index + 1, text: raw.replace(/`[^`]*`/g, "") });
  }
  return out;
}

export function findUnlinkedMentions(input: { store: KnowledgeStore; notesDir: string; limit?: number }): UnlinkedMention[] {
  const candidates: Array<{ nodeId: string; value: string; reason: "title" | "alias" }> = [];
  const rows = input.store.db.prepare("SELECT n.id,n.title,ni.path,ni.frontmatter,ni.content_hash FROM nodes n JOIN notes_index ni ON ni.node_id=n.id WHERE n.node_type='note' ORDER BY n.title,n.id").all() as Array<{ id: string; title: string; path: string; frontmatter: string; content_hash: string }>;
  for (const row of rows) {
    if (row.title.trim().length >= 2) candidates.push({ nodeId: row.id, value: row.title.trim(), reason: "title" });
    try {
      const frontmatter = JSON.parse(row.frontmatter) as { aliases?: unknown };
      const aliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : frontmatter.aliases ? [frontmatter.aliases] : [];
      for (const alias of aliases) if (String(alias).trim().length >= 2) candidates.push({ nodeId: row.id, value: String(alias).trim(), reason: "alias" });
    } catch { /* malformed frontmatter remains searchable but gives no alias */ }
  }
  const result: UnlinkedMention[] = [];
  for (const note of rows) {
    const source = input.store.db.prepare("SELECT body FROM fts_notes WHERE node_id=?").get(note.id) as { body: string } | undefined;
    if (!source?.body) continue;
    for (const candidate of candidates) {
      if (candidate.nodeId === note.id) continue;
      const escaped = candidate.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = /[\u3400-\u9fff]/u.test(candidate.value) ? new RegExp(escaped, "u") : new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
      for (const line of searchableLines(source.body)) {
        if (!re.test(line.text) || /\[\[[^\]]*\b/i.test(line.text) && line.text.includes(candidate.value)) continue;
        result.push({ noteNodeId: note.id, notePath: note.path, targetNodeId: candidate.nodeId, candidate: candidate.value, line: line.line, reason: candidate.reason, expectedContentHash: note.content_hash });
        if (result.length >= (input.limit ?? 100)) return result;
        break;
      }
    }
  }
  return result;
}

export function acceptUnlinkedMention(input: { store: KnowledgeStore; notesDir: string; mention: UnlinkedMention; expectedContentHash?: string }): { path: string; contentHash: string } {
  const full = join(input.notesDir, input.mention.notePath);
  if (!existsSync(full)) throw new Error("UNLINKED_MENTION_NOTE_NOT_FOUND");
  const source = readFileSync(full, "utf8");
  const expected = input.expectedContentHash ?? input.mention.expectedContentHash;
  if (hash(source) !== expected) throw new Error("NOTE_CONTENT_HASH_MISMATCH");
  const escaped = input.mention.candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = /[\u3400-\u9fff]/u.test(input.mention.candidate)
    ? new RegExp(escaped, "u")
    : new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
  const updated = source.replace(re, `[[${input.mention.candidate}]]`);
  if (updated === source) throw new Error("UNLINKED_MENTION_NOT_FOUND");
  const temp = `${full}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "w", 0o600);
  try { writeFileSync(fd, updated, "utf8"); fsyncSync(fd); closeSync(fd); renameSync(temp, full); }
  catch (error) { try { closeSync(fd); } catch {} throw error; }
  reindexNotesDir({ store: input.store, notesDir: input.notesDir });
  return { path: full, contentHash: hash(updated) };
}
