import type { Node } from "web-tree-sitter";

// Code-level entities (P3): thrown error types and env-var reads. Kept as a
// tree-walk (not the shared tags query) so a grammar quirk here can never break
// symbol extraction. Both become `entity` nodes so "where is XError thrown" /
// "who uses JWT_SECRET" are graph queries (vision #5, #10).

export interface CodeEntityRef {
  kind: "throws" | "env";
  rawName: string; // error class name, or env var name
  startLine: number;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

export function collectCodeEntityRefs(root: Node): CodeEntityRef[] {
  const out: CodeEntityRef[] = [];
  walk(root, (n) => {
    // throw new XError(...)
    if (n.type === "throw_statement") {
      const inner = n.namedChild(0);
      if (inner && inner.type === "new_expression") {
        const ctor = inner.childForFieldName("constructor");
        if (ctor && (ctor.type === "identifier" || ctor.type === "type_identifier") && ctor.text) {
          out.push({ kind: "throws", rawName: ctor.text, startLine: n.startPosition.row + 1 });
        }
      }
    }
    // process.env.X
    if (n.type === "member_expression") {
      const obj = n.childForFieldName("object");
      const prop = n.childForFieldName("property");
      if (
        prop && obj && obj.type === "member_expression" &&
        obj.childForFieldName("object")?.text === "process" &&
        obj.childForFieldName("property")?.text === "env" &&
        prop.text
      ) {
        out.push({ kind: "env", rawName: prop.text, startLine: n.startPosition.row + 1 });
      }
    }
  });
  return out;
}
