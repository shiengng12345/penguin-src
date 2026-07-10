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
  // HTTP only: the success status this endpoint returns — @HttpCode(n) if
  // present, else the NestJS default (POST→201, everything else→200). Error
  // statuses are derived separately from the exceptions the handler throws.
  httpStatus?: number;
}

// Back-compat alias (older callers used ExtractedRoute).
export type ExtractedRoute = ExtractedEndpoint;

const HTTP_DECORATORS: Record<string, string> = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ALL",
};

// name + string args + numeric args of a decorator
// (`@Foo('a', 201)` → {Foo, ['a'], [201]}).
// A decorator's string value at a node (drops the surrounding quotes).
function stringVal(node: Node): string {
  const frag = node.namedChild(0);
  return (frag ? frag.text : node.text.replace(/^['"]|['"]$/g, "")) || "";
}

function decoratorInfo(dec: Node): { name: string | null; args: string[]; nums: number[]; argNodes: Node[] } {
  const inner = dec.namedChild(0);
  if (!inner) return { name: null, args: [], nums: [], argNodes: [] };
  if (inner.type === "identifier") return { name: inner.text, args: [], nums: [], argNodes: [] };
  if (inner.type === "call_expression") {
    const name = inner.childForFieldName("function")?.text ?? null;
    const argsNode = inner.childForFieldName("arguments");
    const args: string[] = [];
    const nums: number[] = [];
    const argNodes: Node[] = []; // every arg, any type, positionally faithful
    if (argsNode) {
      for (let i = 0; i < argsNode.namedChildCount; i++) {
        const a = argsNode.namedChild(i)!;
        argNodes.push(a);
        if (a.type === "string") {
          args.push(stringVal(a));
        } else if (a.type === "number") {
          const n = Number(a.text);
          if (!Number.isNaN(n)) nums.push(n);
        }
      }
    }
    return { name, args, nums, argNodes };
  }
  return { name: null, args: [], nums: [], argNodes: [] };
}

// Resolve a class's `static [readonly] NAME = '<value>'` string constant. NestJS
// controllers commonly pass the gRPC service name as `Ctrl.SERVICE` rather than a
// string literal; without this the decorator's service name can't be read.
function resolveClassConst(cls: Node, constName: string): string | null {
  const body = cls.childForFieldName("body");
  if (!body) return null;
  for (let i = 0; i < body.namedChildCount; i++) {
    const f = body.namedChild(i)!;
    if (f.type !== "public_field_definition" && f.type !== "field_definition") continue;
    if (f.childForFieldName("name")?.text !== constName) continue;
    const val = f.childForFieldName("value");
    if (val?.type === "string") return stringVal(val);
  }
  return null;
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
      // Gather all of the method's decorators first — @HttpCode may sit apart
      // from the verb decorator, and we need its value when emitting the route.
      const decs: ReturnType<typeof decoratorInfo>[] = [];
      let sib = m.previousNamedSibling;
      while (sib && sib.type === "decorator") {
        decs.push(decoratorInfo(sib));
        sib = sib.previousNamedSibling;
      }
      const httpCode = decs.find((d) => d.name === "HttpCode")?.nums[0];
      for (const info of decs) {
        const name = info.name;
        if (name && HTTP_DECORATORS[name]) {
          const verb = HTTP_DECORATORS[name];
          endpoints.push({
            protocol: "http",
            key: `${verb} ${joinPath(httpBase, info.args[0] ?? null)}`,
            handlerQualifiedName, controllerName: className,
            // @HttpCode wins; else NestJS defaults (POST→201, else→200).
            httpStatus: httpCode ?? (verb === "POST" ? 201 : 200),
          });
        } else if (name === "GrpcMethod" || name === "GrpcStreamMethod") {
          // Arg 0 = service, arg 1 = rpc method. Arg 0 is often a static-constant
          // reference (`Ctrl.SERVICE`) rather than a string literal — resolve it,
          // else the method name leaks into the service slot and the endpoint id
          // won't match the consumer's `grpc::<Service>.<method>`.
          const svcNode = info.argNodes[0];
          const rpcNode = info.argNodes[1];
          let svc: string | undefined;
          if (svcNode?.type === "string") {
            svc = stringVal(svcNode);
          } else if (svcNode?.type === "member_expression") {
            const constName = svcNode.childForFieldName("property")?.text;
            if (constName) svc = resolveClassConst(cls, constName) ?? undefined;
          } else if (svcNode?.type === "identifier") {
            svc = resolveClassConst(cls, svcNode.text) ?? undefined;
          }
          const rpc = (rpcNode?.type === "string" ? stringVal(rpcNode) : undefined) ?? methodName;
          svc = svc ?? className;
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
      }
    }
  }
  return endpoints;
}

// Back-compat wrapper.
export function extractRoutes(root: Node): ExtractedEndpoint[] {
  return extractEndpoints(root);
}
