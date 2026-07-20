import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/** Resolve workspace roots canonically so lexical traversal and symlink escapes cannot widen scope. */
export function parseWorkspaceRoots(value: string | undefined, fallback: string): string[] {
  const raw = (value ?? "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
  const candidates = raw.length > 0 ? raw : [fallback];
  return [...new Set(candidates.map(canonicalExistingPath).filter((item): item is string => item !== null))];
}

export function canonicalExistingPath(path: string): string | null {
  const absolute = isAbsolute(path) ? path : resolve(path);
  if (!existsSync(absolute)) return null;
  try { return realpathSync.native(absolute).replace(/\/+$/, "") || "/"; } catch { return null; }
}

export function canonicalPathForCheck(path: string): string {
  const existing = canonicalExistingPath(path);
  if (existing) return existing;
  let candidate = isAbsolute(path) ? resolve(path) : resolve(path);
  const suffix: string[] = [];
  while (!existsSync(candidate) && candidate !== dirname(candidate)) {
    suffix.unshift(basename(candidate));
    candidate = dirname(candidate);
  }
  const base = canonicalExistingPath(candidate) ?? candidate;
  return resolve(base, ...suffix).replace(/\/+$/, "") || "/";
}

export function isPathWithinWorkspace(path: string, roots: readonly string[]): boolean {
  const target = canonicalPathForCheck(path);
  return roots.some((root) => {
    const rest = relative(canonicalPathForCheck(root), target);
    return rest === "" || (!rest.startsWith(".." + "/") && rest !== ".." && !isAbsolute(rest));
  });
}

export function assertWorkspacePath(path: string, roots: readonly string[], label = "path"): string {
  const canonical = canonicalPathForCheck(path);
  if (!isPathWithinWorkspace(canonical, roots)) {
    throw new Error(`WORKSPACE_SCOPE_DENIED: ${label} is outside configured workspace roots`);
  }
  return canonical;
}
