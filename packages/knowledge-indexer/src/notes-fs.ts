import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { indexNote, parseNote } from "./notes.js";
import { randomUUID } from "node:crypto";

// File-backed knowledge notes (§7, C9). Notes are plain Markdown files under a
// notes directory — the file on disk is the source of truth (rebuildable: the
// SQLite index is re-derived by re-scanning). Each note carries `id`/`title`
// frontmatter so a stable identity survives edits (append re-indexes the same
// node). New standalone notes are repo-less (repoRelPath = the file name).

export function noteSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "note";
}

function ensureDir(notesDir: string): void {
  if (!existsSync(notesDir)) mkdirSync(notesDir, { recursive: true });
}

function indexFile(store: KnowledgeStore, notesDir: string, fileName: string): string {
  const source = readFileSync(join(notesDir, fileName), "utf8");
  const parsed = parseNote({ path: fileName, source });
  return indexNote({ store, repoRelPath: fileName, parsed }).nodeId;
}

// Create `<slug>.md` with id/title frontmatter, then index it. If the slug is
// taken, suffix -2, -3, … so `note new` never clobbers an existing note.
// Typed-note kinds (Phase 3 why-layer): the "why" behind code, each with a
// status/owner lifecycle and links to code via [[wikilinks]] (fusion resolves).
export type NoteType =
  | "note" | "decision" | "incident" | "compliance" | "bug" | "requirement" | "architecture" | "migration" | "evidence";

export function createNote(input: {
  store: KnowledgeStore;
  notesDir: string;
  title: string;
  body?: string;
  // Extra frontmatter (type/status/owner/…) written after id/title. Parsed back
  // into notes_index.frontmatter, so it's queryable + shown in the detail panel.
  frontmatter?: Record<string, string>;
}): { slug: string; path: string; nodeId: string } {
  ensureDir(input.notesDir);
  const base = noteSlug(input.title);
  let slug = base;
  for (let i = 2; existsSync(join(input.notesDir, `${slug}.md`)); i++) slug = `${base}-${i}`;
  const fileName = `${slug}.md`;
  const extra = Object.entries(input.frontmatter ?? {})
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  const fm = `id: ${slug}\ntitle: ${input.title}${extra ? `\n${extra}` : ""}`;
  const content = `---\n${fm}\n---\n\n${input.body ?? ""}`;
  writeFileSync(join(input.notesDir, fileName), content);
  const nodeId = indexFile(input.store, input.notesDir, fileName);
  return { slug, path: join(input.notesDir, fileName), nodeId };
}

// Error/Incident memory (Phase 4): a structured incident note. AI later answers
// "how did we fix Mongo TLS ECONNRESET?" from these. Links to code via [[…]].
export function createIncident(input: {
  store: KnowledgeStore;
  notesDir: string;
  title: string;
  fields?: Partial<{
    service: string; environment: string; errorMessage: string;
    rootCause: string; fix: string; relatedCode: string; retest: string;
  }>;
}): { slug: string; path: string; nodeId: string } {
  const f = input.fields ?? {};
  const body = [
    `## Error`,
    f.errorMessage ?? "_(paste the error message / stack)_",
    ``,
    `- **service**: ${f.service ?? "?"}`,
    `- **environment**: ${f.environment ?? "?"}`,
    ``,
    `## Root cause`,
    f.rootCause ?? "_(why it happened)_",
    ``,
    `## Fix`,
    f.fix ?? "_(what resolved it)_",
    ``,
    `## Related code`,
    f.relatedCode ?? "_(link symbols with [[Name]])_",
    ``,
    `## Retest`,
    f.retest ?? "_(steps/command to verify)_",
    ``,
  ].join("\n");
  return createNote({
    store: input.store, notesDir: input.notesDir, title: input.title, body,
    frontmatter: { type: "incident", status: "open", ...(f.service ? { service: f.service } : {}) },
  });
}

// Append text to an existing note (by slug) and re-index it (same identity).
export function appendNote(input: {
  store: KnowledgeStore;
  notesDir: string;
  slug: string;
  text: string;
}): { path: string; nodeId: string } {
  const fileName = `${input.slug}.md`;
  const full = join(input.notesDir, fileName);
  if (!existsSync(full)) throw new Error(`note not found: ${input.slug}`);
  appendFileSync(full, `\n${input.text}\n`);
  const nodeId = indexFile(input.store, input.notesDir, fileName);
  return { path: full, nodeId };
}

// Overwrite a note's body (keeping its frontmatter block) and re-index — the
// save path for the Wiki editor. Frontmatter (id/title) is preserved verbatim.
export function writeNoteBody(input: {
  store: KnowledgeStore;
  notesDir: string;
  slug: string;
  body: string;
}): { path: string; nodeId: string } {
  const full = join(input.notesDir, `${input.slug}.md`);
  if (!existsSync(full)) throw new Error(`note not found: ${input.slug}`);
  const src = readFileSync(full, "utf8");
  let frontmatter = "";
  if (src.startsWith("---")) {
    const end = src.indexOf("\n---", 3);
    if (end !== -1) frontmatter = `${src.slice(0, end + 4)}\n`; // through closing ---
  }
  writeFileSync(full, `${frontmatter}\n${input.body.replace(/^\n+/, "")}`);
  const nodeId = indexFile(input.store, input.notesDir, `${input.slug}.md`);
  return { path: full, nodeId };
}

// Read a note's raw Markdown (for the editor to load). null if missing.
export function readNote(notesDir: string, slug: string): string | null {
  const full = join(notesDir, `${slug}.md`);
  return existsSync(full) ? readFileSync(full, "utf8") : null;
}

export function listNotes(notesDir: string): string[] {
  if (!existsSync(notesDir)) return [];
  return readdirSync(notesDir)
    .filter((f) => f.endsWith(".md"))
    .sort();
}

// Re-scan the whole notes dir into the index (rebuildability: notes survive a
// DB wipe because their Markdown persists on disk and re-indexes to the same
// identities). Returns how many notes were indexed.
export function reindexNotesDir(input: { store: KnowledgeStore; notesDir: string }): { indexed: number; pruned: number } {
  const files = listNotes(input.notesDir);
  for (const f of files) indexFile(input.store, input.notesDir, f);
  // File is source of truth: a note whose .md vanished must leave the index
  // too, or it lives on DB-only until a wipe loses it permanently (audit F-3).
  const pruned = input.store.pruneMissingNotes(new Set(files));
  return { indexed: files.length, pruned };
}

export type EvidenceLifecycle = "draft" | "reviewed" | "verified" | "resolved" | "archived";
const EVIDENCE_TRANSITIONS: Record<EvidenceLifecycle, EvidenceLifecycle[]> = {
  draft: ["reviewed"], reviewed: ["verified"], verified: ["resolved"], resolved: ["archived"], archived: [],
};

export interface EvidenceFileSummary {
  slug: string;
  path: string;
  nodeId?: string;
  title: string;
  targetId: string;
  environment: string;
  region: string;
  project: string;
  logstore: string;
  status: EvidenceLifecycle;
  firstSeen?: string;
  lastSeen?: string;
  observationCount: number;
  topicHash?: string;
  evidenceHash?: string;
  sensitive: boolean;
  mcpAccess: string;
  indexed: boolean;
}

function evidenceFiles(notesDir: string): string[] {
  return listNotes(notesDir).filter((file) => {
    try { return parseNote({ path: file, source: readFileSync(join(notesDir, file), "utf8") }).frontmatter.type === "evidence"; } catch { return false; }
  });
}

export function listEvidenceNotes(input: { store: KnowledgeStore; notesDir: string; targetId?: string; status?: EvidenceLifecycle; limit?: number }): EvidenceFileSummary[] {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
  return evidenceFiles(input.notesDir).map((file) => {
    const source = readFileSync(join(input.notesDir, file), "utf8");
    const parsed = parseNote({ path: file, source });
    const f = parsed.frontmatter;
    const node = input.store.db.prepare("SELECT id FROM nodes WHERE node_type='note' AND identity_key=? LIMIT 1").get(String(f.id ?? file)) as { id: string } | undefined;
    return { slug: file.replace(/\.md$/, ""), path: join(input.notesDir, file), ...(node ? { nodeId: node.id } : {}), title: parsed.title, targetId: String(f.target_id ?? ""), environment: String(f.environment ?? ""), region: String(f.region ?? ""), project: String(f.project ?? ""), logstore: String(f.logstore ?? ""), status: (String(f.status ?? "draft") as EvidenceLifecycle), ...(f.first_seen ? { firstSeen: String(f.first_seen) } : {}), ...(f.last_seen ? { lastSeen: String(f.last_seen) } : {}), observationCount: Number(f.observation_count ?? 0) || 0, ...(f.topic_hash ? { topicHash: String(f.topic_hash) } : {}), ...(f.evidence_hash ? { evidenceHash: String(f.evidence_hash) } : {}), sensitive: f.sensitive === true, mcpAccess: String(f.mcp_access ?? "allowed"), indexed: Boolean(node) };
  }).filter((item) => (!input.targetId || item.targetId === input.targetId) && (!input.status || item.status === input.status)).slice(0, limit);
}

export function setEvidenceStatus(input: { store: KnowledgeStore; notesDir: string; slug: string; from?: EvidenceLifecycle; to: EvidenceLifecycle; actor?: string }): EvidenceFileSummary {
  const file = `${input.slug}.md`;
  const full = join(input.notesDir, file);
  if (!existsSync(full)) throw new Error(`evidence note not found: ${input.slug}`);
  const source = readFileSync(full, "utf8");
  const parsed = parseNote({ path: file, source });
  if (parsed.frontmatter.type !== "evidence") throw new Error(`${input.slug} is not an evidence note`);
  const current = String(parsed.frontmatter.status ?? "draft") as EvidenceLifecycle;
  if (input.from && current !== input.from) throw new Error(`status conflict: expected ${input.from}, found ${current}`);
  if (!EVIDENCE_TRANSITIONS[current]?.includes(input.to)) throw new Error(`invalid evidence status transition ${current} -> ${input.to}`);
  const end = source.indexOf("\n---", 3);
  if (end < 0) throw new Error("evidence frontmatter is malformed");
  const block = source.slice(0, end).replace(/^status:\s*[^\n]+$/m, `status: ${input.to}`);
  const temp = `${full}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${block}${source.slice(end)}`);
  renameSync(temp, full);
  indexFile(input.store, input.notesDir, file);
  const row = listEvidenceNotes({ store: input.store, notesDir: input.notesDir }).find((item) => item.slug === input.slug);
  if (!row) throw new Error("evidence status update was not indexed");
  return row;
}

export interface EvidenceDoctorReport { files: number; indexed: number; missingIndex: string[]; orphanIndex: string[]; malformed: string[]; staleLocks: string[] }
export function evidenceDoctor(input: { store: KnowledgeStore; notesDir: string }): EvidenceDoctorReport {
  const files = listNotes(input.notesDir);
  const evidence = files.filter((file) => file.startsWith("evidence-") && file.endsWith(".md"));
  const missingIndex: string[] = [], malformed: string[] = [];
  for (const file of evidence) {
    try {
      const parsed = parseNote({ path: file, source: readFileSync(join(input.notesDir, file), "utf8") });
      if (parsed.frontmatter.type !== "evidence" || !parsed.frontmatter.target_id || !parsed.frontmatter.topic_hash) malformed.push(file);
      const id = String(parsed.frontmatter.id ?? file);
      const row = input.store.db.prepare("SELECT 1 FROM nodes WHERE identity_key=? LIMIT 1").get(id);
      if (!row) missingIndex.push(file);
    } catch { malformed.push(file); }
  }
  const indexedPaths = new Set((input.store.db.prepare("SELECT path FROM notes_index").all() as Array<{ path: string }>).map((row) => row.path));
  const orphanIndex = [...indexedPaths].filter((path) => path.startsWith("evidence-") && !existsSync(join(input.notesDir, path)));
  // listNotes intentionally returns only Markdown; lock discovery must inspect
  // the directory itself or repair cannot recover an interrupted atomic write.
  const staleLocks = readdirSync(input.notesDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".lock") && (() => { try { return Date.now() - statSync(join(input.notesDir, entry.name)).mtimeMs > 5 * 60_000; } catch { return false; } })()).map((entry) => entry.name);
  return { files: evidence.length, indexed: evidence.length - missingIndex.length, missingIndex, orphanIndex, malformed, staleLocks };
}

export function repairEvidence(input: { store: KnowledgeStore; notesDir: string }): EvidenceDoctorReport & { reindexed: number; removedLocks: number } {
  const before = evidenceDoctor(input);
  const reindexed = reindexNotesDir(input).indexed;
  let removedLocks = 0;
  for (const lock of before.staleLocks) { try { unlinkSync(join(input.notesDir, lock)); removedLocks += 1; } catch { /* concurrent repair */ } }
  return { ...evidenceDoctor(input), reindexed, removedLocks };
}
