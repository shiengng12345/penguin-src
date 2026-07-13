import { Parser, type Node } from "web-tree-sitter";
import { loadLanguage } from "./parser.js";
import type { Lang } from "./registry.js";

// Zero-config frontend→backend linking for the `@connectrpc/connect` calling
// convention — a FOURTH shape distinct from frontend-grpc-client.ts's
// object-literal `{functionName: '...'}` dispatcher / `this._net.<X>()`
// sole-forward wrapper classes, and grpc-js-client.ts's old-FPMS
// `serviceRegistry` + `createGrpcClientFromRegistry` convention:
//
//   class GrpcClientService {
//     private client;
//     constructor() { this.client = createClient(BackendConnect.BackendService, transport); }
//     getClient() { return this.client; }
//   }
//   // elsewhere, any file:
//   grpcClientService.getClient().someMethod(request);
//
// Same zero-config philosophy as the other two: no per-repo config, and no
// attempt to resolve WHICH service a getter belongs to — the call site's bare
// method name is handed to the SAME method-name-uniqueness resolution
// (findEndpointServicesByMethod / enqueuePendingFrontendEdge) the other
// conventions already use. We only need to prove structurally that a given
// getter method really does return a connect-rpc-created client (not just
// happen to be named getFooClient), so a real, unrelated `.someMethod()` call
// elsewhere in the codebase never gets mistaken for a gRPC call.

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i)!, visit);
}

// `this.<prop> = createClient(...)` anywhere in a class body (constructor or
// otherwise) → the backed property name. We don't need to resolve WHICH
// service — only that assigning FROM createClient() proves this property
// holds a connect-rpc client, so a getter returning it is a verified
// gRPC-client getter, not a false-positive on naming alone.
function connectClientBackedProps(classBody: Node): Set<string> {
  const props = new Set<string>();
  walk(classBody, (n) => {
    if (n.type !== "assignment_expression") return;
    const left = n.childForFieldName("left");
    const right = n.childForFieldName("right");
    if (!left || !right || left.type !== "member_expression" || right.type !== "call_expression") return;
    if (left.childForFieldName("object")?.type !== "this") return;
    if (right.childForFieldName("function")?.text !== "createClient") return;
    const prop = left.childForFieldName("property")?.text;
    if (prop) props.add(prop);
  });
  return props;
}

// A method whose ENTIRE body is a sole `return this.<prop>;`, where <prop> is
// connect-rpc-backed — a pure field-forwarding getter, structurally proven
// (mirrors soleNetForward's "prove it, don't assume it" philosophy).
function soleFieldReturn(bodyBlock: Node, backedProps: Set<string>): boolean {
  if (bodyBlock.namedChildCount !== 1) return false;
  const stmt = bodyBlock.namedChild(0)!;
  if (stmt.type !== "return_statement") return false;
  const arg = stmt.namedChild(0);
  if (!arg || arg.type !== "member_expression") return false;
  if (arg.childForFieldName("object")?.type !== "this") return false;
  const prop = arg.childForFieldName("property")?.text;
  return !!prop && backedProps.has(prop);
}

// Zero-config auto-detection: every class in the file (any name), every
// method that is a sole-return of a connect-rpc-backed field. Repos with no
// such classes (i.e. every backend repo) → empty set, safe to run always.
export function verifiedConnectRpcGetters(root: Node): Set<string> {
  const out = new Set<string>();
  walk(root, (cls) => {
    if (cls.type !== "class_declaration" && cls.type !== "class") return;
    const body = cls.childForFieldName("body");
    if (!body) return;
    const backedProps = connectClientBackedProps(body);
    if (backedProps.size === 0) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const member = body.namedChild(i)!;
      if (member.type !== "method_definition") continue;
      const name = member.childForFieldName("name")?.text;
      const mbody = member.childForFieldName("body");
      if (name && mbody && soleFieldReturn(mbody, backedProps)) out.add(name);
    }
  });
  return out;
}

export interface ConnectRpcCall {
  functionName: string;
  startLine: number;
}

const FUNCTION_SCOPE_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

// `const <name> = ...;` / `let <name> = ...;` declared as a DIRECT statement
// of `block` (a Program or a function's statement_block) → that declarator.
// Real FPMS-CCMS has both shapes: a module-top-level const shared by every
// exported function in the file (basicConfigService.ts), AND a fresh const
// declared inside a single function (platformService.ts's
// `const adminClient = grpcClientService.getAdminClient();` inside
// `fetchPlatforms()`). Only checking direct children (not a tree-wide walk)
// is what makes this "declared in exactly this scope", not some nested one.
function findDeclaratorInBlock(block: Node, name: string): Node | null {
  for (let i = 0; i < block.namedChildCount; i++) {
    const stmt = block.namedChild(i)!;
    if (stmt.type !== "lexical_declaration" && stmt.type !== "variable_declaration") continue;
    for (let j = 0; j < stmt.namedChildCount; j++) {
      const decl = stmt.namedChild(j)!;
      if (decl.type === "variable_declarator" && decl.childForFieldName("name")?.text === name) return decl;
    }
  }
  return null;
}

function paramNamed(params: Node, name: string): boolean {
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i)!;
    if (p.type === "identifier" && p.text === name) return true;
    const inner = p.childForFieldName("pattern") ?? p.namedChild(0);
    if (inner?.type === "identifier" && inner.text === name) return true;
  }
  return false;
}

// Resolve `name` (referenced at `fromNode`) to its NEAREST enclosing
// declaration, walking outward from the innermost function scope to the
// module top level — real lexical scoping, not a file-wide name lookup. A
// file-wide `Set<string>` of "names ever bound to a verified getter" was the
// actual bug independently caught by codex + deepcode review: an unrelated
// `const client = data.row;` inside some other function would match every
// `client.method()` call inside THAT function too, since the bare name
// "client" was already in the set. Resolving to the nearest declaration
// fixes that (the inner, unrelated `client` shadows the outer real one, so
// its own declarator — not a getter call — is what gets returned) while
// still finding real bindings wherever they're actually declared, whether at
// module top level or fresh inside a single function.
// Returns null if `name` resolves to a function parameter (never a getter
// binding) or has no declaration up to Program.
function resolveDeclarator(fromNode: Node, name: string): Node | null {
  let node: Node | null = fromNode.parent;
  while (node) {
    if (FUNCTION_SCOPE_TYPES.has(node.type)) {
      const params = node.childForFieldName("parameters");
      if (params && paramNamed(params, name)) return null;
      const body = node.childForFieldName("body");
      if (body && body.type === "statement_block") {
        const decl = findDeclaratorInBlock(body, name);
        if (decl) return decl;
      }
    } else if (node.type === "program") {
      return findDeclaratorInBlock(node, name);
    }
    node = node.parent;
  }
  return null;
}

// Is `decl` (a variable_declarator) a zero-arg call to a verified
// client-getter, e.g. `const client = grpcClientService.getPromotionClient();`?
function declaratorIsVerifiedGetterCall(decl: Node, verifiedGetters: Set<string>): boolean {
  const init = decl.childForFieldName("value");
  if (!init || init.type !== "call_expression") return false;
  const fn = init.childForFieldName("function");
  if (fn?.type !== "member_expression") return false;
  const getterName = fn.childForFieldName("property")?.text;
  if (!getterName || !verifiedGetters.has(getterName)) return false;
  const args = init.childForFieldName("arguments");
  return !args || args.namedChildCount === 0; // zero-arg getter call
}

// Any call_expression `<expr>.<methodName>(<args>)` where <expr> is either:
//   (a) a ZERO-ARG call to a verified client-getter, chained inline, e.g.
//       `grpcClientService.getPromotionClient().someMethod(request)`, or
//   (b) a bare identifier previously bound (via clientBackedLocalVars) to a
//       verified client-getter call, e.g. `client.someMethod(request)`, AND
//       not shadowed by an unrelated same-named binding closer to the call.
// Requiring the getter call to be zero-arg (form a) keeps this from
// over-matching a same-named function that happens to take params.
export function extractConnectRpcCalls(root: Node, verifiedGetters: Set<string>): ConnectRpcCall[] {
  const calls: ConnectRpcCall[] = [];
  if (verifiedGetters.size === 0) return calls;
  walk(root, (n) => {
    if (n.type !== "call_expression") return;
    const fn = n.childForFieldName("function");
    if (fn?.type !== "member_expression") return;
    const methodName = fn.childForFieldName("property")?.text;
    const obj = fn.childForFieldName("object");
    if (!methodName || !obj) return;

    if (obj.type === "call_expression") {
      const innerFn = obj.childForFieldName("function");
      if (innerFn?.type !== "member_expression") return;
      const getterName = innerFn.childForFieldName("property")?.text;
      if (!getterName || !verifiedGetters.has(getterName)) return;
      const innerArgs = obj.childForFieldName("arguments");
      if (innerArgs && innerArgs.namedChildCount > 0) return; // not a zero-arg getter call
      calls.push({ functionName: methodName, startLine: n.startPosition.row + 1 });
      return;
    }

    if (obj.type === "identifier") {
      const decl = resolveDeclarator(obj, obj.text);
      if (decl && declaratorIsVerifiedGetterCall(decl, verifiedGetters)) {
        calls.push({ functionName: methodName, startLine: n.startPosition.row + 1 });
      }
    }
  });
  return calls;
}

// Test-only helpers: parse then extract, mirroring frontend-grpc-client.ts's
// *FromSource helpers.
export async function verifiedConnectRpcGettersFromSource(lang: Lang, source: string): Promise<Set<string>> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? verifiedConnectRpcGetters(tree.rootNode) : new Set();
}

export async function extractConnectRpcCallsFromSource(
  lang: Lang,
  source: string,
  verifiedGetters: Set<string>,
): Promise<ConnectRpcCall[]> {
  const language = await loadLanguage(lang);
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  return tree ? extractConnectRpcCalls(tree.rootNode, verifiedGetters) : [];
}
