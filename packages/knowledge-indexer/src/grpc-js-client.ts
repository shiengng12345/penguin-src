/**
 * Extract gRPC client calls from FPMS-style JavaScript source files
 * that use the `serviceRegistry` + `grpcClientCall` pattern.
 *
 * Detected pattern:
 *   FuncName: async function (data) {
 *       const { client } = createGrpcClientFromRegistry(SERVICE_X, 'FuncName');
 *       return grpcClientCall(client, 'MethodName', data);
 *   }
 *
 * Paired with serviceRegistry entries like:
 *   [SERVICE_X]: { serviceName: 'XxxService', ... }
 */

export interface JsGrpcCall {
  /** gRPC service name resolved from serviceRegistry (e.g. "CardSystemService") */
  service: string;
  /** gRPC method name from grpcClientCall (e.g. "AdminUnlockPlayer") */
  method: string;
  /** The export function name (e.g. "AdminUnlockPlayer") */
  functionName: string;
  /** 1-based line number of the function */
  startLine: number;
}

/**
 * Parse `serviceRegistry = { [KEY]: { serviceName: 'Xxx', ... } }` entries
 * from FPMS source. Returns a Map of SERVICE_KEY → serviceName.
 */
function parseServiceRegistry(source: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match: [SERVICE_X]: { ... serviceName: 'XxxService' ... }
  const re = /\[(\w+)\]:\s*\{[^}]*serviceName:\s*['"](\w+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    map.set(m[1], m[2]);
  }
  return map;
}

/**
 * Extract gRPC calls from FPMS-style JS files.
 *
 * Steps:
 * 1. Parse serviceRegistry → SERVICE_KEY → serviceName mapping
 * 2. Find export object functions that call createGrpcClientFromRegistry
 * 3. Extract the method name from grpcClientCall in the same function
 */
export function extractFpmsGrpcCalls(source: string): JsGrpcCall[] {
  const registry = parseServiceRegistry(source);
  if (registry.size === 0) return [];

  const calls: JsGrpcCall[] = [];

  // Find each function in the export object: `FuncName: async function (data) { ... }`
  // or `FuncName: function (data) { ... }`
  const funcRe = /(\w+)\s*:\s*(?:async\s+)?function\s*\([^)]*\)\s*\{/g;
  let funcMatch: RegExpExecArray | null;

  while ((funcMatch = funcRe.exec(source)) !== null) {
    const functionName = funcMatch[1];
    const funcStart = funcMatch.index;
    const startLine = (source.slice(0, funcStart).match(/\n/g) ?? []).length + 1;

    // Find the matching closing brace
    const bodyStart = source.indexOf("{", funcMatch.index + funcMatch[0].length - 1) + 1;
    let depth = 1;
    let pos = bodyStart;
    while (depth > 0 && pos < source.length) {
      const ch = source[pos];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      pos++;
    }
    const body = source.slice(bodyStart, pos - 1);

    // Find service key from createGrpcClientFromRegistry
    const svcKeyMatch = body.match(/createGrpcClientFromRegistry\((\w+)/);
    if (!svcKeyMatch) continue;

    const serviceKey = svcKeyMatch[1];
    const serviceName = registry.get(serviceKey);
    if (!serviceName) continue;

    // Find method name from grpcClientCall
    const methodMatch = body.match(/grpcClientCall\([^,]+,\s*['"](\w+)['"]/);
    if (!methodMatch) continue;

    calls.push({
      service: serviceName,
      method: methodMatch[1],
      functionName,
      startLine,
    });
  }

  return calls;
}
