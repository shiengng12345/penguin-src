import { createClient, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport, createGrpcWebTransport } from "@connectrpc/connect-web";
import type { ResponseState, MetadataEntry, ConnectServiceDef } from "./types.js";
import { discoverServices } from "./discover-services.js";
import { normalizeGrpcJsonBody } from "./grpc-json.js";
import { parseWebRpcServicePath } from "./service-path.js";
import { inspectGrpcWebResponse, type GrpcWebResponseInspection } from "./grpc-web-debug.js";

// Module loader signature. Penguin desktop injects a Tauri-backed loader that
// reads bundle.js via the Rust side and dynamic-imports a blob URL; Node
// runtimes (MCP server, CLI) pass a plain dynamic-import wrapper.
export type LoadPackageModule = (
  packageName: string,
) => Promise<Record<string, unknown>>;

interface GrpcWebCallParams {
  url: string;
  servicePath: string;
  body: string;
  metadata: MetadataEntry[];
  packageName?: string;
  // Required — how to load the @snsoft package so we can extract Connect
  // service descriptors at runtime.
  loadModule: LoadPackageModule;
  // Optional — Penguin passes a Tauri proxy fetch to bypass CORS; Node
  // consumers can omit (defaults to globalThis.fetch).
  fetch?: typeof globalThis.fetch;
}

function cleanProtoResponse(result: unknown): string {
  const raw = JSON.stringify(result);
  const stripped = raw.replace(/,"_[a-zA-Z][a-zA-Z0-9]*":\s*"[^"]*"/g, "")
                      .replace(/"_[a-zA-Z][a-zA-Z0-9]*":\s*"[^"]*",?/g, "");
  try {
    return JSON.stringify(JSON.parse(stripped), null, 2);
  } catch {
    return JSON.stringify(JSON.parse(raw), null, 2);
  }
}

function buildErrorResponse(message: string, startTime: number): ResponseState {
  return {
    status: "ERROR",
    statusCode: 0,
    body: "",
    headers: {},
    duration: Math.round(performance.now() - startTime),
    error: message,
  };
}

function inspectionHeaders(inspection: GrpcWebResponseInspection | null): Record<string, string> {
  if (!inspection) return {};
  return {
    "x-penguin-http-status": String(inspection.status),
    "x-penguin-content-type": inspection.contentType ?? "",
    "x-penguin-content-encoding": inspection.contentEncoding ?? "",
    "x-penguin-content-length": String(inspection.contentLength ?? ""),
    "x-penguin-grpc-status": inspection.grpcStatus ?? "",
    "x-penguin-grpc-message": inspection.grpcMessage ?? "",
    "x-penguin-response-bytes": String(inspection.bytes),
    "x-penguin-response-prefix": inspection.prefixHex,
  };
}

function safeResponseMetadata(metadata?: Headers): Record<string, string> {
  if (!metadata) return {};
  const allowed = new Set([
    "content-type",
    "content-encoding",
    "grpc-status",
    "grpc-message",
    "x-penguin-http-status",
    "x-penguin-content-type",
    "x-penguin-content-encoding",
    "x-penguin-content-length",
    "x-penguin-transfer-encoding",
    "x-penguin-connection",
    "x-penguin-grpc-status",
    "x-penguin-grpc-message",
    "x-penguin-response-bytes",
    "x-penguin-response-prefix",
  ]);
  const out: Record<string, string> = {};
  metadata.forEach((value, key) => {
    if (allowed.has(key.toLowerCase())) out[key] = value;
  });
  return out;
}

const serviceCache = new Map<string, ConnectServiceDef>();

async function ensureServiceLoaded(
  packageName: string,
  typeName: string,
  loadModule: LoadPackageModule,
): Promise<ConnectServiceDef | null> {
  if (serviceCache.has(typeName)) {
    return serviceCache.get(typeName)!;
  }

  const mod = await loadModule(packageName);
  const { serviceMap } = discoverServices(mod);

  for (const [key, svc] of serviceMap) {
    serviceCache.set(key, svc);
  }

  return serviceMap.get(typeName) ?? null;
}

/** Wire protocol for a web-transport RPC call. Both share everything except
 * the ConnectRPC transport, the URL layout, and the accepted path shapes. */
export type WebRpcProtocol = "grpc-web" | "connect";

/** Old servers: gRPC-Web framed, mounted under the proto package prefix. */
export async function callGrpcWeb(
  params: GrpcWebCallParams
): Promise<ResponseState> {
  return callWebRpc(params, "grpc-web");
}

/** New servers: Connect unary (bare application/proto), mounted at the root. */
export async function callConnect(
  params: GrpcWebCallParams
): Promise<ResponseState> {
  return callWebRpc(params, "connect");
}

async function callWebRpc(
  params: GrpcWebCallParams,
  protocol: WebRpcProtocol,
): Promise<ResponseState> {
  const startTime = performance.now();
  const { url, servicePath, body, metadata, packageName, loadModule } = params;
  const fetchImpl = params.fetch ?? globalThis.fetch;

  // Validate JSON body — caller pasted this directly from the editor.
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return buildErrorResponse("Invalid JSON request body / 无效的 JSON 请求体", startTime);
  }

  const parsedPath = parseWebRpcServicePath(servicePath, protocol);
  if (!parsedPath) {
    return buildErrorResponse(
      protocol === "connect"
        ? `Invalid service path: ${servicePath}. Expected /<pkg.Service>/<Method> or /<package>/<typeName>/<method>`
        : `Invalid service path: ${servicePath}. Expected /<package>/<typeName>/<method>`,
      startTime,
    );
  }
  const { protoPackage, typeName, methodName } = parsedPath;

  // Both protocols need the package name to load the generated client module.
  if (!packageName) {
    return buildErrorResponse(
      "Package name is required to load the service definition. Select a method from an installed package.",
      startTime,
    );
  }

  const serviceDef = await ensureServiceLoaded(packageName, typeName, loadModule);
  if (!serviceDef) {
    return buildErrorResponse(
      `Service definition not found: ${typeName}. Ensure the package is installed and contains this service.`,
      startTime,
    );
  }

  const methodNameLower = methodName[0].toLowerCase() +methodName.slice(1);
  const resolvedMethodName =
    serviceDef.methods[methodName] ? methodName
    : serviceDef.methods[methodNameLower] ? methodNameLower
    : Object.keys(serviceDef.methods).find(
        (k) => k.toLowerCase() === methodName.toLowerCase()
      );

  const methodMissingOnDef = !resolvedMethodName || !serviceDef.methods[resolvedMethodName];
  if (methodMissingOnDef) {
    return buildErrorResponse(
      `Method ${methodName} not found on service ${typeName}. Available: ${Object.keys(serviceDef.methods).join(", ")}`,
      startTime,
    );
  }

  // gRPC-Web servers mount under the proto package prefix; Connect servers
  // serve /<pkg.Service>/<Method> directly at the given URL (any mount prefix
  // belongs in the URL itself, so /api/v1-style prefixes keep working).
  const strippedUrl = url.replace(/\/$/, "");
  const baseUrl = protocol === "connect" ? strippedUrl : `${strippedUrl}/${protoPackage}`;

  const headerInterceptor: Interceptor = (next) => async (req) => {
    for (const entry of metadata) {
      if (entry.enabled && entry.key.trim()) {
        req.header.set(entry.key, entry.value);
      }
    }
    return await next(req);
  };

  let transportInspection: Promise<GrpcWebResponseInspection | null> = Promise.resolve(null);
  const transportOptions = {
    baseUrl,
    interceptors: [headerInterceptor],
    fetch: (async (input, init) => {
      const response = await fetchImpl(input, init);
      transportInspection = inspectGrpcWebResponse(response)
        .then((inspection) => {
          // Safe metadata only: no authorization, request body, or response body.
          console.info(`[Penguin ${protocol} response inspection]`, inspection);
          return inspection;
        })
        .catch(() => null);
      return response;
    }) satisfies typeof globalThis.fetch,
  };
  // Connect binary format sends content-type: application/proto plus the
  // connect-protocol-version header — the exact wire shape of the new servers.
  const transport =
    protocol === "connect"
      ? createConnectTransport({ ...transportOptions, useBinaryFormat: true })
      : createGrpcWebTransport(transportOptions);

  // ConnectRPC service definition types are not exported publicly; the cast
  // bridges our discovered shape to its internal expected shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = createClient(serviceDef as any, transport);
  const dynamicClient = client as Record<
    string,
    ((data?: unknown) => Promise<unknown>) | undefined
  >;

  const clientMethod = dynamicClient[resolvedMethodName!];
  if (!clientMethod) {
    return buildErrorResponse(
      `Method ${resolvedMethodName} does not exist on the generated client`,
      startTime,
    );
  }

  let requestData: unknown = parsedBody;
  try {
    requestData = normalizeGrpcJsonBody(parsedBody, serviceDef.methods[resolvedMethodName].I);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return buildErrorResponse(
      `${message} / 请求体不符合 proto schema。Enum accepts either the enum name or number.`,
      startTime,
    );
  }

  // Only the network call is wrapped in try/catch — everything above is
  // pre-validation and now returns early. Errors here are gRPC ConnectErrors
  // (which carry .code and .rawMessage) or transport failures from fetch.
  try {
    const isEmpty = !parsedBody || Object.keys(parsedBody).length === 0;
    const result = isEmpty
      ? await clientMethod()
      : await clientMethod(requestData);

    const duration = performance.now() - startTime;
    const formattedBody = cleanProtoResponse(result);
    const inspection = await transportInspection;

    return {
      status: "OK",
      statusCode: 200,
      body: formattedBody,
      headers: {
        "x-penguin-request-url": `${baseUrl}/${typeName}/${methodName}`,
        "x-penguin-protocol": protocol === "connect" ? "connect+proto" : "grpc-web+proto",
        ...inspectionHeaders(inspection),
      },
      duration: Math.round(duration),
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    const errMsg =
      error instanceof Error ? error.message : String(error);

    const isConnectError =
      error &&
      typeof error === "object" &&
      "code" in error &&
      "rawMessage" in error;

    if (isConnectError) {
      const ce = error as { code: string; rawMessage: string; metadata?: Headers };
      const inspection = await transportInspection;
      const grpcHeaders: Record<string, string> = {
        ...safeResponseMetadata(ce.metadata),
        "grpc-status": ce.code,
        "grpc-message": ce.rawMessage,
        ...inspectionHeaders(inspection),
      };
      return {
        status: `gRPC ${ce.code}`,
        // Connect wraps non-2xx HTTP responses as an error, but the actual
        // HTTP status remains the most useful machine-readable signal.
        statusCode: inspection?.status ?? 200,
        body: JSON.stringify(
          { code: ce.code, message: ce.rawMessage },
          null,
          2
        ),
        headers: grpcHeaders,
        duration: Math.round(duration),
        error: ce.rawMessage,
      };
    }

    return {
      status: "ERROR",
      statusCode: 0,
      body: "",
      headers: inspectionHeaders(await transportInspection),
      duration: Math.round(duration),
      error: errMsg,
    };
  }
}
