import type { SearchLane, SearchMode } from "./search.js";

export interface SearchCursorPayload {
  schemaVersion: "1";
  queryHash: string;
  normalizedRequestHash: string;
  scopeHash: string;
  capabilityHash: string;
  mode: SearchMode;
  lanes: SearchLane[];
  lastRank: number;
  lastHitId: string;
  expiresAt: string;
}

export interface SearchCursorCodec {
  encode(payload: SearchCursorPayload): string;
  decode(cursor: string): SearchCursorPayload;
}
