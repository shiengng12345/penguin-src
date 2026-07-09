import type { Node } from "web-tree-sitter";

// Consumer side of inter-service gRPC (microservice → microservice). Detects
// `this.x = client.getService<Svc>('Svc')` bindings, then calls on that proxy
// (`this.x.method(...)`) → an `invokes` edge to the GLOBAL endpoint
// `grpc::<Service>.<method>`. The provider side (routes.ts @GrpcMethod) emits
// `handles` to the SAME global endpoint id, so two different repos connect
// through it — this is the cross-repo service call graph.

export interface GrpcClientCall {
  service: string; // target gRPC service name (e.g. PushService)
  method: string; // called method (camelCase as written on the proxy)
  startLine: number;
  enclosingQualifiedName: string | null; // the calling symbol (filled by extract.ts)
}

// Normalize a gRPC method name so provider (PascalCase `SendPush`) and consumer
// (camelCase `sendPush`) resolve to the same endpoint id.
export function grpcEndpointKey(service: string, method: string): string {
  return `grpc::${service}.${method.toLowerCase()}`;
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

// The receiver identifier of a member access: `this.pushService` → "pushService",
// `pushService` → "pushService". Returns null for anything else.
function receiverVar(objNode: Node | null): string | null {
  if (!objNode) return null;
  if (objNode.type === "identifier") return objNode.text;
  if (objNode.type === "member_expression") {
    const o = objNode.childForFieldName("object");
    const p = objNode.childForFieldName("property");
    if (o?.type === "this" && p) return p.text; // this.pushService
  }
  return null;
}

export function extractGrpcClientCalls(root: Node): GrpcClientCall[] {
  // Pass 1: build proxyVar → serviceName from getService bindings.
  const proxy = new Map<string, string>();
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    if (fn.childForFieldName("property")?.text !== "getService") return;
    // service name: prefer the string arg, else the generic type arg
    let service: string | null = null;
    const args = n.childForFieldName("arguments");
    if (args) {
      for (let i = 0; i < args.namedChildCount; i++) {
        const a = args.namedChild(i)!;
        if (a.type === "string") { service = a.namedChild(0)?.text ?? a.text.replace(/^['"]|['"]$/g, ""); break; }
      }
    }
    if (!service) {
      const ta = n.childForFieldName("type_arguments") ?? n.namedChildren.find((c) => c?.type === "type_arguments");
      const t = ta?.namedChild(0);
      if (t && (t.type === "type_identifier" || t.type === "generic_type")) service = t.childForFieldName("name")?.text ?? t.text;
    }
    if (!service) return;
    // the var it's assigned to: `this.x = getService(...)` or `const x = getService(...)`
    let p: Node | null = n.parent;
    while (p && p.type !== "assignment_expression" && p.type !== "variable_declarator" && p.type !== "statement_block") p = p.parent;
    if (!p) return;
    if (p.type === "assignment_expression") {
      const left = p.childForFieldName("left");
      const v = receiverVar(left);
      if (v) proxy.set(v, service);
    } else if (p.type === "variable_declarator") {
      const name = p.childForFieldName("name");
      if (name?.type === "identifier") proxy.set(name.text, service);
    }
  });

  if (proxy.size === 0) return [];

  // Pass 2: calls on a known proxy var → invokes.
  const calls: GrpcClientCall[] = [];
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    const method = fn.childForFieldName("property")?.text;
    if (!method || method === "getService") return;
    const recv = receiverVar(fn.childForFieldName("object"));
    if (!recv) return;
    const service = proxy.get(recv);
    if (!service) return;
    calls.push({ service, method, startLine: n.startPosition.row + 1, enclosingQualifiedName: null });
  });
  return calls;
}
