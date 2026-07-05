// Sprint 10 Phase 10A — REST module FE-side persistence.
//
// Phase 10A uses app_kv-backed JSON blobs keyed by project so we can ship
// the UI shell + iterate fast. Phase 10B+ swaps to dedicated SQLite tables
// + Tauri commands (rest_collections / rest_requests / etc. — backend
// tables already exist in db.rs from T10A.1).
//
// Migration from blob → table happens at first-time entry to REST module
// (DEC #198 — idempotent copy migration with version flag).

import { logger } from "@/lib/logger";
import { getPersistedValue, setPersistedValue } from "@/lib/app-persistence";
import type {
  RestCollection,
  RestEnvVar,
  RestEnvironment,
  RestProject,
  RestRequestRecord,
} from "./rest-types";

const LOG_SCOPE = "rest-storage";

const KEYS = {
  projects: "penguin-rest-projects",
  environments: "penguin-rest-environments",
  collections: "penguin-rest-collections",
  requests: "penguin-rest-requests",
  envVars: "penguin-rest-env-vars",
  migrationVersion: "penguin-rest-migration-version",
} as const;

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function loadList<T>(key: string): T[] {
  const raw = getPersistedValue(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as T[];
  } catch (error) {
    logger.warn(LOG_SCOPE, `loadList — invalid JSON for ${key}`, { error: String(error) });
    return [];
  }
}

function saveList<T>(key: string, items: T[]): void {
  setPersistedValue(key, JSON.stringify(items));
}

// ---- Projects ----

export function loadProjects(): RestProject[] {
  return loadList<RestProject>(KEYS.projects);
}

export function createProject(payload: { name: string }): RestProject {
  const project: RestProject = {
    id: newId("proj"),
    name: payload.name.trim(),
    createdAt: Date.now(),
  };
  const list = loadProjects();
  list.push(project);
  saveList(KEYS.projects, list);
  return project;
}

export function renameProject(payload: { id: string; name: string }): RestProject[] {
  const list = loadProjects().map((p) =>
    p.id === payload.id ? { ...p, name: payload.name.trim() } : p,
  );
  saveList(KEYS.projects, list);
  return list;
}

export function deleteProject(payload: { id: string }): RestProject[] {
  // Cascade delete child environments / collections / requests / env vars.
  const projects = loadProjects().filter((p) => p.id !== payload.id);
  saveList(KEYS.projects, projects);
  const envs = loadEnvironments().filter((e) => e.projectId !== payload.id);
  saveList(KEYS.environments, envs);
  const collections = loadCollections().filter((c) => c.projectId !== payload.id);
  saveList(KEYS.collections, collections);
  const collectionIds = new Set(collections.map((c) => c.id));
  const requests = loadRequests().filter((r) => collectionIds.has(r.collectionId));
  saveList(KEYS.requests, requests);
  return projects;
}

// ---- Environments ----

export function loadEnvironments(): RestEnvironment[] {
  return loadList<RestEnvironment>(KEYS.environments);
}

export function createEnvironment(payload: { projectId: string; name: string }): RestEnvironment {
  const env: RestEnvironment = {
    id: newId("env"),
    projectId: payload.projectId,
    name: payload.name.trim(),
  };
  const list = loadEnvironments();
  list.push(env);
  saveList(KEYS.environments, list);
  return env;
}

export function renameEnvironment(payload: { id: string; name: string }): RestEnvironment[] {
  const list = loadEnvironments().map((e) =>
    e.id === payload.id ? { ...e, name: payload.name.trim() } : e,
  );
  saveList(KEYS.environments, list);
  return list;
}

export function deleteEnvironment(payload: { id: string }): RestEnvironment[] {
  // Detach collections from this env (set envId=null) so requests aren't lost.
  const envs = loadEnvironments().filter((e) => e.id !== payload.id);
  saveList(KEYS.environments, envs);
  const collections = loadCollections().map((c) =>
    c.envId === payload.id ? { ...c, envId: null } : c,
  );
  saveList(KEYS.collections, collections);
  return envs;
}

// ---- Collections ----

export function loadCollections(): RestCollection[] {
  return loadList<RestCollection>(KEYS.collections);
}

export function createCollection(payload: {
  projectId: string;
  envId: string | null;
  name: string;
}): RestCollection {
  const now = Date.now();
  const collection: RestCollection = {
    id: newId("col"),
    projectId: payload.projectId,
    envId: payload.envId,
    parentId: null,
    name: payload.name.trim(),
    createdAt: now,
    updatedAt: now,
  };
  const list = loadCollections();
  list.push(collection);
  saveList(KEYS.collections, list);
  return collection;
}

export function renameCollection(payload: { id: string; name: string }): RestCollection[] {
  const list = loadCollections().map((c) =>
    c.id === payload.id ? { ...c, name: payload.name.trim(), updatedAt: Date.now() } : c,
  );
  saveList(KEYS.collections, list);
  return list;
}

export function deleteCollection(payload: { id: string }): RestCollection[] {
  const collections = loadCollections().filter((c) => c.id !== payload.id);
  saveList(KEYS.collections, collections);
  const requests = loadRequests().filter((r) => r.collectionId !== payload.id);
  saveList(KEYS.requests, requests);
  return collections;
}

// ---- Requests ----

export function loadRequests(): RestRequestRecord[] {
  return loadList<RestRequestRecord>(KEYS.requests);
}

export function createRequest(payload: { collectionId: string; name: string }): RestRequestRecord {
  const now = Date.now();
  const record: RestRequestRecord = {
    id: newId("req"),
    collectionId: payload.collectionId,
    name: payload.name.trim() || "New Request",
    method: "GET",
    url: "",
    headers: [],
    queryParams: [],
    followRedirects: true,
    createdAt: now,
    updatedAt: now,
  };
  const list = loadRequests();
  list.push(record);
  saveList(KEYS.requests, list);
  return record;
}

export function upsertRequest(record: RestRequestRecord): RestRequestRecord[] {
  const list = loadRequests();
  const idx = list.findIndex((r) => r.id === record.id);
  const stamped = { ...record, updatedAt: Date.now() };
  if (idx >= 0) list[idx] = stamped;
  else list.push(stamped);
  saveList(KEYS.requests, list);
  return list;
}

export function deleteRequest(payload: { id: string }): RestRequestRecord[] {
  const list = loadRequests().filter((r) => r.id !== payload.id);
  saveList(KEYS.requests, list);
  return list;
}

// ---- Env vars ----

export function loadEnvVars(): RestEnvVar[] {
  return loadList<RestEnvVar>(KEYS.envVars);
}

export function upsertEnvVar(envVar: RestEnvVar): RestEnvVar[] {
  const list = loadEnvVars();
  const idx = list.findIndex((v) => v.id === envVar.id);
  const stamped = { ...envVar, updatedAt: Date.now() };
  if (idx >= 0) list[idx] = stamped;
  else list.push(stamped);
  saveList(KEYS.envVars, list);
  return list;
}

export function deleteEnvVar(id: string): RestEnvVar[] {
  const list = loadEnvVars().filter((v) => v.id !== id);
  saveList(KEYS.envVars, list);
  return list;
}

// ---- Migration ----

export function getMigrationVersion(): number {
  const raw = getPersistedValue(KEYS.migrationVersion);
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function setMigrationVersion(v: number): void {
  setPersistedValue(KEYS.migrationVersion, String(v));
}
