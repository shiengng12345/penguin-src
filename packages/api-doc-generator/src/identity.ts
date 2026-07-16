import { createHash } from "node:crypto";
import type { DocumentationRequest, DocumentationRevision, DocumentationRequestValidation } from "./types.js";

const SUBJECT_KEYS = new Set(["repo", "service", "method", "route"]);
const REVISION_KEYS = new Set(["branch", "branches", "commitSha", "commits", "targetId", "deployedAt"]);
function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = sorted((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}
export function canonicalJson(input: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("canonical JSON does not accept non-finite numbers");
    if (value === undefined) throw new Error("canonical JSON does not accept undefined");
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("canonical JSON does not accept cyclic objects");
    seen.add(value);
    const result = Array.isArray(value) ? value.map(walk) : Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, walk((value as Record<string, unknown>)[key])]));
    seen.delete(value);
    return result;
  };
  return JSON.stringify(walk(sorted(input)));
}
function digest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function unknownKeys(value: Record<string, unknown>, allowed: Set<string>, path: string): Array<{ path: string; code: string; message: string }> {
  return Object.keys(value).filter((key) => !allowed.has(key)).map((key) => ({ path: `${path}.${key}`, code: "unknown_key", message: `Unknown property: ${key}` }));
}
function validLanguage(language: string): boolean { try { new Intl.Locale(language); return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language); } catch { return false; } }
export function validateDocumentationRequest(input: unknown): DocumentationRequestValidation {
  const errors: Array<{ path: string; code: string; message: string }> = [];
  if (!input || typeof input !== "object") return { ok: false, errors: [{ path: "", code: "type", message: "request must be an object" }] };
  const value = input as Record<string, unknown>;
  errors.push(...unknownKeys(value, new Set(["subjects", "revision", "audience", "language", "mode", "includeRuntimeEvidence", "runtimeScope"]), "request"));
  if (!Array.isArray(value.subjects) || value.subjects.length === 0) errors.push({ path: "subjects", code: "empty", message: "at least one subject is required" });
  else value.subjects.forEach((subject, i) => {
    if (!subject || typeof subject !== "object") errors.push({ path: `subjects[${i}]`, code: "type", message: "subject must be an object" });
    else {
      errors.push(...unknownKeys(subject as Record<string, unknown>, SUBJECT_KEYS, `subjects[${i}]`));
      if (!Object.values(subject as Record<string, unknown>).some((item) => typeof item === "string" && item.trim())) errors.push({ path: `subjects[${i}]`, code: "empty", message: "subject needs repo, service, method, or route" });
    }
  });
  if (!value.revision || typeof value.revision !== "object") errors.push({ path: "revision", code: "type", message: "revision is required" });
  else errors.push(...unknownKeys(value.revision as Record<string, unknown>, REVISION_KEYS, "revision"));
  if (!["frontend", "backend", "operations"].includes(String(value.audience))) errors.push({ path: "audience", code: "enum", message: "audience must be frontend, backend, or operations" });
  if (typeof value.language !== "string" || !validLanguage(value.language)) errors.push({ path: "language", code: "language", message: "language must be a BCP-47 tag" });
  if (!["preview", "draft", "sync"].includes(String(value.mode))) errors.push({ path: "mode", code: "enum", message: "mode must be preview, draft, or sync" });
  if (typeof value.includeRuntimeEvidence !== "boolean") errors.push({ path: "includeRuntimeEvidence", code: "type", message: "includeRuntimeEvidence must be boolean" });
  if (value.includeRuntimeEvidence === true && (!value.runtimeScope || typeof value.runtimeScope !== "object")) errors.push({ path: "runtimeScope", code: "required", message: "runtimeScope is required when runtime evidence is enabled" });
  if (value.runtimeScope && typeof value.runtimeScope === "object") {
    errors.push(...unknownKeys(value.runtimeScope as Record<string, unknown>, new Set(["targetIds", "from", "to", "clues"]), "runtimeScope"));
    if (!Date.parse(String((value.runtimeScope as Record<string, unknown>).from)) || !Date.parse(String((value.runtimeScope as Record<string, unknown>).to))) errors.push({ path: "runtimeScope", code: "time", message: "runtimeScope requires valid from/to times" });
  }
  const subjects = Array.isArray(value.subjects) ? value.subjects as DocumentationRequest["subjects"] : [];
  const revision = (value.revision && typeof value.revision === "object" ? value.revision : {}) as DocumentationRequest["revision"];
  if (subjects.length > 1 && revision.commitSha && !revision.commits) errors.push({ path: "revision.commitSha", code: "ambiguous", message: "multiple repositories require revision.commits" });
  if (subjects.length > 1 && revision.branch && !revision.branches) errors.push({ path: "revision.branch", code: "ambiguous", message: "multiple repositories require revision.branches" });
  if (errors.length) return { ok: false, errors };
  return { ok: true, request: { subjects: subjects.map((s) => ({ ...s })), revision: { ...revision }, audience: String(value.audience).toLowerCase() as DocumentationRequest["audience"], language: String(value.language), mode: value.mode as DocumentationRequest["mode"], includeRuntimeEvidence: value.includeRuntimeEvidence as boolean, ...(value.runtimeScope ? { runtimeScope: value.runtimeScope as DocumentationRequest["runtimeScope"] } : {}) }, errors: [] };
}
export function createDocumentKey(request: DocumentationRequest): string { return `api-doc:v1:${request.audience}:${request.language.toLowerCase()}:${digest({ subjects: [...request.subjects].map((s) => sorted(s)).sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))), audience: request.audience, language: request.language.toLowerCase() }).slice(0, 16)}`; }
export function createRevisionSetHash(revisions: DocumentationRevision[]): string { return digest([...revisions].sort((a, b) => a.repoId.localeCompare(b.repoId)).map(({ repoId, repo, commitSha, snapshotId, worktreeFingerprint, trust }) => { if (trust === "exact_worktree" && !worktreeFingerprint) throw new Error(`exact_worktree revision ${repoId} requires worktreeFingerprint`); return { repoId, repo, commitSha, ...(snapshotId ? { snapshotId } : {}), ...(worktreeFingerprint ? { worktreeFingerprint } : {}) }; })); }
export function createScenarioId(input: { endpointKey: string; kind: "request" | "response"; partitions: string[]; preconditions: string[] }): string { return `scenario:${input.kind}:${digest({ endpointKey: input.endpointKey, partitions: [...input.partitions].sort(), preconditions: [...input.preconditions].sort() }).slice(0, 24)}`; }
