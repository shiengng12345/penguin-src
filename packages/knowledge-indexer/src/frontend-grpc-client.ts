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
