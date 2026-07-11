import { Parser, type Node } from "web-tree-sitter";
import { loadLanguage } from "./parser.js";
import type { Lang } from "./registry.js";

// Zero-config frontend→backend gRPC-web linking (no `.penguin-frontend-grpc.json`
// anywhere): a call site is linked to a backend endpoint purely by method-name
// uniqueness — see pipeline.ts and knowledge-core's
// findEndpointServicesByMethod/enqueuePendingFrontendEdge/replayPendingFrontendEdges.
export interface FrontendGrpcCall {
  functionName: string;
  startLine: number;
  enclosingQualifiedName: string | null;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

// Value of an object property by key, given the `object` node.
function propValue(obj: Node, key: string): Node | null {
  for (let i = 0; i < obj.namedChildCount; i++) {
    const pair = obj.namedChild(i)!;
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    if (k && (k.text === key || k.text === `'${key}'` || k.text === `"${key}"`)) {
      return pair.childForFieldName("value");
    }
  }
  return null;
}

function stringLiteral(n: Node | null): string | null {
  if (!n || n.type !== "string") return null;
  return n.namedChild(0)?.text ?? n.text.replace(/^['"]|['"]$/g, "");
}

// Dispatcher-agnostic call-site extraction: ANY call_expression whose FIRST
// object-literal argument has a property `functionName: '<string literal>'`
// where the literal is IN `verifiedMethods` (the auto-detected wrapper
// methods — see allForwardingMethods below). We deliberately do NOT check
// what the call target/dispatcher is named — zero-config means there is no
// config to say "requestApi" or similar, so any call shape qualifies as long
// as the literal functionName is a verified sole-forward wrapper method.
// Computed (non-literal) functionName values are skipped (no false edges).
export function extractFunctionNameCalls(root: Node, verifiedMethods: Set<string>): FrontendGrpcCall[] {
  const calls: FrontendGrpcCall[] = [];
  if (verifiedMethods.size === 0) return calls;
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const args = n.childForFieldName("arguments");
    const obj = args?.namedChildren.find((c) => c?.type === "object");
    if (!obj) return;
    const functionName = stringLiteral(propValue(obj, "functionName"));
    if (!functionName || !verifiedMethods.has(functionName)) return; // computed / unverified → skip
    calls.push({ functionName, startLine: n.startPosition.row + 1, enclosingQualifiedName: null });
  });
  return calls;
}

// Test-only helper: parse then extract.
export async function extractFunctionNameCallsFromSource(
  lang: Lang,
  source: string,
  verifiedMethods: Set<string>,
): Promise<FrontendGrpcCall[]> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? extractFunctionNameCalls(tree.rootNode, verifiedMethods) : [];
}

// Count occurrences of `this._net.<X>(` in a body node; true iff there is
// exactly one such call AND it calls <name> — i.e. the body is a SOLE forward
// to the same-named RPC. Rejects rename (calls something else), batching
// (more than one _net call), and any transform beyond forwarding args/return.
//
// Optional chaining (`this._net?.<X>(...)`, real in native wrappers e.g.
// casino-plus-app PromotionService) is handled for free here: tree-sitter
// inserts an anonymous `optional_chain` ("?.") node as a sibling between the
// member_expression's `object` and `property` children, but `object`/
// `property` are grammar FIELDS, not positional children — childForFieldName
// resolves straight to `this._net` / the property name in both the plain-dot
// and optional-chain forms. Confirmed by dumping the parse tree for both
// `this._net.X(r)` and `this._net?.X(r)`: identical field structure, only an
// extra `optional_chain` named node appears in the optional-chain case.
function soleNetForward(body: Node, name: string): boolean {
  let netCalls = 0;
  let matchesName = false;
  walk(body, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text;
    // obj is `this._net` (works for both `this._net.X(` and `this._net?.X(`)
    if (
      obj?.type === "member_expression" &&
      obj.childForFieldName("object")?.type === "this" &&
      obj.childForFieldName("property")?.text === "_net"
    ) {
      netCalls += 1;
      if (prop === name) matchesName = true;
    }
  });
  return netCalls === 1 && matchesName; // exactly one _net call, and it is <name>
}

// Static methods of ONE `class <body>` whose body is a SOLE forward to
// `this._net.<sameName>(...)`. Confirms a frontend wrapper method name really
// maps 1:1 to the RPC it dispatches to — rejects rename/batch/transform.
//
// Grammar note (tree-sitter-tsx): `class <name> { static x = (r) => ... }`
// parses as `class_declaration` → body: `class_body` → members:
// `public_field_definition` (name: property_identifier, value: arrow_function),
// with a leading unnamed `static` token as the field's first child (no
// dedicated field name for it) — confirmed by parsing the task fixture and
// inspecting `tree.rootNode.toString()` plus each member's raw children.
function classForwardingMethods(body: Node): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < body.namedChildCount; i++) {
    const member = body.namedChild(i)!;
    if (member.type !== "public_field_definition") continue;
    // Scan ALL children (not just child(0)) for the `static` keyword: with
    // an accessibility modifier present (e.g. `public static x = ...`), the
    // modifier is child(0) and `static` shifts to a later positional child,
    // so a child(0)-only check wrongly excludes real-world wrappers.
    let isStatic = false;
    for (let j = 0; j < member.childCount; j++) {
      if (member.child(j)?.type === "static") {
        isStatic = true;
        break;
      }
    }
    if (!isStatic) continue; // instance fields don't count
    const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
    const value = member.childForFieldName("value");
    const name = nameNode?.text;
    if (!name || !value || value.type !== "arrow_function") continue;
    const abody = value.childForFieldName("body");
    if (abody && soleNetForward(abody, name)) out.add(name);
  }
  return out;
}

// Static methods of `class <className>` whose body is a SOLE forward to
// `this._net.<sameName>(...)`.
export function verifiedForwardingMethods(root: Node, className: string): Set<string> {
  const out = new Set<string>();
  walk(root, (cls) => {
    if (cls.type !== "class_declaration" && cls.type !== "class") return;
    if (cls.childForFieldName("name")?.text !== className) return;
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (const m of classForwardingMethods(body)) out.add(m);
  });
  return out;
}

// Zero-config auto-detection: union of sole-forward static methods across
// EVERY class declared in the file, regardless of class name. A "wrapper
// method" is simply any static class method whose body is a SOLE forward to
// `this._net.<sameName>(...)` — no `wrappers` config naming which classes
// matter. Backend repos have no such classes → empty set → 0 edges (safe to
// run on every repo unconditionally).
export function allForwardingMethods(root: Node): Set<string> {
  const out = new Set<string>();
  walk(root, (cls) => {
    if (cls.type !== "class_declaration" && cls.type !== "class") return;
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (const m of classForwardingMethods(body)) out.add(m);
  });
  return out;
}

export async function verifiedMethodsFromSource(
  lang: Lang,
  source: string,
  className: string,
): Promise<Set<string>> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? verifiedForwardingMethods(tree.rootNode, className) : new Set();
}

export async function allForwardingMethodsFromSource(lang: Lang, source: string): Promise<Set<string>> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? allForwardingMethods(tree.rootNode) : new Set();
}
