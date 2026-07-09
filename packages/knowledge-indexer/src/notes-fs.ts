import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { indexNote, parseNote } from "./notes.js";

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
  | "note" | "decision" | "incident" | "compliance" | "bug" | "requirement" | "architecture" | "migration";

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
export function reindexNotesDir(input: { store: KnowledgeStore; notesDir: string }): { indexed: number } {
  const files = listNotes(input.notesDir);
  for (const f of files) indexFile(input.store, input.notesDir, f);
  return { indexed: files.length };
}
