export interface GrpcWebResponseInspection {
  status: number;
  statusText: string;
  url: string;
  contentType: string | null;
  contentEncoding: string | null;
  grpcStatus: string | null;
  grpcMessage: string | null;
  contentLength: number | null;
  bytes: number;
  prefixHex: string;
}

// Inspect only response framing metadata and a short binary prefix. The body
// is read from a clone, so ConnectRPC still receives the original protobuf
// stream. Never include response text or request metadata here: this output is
// intended for browser logs and must not leak credentials or player data.
export async function inspectGrpcWebResponse(
  response: Response,
): Promise<GrpcWebResponseInspection> {
  // Tauri's proxy already inspected the bytes before creating this synthetic
  // Response. Prefer that metadata because some WebViews cannot clone a
  // synthetic response body after the ConnectRPC reader has locked it.
  const proxyBytes = response.headers.get("x-penguin-response-bytes");
  const proxyPrefix = response.headers.get("x-penguin-response-prefix");
  if (proxyBytes !== null && proxyPrefix !== null) {
    const parsedBytes = Number.parseInt(proxyBytes, 10);
    return {
      status: Number.parseInt(response.headers.get("x-penguin-http-status") ?? "", 10) || response.status,
      statusText: response.statusText,
      url: response.url,
      contentType: response.headers.get("x-penguin-content-type") || response.headers.get("content-type"),
      contentEncoding: response.headers.get("x-penguin-content-encoding") || response.headers.get("content-encoding"),
      grpcStatus: response.headers.get("x-penguin-grpc-status") || response.headers.get("grpc-status"),
      grpcMessage: response.headers.get("x-penguin-grpc-message") || response.headers.get("grpc-message"),
      contentLength: null,
      bytes: Number.isFinite(parsedBytes) ? parsedBytes : 0,
      prefixHex: proxyPrefix,
    };
  }
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  const contentLength = response.headers.get("content-length");
  const parsedLength = contentLength === null ? null : Number.parseInt(contentLength, 10);
  return {
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    contentType: response.headers.get("content-type"),
    contentEncoding: response.headers.get("content-encoding"),
    grpcStatus: response.headers.get("grpc-status"),
    grpcMessage: response.headers.get("grpc-message"),
    contentLength: Number.isFinite(parsedLength) ? parsedLength : null,
    bytes: bytes.byteLength,
    prefixHex: Array.from(bytes.slice(0, 32), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  };
}
