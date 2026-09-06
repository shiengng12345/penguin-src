function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasTypedMcpToolError(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.error)) return false;
  return typeof value.error.code === "string"
    && typeof value.error.message === "string"
    && typeof value.error.retryable === "boolean";
}

/** Human text is a convenience projection. Typed failures must retain their
 * complete machine-readable envelope because some MCP clients surface only
 * the text block when `isError` is true. */
export function mcpResultText(value: unknown): string {
  if (hasTypedMcpToolError(value)) return JSON.stringify(value, null, 2);
  if (isRecord(value) && Array.isArray(value.hits)) {
    const searchedLanes = isRecord(value.diagnostics) && Array.isArray(value.diagnostics.searchedLanes)
      ? value.diagnostics.searchedLanes.filter((lane): lane is string => typeof lane === "string")
      : [];
    return `${value.hits.length} hits${searchedLanes.length ? ` · lanes ${searchedLanes.join(",")}` : ""}`;
  }
  return JSON.stringify(value, null, 2);
}
