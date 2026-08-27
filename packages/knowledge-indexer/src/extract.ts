import { createHash } from "node:crypto";
import { Parser, Query, type Node } from "web-tree-sitter";
import { loadLanguage } from "./parser.js";
import { TAGS_QUERY, SCOPE_NODES } from "./queries.js";
import { extractEndpoints, type ExtractedEndpoint } from "./routes.js";
import { collectCodeEntityRefs } from "./code-entities.js";
import { extractGrpcClientCalls, type GrpcClientCall } from "./grpc-client.js";
import { collectIdentifierNode, type IdentifierEntry } from "./identifiers.js";
import { extractChannelBindings, type ExtractedChannelBinding } from "./channels.js";
import type { Lang } from "./registry.js";

export interface ExtractedSymbol {
  qualifiedName: string;
  name: string;
  kind: string;
  signature: string | null;
  startLine: number;
  endLine: number;
  contentHash: string;
  /** Normalized parameter text, used only when a base name is overloaded. */
  identityDiscriminator?: string;
}

export interface ExtractedRef {
  kind: "call" | "import" | "type" | "throws" | "env" | "jsx-component" | "jsx-callback";
  rawName: string;
  // For member calls, retain the receiver text (`Date` in `Date.now()`,
  // `this.playerProcessor` in `this.playerProcessor.login()`). Resolving only
  // the property name loses the evidence needed to distinguish platform APIs
  // from user symbols with the same bare name.
  memberReceiver?: string;
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
  endpoints: ExtractedEndpoint[]; // NestJS endpoints (gRPC/kafka/http), ts/tsx
  grpcClientCalls: GrpcClientCall[]; // inter-service gRPC client invocations
  identifiers: IdentifierEntry[]; // TS/JS fields and object keys, from this same AST
  logSites: ExtractedLogSite[]; // static logger message → enclosing symbol
  channels: ExtractedChannelBinding[];
  parseError: string | null;
}

export interface ExtractedLogSite {
  message: string;
  level: string;
  startLine: number;
  enclosingQualifiedName: string | null;
}

const DEFAULT_MAX_BYTES = 1_000_000;

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

const LOG_LEVELS = new Set(["trace", "debug", "info", "log", "warn", "error", "fatal", "verbose"]);

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

function staticLogText(node: Node): string | null {
  if (node.type === "string") {
    const text = node.text;
    return text.length >= 2 ? text.slice(1, -1) : "";
  }
  if (node.type !== "template_string") return null;
  let prefix = "";
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i)!;
    if (child.type === "template_substitution") break;
    if (child.type === "string_fragment") prefix += child.text;
  }
  return prefix || null;
}

function extractJsMetadata(root: Node): { identifiers: IdentifierEntry[]; logSites: ExtractedLogSite[] } {
  const identifiers: IdentifierEntry[] = [];
  const sites: ExtractedLogSite[] = [];
  walk(root, (node) => {
    collectIdentifierNode(node, identifiers);
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    if (!fn || !args || fn.type !== "member_expression") return;
    const object = fn.childForFieldName("object");
    const property = fn.childForFieldName("property");
    const level = property?.text.toLowerCase();
    if (!object || !level || !LOG_LEVELS.has(level)) return;
    if (!/(?:^|\.)((?:app)?logger|console)$/i.test(object.text)) return;
    const firstArg = args.namedChild(0);
    if (!firstArg) return;
    const message = staticLogText(firstArg);
    if (message == null) return;
    sites.push({
      message,
      level,
      startLine: node.startPosition.row + 1,
      enclosingQualifiedName: null,
    });
  });
  return { identifiers, logSites: sites };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// content_hash = hash of the symbol's IMPLEMENTATION, independent of its own
// name (§3.2: "hash 相同 = 实现无差异"). We blank whole-word occurrences of the
// symbol's name before hashing so a pure rename (same body, new name) keeps an
// equal hash — the signal rename detection relies on (§6.3).
function contentHashOf(defText: string, name: string): string {
  const normalized = name
    ? defText.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), "\\0")
    : defText;
  return sha256(normalized);
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0].trim().slice(0, 200);
}

// Build the qualified name by walking scope-node ancestors (outermost first).
function identitySignature(defNode: Node): string {
  const parameters = defNode.childForFieldName("parameters") ?? defNode.childForFieldName("formal_parameters");
  if (!parameters) return "";
  // Parameter text is an identity discriminator, not display text. Remove
  // whitespace/comments noise while preserving arity and type/default
  // markers so overloads in the same container cannot collapse into one node.
  return parameters.text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "").replace(/\s+/g, "");
}

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

function extractTsxRelationRefs(root: Node): ExtractedRef[] {
  const refs: ExtractedRef[] = [];
  walk(root, (node) => {
    if (node.type === "jsx_self_closing_element" || node.type === "jsx_opening_element") {
      const name = node.namedChild(0);
      // Member expressions and namespaces need import/type resolution that is
      // not available from this syntax alone. Lowercase names are intrinsic
      // DOM elements, not repository component symbols.
      if (name?.type === "identifier" && /^[A-Z_$]/u.test(name.text)) {
        refs.push({
          kind: "jsx-component",
          rawName: name.text,
          startLine: name.startPosition.row + 1,
          enclosingQualifiedName: null,
        });
      }
    }
    if (node.type !== "jsx_attribute") return;
    const value = [...Array(node.namedChildCount)].map((_, index) => node.namedChild(index)!).find(
      (child) => child.type === "jsx_expression",
    );
    const expression = value?.namedChild(0);
    // Only a direct identifier is a stable callback target. Calls, arrows,
    // member expressions, spreads, and computed values remain unlinked.
    if (expression?.type === "identifier") {
      refs.push({
        kind: "jsx-callback",
        rawName: expression.text,
        startLine: expression.startPosition.row + 1,
        enclosingQualifiedName: null,
      });
    }
  });
  return refs;
}

// Extract symbols + raw refs/imports from one source file. Never throws:
// oversize / missing grammar / parse failure / bad query → parseError set and
// empty results (file-level degrade, §9). A grammar present but with no tags
// query yields empty symbols with parseError=null.
export async function extractSymbols(input: {
  lang: Lang;
  source: string;
  maxBytes?: number;
  // Used to file-scope scope-less object-property functions (see below) so a
  // bare name like `useFactory` doesn't collide across files into one node.
  relPath?: string;
}): Promise<ExtractedFile> {
  const lang = input.lang;
  const base: ExtractedFile = {
    lang, symbols: [], refs: [], fileImports: [], endpoints: [], grpcClientCalls: [],
    identifiers: [], logSites: [], channels: [], parseError: null,
  };
  const max = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(input.source, "utf8") > max) {
    return { ...base, parseError: "file exceeds max bytes" };
  }

  // Languages without a tags query are intentionally file-level only. Do not
  // invoke their grammar merely to discard the tree: some bundled grammars
  // reject otherwise valid syntax in this web-tree-sitter runtime (notably
  // Bash `case`) and would turn a supported file-level index into a false
  // parse error.
  const tagsQuery = TAGS_QUERY[lang];
  if (!tagsQuery) return base;

  let language;
  try {
    language = await loadLanguage(lang);
  } catch (e) {
    return { ...base, parseError: `grammar load failed: ${(e as Error).message}` };
  }

  const parser = new Parser();
  parser.setLanguage(language);
  let tree: ReturnType<Parser["parse"]> = null;
  let query: Query | null = null;
  try {
    try {
      tree = parser.parse(input.source);
    } catch (e) {
      return { ...base, parseError: `parse failed: ${(e as Error).message}` };
    }
    if (!tree) return { ...base, parseError: "parse returned null" };

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
    const typeCap = match.captures.find((c) => c.name === "reference.type");
    const importCap = match.captures.find((c) => c.name === "reference.import");

    if (def && nameCap) {
      const kind = def.name.slice("definition.".length);
      let qn = qualifiedNameFor(def.node, nameCap.node.text, scopeNodes);
      // Object-property functions with no enclosing class scope (pair-extracted
      // `method`s — e.g. every NestJS provider's `useFactory`/`useValue`) get a
      // bare qualifiedName, so they collide repo-wide into a single node and
      // mis-attribute edges. File-scope them: `<relPath>::<name>` keeps the bare
      // name a suffix, so bareNameCandidates + bareOf still resolve calls to it.
      if ((kind === "method" || kind === "function") && !qn.includes(".") && input.relPath) {
        qn = `${input.relPath}::${qn}`;
      }
      symbols.push({
        qualifiedName: qn,
        name: nameCap.node.text,
        kind,
        signature: firstLine(def.node.text),
        identityDiscriminator: identitySignature(def.node),
        startLine: def.node.startPosition.row + 1,
        endLine: def.node.endPosition.row + 1,
        contentHash: contentHashOf(def.node.text, nameCap.node.text),
      });
    } else if (callCap) {
      const member = callCap.node.parent?.type === "member_expression"
        ? callCap.node.parent
        : null;
      const receiver = member?.childForFieldName("object")?.text;
      refs.push({
        kind: "call",
        rawName: callCap.node.text,
        ...(receiver ? { memberReceiver: receiver } : {}),
        startLine: callCap.node.startPosition.row + 1,
        enclosingQualifiedName: null,
      });
    } else if (typeCap) {
      refs.push({
        kind: "type",
        rawName: typeCap.node.text,
        startLine: typeCap.node.startPosition.row + 1,
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

  // Re-export declarations are import edges too.  Some tree-sitter tags
  // queries capture `import ... from` but omit `export {x} from` and
  // `export {default as x} from`; retain the source locator so the pipeline
  // can resolve barrel files without treating the re-export as a plain text
  // mention.
  if (lang === "ts" || lang === "tsx" || lang === "js") {
    walk(tree.rootNode, (node) => {
      if (node.type !== "export_statement") return;
      const source = node.childForFieldName("source");
      if (!source) return;
      const raw = source.text.replace(/^['"]|['"]$/g, "");
      if (!raw || fileImports.includes(raw)) return;
      fileImports.push(raw);
      refs.push({ kind: "import", rawName: raw, startLine: source.startPosition.row + 1, enclosingQualifiedName: null });
    });
  }

  // Keep the long-standing friendly qualified name for unique symbols. Only
  // a duplicate base identity gets a stable parameter discriminator, avoiding
  // noisy `login()` suffixes while still separating true overloads. If an
  // overload has no parameter node, AST order is a deterministic final tie
  // breaker within that parent/file.
  const byBase = new Map<string, ExtractedSymbol[]>();
  for (const symbol of symbols) byBase.set(symbol.qualifiedName, [...(byBase.get(symbol.qualifiedName) ?? []), symbol]);
  for (const group of byBase.values()) if (group.length > 1) {
    group.forEach((symbol, index) => { symbol.qualifiedName = `${symbol.qualifiedName}${symbol.identityDiscriminator || `#${index + 1}`}`; });
  }

  // Code entities (thrown errors, env reads) join the refs stream so they get
  // the same enclosing-symbol attribution, then become entity edges in the pipeline.
  if (lang === "ts" || lang === "tsx") {
    for (const ce of collectCodeEntityRefs(tree.rootNode)) {
      refs.push({ kind: ce.kind, rawName: ce.rawName, startLine: ce.startLine, enclosingQualifiedName: null });
    }
  }

  if (lang === "tsx") refs.push(...extractTsxRelationRefs(tree.rootNode));

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

  // Framework endpoints + inter-service gRPC client calls (ts/tsx): layered on the AST.
  const isTs = lang === "ts" || lang === "tsx";
  const endpoints = isTs ? extractEndpoints(tree.rootNode) : [];
  const grpcClientCalls = isTs ? extractGrpcClientCalls(tree.rootNode) : [];
  // Attribute each gRPC client call to the innermost enclosing symbol (the caller).
  for (const gc of grpcClientCalls) {
    let best: ExtractedSymbol | null = null;
    for (const sym of symbols) {
      if (sym.startLine <= gc.startLine && gc.startLine <= sym.endLine) {
        if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
      }
    }
    gc.enclosingQualifiedName = best ? best.qualifiedName : null;
  }

  // Keep TS/JS extraction to one tree-sitter parse per file. These used to
  // call a second parse through extractIdentifiersFromSource(), doubling the
  // hottest part of large JS/TS rebuilds.
  const isJsLike = lang === "ts" || lang === "tsx" || lang === "js";
  const metadata = isJsLike ? extractJsMetadata(tree.rootNode) : { identifiers: [], logSites: [] };
  const { identifiers, logSites } = metadata;
  for (const site of logSites) {
    let best: ExtractedSymbol | null = null;
    for (const sym of symbols) {
      if (sym.startLine <= site.startLine && site.startLine <= sym.endLine) {
        if (!best || sym.endLine - sym.startLine < best.endLine - best.startLine) best = sym;
      }
    }
    site.enclosingQualifiedName = best ? best.qualifiedName : null;
  }

    // Channel syntax is intentionally language-agnostic at this boundary:
    // framework adapters are represented by the same binding extractor, while
    // unresolved/computed names remain candidates instead of becoming joins.
    const channels = extractChannelBindings(input.source, symbols);
    return { lang, symbols, refs, fileImports, endpoints, grpcClientCalls, identifiers, logSites, channels, parseError: null };
  } finally {
    query?.delete();
    tree?.delete();
    parser.delete();
  }
}
