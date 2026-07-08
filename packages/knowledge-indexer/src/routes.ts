import type { Node } from "web-tree-sitter";

// NestJS-style HTTP route extraction (P2, layered framework semantics).
// Generic-ish: driven purely by decorator names on classes/methods, so it also
// covers frameworks that copy the `@Controller` / `@Get('path')` convention.
// Every route carries provenance="parser" + a framework tag so the graph can
// distinguish inferred framework facts from raw AST facts.

export interface ExtractedRoute {
  httpMethod: string; // GET | POST | …
  routePath: string; // normalized full path, e.g. /users/:id
  handlerQualifiedName: string; // Controller.method
  controllerName: string;
}

const HTTP_DECORATORS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ALL",
};

// name + first string argument of a decorator node (`@Foo('bar')` → {Foo, bar}).
function decoratorInfo(dec: Node): { name: string | null; arg: string | null } {
  const inner = dec.namedChild(0);
  if (!inner) return { name: null, arg: null };
  if (inner.type === "identifier") return { name: inner.text, arg: null };
  if (inner.type === "call_expression") {
    const name = inner.childForFieldName("function")?.text ?? null;
    const args = inner.childForFieldName("arguments");
    let arg: string | null = null;
    if (args) {
      for (let i = 0; i < args.namedChildCount; i++) {
        const a = args.namedChild(i)!;
        if (a.type === "string") {
          const frag = a.namedChild(0);
          arg = (frag ? frag.text : a.text.replace(/^['"]|['"]$/g, "")) || "";
          break;
        }
      }
    }
    return { name, arg };
  }
  return { name: null, arg: null };
}

function joinPath(base: string | null, sub: string | null): string {
  const parts = [base ?? "", sub ?? ""]
    .map((s) => s.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean);
  return "/" + parts.join("/");
}

function findAll(node: Node, type: string, out: Node[] = []): Node[] {
  if (node.type === type) out.push(node);
  for (let i = 0; i < node.namedChildCount; i++) findAll(node.namedChild(i)!, type, out);
  return out;
}

// The `@Controller('base')` decorator attached to a class sits among the class's
// preceding named siblings (or its export_statement wrapper's children).
function controllerBaseFor(cls: Node): { name: string | null; base: string | null } | null {
  const scan = (start: Node | null): { name: string; base: string | null } | null => {
    let sib = start;
    while (sib) {
      if (sib.type === "decorator") {
        const info = decoratorInfo(sib);
        if (info.name === "Controller") return { name: "Controller", base: info.arg };
      } else if (sib.type !== "comment") {
        break;
      }
      sib = sib.previousNamedSibling;
    }
    return null;
  };
  // decorators may precede the class directly, or precede its export_statement.
  return scan(cls.previousNamedSibling) ?? (cls.parent ? scan(cls.parent.previousNamedSibling) : null);
}

export function extractRoutes(root: Node): ExtractedRoute[] {
  const routes: ExtractedRoute[] = [];
  for (const cls of findAll(root, "class_declaration")) {
    const className = cls.childForFieldName("name")?.text;
    if (!className) continue;
    const ctrl = controllerBaseFor(cls);
    if (!ctrl) continue; // not a controller → no routes
    const base = ctrl.base;
    const body = cls.childForFieldName("body");
    if (!body) continue;
    for (let i = 0; i < body.namedChildCount; i++) {
      const m = body.namedChild(i)!;
      if (m.type !== "method_definition") continue;
      const methodName = m.childForFieldName("name")?.text;
      if (!methodName) continue;
      // preceding decorators of this method
      let sib = m.previousNamedSibling;
      while (sib && sib.type === "decorator") {
        const info = decoratorInfo(sib);
        const verb = info.name ? HTTP_DECORATORS[info.name] : undefined;
        if (verb) {
          routes.push({
            httpMethod: verb,
            routePath: joinPath(base, info.arg),
            handlerQualifiedName: `${className}.${methodName}`,
            controllerName: className,
          });
        }
        sib = sib.previousNamedSibling;
      }
    }
  }
  return routes;
}
