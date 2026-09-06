import type { ParsedEdge } from "@penguin/knowledge-core";
import { frameworkEdgeEvidence, type FrameworkEdgeType } from "@penguin/knowledge-core";

export interface FrameworkSymbol {
  qualifiedName: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface FrameworkSymbolTarget {
  nodeId: string;
  filePath?: string | null;
}

export interface NestJsFrameworkEdgeInput {
  filePath: string;
  source: string;
  symbols: FrameworkSymbol[];
  symbolIds: Map<string, string>;
  resolveSymbol(name: string): FrameworkSymbolTarget | null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

function lineAt(source: string, offset: number): number {
  return source.slice(0, Math.max(0, offset)).split(/\r?\n/u).length;
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
    if (char === right && --depth === 0) return index;
  }
  return -1;
}

/** Split a decorator/array/object body without treating nested expressions as items. */
function splitTopLevel(value: string): Array<{ value: string; offset: number }> {
  const result: Array<{ value: string; offset: number }> = [];
  let start = 0;
  let parens = 0;
  let braces = 0;
  let brackets = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "(") parens += 1;
    else if (char === ")") parens -= 1;
    else if (char === "{") braces += 1;
    else if (char === "}") braces -= 1;
    else if (char === "[") brackets += 1;
    else if (char === "]") brackets -= 1;
    else if (char === "," && parens === 0 && braces === 0 && brackets === 0) {
      result.push({ value: value.slice(start, index).trim(), offset: start });
      start = index + 1;
    }
  }
  const last = value.slice(start).trim();
  if (last) result.push({ value: last, offset: start });
  return result;
}

function symbolForName(input: NestJsFrameworkEdgeInput, name: string): FrameworkSymbolTarget | null {
  const normalized = name.trim().replace(/[?\[\]<>].*$/u, "").trim();
  if (!IDENTIFIER.test(normalized)) return null;
  const local = input.symbols.filter((symbol) => symbol.name === normalized);
  if (local.length === 1) {
    const nodeId = input.symbolIds.get(local[0].qualifiedName);
    return nodeId ? { nodeId, filePath: input.filePath } : null;
  }
  return input.resolveSymbol(normalized);
}

function addEdge(
  edges: ParsedEdge[],
  seen: Set<string>,
  input: NestJsFrameworkEdgeInput,
  src: FrameworkSymbolTarget,
  dst: FrameworkSymbolTarget,
  edgeType: FrameworkEdgeType,
  startLine: number,
  token?: string,
): void {
  if (src.nodeId === dst.nodeId) return;
  const evidence = frameworkEdgeEvidence({ edgeType, filePath: input.filePath, startLine, ...(token ? { token } : {}) });
  const key = `${src.nodeId}\u0000${dst.nodeId}\u0000${edgeType}`;
  if (seen.has(key)) return;
  seen.add(key);
  // The source is parser-owned and therefore safely rebuilt by replaceFileEdges.
  // `frameworkAdapter` in provenance preserves the semantic evidence origin
  // without allowing a non-rebuildable runtime/AI edge into the parser set.
  edges.push({
    src: src.nodeId,
    dst: dst.nodeId,
    edgeType,
    origin: "parser",
    method: evidence.method,
    confidence: evidence.confidence,
    provenance: {
      ...evidence.provenance,
      frameworkAdapter: "nestjs",
      frameworkRegistration: true,
      evidenceOrigin: evidence.origin,
    },
  });
}

function classSymbols(input: NestJsFrameworkEdgeInput): FrameworkSymbol[] {
  return input.symbols.filter((symbol) => symbol.kind === "class");
}

function extractImplements(input: NestJsFrameworkEdgeInput, edges: ParsedEdge[], seen: Set<string>): void {
  for (const symbol of classSymbols(input)) {
    const declaration = new RegExp(`\\bclass\\s+${symbol.name}\\b[^{]*`, "u").exec(input.source);
    if (!declaration || declaration.index < 0) continue;
    const implementsPart = /\bimplements\s+(.+)$/u.exec(declaration[0]);
    if (!implementsPart) continue;
    for (const name of implementsPart[1].split(",").map((item) => item.trim().match(/^[A-Za-z_$][\w$]*/u)?.[0]).filter((item): item is string => Boolean(item))) {
      const target = symbolForName(input, name);
      const src = input.symbolIds.get(symbol.qualifiedName);
      if (!src || !target) continue;
      addEdge(edges, seen, input, { nodeId: src, filePath: input.filePath }, target, "implements", lineAt(input.source, declaration.index));
    }
  }
}

function extractConstructors(input: NestJsFrameworkEdgeInput, edges: ParsedEdge[], seen: Set<string>): void {
  for (const symbol of classSymbols(input)) {
    const classId = input.symbolIds.get(symbol.qualifiedName);
    if (!classId) continue;
    const classStart = input.source.search(new RegExp(`\\bclass\\s+${symbol.name}\\b`, "u"));
    if (classStart < 0) continue;
    const classOpen = input.source.indexOf("{", classStart);
    const classEnd = classOpen >= 0 ? matchingClose(input.source, classOpen, "{", "}") : -1;
    if (classOpen < 0 || classEnd < 0) continue;
    const search = input.source.slice(classStart, classEnd + 1);
    const constructor = /\bconstructor\s*\(/u.exec(search);
    if (!constructor) continue;
    const open = classStart + constructor.index + constructor[0].lastIndexOf("(");
    const close = matchingClose(input.source, open, "(", ")");
    if (close < 0) continue;
    const parameters = input.source.slice(open + 1, close);
    for (const parameter of splitTopLevel(parameters)) {
      const tokenMatch = /@Inject\s*\(\s*([A-Za-z_$][\w$]*|['"][^'"]+['"])/u.exec(parameter.value);
      const withoutDecorators = parameter.value.replace(/@[A-Za-z_$][\w$]*(?:\s*\([^)]*\))?/gu, " ");
      const typeMatch = /:\s*([A-Za-z_$][\w$]*)/u.exec(withoutDecorators);
      const typeName = typeMatch?.[1];
      if (!typeName) continue;
      const target = symbolForName(input, typeName);
      if (!target) continue;
      addEdge(edges, seen, input, { nodeId: classId, filePath: input.filePath }, target, "injects", lineAt(input.source, open), tokenMatch?.[1]);
    }
  }
}

function moduleDecorators(input: NestJsFrameworkEdgeInput): Array<{ module: FrameworkSymbol; body: string; bodyOffset: number }> {
  const result: Array<{ module: FrameworkSymbol; body: string; bodyOffset: number }> = [];
  for (const match of input.source.matchAll(/@Module\s*\(/gu)) {
    const openParen = (match.index ?? 0) + match[0].lastIndexOf("(");
    const openBrace = input.source.indexOf("{", openParen);
    if (openBrace < 0) continue;
    const closeBrace = matchingClose(input.source, openBrace, "{", "}");
    if (closeBrace < 0) continue;
    const after = input.source.slice(closeBrace + 1).match(/\bclass\s+([A-Za-z_$][\w$]*)/u);
    const name = after?.[1];
    const module = name ? input.symbols.find((symbol) => symbol.name === name && symbol.kind === "class") : undefined;
    if (module) result.push({ module, body: input.source.slice(openBrace + 1, closeBrace), bodyOffset: openBrace + 1 });
  }
  return result;
}

function extractProviders(input: NestJsFrameworkEdgeInput, edges: ParsedEdge[], seen: Set<string>): void {
  for (const item of moduleDecorators(input)) {
    const moduleId = input.symbolIds.get(item.module.qualifiedName);
    if (!moduleId) continue;
    const providersMatch = /\bproviders\s*:\s*\[/u.exec(item.body);
    if (!providersMatch) continue;
    const open = item.bodyOffset + providersMatch.index + providersMatch[0].lastIndexOf("[");
    const close = matchingClose(input.source, open, "[", "]");
    if (close < 0) continue;
    const entries = splitTopLevel(input.source.slice(open + 1, close));
    for (const entry of entries) {
      const entryLine = lineAt(input.source, open + 1 + entry.offset);
      const object = entry.value.match(/^\{([\s\S]*)\}$/u)?.[1];
      if (!object) {
        const providerName = entry.value.match(/^([A-Za-z_$][\w$]*)/u)?.[1];
        const provider = providerName ? symbolForName(input, providerName) : null;
        if (provider) addEdge(edges, seen, input, { nodeId: moduleId, filePath: input.filePath }, provider, "provides", entryLine);
        continue;
      }
      const provideName = object.match(/\bprovide\s*:\s*([A-Za-z_$][\w$]*)/u)?.[1];
      const implementationName = object.match(/\b(?:useClass|useExisting)\s*:\s*([A-Za-z_$][\w$]*)/u)?.[1];
      const implementation = implementationName ? symbolForName(input, implementationName) : null;
      if (implementation) addEdge(edges, seen, input, { nodeId: moduleId, filePath: input.filePath }, implementation, "provides", entryLine, provideName);
      const token = provideName ? symbolForName(input, provideName) : null;
      if (token && implementation) addEdge(edges, seen, input, token, implementation, "dispatches_to", entryLine, provideName);
    }
  }
}

function extractControllers(input: NestJsFrameworkEdgeInput, edges: ParsedEdge[], seen: Set<string>): void {
  for (const item of moduleDecorators(input)) {
    const moduleId = input.symbolIds.get(item.module.qualifiedName);
    if (!moduleId) continue;
    const controllersMatch = /\bcontrollers\s*:\s*\[/u.exec(item.body);
    if (!controllersMatch) continue;
    const open = item.bodyOffset + controllersMatch.index + controllersMatch[0].lastIndexOf("[");
    const close = matchingClose(input.source, open, "[", "]");
    if (close < 0) continue;
    for (const entry of splitTopLevel(input.source.slice(open + 1, close))) {
      const controllerName = entry.value.match(/^([A-Za-z_$][\w$]*)/u)?.[1];
      if (!controllerName) continue;
      const controller = symbolForName(input, controllerName);
      if (controller) {
        addEdge(
          edges,
          seen,
          input,
          { nodeId: moduleId, filePath: input.filePath },
          controller,
          "provides",
          lineAt(input.source, open + 1 + entry.offset),
        );
      }
    }
  }
}

/** Extract only source-grounded NestJS DI/dispatch relations. */
export function extractNestJsFrameworkEdges(input: NestJsFrameworkEdgeInput): ParsedEdge[] {
  if (!/(@(?:Module|Injectable|Controller)\s*\(|from\s+["']@nestjs\/)/u.test(input.source)) return [];
  const edges: ParsedEdge[] = [];
  const seen = new Set<string>();
  extractImplements(input, edges, seen);
  extractConstructors(input, edges, seen);
  extractProviders(input, edges, seen);
  extractControllers(input, edges, seen);
  return edges;
}
