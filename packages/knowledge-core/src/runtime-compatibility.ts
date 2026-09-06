import type { KnowledgeStore } from "./store.js";
import { SCHEMA_VERSION } from "./schema.js";

export type RuntimeIndexCompatibility =
  | { state: "compatible"; compatible: true; code: null; runtimeSchemaVersion: number; indexedSchemaVersion: number; remediation: null }
  | { state: "not_indexed"; compatible: false; code: "INDEX_NOT_READY"; runtimeSchemaVersion: number; indexedSchemaVersion: null; remediation: "penguin index" }
  | { state: "schema_outdated"; compatible: false; code: "SCHEMA_OUTDATED"; runtimeSchemaVersion: number; indexedSchemaVersion: number; remediation: "penguin index" };

export class RuntimeIndexCompatibilityError extends Error {
  readonly code = "SCHEMA_OUTDATED";
  readonly retryable = false;
  readonly remediation = "penguin index";
  readonly details: { branchId: string; runtimeSchemaVersion: number; indexedSchemaVersion: number };

  constructor(branchId: string, state: Extract<RuntimeIndexCompatibility, { state: "schema_outdated" }>) {
    super(`knowledge index schema is outdated for branch ${branchId} (indexed=${state.indexedSchemaVersion}, runtime=${state.runtimeSchemaVersion}); the owner must run penguin index`);
    this.name = "RuntimeIndexCompatibilityError";
    this.details = { branchId, runtimeSchemaVersion: state.runtimeSchemaVersion, indexedSchemaVersion: state.indexedSchemaVersion };
  }
}

/** Canonical runtime-versus-branch index compatibility used by every surface. */
export function runtimeIndexCompatibility(store: KnowledgeStore, branchId: string): RuntimeIndexCompatibility {
  const row = store.db.prepare(
    "SELECT indexed_schema_version AS indexedSchemaVersion FROM branches WHERE id=?",
  ).get(branchId) as { indexedSchemaVersion: number | null } | undefined;
  const indexedSchemaVersion = row?.indexedSchemaVersion ?? null;
  if (indexedSchemaVersion == null) {
    return { state: "not_indexed", compatible: false, code: "INDEX_NOT_READY", runtimeSchemaVersion: SCHEMA_VERSION, indexedSchemaVersion: null, remediation: "penguin index" };
  }
  if (indexedSchemaVersion !== SCHEMA_VERSION) {
    return { state: "schema_outdated", compatible: false, code: "SCHEMA_OUTDATED", runtimeSchemaVersion: SCHEMA_VERSION, indexedSchemaVersion, remediation: "penguin index" };
  }
  return { state: "compatible", compatible: true, code: null, runtimeSchemaVersion: SCHEMA_VERSION, indexedSchemaVersion, remediation: null };
}

export function assertRuntimeIndexCompatible(store: KnowledgeStore, branchId: string): RuntimeIndexCompatibility {
  const state = runtimeIndexCompatibility(store, branchId);
  if (state.state === "schema_outdated") throw new RuntimeIndexCompatibilityError(branchId, state);
  return state;
}
