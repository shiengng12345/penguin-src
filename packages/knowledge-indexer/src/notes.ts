import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { KnowledgeStore } from "@penguin/knowledge-core";

export interface ParsedNote {
  identityKey: string;
  title: string;
  frontmatter: Record<string, unknown>;
  sensitive: boolean;
  mcpAccess: "allowed" | "denied";
  isCredential: boolean;
  body: string;
  wikilinks: Array<{ rawTarget: string; namespace: string | null }>;
  tags: string[];
  entities: Array<{ entityType: string; value: string; normalizedValue: string }>;
  headings: Array<{ level: number; text: string }>;
  contentHash: string;
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
  for (const raw of block.split("\n")) {
    const m = raw.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value: unknown = m[2].trim().replace(/^["']|["']$/g, "");
    if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
    data[key] = value;
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
    { type: "env", re: /\b(production|prod|staging|uat|sandbox)\b/gi },
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
  for (const m of body.matchAll(/\[\[([^\]]+)\]\]/g)) {
    const inner = m[1].trim();
    const colon = inner.indexOf(":");
    if (colon > 0) {
      wikilinks.push({ rawTarget: inner.slice(colon + 1).trim(), namespace: inner.slice(0, colon).trim() });
    } else {
      wikilinks.push({ rawTarget: inner, namespace: null });
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
  const nodeId = store.upsertNode({
    nodeType: parsed.isCredential ? "credential" : "note",
    identityKey: parsed.identityKey,
    title: parsed.title,
    meta: { tags: parsed.tags, frontmatter: parsed.frontmatter },
  });
  store.indexNoteText({
    nodeId,
    path: input.repoRelPath,
    title: parsed.title,
    body: parsed.isCredential ? "" : parsed.body,
    frontmatter: parsed.frontmatter,
    sensitive: parsed.sensitive || parsed.isCredential,
    mcpAccess: parsed.isCredential ? "denied" : parsed.mcpAccess,
    contentHash: parsed.contentHash,
  });
  return { nodeId };
}
