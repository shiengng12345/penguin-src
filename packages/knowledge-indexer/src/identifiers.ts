import { type Node } from "web-tree-sitter";
import { withParsedTree } from "./parser.js";
import type { Lang } from "./registry.js";

// Lightweight, non-graph field/key index (real gap reported from actual MCP
// usage: object-literal property keys, interface/type-alias member names, and
// class field names are never symbol nodes — a class/function/interface gets
// its OWN node, but its individual members don't — so a real field name like
// "suspensionPeriod" was completely unsearchable, forcing a fallback to
// grep/find. This does NOT create graph nodes/edges (that would explode node
// count for zero real graph value) — it only feeds fts_identifiers, a
// file:line lookup, on purpose.

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

function stringLiteralText(node: Node): string | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i)!;
    if (c.type === "string_fragment") return c.text;
  }
  return null;
}

export interface IdentifierEntry {
  name: string;
  startLine: number;
  kind: "field" | "class_field" | "object_key";
}

export function collectIdentifierNode(n: Node, out: IdentifierEntry[]): void {
  if (n.type === "property_signature") {
    const name = n.childForFieldName("name");
    if (name) out.push({ name: name.text, startLine: name.startPosition.row + 1, kind: "field" });
    return;
  }
  if (n.type === "public_field_definition") {
    const name = n.childForFieldName("name");
    if (name && name.type === "property_identifier") {
      out.push({ name: name.text, startLine: name.startPosition.row + 1, kind: "class_field" });
    }
    return;
  }
  if (n.type !== "pair") return;
  const key = n.childForFieldName("key");
  if (!key) return;
  if (key.type === "property_identifier") {
    out.push({ name: key.text, startLine: key.startPosition.row + 1, kind: "object_key" });
  } else if (key.type === "string") {
    const text = stringLiteralText(key);
    if (text) out.push({ name: text, startLine: key.startPosition.row + 1, kind: "object_key" });
  }
}

// `interface X { name: T }` and `type X = { name: T }` both parse their
// members as `property_signature` — one pass covers both declaration forms.
// Class fields (`public_field_definition`) and object-literal keys (`pair`)
// are each their own node shape. Computed keys (`[expr]: v`) are skipped —
// there's no static name to index.
export function extractIdentifiers(root: Node): IdentifierEntry[] {
  const out: IdentifierEntry[] = [];
  walk(root, (n) => collectIdentifierNode(n, out));
  return out;
}

export async function extractIdentifiersFromSource(lang: Lang, source: string): Promise<IdentifierEntry[]> {
  return withParsedTree(lang, source, extractIdentifiers, []);
}
