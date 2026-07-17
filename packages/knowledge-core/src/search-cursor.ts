import { createHmac, timingSafeEqual } from "node:crypto";
import type { SearchCursorPayload, SearchCursorCodec } from "@penguin/knowledge-contracts";

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
