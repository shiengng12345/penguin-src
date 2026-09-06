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
import { wrappedFunctionVerdict } from "./wrapper-functions.js";

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

/** One imported local name and the specifier it came from. */
export interface ExtractedImportBinding {
  localName: string;
  specifier: string;
  /** `import type {...}` — no runtime call can reach this binding. */
  typeOnly: boolean;
}

/** A source-grounded owner-property -> declared-type relationship. */
export interface ExtractedReceiverBinding {
  ownerQualifiedName: string;
  propertyName: string;
  typeName: string;
  typeSpecifier?: string;
  /** Resolved repository-relative file, added by the indexing pipeline. */
  typeFilePath?: string;
  startLine: number;
}

export interface ExtractedFile {
  lang: Lang;
  symbols: ExtractedSymbol[];
  refs: ExtractedRef[];
  fileImports: string[];
  // localName -> specifier, which fileImports alone cannot express. Without it
  // the resolver only learns which in-repo FILES a file imports; a bare
  // specifier like 'react-redux' resolves to no file and disappears, so
  // `useSelector` looks like an unqualified name and the resolver's
  // unique-same-repo-hit tier happily binds it to a jest.mock stub.
  importBindings: ExtractedImportBinding[];
  /** TypeScript constructor property bindings used for receiver-aware calls. */
  receiverBindings: ExtractedReceiverBinding[];
  endpoints: ExtractedEndpoint[]; // NestJS endpoints (gRPC/kafka/http), ts/tsx
  grpcClientCalls: GrpcClientCall[]; // inter-service gRPC client invocations
  identifiers: IdentifierEntry[]; // TS/JS fields and object keys, from this same AST
  logSites: ExtractedLogSite[]; // static logger message → enclosing symbol
  channels: ExtractedChannelBinding[];
  /** The grammar was asked to parse and could not. A real failure. */
  parseError: string | null;
  /** The file was deliberately not parsed (policy, e.g. over the byte limit).
   * Distinct from parseError so an intentional exclusion is never counted as
   * breakage. */
  parseSkipped: string | null;
}

export interface ExtractedLogSite {
  message: string;
  level: string;
  startLine: number;
  enclosingQualifiedName: string | null;
}

/** Files above this are not parsed — the extractor returns a parseError without
 * reading the content. Exported so callers can avoid loading a file that is
 * going to be refused. */
export const EXTRACT_MAX_BYTES = 1_000_000;
const DEFAULT_MAX_BYTES = EXTRACT_MAX_BYTES;

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

function matchingClose(source: string, open: number, left: string, right: string): number {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === left) depth += 1;
    else if (char === right && --depth === 0) return index;
  }
  return -1;
}

function splitTopLevel(source: string): Array<{ value: string; offset: number }> {
  const result: Array<{ value: string; offset: number }> = [];
  let start = 0;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let angle = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "<") angle += 1;
    else if (char === ">" && angle > 0) angle -= 1;
    else if (char === "," && parens === 0 && braces === 0 && brackets === 0 && angle === 0) {
      const value = source.slice(start, index).trim();
      if (value) result.push({ value, offset: start });
      start = index + 1;
    }
  }
  const value = source.slice(start).trim();
  if (value) result.push({ value, offset: start });
  return result;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/u).length;
}

function extractReceiverBindings(
  source: string,
  symbols: ExtractedSymbol[],
  importBindings: ExtractedImportBinding[],
): ExtractedReceiverBinding[] {
  const bindings: ExtractedReceiverBinding[] = [];
  for (const owner of symbols.filter((symbol) => symbol.kind === "class")) {
    const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(owner.name)}\\b`, "gu");
    const classMatch = [...source.matchAll(classPattern)].find((match) => lineAt(source, match.index ?? 0) === owner.startLine)
      ?? source.match(new RegExp(`\\bclass\\s+${escapeRegExp(owner.name)}\\b`, "u"));
    const classStart = classMatch?.index ?? -1;
    if (classStart < 0) continue;
    const classOpen = source.indexOf("{", classStart);
    const classEnd = classOpen >= 0 ? matchingClose(source, classOpen, "{", "}") : -1;
    if (classOpen < 0 || classEnd < 0) continue;
    const classBody = source.slice(classStart, classEnd + 1);
    const constructorMatch = /\bconstructor\s*\(/u.exec(classBody);
    if (!constructorMatch) continue;
    const open = classStart + constructorMatch.index + constructorMatch[0].lastIndexOf("(");
    const close = matchingClose(source, open, "(", ")");
    if (close < 0) continue;
    for (const parameter of splitTopLevel(source.slice(open + 1, close))) {
      const withoutDecorators = parameter.value.replace(/@[A-Za-z_$][\w$]*(?:\s*\([^)]*\))?/gu, " ");
      // Only TypeScript parameter properties establish a stable receiver
      // binding. A normal constructor argument is not automatically a field.
      if (!/\b(?:public|private|protected|readonly)\b/u.test(withoutDecorators)) continue;
      const match = /\b(?:public|private|protected|readonly)\b[\s\S]*?\b([A-Za-z_$][\w$]*)\s*(?:[?!])?\s*:\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)?)/u.exec(withoutDecorators);
      if (!match) continue;
      const propertyName = match[1];
      const typeName = match[2].replace(/\s+/gu, "");
      const typeBinding = importBindings.find((binding) => binding.localName === typeName && !binding.typeOnly);
      const binding: ExtractedReceiverBinding = {
        ownerQualifiedName: owner.qualifiedName,
        propertyName,
        typeName: typeName.split(".").at(-1) ?? typeName,
        startLine: lineAt(source, open + 1 + parameter.offset),
        ...(typeBinding ? { typeSpecifier: typeBinding.specifier } : {}),
      };
      if (!bindings.some((item) => item.ownerQualifiedName === binding.ownerQualifiedName
        && item.propertyName === binding.propertyName)) bindings.push(binding);
    }
  }
  return bindings;
}

function memberReceiverForCall(node: Node, lang: Lang): string | undefined {
  const parent = node.parent;
  if (!parent) return undefined;
  if ((lang === "ts" || lang === "tsx" || lang === "js") && parent.type === "member_expression") {
    return parent.childForFieldName("object")?.text;
  }
  if (lang === "rust" && parent.type === "field_expression") {
    return parent.childForFieldName("value")?.text;
  }
  if (lang === "rust" && parent.type === "scoped_identifier") {
    const children = parent.namedChildren.filter((child): child is Node => Boolean(child));
    return children.length > 1 ? children.slice(0, -1).map((child) => child.text).join("::") : undefined;
  }
  return undefined;
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
    lang, symbols: [], refs: [], fileImports: [], importBindings: [], endpoints: [], grpcClientCalls: [],
    receiverBindings: [], identifiers: [], logSites: [], channels: [], parseError: null, parseSkipped: null,
  };
  const max = input.maxBytes ?? DEFAULT_MAX_BYTES;
  if (Buffer.byteLength(input.source, "utf8") > max) {
    // Declining to parse a file the policy excludes is a decision, not a
    // failure. Reporting it as parseError made a repo with 97 generated data
    // blobs print "97 errors" on every single index — a permanent false alarm
    // that teaches the reader to ignore the error count entirely.
    return { ...base, parseSkipped: "file exceeds max bytes" };
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
  const importBindings: ExtractedImportBinding[] = [];

  for (const match of query.matches(tree.rootNode)) {
    const def = match.captures.find((c) => c.name.startsWith("definition."));
    const nameCap = match.captures.find((c) => c.name === "name");
    const callCap = match.captures.find((c) => c.name === "reference.call");
    const typeCap = match.captures.find((c) => c.name === "reference.type");
    const importCap = match.captures.find((c) => c.name === "reference.import");

    if (def && nameCap) {
      const kind = def.name.slice("definition.".length);
      // `const X = call(callback)` is only a function when the call returns
      // one. The tags query cannot tell — it matches any call taking a
      // callback — so the callee is checked here against an allowlist. Without
      // this, every `.filter()`/`.find()`/`renderHook()` bound to a const was
      // indexed as a function (11.6% of all function symbols).
      if (kind === "function") {
        const verdict = wrappedFunctionVerdict(def.node);
        if (verdict?.wrapped && !verdict.returnsFunction) continue;
      }
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
      const receiver = memberReceiverForCall(callCap.node, lang);
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

    // Import BINDINGS: local name -> specifier. fileImports records only the
    // specifier, so a bare one ('react-redux') resolves to no repo file, drops
    // out, and the resolver never learns that `useSelector` came from outside
    // the repo — it then binds the call to whatever same-named symbol exists
    // in-repo, which in a React codebase is a jest.mock stub in a test file.
    //
    // Node shapes verified against the shipped TypeScript grammar:
    //   import d from "m"                 import_clause > identifier
    //   import { a, b as c } from "m"     import_clause > named_imports > import_specifier(.name/.alias)
    //   import * as ns from "m"           import_clause > namespace_import > identifier
    walk(tree.rootNode, (node) => {
      if (node.type !== "import_statement") return;
      const source = node.childForFieldName("source");
      if (!source) return;
      const specifier = source.text.replace(/^['"]|['"]$/g, "");
      if (!specifier) return;
      // `import type {...}` binds no runtime value, so no call can reach it.
      const typeOnly = /^import\s+type\b/.test(node.text);
      const add = (localName: string | undefined | null) => {
        if (!localName) return;
        if (importBindings.some((binding) => binding.localName === localName)) return;
        importBindings.push({ localName, specifier, typeOnly });
      };
      for (const clause of node.namedChildren) {
        if (!clause || clause.type !== "import_clause") continue;
        for (const child of clause.namedChildren) {
          if (!child) continue;
          if (child.type === "identifier") {
            add(child.text); // default import
          } else if (child.type === "namespace_import") {
            const alias = child.namedChildren.find((n) => n?.type === "identifier");
            add(alias?.text);
          } else if (child.type === "named_imports") {
            for (const spec of child.namedChildren) {
              if (!spec || spec.type !== "import_specifier") continue;
              // `a as b` binds b; a bare `a` binds a.
              add((spec.childForFieldName("alias") ?? spec.childForFieldName("name"))?.text);
            }
          }
        }
      }
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

  const receiverBindings = (lang === "ts" || lang === "tsx")
    ? extractReceiverBindings(input.source, symbols, importBindings)
    : [];

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
    return { lang, symbols, refs, fileImports, importBindings, receiverBindings, endpoints, grpcClientCalls, identifiers, logSites, channels, parseError: null, parseSkipped: null };
  } finally {
    query?.delete();
    tree?.delete();
    parser.delete();
  }
}
