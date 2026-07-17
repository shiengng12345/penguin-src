import { randomUUID, createHash } from "node:crypto";
import type { KnowledgeStore } from "./store.js";

export interface SavedQuery {
  id: string;
  name: string;
  request: Record<string, unknown>;
  scope: Record<string, unknown>;
  contractVersion: string;
  createdAt: string;
  updatedAt: string;
}

function rowToQuery(row: Record<string, string>): SavedQuery {
  return {
    id: row.id,
    name: row.name,
    request: JSON.parse(row.request_json),
    scope: JSON.parse(row.scope_json),
    contractVersion: row.contract_version ?? "2",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SavedQueryStore {
  constructor(private readonly store: KnowledgeStore) {}

  write(input: { name: string; request: Record<string, unknown>; scope?: Record<string, unknown> }): SavedQuery {
    const name = input.name.trim();
    if (!name) throw new Error("SAVED_QUERY_NAME_REQUIRED");
    const now = new Date().toISOString();
    const id = `saved:${createHash("sha256").update(name).digest("hex").slice(0, 24)}`;
    this.store.db.prepare(`INSERT INTO saved_queries(id,name,request_json,scope_json,contract_version,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET request_json=excluded.request_json,scope_json=excluded.scope_json,contract_version=excluded.contract_version,updated_at=excluded.updated_at`)
      .run(id, name, JSON.stringify(input.request), JSON.stringify(input.scope ?? {}), "2", now, now);
    return this.get(name)!;
  }

  get(nameOrId: string): SavedQuery | null {
    const row = this.store.db.prepare("SELECT * FROM saved_queries WHERE id=? OR name=? LIMIT 1").get(nameOrId, nameOrId) as Record<string, string> | undefined;
    return row ? rowToQuery(row) : null;
  }

  list(query?: string): SavedQuery[] {
    const rows = query ? this.store.db.prepare("SELECT * FROM saved_queries WHERE name LIKE ? ORDER BY name").all(`%${query}%`) : this.store.db.prepare("SELECT * FROM saved_queries ORDER BY name").all();
    return (rows as Array<Record<string, string>>).map(rowToQuery);
  }

  remove(nameOrId: string): boolean {
    return this.store.db.prepare("DELETE FROM saved_queries WHERE id=? OR name=?").run(nameOrId, nameOrId).changes > 0;
  }
}
