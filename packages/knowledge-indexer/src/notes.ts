import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";
import { extractMarkdownLinks } from "./markdown-links.js";
import { extractMarkdownProperties } from "./markdown-properties.js";
import { resolveNoteLinks } from "./fusion.js";

export interface ParsedNote {
  identityKey: string;
  title: string;
  frontmatter: Record<string, unknown>;
  sensitive: boolean;
  mcpAccess: "allowed" | "denied";
  isCredential: boolean;
  body: string;
  wikilinks: Array<{ rawTarget: string; namespace: string | null; targetAnchor: string | null; displayText: string | null; embedded: boolean; sourceLine: number }>;
  tags: string[];
  entities: Array<{ entityType: string; value: string; normalizedValue: string }>;
  headings: Array<{ level: number; text: string }>;
  contentHash: string;
}

const SECRET_KEY = /(?:secret|password|token|api[_-]?key|private[_-]?key|credential|authorization)/i;
function redactedFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(frontmatter).map(([key, value]) => [key, SECRET_KEY.test(key) ? "[REDACTED_SECRET]" : value]));
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// Minimal YAML frontmatter: `key: value` lines + inline `[a, b]` lists between
// leading `---` fences. Enough for note flags (id/title/sensitive/mcp_access/
// type/tags); a full YAML parser is deliberately avoided (YAGNI).
function parseFrontmatter(source: string): { data: Record<string, unknown>; body: string } {
  if (!source.startsWith("---")) return { data: {}, body: source };
  const end = source.indexOf("\n---", 3);
  if (end === -1) return { data: {}, body: source };
  const block = source.slice(source.indexOf("\n") + 1, end);
  const rest = source.slice(source.indexOf("\n---", end === 3 ? 3 : end) + 4);
  const body = rest.replace(/^\r?\n/, "");
  const data: Record<string, unknown> = {};
  const scalar = (raw: string): unknown => {
    const value = raw.trim().replace(/^["']|["']$/g, "");
    if (value === "null" || value === "~") return null;
    if (value === "true") return true;
    if (value === "false") return false;
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(value)) return Number(value);
    if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).split(",").map((item) => scalar(item)).filter((item) => item !== "");
    return value;
  };
  const lines = block.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const m = lines[index].match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (!m[2].trim()) {
      const items: unknown[] = [];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const item = lines[cursor].match(/^\s+-\s+(.*)$/);
        if (!item) break;
        items.push(scalar(item[1]));
        cursor += 1;
      }
      if (items.length) { data[key] = items; index = cursor - 1; continue; }
    }
    data[key] = scalar(m[2]);
  }
  return { data, body };
}

// Regex entity extraction (zero LLM, §5). Deduped by (type, normalizedValue).
export function extractEntities(text: string): ParsedNote["entities"] {
  const patterns: Array<{ type: string; re: RegExp }> = [
    { type: "player_id", re: /\bplayer[_-]?id[=:\s]+(\d+)/gi },
    { type: "proposal_id", re: /\bproposal[_-]?id[=:\s]+([\w-]+)/gi },
    { type: "req_id", re: /\b(?:reqid|request[_-]?id)[=:\s]+([\w-]+)/gi },
    { type: "trace_id", re: /\btrace[_-]?id[=:\s]+([0-9a-f]{8,})/gi },
    { type: "env", re: /\b(production|prod|staging|qat|uat|sandbox)\b/gi },
  ];
  const seen = new Set<string>();
  const out: ParsedNote["entities"] = [];
  for (const { type, re } of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const value = m[1];
      const normalizedValue = value.toLowerCase();
      const key = `${type}:${normalizedValue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ entityType: type, value, normalizedValue });
    }
  }
  return out;
}

function extractTags(body: string): string[] {
  const tags = new Set<string>();
  let inFence = false;
  for (const line of body.split("\n")) {
    if (line.trim().startsWith("```")) { inFence = !inFence; continue; }
    if (inFence) continue;
    for (const m of line.matchAll(/(?:^|\s)#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g)) {
      tags.add(m[1]);
    }
  }
  return [...tags];
}

export function parseNote(input: { path: string; source: string }): ParsedNote {
  const { data, body } = parseFrontmatter(input.source);
  const h1 = body.match(/^#\s+(.+)$/m);
  const title = String(data.title ?? h1?.[1] ?? basename(input.path).replace(/\.md$/i, "")).trim();
  const identityKey = data.id ? String(data.id) : input.path;
  const sensitive = data.sensitive === true;
  const mcpAccess = data.mcp_access === "denied" ? "denied" : "allowed";
  const isCredential = data.type === "credential";

  const wikilinks: ParsedNote["wikilinks"] = [];
  for (const m of body.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    const rawInner = m[2].trim();
    const pipe = rawInner.indexOf("|");
    const targetAndAnchor = (pipe >= 0 ? rawInner.slice(0, pipe) : rawInner).trim();
    const hash = targetAndAnchor.indexOf("#");
    const rawTarget = (hash >= 0 ? targetAndAnchor.slice(0, hash) : targetAndAnchor).trim();
    const colon = rawTarget.indexOf(":");
    if (colon > 0) {
      wikilinks.push({ rawTarget: rawTarget.slice(colon + 1).trim(), namespace: rawTarget.slice(0, colon).trim(), targetAnchor: hash >= 0 ? targetAndAnchor.slice(hash + 1) : null, displayText: pipe >= 0 ? rawInner.slice(pipe + 1).trim() : null, embedded: m[1] === "!", sourceLine: body.slice(0, m.index ?? 0).split(/\r?\n/).length });
    } else {
      wikilinks.push({ rawTarget, namespace: null, targetAnchor: hash >= 0 ? targetAndAnchor.slice(hash + 1) : null, displayText: pipe >= 0 ? rawInner.slice(pipe + 1).trim() : null, embedded: m[1] === "!", sourceLine: body.slice(0, m.index ?? 0).split(/\r?\n/).length });
    }
  }

  const headings: ParsedNote["headings"] = [];
  for (const m of body.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    headings.push({ level: m[1].length, text: m[2].trim() });
  }

  return {
    identityKey, title, frontmatter: data, sensitive, mcpAccess, isCredential,
    body, wikilinks, tags: extractTags(body), entities: extractEntities(body),
    headings, contentHash: sha256(input.source),
  };
}

// Index a parsed note into the store: upsert the note node (identity = fm id or
// path — path change with same id keeps the node) + notes_index + FTS. Credential
// notes are never body-indexed into FTS (§5); their body lands in Plan 3's table.
export function indexNote(input: {
  store: KnowledgeStore;
  repoRelPath: string;
  parsed: ParsedNote;
}): { nodeId: string } {
  const { store, parsed } = input;
  const searchableFrontmatter = redactedFrontmatter(parsed.frontmatter);
  const nodeId = store.upsertNode({
    nodeType: parsed.isCredential ? "credential" : "note",
    identityKey: parsed.identityKey,
    title: parsed.title,
    meta: { tags: parsed.tags, frontmatter: searchableFrontmatter },
  });
  const links = extractMarkdownLinks(parsed.body);
  const properties = extractMarkdownProperties(searchableFrontmatter, parsed.body);
  const tx = store.db.transaction(() => {
    store.db.prepare("DELETE FROM note_properties WHERE note_node_id=?").run(nodeId);
    const propertyInsert = store.db.prepare("INSERT INTO note_properties(note_node_id,property_key,ordinal,value_type,value_text,value_number,value_boolean,value_date,source_line) VALUES (?,?,?,?,?,?,?,?,?)");
    for (const property of properties) propertyInsert.run(nodeId, property.key, property.ordinal, property.valueType, property.valueText, property.valueNumber, property.valueBoolean === null ? null : property.valueBoolean ? 1 : 0, property.valueDate, property.sourceLine);
    store.db.prepare("DELETE FROM note_links WHERE source_node_id=?").run(nodeId);
    const linkInsert = store.db.prepare("INSERT INTO note_links(source_node_id,source_line,raw_target,target_node_id,target_anchor,display_text,embedded,resolution_status) VALUES (?,?,?,?,?,?,?,?)");
    for (const link of links) linkInsert.run(nodeId, link.sourceLine, link.rawTarget, null, link.targetAnchor, link.displayText, link.embedded ? 1 : 0, "unresolved");
  });
  tx();
  resolveNoteLinks({ store, noteNodeId: nodeId, noteTitle: parsed.title, noteIdentityKey: parsed.identityKey, parsed });
  // Derived properties/links are replaced first; FTS is the final derived
  // layer so a failed transaction cannot expose a half-updated note.
  store.indexNoteText({
    nodeId,
    path: input.repoRelPath,
    title: parsed.title,
    body: parsed.isCredential ? "" : parsed.body,
    frontmatter: searchableFrontmatter,
    sensitive: parsed.sensitive || parsed.isCredential,
    mcpAccess: parsed.isCredential ? "denied" : parsed.mcpAccess,
    contentHash: parsed.contentHash,
  });
  return { nodeId };
}
