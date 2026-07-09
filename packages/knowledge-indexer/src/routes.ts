import type { Node } from "web-tree-sitter";

// Endpoint extraction (P2, layered framework semantics). Covers the real entry
// points in a NestJS microservice codebase — **gRPC dominates** (@GrpcMethod),
// plus Kafka message/event handlers and HTTP routes. Decorator-driven, so it
// also fits any framework copying these conventions. Every endpoint carries
// provenance="parser" + a protocol tag so the graph distinguishes them.

export type EndpointProtocol = "grpc" | "kafka" | "http";

export interface ExtractedEndpoint {
  protocol: EndpointProtocol;
  key: string; // display key: "gRPC Svc.Method" | "EVENT pattern" | "GET /path"
  handlerQualifiedName: string; // Controller.method
  controllerName: string;
  // gRPC only: the target service + rpc method, used to build a GLOBAL (cross-repo)
  // endpoint id so a provider and a consumer in different repos connect.
  grpcService?: string;
  grpcMethod?: string;
}

// Back-compat alias (older callers used ExtractedRoute).
export type ExtractedRoute = ExtractedEndpoint;

const HTTP_DECORATORS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ALL",
};

// name + all string args of a decorator (`@Foo('a','b')` → {Foo, ['a','b']}).
function decoratorInfo(dec: Node): { name: string | null; args: string[] } {
  const inner = dec.namedChild(0);
  if (!inner) return { name: null, args: [] };
  if (inner.type === "identifier") return { name: inner.text, args: [] };
  if (inner.type === "call_expression") {
    const name = inner.childForFieldName("function")?.text ?? null;
    const argsNode = inner.childForFieldName("arguments");
    const args: string[] = [];
    if (argsNode) {
      for (let i = 0; i < argsNode.namedChildCount; i++) {
        const a = argsNode.namedChild(i)!;
        if (a.type === "string") {
          const frag = a.namedChild(0);
          args.push((frag ? frag.text : a.text.replace(/^['"]|['"]$/g, "")) || "");
        }
      }
    }
    return { name, args };
  }
  return { name: null, args: [] };
}

function joinPath(base: string | null, sub: string | null): string {
  const parts = [base ?? "", sub ?? ""].map((s) => s.replace(/^\/+|\/+$/g, "")).filter(Boolean);
  return "/" + parts.join("/");
}

function findAll(node: Node, type: string, out: Node[] = []): Node[] {
  if (node.type === type) out.push(node);
  for (let i = 0; i < node.namedChildCount; i++) findAll(node.namedChild(i)!, type, out);
  return out;
}

// The `@Controller('base')` decorator's base path (for HTTP routes on that class).
function controllerBaseFor(cls: Node): string | null {
  const scan = (start: Node | null): string | null => {
    let sib = start;
    while (sib) {
      if (sib.type === "decorator") {
        const info = decoratorInfo(sib);
        if (info.name === "Controller") return info.args[0] ?? null;
      } else if (sib.type !== "comment") break;
      sib = sib.previousNamedSibling;
    }
    return null;
  };
  return scan(cls.previousNamedSibling) ?? (cls.parent ? scan(cls.parent.previousNamedSibling) : null);
}

export function extractEndpoints(root: Node): ExtractedEndpoint[] {
  const endpoints: ExtractedEndpoint[] = [];
  for (const cls of findAll(root, "class_declaration")) {
    const className = cls.childForFieldName("name")?.text;
    if (!className) continue;
    const httpBase = controllerBaseFor(cls);
    const body = cls.childForFieldName("body");
    if (!body) continue;
    for (let i = 0; i < body.namedChildCount; i++) {
      const m = body.namedChild(i)!;
      if (m.type !== "method_definition") continue;
      const methodName = m.childForFieldName("name")?.text;
      if (!methodName) continue;
      const handlerQualifiedName = `${className}.${methodName}`;
      let sib = m.previousNamedSibling;
      while (sib && sib.type === "decorator") {
        const info = decoratorInfo(sib);
        const name = info.name;
        if (name && HTTP_DECORATORS[name]) {
          endpoints.push({
            protocol: "http",
            key: `${HTTP_DECORATORS[name]} ${joinPath(httpBase, info.args[0] ?? null)}`,
            handlerQualifiedName, controllerName: className,
          });
        } else if (name === "GrpcMethod" || name === "GrpcStreamMethod") {
          const svc = info.args[0] ?? className;
          const rpc = info.args[1] ?? methodName;
          endpoints.push({
            protocol: "grpc",
            key: `gRPC ${svc}.${rpc}`,
            handlerQualifiedName, controllerName: className,
            grpcService: svc, grpcMethod: rpc,
          });
        } else if (name === "MessagePattern" || name === "EventPattern") {
          const pat = info.args[0] ?? methodName;
          endpoints.push({
            protocol: "kafka",
            key: `${name === "EventPattern" ? "EVENT" : "MSG"} ${pat}`,
            handlerQualifiedName, controllerName: className,
          });
        }
        sib = sib.previousNamedSibling;
      }
    }
  }
  return endpoints;
}

// Back-compat wrapper.
export function extractRoutes(root: Node): ExtractedEndpoint[] {
  return extractEndpoints(root);
}
