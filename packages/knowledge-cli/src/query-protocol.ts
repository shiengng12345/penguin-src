import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";

export interface QueryHello { type: "hello"; protocolVersion: 1; capabilityHash: string; schemaVersion: number; }
export interface QueryRequest { type: "request"; id: string; capabilityId: string; input: unknown; protocolVersion?: number; }
export interface QueryCancel { type: "cancel"; id: string; }
export type QueryFrame = QueryRequest | QueryCancel;
export type QueryResponse = { type: "response"; id: string; ok: true; result: unknown } | { type: "response"; id: string; ok: false; error: { code: string; message: string } };

export function queryHello(schemaVersion: number): QueryHello { return { type: "hello", protocolVersion: 1, capabilityHash: capabilityHash(CAPABILITIES), schemaVersion }; }
export function encodeFrame(frame: unknown): string { return JSON.stringify(frame) + "\n"; }
export function parseFrame(line: string): QueryFrame {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error("MALFORMED_FRAME"); }
  if (!value || typeof value !== "object") throw new Error("MALFORMED_FRAME");
  const frame = value as Record<string, unknown>;
  if (frame.type === "cancel" && typeof frame.id === "string") return frame as unknown as QueryCancel;
  if (frame.type === "request" && typeof frame.id === "string" && typeof frame.capabilityId === "string" && "input" in frame) {
    if (frame.protocolVersion !== undefined && frame.protocolVersion !== 1) throw new Error("PROTOCOL_MAJOR_MISMATCH");
    return frame as unknown as QueryRequest;
  }
  throw new Error("MALFORMED_FRAME");
}

export async function dispatchQueryFrame(frame: QueryFrame, invoke: (capabilityId: string, input: unknown, signal?: AbortSignal) => Promise<unknown>, cancelled = new Set<string>(), active = new Map<string, AbortController>()): Promise<QueryResponse | null> {
  if (frame.type === "cancel") { cancelled.add(frame.id); active.get(frame.id)?.abort(); return null; }
  if (cancelled.has(frame.id)) return { type: "response", id: frame.id, ok: false, error: { code: "CANCELLED", message: "request was cancelled" } };
  const controller = new AbortController();
  active.set(frame.id, controller);
  try {
    const result = await invoke(frame.capabilityId, frame.input, controller.signal);
    if (cancelled.has(frame.id) || controller.signal.aborted) return { type: "response", id: frame.id, ok: false, error: { code: "CANCELLED", message: "request was cancelled" } };
    return { type: "response", id: frame.id, ok: true, result };
  }
  catch (error) { return { type: "response", id: frame.id, ok: false, error: { code: (error as { code?: string }).code ?? "INTERNAL", message: String((error as Error).message ?? error) } }; }
  finally { active.delete(frame.id); }
}
