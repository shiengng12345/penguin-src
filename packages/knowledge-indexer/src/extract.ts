import { createHash } from "node:crypto";
import { Parser, Query, type Node } from "web-tree-sitter";
import { loadLanguage } from "./parser.js";
import { TAGS_QUERY, SCOPE_NODES } from "./queries.js";
import type { Lang } from "./registry.js";

export interface ExtractedSymbol {
  qualifiedName: string;
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
  contentHash: string;
}

export interface ExtractedRef {
  kind: "call" | "import";
  rawName: string;
  startLine: number;
  // Qualified name of the innermost symbol containing this ref — the `src` of a
  // resolved edge (2c). null for top-level refs with no enclosing symbol.
  enclosingQualifiedName: string | null;
}

export interface ExtractedFile {
  lang: Lang;
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];
  fileImports: string[];
  parseError: string | null;
}

const DEFAULT_MAX_BYTES = 1_000_000;

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim().slice(0, 200);
}

// Build the qualified name by walking scope-node ancestors (outermost first).
function qualifiedNameFor(defNode: Node, name: string, scopeNodes: Set<string>): string {
  const scopes: string[] = [];
  let cur: Node | null = defNode.parent;
  while (cur) {
    if (scopeNodes.has(cur.type)) {
      const scopeName = cur.childForFieldName("name")?.text;
      if (scopeName) scopes.unshift(scopeName);
    }
    cur = cur.parent;
  }
  return [...scopes, name].join(".");
}

// Extract symbols + raw refs/imports from one source file. Never throws:
// oversize / missing grammar / parse failure / bad query → parseError set and
// empty results (file-level degrade, §9). A grammar present but with no tags
// query yields empty symbols with parseError=null.
export async function extractSymbols(input: {
  lang: Lang;
  source: string;
  maxBytes?: number;
}): Promise<ExtractedFile> {
  const lang = input.lang;
  const base: ExtractedFile = { lang, symbols: [], refs: [], fileImports: [], parseError: null };
  const max = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(input.source, "utf8") > max) {
    return { ...base, parseError: "file exceeds max bytes" };
  }

  let language;
  try {
    language = await loadLanguage(lang);
  } catch (e) {
    return { ...base, parseError: `grammar load failed: ${(e as Error).message}` };
  }

  const parser = new Parser();
  parser.setLanguage(language);
  let tree;
  try {
    tree = parser.parse(input.source);
  } catch (e) {
    return { ...base, parseError: `parse failed: ${(e as Error).message}` };
  }
  if (!tree) return { ...base, parseError: "parse returned null" };

  const tagsQuery = TAGS_QUERY[lang];
  if (!tagsQuery) return base; // grammar present, no symbol query → file-level only

  let query: Query;
  try {
    query = new Query(language, tagsQuery);
  } catch (e) {
    return { ...base, parseError: `bad tags query: ${(e as Error).message}` };
  }

  const scopeNodes = new Set(SCOPE_NODES[lang] ?? []);
  const symbols: ExtractedSymbol[] = [];
  const refs: ExtractedRef[] = [];
  const fileImports: string[] = [];

  for (const match of query.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name.startsWith("definition."));
    const nameCap = match.captures.find((c) => c.name === "name");
    const callCap = match.captures.find((c) => c.name === "reference.call");
    const importCap = match.captures.find((c) => c.name === "reference.import");

    if (def && nameCap) {
      symbols.push({
        qualifiedName: qualifiedNameFor(def.node, nameCap.node.text, scopeNodes),
        name: nameCap.node.text,
        kind: def.name.slice("definition.".length),
        signature: firstLine(def.node.text),
        startLine: def.node.startPosition.row + 1,
        endLine: def.node.endPosition.row + 1,
        contentHash: sha256(def.node.text),
      });
    } else if (callCap) {
      refs.push({
        kind: "call",
        rawName: callCap.node.text,
        startLine: callCap.node.startPosition.row + 1,
        enclosingQualifiedName: null,
      });
    } else if (importCap) {
      const raw = importCap.node.text.replace(/^['"]|['"]$/g, "");
      fileImports.push(raw);
      refs.push({
        kind: "import",
        rawName: raw,
        startLine: importCap.node.startPosition.row + 1,
        enclosingQualifiedName: null,
      });
    }
  }

  // Attribute each ref to the innermost symbol whose line range contains it.
  for (const ref of refs) {
    let best: ExtractedSymbol | null = null;
    for (const sym of symbols) {
      if (sym.startLine <= ref.startLine && ref.startLine <= sym.endLine) {
        if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) {
          best = sym;
        }
      }
    }
    ref.enclosingQualifiedName = best ? best.qualifiedName : null;
  }

  return { lang, symbols, refs, fileImports, parseError: null };
}
