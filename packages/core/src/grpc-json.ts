export interface GrpcJsonRequestType {
  typeName?: string;
  fromJson?: (value: unknown, options?: { ignoreUnknownFields?: boolean }) => unknown;
}

export function normalizeGrpcJsonBody(
  parsedBody: Record<string, unknown>,
  requestType?: GrpcJsonRequestType | null,
): unknown {
  if (!requestType || typeof requestType.fromJson !== "function") {
    return parsedBody;
  }

  try {
    // Unknown fields are almost always a typo in an MCP-authored request.
    // Silently dropping them can turn a semantically wrong request into a
    // successful call with default values, so keep the generated protobuf
    // decoder strict at this boundary.
    return requestType.fromJson(parsedBody, { ignoreUnknownFields: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const typeName = requestType.typeName ? ` for ${requestType.typeName}` : "";
    throw new Error(`Request body does not match proto schema${typeName}: ${message}`);
  }
}
