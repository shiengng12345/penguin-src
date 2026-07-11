import { Parser, type Node } from "web-tree-sitter";
import { loadLanguage } from "./parser.js";
import type { Lang } from "./registry.js";
import type { FrontendGrpcConfig } from "./frontend-grpc-config.js";

export interface FrontendGrpcCall {
  service: string;
  functionName: string;
  startLine: number;
  enclosingQualifiedName: string | null;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

// "A.B" for a member_expression object.property; null otherwise.
function dottedName(n: Node | null): string | null {
  if (!n) return null;
  if (n.type === "member_expression") {
    const o = n.childForFieldName("object");
    const p = n.childForFieldName("property");
    if (o?.type === "identifier" && p) return `${o.text}.${p.text}`;
  }
  return null;
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

// Frontend requestApi call-site extraction: `WebServices.<dispatcher>({ service:
// <ENUM>, functionName: '<literal>', ... })`. Resolves the enum member (e.g.
// `NT_SERVICE_INTERFACE.SKINFRAGMENT`) to a proto service name via
// `config.serviceEnumMap`. Only literal functionName + mapped enum produce a
// call; computed values or unmapped enums are skipped (no false edges).
export function extractFrontendGrpcCalls(root: Node, config: FrontendGrpcConfig): FrontendGrpcCall[] {
  const calls: FrontendGrpcCall[] = [];
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    if (fn.childForFieldName("property")?.text !== config.dispatcher) return;
    const args = n.childForFieldName("arguments");
    const obj = args?.namedChildren.find((c) => c?.type === "object");
    if (!obj) return;
    const svcEnum = dottedName(propValue(obj, "service"));
    const functionName = stringLiteral(propValue(obj, "functionName"));
    if (!svcEnum || !functionName) return; // computed / missing → skip
    const service = config.serviceEnumMap[svcEnum];
    if (!service) return; // unmapped enum → skip
    calls.push({ service, functionName, startLine: n.startPosition.row + 1, enclosingQualifiedName: null });
  });
  return calls;
}

// Test-only helper: parse source then extract.
export async function extractFrontendCallsFromSource(
  lang: Lang,
  source: string,
  config: FrontendGrpcConfig,
): Promise<FrontendGrpcCall[]> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? extractFrontendGrpcCalls(tree.rootNode, config) : [];
}

// Count occurrences of `this._net.<X>(` in a body node; true iff there is
// exactly one such call AND it calls <name> — i.e. the body is a SOLE forward
// to the same-named RPC. Rejects rename (calls something else), batching
// (more than one _net call), and any transform beyond forwarding args/return.
function soleNetForward(body: Node, name: string): boolean {
  let netCalls = 0;
  let matchesName = false;
  walk(body, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    const obj = fn.childForFieldName("object");
    const prop = fn.childForFieldName("property")?.text;
    // obj is `this._net`
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

// Static methods of `class <className>` whose body is a SOLE forward to
// `this._net.<sameName>(...)`. Confirms a frontend wrapper method name really
// maps 1:1 to the RPC it dispatches to — rejects rename/batch/transform.
//
// Grammar note (tree-sitter-tsx): `class <name> { static x = (r) => ... }`
// parses as `class_declaration` → body: `class_body` → members:
// `public_field_definition` (name: property_identifier, value: arrow_function),
// with a leading unnamed `static` token as the field's first child (no
// dedicated field name for it) — confirmed by parsing the task fixture and
// inspecting `tree.rootNode.toString()` plus each member's raw children.
export function verifiedForwardingMethods(root: Node, className: string): Set<string> {
  const out = new Set<string>();
  walk(root, (cls) => {
    if (cls.type !== "class_declaration" && cls.type !== "class") return;
    if (cls.childForFieldName("name")?.text !== className) return;
    const body = cls.childForFieldName("body");
    if (!body) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i)!;
      if (member.type !== "public_field_definition") continue;
      if (member.child(0)?.type !== "static") continue; // instance fields don't count
      const nameNode = member.childForFieldName("name") ?? member.childForFieldName("property");
      const value = member.childForFieldName("value");
      const name = nameNode?.text;
      if (!name || !value || value.type !== "arrow_function") continue;
      const abody = value.childForFieldName("body");
      if (abody && soleNetForward(abody, name)) out.add(name);
    }
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
