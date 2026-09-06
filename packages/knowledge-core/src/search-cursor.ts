import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchCursorPayload, SearchCursorCodec } from "@penguin/knowledge-contracts";

/** One persisted owner-local secret signs every cursor family. Sharing the
 * signing root lets a receiver distinguish a valid cursor from another
 * operation from a token whose bytes were actually tampered with. */
export function resolveLocalCursorSecret(): string {
  if (process.env.PENGUIN_CURSOR_SECRET) return process.env.PENGUIN_CURSOR_SECRET;
  const root = join(homedir(), ".penguin", "knowledge");
  const path = join(root, ".cursor-secret");
  try {
    const existing = readFileSync(path, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch { /* first process creates the local secret */ }
  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (!existsSync(path)) writeFileSync(path, `${generated}\n`, { mode: 0o600, flag: "wx" });
    const persisted = readFileSync(path, "utf8").trim();
    return persisted.length >= 32 ? persisted : generated;
  } catch {
    return generated;
  }
}

export interface OperationCursorPayload {
  schemaVersion: "1";
  contractVersion: "2";
  operation: "endpoints" | "filesymbols" | "deadcode" | "coverage" | "notelist" | "context";
  scope: string;
  orderingKey: string;
  lastKey: string;
  revision: string | null;
  expiresAt: string;
  limit?: number;
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
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SearchCursorPayload & { operation?: string };
      if (payload.operation) throw new Error("CURSOR_OPERATION_MISMATCH");
      if (payload.schemaVersion !== "1") throw new Error("CURSOR_STALE");
      if (Date.parse(payload.expiresAt) <= this.now()) throw new Error("CURSOR_EXPIRED");
      return payload;
    } catch (error) {
      if (["CURSOR_STALE", "CURSOR_EXPIRED", "CURSOR_OPERATION_MISMATCH"].includes(String((error as Error).message))) throw error;
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
  decode(cursor: string, expected: Pick<OperationCursorPayload, "operation" | "scope" | "revision"> & { limit?: number }): OperationCursorPayload {
    const [body, mac] = cursor.split(".");
    if (!body || !mac) throw new Error("CURSOR_INVALID");
    const expectedMac = createHmac("sha256", this.secret).update(body).digest("base64url");
    if (mac.length !== expectedMac.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(expectedMac))) throw new Error("CURSOR_INVALID");
    let payload: OperationCursorPayload & { normalizedRequestHash?: string };
    try { payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OperationCursorPayload & { normalizedRequestHash?: string }; }
    catch { throw new Error("CURSOR_INVALID"); }
    if (!payload.operation && payload.normalizedRequestHash) throw new Error("CURSOR_OPERATION_MISMATCH");
    if (payload.schemaVersion !== "1" || payload.contractVersion !== "2") throw new Error("CURSOR_STALE");
    if (payload.operation !== expected.operation) throw new Error("CURSOR_OPERATION_MISMATCH");
    if (payload.scope !== expected.scope || payload.revision !== expected.revision) throw new Error("CURSOR_SCOPE_MISMATCH");
    if (expected.limit !== undefined && payload.limit !== undefined && payload.limit !== expected.limit) throw new Error("CURSOR_REQUEST_MISMATCH");
    if (!payload.orderingKey || !payload.lastKey) throw new Error("CURSOR_STALE");
    if (Date.parse(payload.expiresAt) <= this.now()) throw new Error("CURSOR_EXPIRED");
    return payload;
  }
}
