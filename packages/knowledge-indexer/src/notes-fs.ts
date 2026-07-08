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
export function createNote(input: {
  store: KnowledgeStore;
  notesDir: string;
  title: string;
  body?: string;
}): { slug: string; path: string; nodeId: string } {
  ensureDir(input.notesDir);
  const base = noteSlug(input.title);
  let slug = base;
  for (let i = 2; existsSync(join(input.notesDir, `${slug}.md`)); i++) slug = `${base}-${i}`;
  const fileName = `${slug}.md`;
  const content = `---\nid: ${slug}\ntitle: ${input.title}\n---\n\n${input.body ?? ""}`;
  writeFileSync(join(input.notesDir, fileName), content);
  const nodeId = indexFile(input.store, input.notesDir, fileName);
  return { slug, path: join(input.notesDir, fileName), nodeId };
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
