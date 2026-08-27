// Single source of truth for the default gRPC/gRPC-Web request path.
// Shape: /<gateway prefix>/<service full name>/<method>
//
// The two segments have DIFFERENT case rules and must not share one string:
//   * gateway prefix — the platform mounts routes lowercase (/cms/), so the
//     proto package's first segment is force-lowercased here;
//   * service full name — the gRPC wire path is case-sensitive and must match
//     the .proto declaration byte-for-byte (`package CMS;` → CMS.FrontendService).
// Lowercasing both (or neither) breaks uppercase proto packages like CMS:
// /CMS/... 404s at the gateway, /cms/cms.... gets UNIMPLEMENTED upstream.
export function computeServicePath(fullName: string): string {
  const typeName = fullName.substring(0, fullName.lastIndexOf("."));
  const methodName = fullName.substring(fullName.lastIndexOf(".") + 1);
  const gatewayPrefix = typeName.split(".")[0].toLowerCase();
  return `/${gatewayPrefix}/${typeName}/${methodName}`;
}

// Connect protocol default path: /<service full name>/<method>, served at the
// root (no gateway prefix — a mount prefix, if any, belongs in the base URL).
export function computeConnectServicePath(fullName: string): string {
  const typeName = fullName.substring(0, fullName.lastIndexOf("."));
  const methodName = fullName.substring(fullName.lastIndexOf(".") + 1);
  return `/${typeName}/${methodName}`;
}

export interface ParsedWebRpcPath {
  /** Gateway prefix segment (legacy 3-segment form); null for the Connect 2-segment form. */
  protoPackage: string | null;
  /** Case-sensitive service full name, e.g. `CMS.FrontendService`. */
  typeName: string;
  methodName: string;
}

/**
 * Parse a request path into service/method parts.
 *
 * Accepted shapes:
 * - `/<package>/<typeName>/<method>` (legacy, both protocols) — typeName may
 *   itself contain dots and extra path segments collapse into it;
 * - `/<pkg.Service>/<Method>` (Connect only) — the protocol-standard form the
 *   new servers mount at the root; requires a dotted first segment so a plain
 *   two-segment REST-ish path never false-positives.
 *
 * Returns null when the path fits neither shape.
 */
export function parseWebRpcServicePath(
  servicePath: string,
  protocol: "grpc-web" | "connect",
): ParsedWebRpcPath | null {
  const parts = servicePath.replace(/^\//, "").replace(/\/$/, "").split("/").filter(Boolean);
  if (parts.length >= 3) {
    return {
      protoPackage: parts[0],
      typeName: parts.slice(1, -1).join("."),
      methodName: parts[parts.length - 1],
    };
  }
  if (protocol === "connect" && parts.length === 2 && parts[0].includes(".")) {
    return { protoPackage: null, typeName: parts[0], methodName: parts[1] };
  }
  return null;
}
