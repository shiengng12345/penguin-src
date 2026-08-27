import { capabilityHash, CAPABILITIES } from "@penguin/knowledge-contracts";
export function queryHello(schemaVersion) { return { type: "hello", protocolVersion: 1, capabilityHash: capabilityHash(CAPABILITIES), schemaVersion }; }
export function encodeFrame(frame) { return JSON.stringify(frame) + "\n"; }
export function parseFrame(line) {
    let value;
    try {
        value = JSON.parse(line);
    }
    catch {
        throw new Error("MALFORMED_FRAME");
    }
    if (!value || typeof value !== "object")
        throw new Error("MALFORMED_FRAME");
    const frame = value;
    if (frame.type === "cancel" && typeof frame.id === "string")
        return frame;
    if (frame.type === "request" && typeof frame.id === "string" && typeof frame.capabilityId === "string" && "input" in frame) {
        if (frame.protocolVersion !== undefined && frame.protocolVersion !== 1)
            throw new Error("PROTOCOL_MAJOR_MISMATCH");
        return frame;
    }
    throw new Error("MALFORMED_FRAME");
}
export async function dispatchQueryFrame(frame, invoke, cancelled = new Set(), active = new Map()) {
    if (frame.type === "cancel") {
        cancelled.add(frame.id);
        active.get(frame.id)?.abort();
        return null;
    }
    if (cancelled.has(frame.id))
        return { type: "response", id: frame.id, ok: false, error: { code: "CANCELLED", message: "request was cancelled" } };
    const controller = new AbortController();
    active.set(frame.id, controller);
    try {
        const result = await invoke(frame.capabilityId, frame.input, controller.signal);
        if (cancelled.has(frame.id) || controller.signal.aborted)
            return { type: "response", id: frame.id, ok: false, error: { code: "CANCELLED", message: "request was cancelled" } };
        return { type: "response", id: frame.id, ok: true, result };
    }
    catch (error) {
        return { type: "response", id: frame.id, ok: false, error: { code: error.code ?? "INTERNAL", message: String(error.message ?? error) } };
    }
    finally {
        active.delete(frame.id);
    }
}
//# sourceMappingURL=query-protocol.js.map