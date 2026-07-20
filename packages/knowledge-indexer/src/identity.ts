/** Stable identity for an anonymous callback: parent identity plus AST/source
 * order. The ordinal is assigned from traversal order, never from a line
 * number, so harmless formatting edits do not change the callback identity. */
export function anonymousCallbackIdentity(parentIdentity: string, astOrdinal: number): string {
  if (!parentIdentity.trim() || !Number.isInteger(astOrdinal) || astOrdinal < 0) throw new Error("ANONYMOUS_CALLBACK_ID_INVALID");
  return `${parentIdentity}::anonymous_callback#${astOrdinal}`;
}
