import { createHmac, timingSafeEqual } from "node:crypto";
import type { SearchCursorPayload, SearchCursorCodec } from "@penguin/knowledge-contracts";

export interface OperationCursorPayload {
  schemaVersion: "1";
  contractVersion: "2";
  operation: "endpoints" | "filesymbols" | "deadcode";
  scope: string;
  orderingKey: string;
  lastKey: string;
  revision: string | null;
  expiresAt: string;
}

export class HmacSearchCursorCodec implements SearchCursorCodec {
  constructor(private readonly secret: string, private readonly now = () => Date.now()) {}
  encode(payload: SearchCursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${mac}`;
  }
  decode(cursor: string): SearchCursorPayload {
    const [body, mac] = cursor.split(".");
    if (!body || !mac) throw new Error("CURSOR_INVALID");
    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    if (mac.length !== expected.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) throw new Error("CURSOR_INVALID");
    try {
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SearchCursorPayload;
      if (payload.schemaVersion !== "1" || Date.parse(payload.expiresAt) <= this.now()) throw new Error("CURSOR_STALE");
      return payload;
    } catch (error) {
      if (String((error as Error).message).includes("CURSOR_STALE")) throw error;
      throw new Error("CURSOR_INVALID");
    }
  }
}

/** Shared signed cursor for non-search list operations. The cursor carries
 * operation and scope so a token from one list cannot be replayed against a
 * different repository, file, branch, or revision. */
export class HmacOperationCursorCodec {
  constructor(private readonly secret: string, private readonly now = () => Date.now()) {}
  encode(payload: OperationCursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const mac = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${mac}`;
  }
  decode(cursor: string, expected: Pick<OperationCursorPayload, "operation" | "scope" | "revision">): OperationCursorPayload {
    const [body, mac] = cursor.split(".");
    if (!body || !mac) throw new Error("CURSOR_INVALID");
    const expectedMac = createHmac("sha256", this.secret).update(body).digest("base64url");
    if (mac.length !== expectedMac.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) throw new Error("CURSOR_INVALID");
    let payload: OperationCursorPayload;
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OperationCursorPayload; }
    catch { throw new Error("CURSOR_INVALID"); }
    if (payload.schemaVersion !== "1" || payload.contractVersion !== "2" || payload.operation !== expected.operation || payload.scope !== expected.scope || payload.revision !== expected.revision) throw new Error("CURSOR_SCOPE_MISMATCH");
    if (!payload.orderingKey || !payload.lastKey || Date.parse(payload.expiresAt) <= this.now()) throw new Error("CURSOR_STALE");
    return payload;
  }
}
