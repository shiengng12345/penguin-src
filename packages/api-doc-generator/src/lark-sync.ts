import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseManagedSections } from "./managed-sections.js";
import type { ApiDocPreview, ManagedBlockInput, ParsedManagedSection } from "./types.js";

export interface LarkDocumentSnapshot { nodeToken: string; documentId: string; revisionId: number; blocks: ManagedBlockInput[] }
export interface LarkSectionClient {
  fetchFull(nodeToken: string, revisionId?: number): Promise<LarkDocumentSnapshot>;
  replaceSection(input: { nodeToken: string; sectionKey: string; xml: string; revisionId: number }): Promise<{ revisionId: number }>;
  deleteSection(input: { nodeToken: string; sectionKey: string; blockIds: string[]; revisionId: number }): Promise<{ revisionId: number }>;
  createDraft(input: { parentToken: string; title: string; xml: string }): Promise<{ nodeToken: string; revisionId: number }>;
}
export interface ApiDocBinding { documentKey: string; nodeToken: string; documentId: string; lastRevisionId: number; sectionHashes: Record<string, string>; previewId: string; sourceRevisions: string[] }
export interface ApiDocSyncResult { status: "no_change" | "synced" | "conflict" | "partial" | "confirmation_required"; binding?: ApiDocBinding; conflict?: { sectionKeys: string[]; reason: string }; journalId?: string; error?: string }
export interface ApiDocSyncJournal { journalId: string; documentKey: string; nodeToken: string; baseRevisionId: number; desiredSectionHashes: Record<string, string>; completedSectionKeys: string[]; status: "running" | "partial" | "verified"; pending?: { sectionKey: string; phase: string }; lastError?: string; updatedAt: string }
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function atomic(path: string, value: string): void { const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(tmp, value); renameSync(tmp, path); }
function desiredContent(xml: string): string { return xml.replace(/<p style="color:#999999">PENGUIN_API_DOC_(?:BEGIN|END):v1:[^<]+<\/p>/g, ""); }
function desiredSectionHash(documentKey: string, xml: string): string {
  const blocks = (xml.match(/<p style="color:#999999">.*?<\/p>|<h[1-6]>.*?<\/h[1-6]>|<p>.*?<\/p>/g) ?? [xml]).map((value, index) => ({ blockId: `desired-${index}`, topLevelIndex: index, xml: value }));
  const parsed = parseManagedSections(documentKey, blocks);
  return parsed.sections[0]?.contentHash ?? hash(desiredContent(xml));
}
function journalPath(dir: string, key: string): string { mkdirSync(dir, { recursive: true }); return join(dir, `${hash(key)}.json`); }

export async function syncManagedDocument(input: { preview: ApiDocPreview; binding: ApiDocBinding; client: LarkSectionClient; journalDir: string; now?: Date }): Promise<ApiDocSyncResult> {
  const { preview, binding, client } = input; const journalId = `journal:${randomUUID()}`; const path = journalPath(input.journalDir, binding.documentKey);
  let snapshot = await client.fetchFull(binding.nodeToken, binding.lastRevisionId);
  const parsed = parseManagedSections(binding.documentKey, snapshot.blocks);
  if (parsed.status !== "ok") return { status: "conflict", journalId, conflict: { sectionKeys: parsed.errors.flatMap((error) => error.sectionKey ? [error.sectionKey] : []), reason: "document has unbalanced or duplicate managed markers" } };
  const desired = Object.fromEntries(preview.rendered.sections.map((section) => [section.sectionKey, desiredSectionHash(binding.documentKey, section.larkXml)]));
  const journal: ApiDocSyncJournal = { journalId, documentKey: binding.documentKey, nodeToken: binding.nodeToken, baseRevisionId: snapshot.revisionId, desiredSectionHashes: desired, completedSectionKeys: [], status: "running", updatedAt: (input.now ?? new Date()).toISOString() }; atomic(path, JSON.stringify(journal, null, 2));
  const current = new Map(parsed.sections.map((section) => [section.sectionKey, section]));
  const conflicts = parsed.sections.filter((section) => binding.sectionHashes[section.sectionKey] && binding.sectionHashes[section.sectionKey] !== section.contentHash).map((section) => section.sectionKey);
  if (conflicts.length) { journal.status = "partial"; journal.lastError = "human edits detected"; atomic(path, JSON.stringify(journal, null, 2)); return { status: "conflict", journalId, conflict: { sectionKeys: conflicts, reason: "managed section changed since last verified binding" } }; }
  try {
    for (const section of preview.rendered.sections) {
      const existing = current.get(section.sectionKey);
      if (existing && existing.contentHash === desired[section.sectionKey]) { journal.completedSectionKeys.push(section.sectionKey); continue; }
      journal.pending = { sectionKey: section.sectionKey, phase: "replace_pending" }; atomic(path, JSON.stringify(journal, null, 2));
      const result = await client.replaceSection({ nodeToken: binding.nodeToken, sectionKey: section.sectionKey, xml: section.larkXml, revisionId: snapshot.revisionId });
      snapshot = await client.fetchFull(binding.nodeToken, result.revisionId); journal.completedSectionKeys.push(section.sectionKey); journal.pending = undefined; journal.updatedAt = (input.now ?? new Date()).toISOString(); atomic(path, JSON.stringify(journal, null, 2));
    }
    const desiredKeys = new Set(preview.rendered.sections.map((section) => section.sectionKey));
    for (const section of parsed.sections) if (!desiredKeys.has(section.sectionKey)) {
      if (!binding.sectionHashes[section.sectionKey]) continue;
      journal.pending = { sectionKey: section.sectionKey, phase: "delete_pending" }; atomic(path, JSON.stringify(journal, null, 2));
      const result = await client.deleteSection({ nodeToken: binding.nodeToken, sectionKey: section.sectionKey, blockIds: [section.beginBlockId, ...section.contentBlockIds, section.endBlockId], revisionId: snapshot.revisionId });
      snapshot = await client.fetchFull(binding.nodeToken, result.revisionId); journal.completedSectionKeys.push(section.sectionKey); journal.pending = undefined; atomic(path, JSON.stringify(journal, null, 2));
    }
    const final = parseManagedSections(binding.documentKey, snapshot.blocks); if (final.status !== "ok") throw new Error(`final document markers are invalid: ${JSON.stringify(final.errors)}`);
    const finalHashes = Object.fromEntries(final.sections.map((section) => [section.sectionKey, section.contentHash]));
    for (const key of Object.keys(desired)) if (finalHashes[key] !== desired[key]) throw new Error(`final readback mismatch for ${key}`);
    journal.status = "verified"; journal.pending = undefined; atomic(path, JSON.stringify(journal, null, 2));
    return { status: Object.keys(binding.sectionHashes).length === Object.keys(desired).length && Object.entries(desired).every(([key, value]) => binding.sectionHashes[key] === value) ? "no_change" : "synced", journalId, binding: { ...binding, lastRevisionId: snapshot.revisionId, sectionHashes: finalHashes } };
  } catch (error) { journal.status = "partial"; journal.lastError = String((error as Error).message ?? error); atomic(path, JSON.stringify(journal, null, 2)); return { status: "partial", journalId, error: journal.lastError }; }
}

export async function repairManagedDocument(input: { binding: ApiDocBinding; client: LarkSectionClient; journalDir: string; preview: ApiDocPreview }): Promise<ApiDocSyncResult> {
  // Repair deliberately refetches and re-enters the same conflict-safe path;
  // it never infers success from a stale process journal.
  return syncManagedDocument(input);
}
