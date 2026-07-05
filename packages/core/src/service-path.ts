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
