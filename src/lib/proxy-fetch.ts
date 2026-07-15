import { invoke } from "@tauri-apps/api/core";

interface HttpProxyResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  body_base64: string;
  error: string | null;
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function proxyFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === "string" ? input : input.toString();
  const method = init?.method ?? "GET";

  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [key, value] of init.headers) {
        headers[key] = value;
      }
    } else {
      Object.assign(headers, init.headers);
    }
  }

  let bodyBase64: string | undefined;
  let bodyText: string | undefined;

  if (init?.body != null) {
    if (init.body instanceof ArrayBuffer) {
      bodyBase64 = uint8ToBase64(new Uint8Array(init.body));
    } else if (init.body instanceof Uint8Array) {
      bodyBase64 = uint8ToBase64(init.body);
    } else if (typeof init.body === "string") {
      bodyText = init.body;
    } else {
      bodyText = String(init.body);
    }
  }

  const signal = init?.signal ?? null;
  if (signal?.aborted) {
    throw new DOMException("Request cancelled", "AbortError");
  }

  // With a signal, register an id so abort can drop the request inside the
  // Rust proxy mid-flight instead of letting it run to completion.
  const requestId = signal
    ? `proxy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    : null;
  const onAbort = requestId
    ? () => void invoke("http_proxy_abort", { requestId })
    : null;
  if (signal && onAbort) signal.addEventListener("abort", onAbort);

  let resp: HttpProxyResponse;
  try {
    resp = await invoke<HttpProxyResponse>("http_proxy", {
      req: {
        url,
        method,
        headers,
        body: bodyText ?? null,
        body_base64: bodyBase64 ?? null,
        request_id: requestId,
      },
    });
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }

  if (signal?.aborted || resp.error === "Request cancelled") {
    throw new DOMException("Request cancelled", "AbortError");
  }

  if (resp.error) {
    // proxyFetch implements the standard fetch() contract for ConnectRPC's
    // transport layer, which expects exceptions on network failure. Returning
    // a synthetic Response would misrepresent transport state to the gRPC client.
    throw new Error(resp.error);
  }

  const responseBytes = resp.body_base64
    ? base64ToUint8(resp.body_base64)
    : new TextEncoder().encode(resp.body);

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(resp.headers)) {
    responseHeaders.set(key, value);
  }

  // Keep transport evidence on the synthetic Response itself. ConnectRPC can
  // fail while decoding the body, so the caller must still be able to inspect
  // the raw status, framing prefix, and content headers in the UI. This is
  // metadata only; never log authorization, request bodies, or response text.
  const rawHeader = (name: string): string => {
    const entry = Object.entries(resp.headers).find(([key]) => key.toLowerCase() === name);
    return entry?.[1] ?? "";
  };
  const responsePrefix = Array.from(responseBytes.slice(0, 32), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const inspection = {
    status: resp.status,
    contentType: rawHeader("content-type") || null,
    contentEncoding: rawHeader("content-encoding") || null,
    grpcStatus: rawHeader("grpc-status") || null,
    grpcMessage: rawHeader("grpc-message") || null,
    bytes: responseBytes.byteLength,
    prefixHex: responsePrefix,
  };
  responseHeaders.set("x-penguin-http-status", String(inspection.status));
  responseHeaders.set("x-penguin-content-type", inspection.contentType ?? "");
  responseHeaders.set("x-penguin-content-encoding", inspection.contentEncoding ?? "");
  responseHeaders.set("x-penguin-grpc-status", inspection.grpcStatus ?? "");
  responseHeaders.set("x-penguin-grpc-message", inspection.grpcMessage ?? "");
  responseHeaders.set("x-penguin-response-bytes", String(inspection.bytes));
  responseHeaders.set("x-penguin-response-prefix", inspection.prefixHex);
  console.info("[Penguin gRPC-Web proxy response inspection]", inspection);

  return new Response(responseBytes.buffer as ArrayBuffer, {
    status: resp.status,
    headers: responseHeaders,
  });
}
