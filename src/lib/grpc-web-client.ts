// grpc-web-client now lives in @penguin/core. This shim pre-binds the
// Tauri-specific dependencies (proxyFetch for CORS, loadPackageModule for
// runtime module loading) so existing call sites can keep the old signature.
import { callGrpcWeb as coreCallGrpcWeb, callConnect as coreCallConnect } from "@penguin/core";
import type { MetadataEntry, ResponseState } from "@penguin/core";
import { loadPackageModule } from "./package-loader";
import { proxyFetch } from "./proxy-fetch";

interface GrpcWebCallParams {
  url: string;
  servicePath: string;
  body: string;
  metadata: MetadataEntry[];
  packageName?: string;
}

type CoreWebRpcCall = typeof coreCallGrpcWeb;

function callViaProxy(
  coreCall: CoreWebRpcCall,
  params: GrpcWebCallParams,
  signal?: AbortSignal,
): Promise<ResponseState> {
  const transportHeaders: Record<string, string> = {};
  let fetchCalled = false;
  const safeHeader = (key: string): boolean =>
    key.toLowerCase().startsWith("x-penguin-")
    || key.toLowerCase() === "content-type"
    || key.toLowerCase() === "content-encoding"
    || key.toLowerCase() === "grpc-status"
    || key.toLowerCase() === "grpc-message";
  // Inject the abort signal into every proxied fetch for this call so Esc
  // cancels the request inside the Rust proxy, not just in the UI.
  const fetchWithSignal: typeof proxyFetch = async (input, init) => {
    fetchCalled = true;
    const response = await proxyFetch(input, signal ? { ...init, signal } : init);
    response.headers.forEach((value, key) => {
      if (safeHeader(key)) transportHeaders[key] = value;
    });
    return response;
  };
  return coreCall({
    ...params,
    loadModule: loadPackageModule,
    fetch: fetchWithSignal,
  }).then((result) => ({
    ...result,
    headers: {
      ...transportHeaders,
      ...result.headers,
      "x-penguin-fetch-called": String(fetchCalled),
      // Visible proof that the desktop request went through the current
      // source wrapper while diagnosing packaged-vs-dev bundle confusion.
      "x-penguin-client-build": "dev-grpc-inspection",
    },
  }));
}

export function callGrpcWeb(
  params: GrpcWebCallParams,
  signal?: AbortSignal,
): Promise<ResponseState> {
  return callViaProxy(coreCallGrpcWeb, params, signal);
}

/** Connect unary (bare application/proto) — the migrated servers' protocol. */
export function callConnect(
  params: GrpcWebCallParams,
  signal?: AbortSignal,
): Promise<ResponseState> {
  return callViaProxy(coreCallConnect, params, signal);
}
