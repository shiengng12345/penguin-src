import { createHash } from "node:crypto";
import type { ManagedBlockInput, ManagedSectionParseResult, ParsedManagedSection } from "./types.js";
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const marker = (xml: string, documentKey: string, kind: "BEGIN" | "END") => xml.match(new RegExp(`PENGUIN_API_DOC_${kind}:v1:${escapeRegex(documentKey)}:([^<\\s]+)`));
function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
export function parseManagedSections(documentKey: string, blocks: ManagedBlockInput[], options: { pending?: { sectionKey: string; oldBlockIds: string[]; observedNewBlockIds: string[] } } = {}): ManagedSectionParseResult {
  const sections: ParsedManagedSection[] = [], errors: ManagedSectionParseResult["errors"] = [], used = new Set<string>();
  let current: { key: string; begin: ManagedBlockInput; content: ManagedBlockInput[] } | null = null;
  for (const block of [...blocks].sort((a, b) => a.topLevelIndex - b.topLevelIndex)) {
    const begin = marker(block.xml, documentKey, "BEGIN"), end = marker(block.xml, documentKey, "END");
    if (begin) {
      if (current) { errors.push({ code: "nested_or_duplicate_begin", sectionKey: begin[1], blockIds: [block.blockId] }); continue; }
      current = { key: begin[1], begin: block, content: [] }; used.add(block.blockId); continue;
    }
    if (end) {
      if (!current || end[1] !== current.key) { errors.push({ code: "unbalanced_end", sectionKey: end[1], blockIds: [block.blockId] }); continue; }
      used.add(block.blockId); const canonicalXml = current.content.map((item) => item.xml).join(""); sections.push({ sectionKey: current.key, beginBlockId: current.begin.blockId, contentBlockIds: current.content.map((item) => item.blockId), endBlockId: block.blockId, contentHash: hash(canonicalXml), canonicalXml }); current = null; continue;
    }
    if (current) { current.content.push(block); used.add(block.blockId); }
  }
  if (current) errors.push({ code: "unbalanced_begin", sectionKey: current.key, blockIds: [current.begin.blockId, ...current.content.map((item) => item.blockId)] });
  const unmanagedBlockIds = blocks.filter((block) => !used.has(block.blockId)).map((block) => block.blockId);
  if (options.pending) {
    const allowed = new Set([...options.pending.oldBlockIds, ...options.pending.observedNewBlockIds]);
    for (const section of sections) for (const id of [section.beginBlockId, ...section.contentBlockIds, section.endBlockId]) if (!allowed.has(id)) errors.push({ code: "unexpected_pending_duplicate", sectionKey: section.sectionKey, blockIds: [id] });
  }
  return { status: errors.length ? "structural_conflict" : "ok", sections, unmanagedBlockIds, errors };
}
