import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";

export type DependencyScope =
  | "dependencies"
  | "devDependencies"
  | "optionalDependencies"
  | "peerDependencies";

export type DependencySource =
  | "package.json"
  | "pnpm-lock.yaml"
  | "indexed_dependency_repo";

export interface DependencySpec {
  name: string;
  specifier: string | null;
  scope: DependencyScope;
  resolvedVersion?: string;
  source: DependencySource;
}

export interface PackageDependencyEdge extends DependencySpec {
  from: string;
  to: string;
}

export interface PackageDependencyReport {
  packageName: string;
  dependencies: DependencySpec[];
  edges: PackageDependencyEdge[];
  lockfilePath: string | null;
  complete: boolean;
  gaps: string[];
}

interface LockEntry {
  specifier?: unknown;
  version?: unknown;
  optional?: unknown;
}

interface LockSnapshot {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface PnpmLock {
  importers?: Record<string, Record<string, Record<string, LockEntry> | undefined>>;
  snapshots?: Record<string, LockSnapshot>;
  packages?: Record<string, unknown>;
}

const DEPENDENCY_SCOPES: readonly DependencyScope[] = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stripPeerSuffix(version: string): string {
  const peerStart = version.indexOf("(");
  return peerStart === -1 ? version : version.slice(0, peerStart);
}

function packageNameFromRef(ref: string): string {
  const clean = ref.startsWith("/") ? ref.slice(1) : ref;
  const at = clean.lastIndexOf("@");
  if (at <= 0) return clean;
  return clean.slice(0, at);
}

function packageVersionFromRef(ref: string): string | undefined {
  const clean = ref.startsWith("/") ? ref.slice(1) : ref;
  const at = clean.lastIndexOf("@");
  if (at <= 0) return undefined;
  return stripPeerSuffix(clean.slice(at + 1));
}

function refMatches(name: string, version: string, ref: string): boolean {
  return packageNameFromRef(ref) === name && packageVersionFromRef(ref) === stripPeerSuffix(version);
}

function findSnapshotKey(lock: PnpmLock, name: string, version: string | undefined): string | undefined {
  if (!version) return undefined;
  const snapshots = lock.snapshots ?? {};
  return Object.keys(snapshots).find((key) => refMatches(name, version, key));
}

function entrySpecifier(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  return asString(asRecord(entry).specifier) ?? null;
}

function entryVersion(entry: unknown): string | undefined {
  if (typeof entry === "string") return stripPeerSuffix(entry);
  const version = asString(asRecord(entry).version);
  return version ? stripPeerSuffix(version) : undefined;
}

function readLockfile(rootPath: string): { path: string; lock: PnpmLock } | { path: string; error: string } | null {
  const path = join(rootPath, "pnpm-lock.yaml");
  if (!existsSync(path)) return null;
  try {
    return { path, lock: parseYaml(readFileSync(path, "utf8")) as PnpmLock };
  } catch (error) {
    return { path, error: `pnpm-lock.yaml could not be parsed: ${String(error)}` };
  }
}

function manifestDependencies(manifest: Record<string, unknown>): DependencySpec[] {
  const dependencies: DependencySpec[] = [];
  for (const scope of DEPENDENCY_SCOPES) {
    for (const [name, raw] of Object.entries(asRecord(manifest[scope]))) {
      dependencies.push({
        name,
        specifier: typeof raw === "string" ? raw : asString(asRecord(raw).specifier) ?? null,
        scope,
        source: "package.json",
      });
    }
  }
  return dependencies;
}

function importerFor(lock: PnpmLock, rootPath: string): Record<string, Record<string, LockEntry> | undefined> {
  const importers = lock.importers ?? {};
  const candidates = [".", basename(rootPath)];
  for (const candidate of candidates) {
    const importer = importers[candidate];
    if (importer) return importer;
  }
  return importers["."] ?? {};
}

function lockResolvedDependencies(
  rootPath: string,
  direct: DependencySpec[],
  lock: PnpmLock,
  gaps: string[],
): { dependencies: DependencySpec[]; edges: PackageDependencyEdge[] } {
  const importer = importerFor(lock, rootPath);
  const packageName = "__root__";
  const dependencies: DependencySpec[] = [];
  const edges: PackageDependencyEdge[] = [];
  const queue: Array<{ name: string; version?: string; depth: number }> = [];
  const visited = new Set<string>();

  for (const item of direct) {
    const lockEntry = asRecord(importer[item.scope])[item.name];
    const resolvedVersion = entryVersion(lockEntry);
    const merged: DependencySpec = {
      ...item,
      resolvedVersion,
      source: resolvedVersion ? "pnpm-lock.yaml" : "package.json",
    };
    dependencies.push(merged);
    edges.push({ from: packageName, to: item.name, ...merged });
    if (!resolvedVersion) {
      gaps.push(`No lockfile resolution for ${item.name}`);
      continue;
    }
    queue.push({ name: item.name, version: resolvedVersion, depth: 0 });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    const key = `${current.name}@${current.version ?? "unknown"}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const snapshotKey = findSnapshotKey(lock, current.name, current.version);
    const snapshot = snapshotKey ? lock.snapshots?.[snapshotKey] : undefined;
    if (!snapshot) {
      gaps.push(`No lockfile snapshot for ${key}`);
      continue;
    }

    const childEntries = {
      ...asRecord(snapshot.dependencies),
      ...asRecord(snapshot.optionalDependencies),
    };
    for (const [name, raw] of Object.entries(childEntries)) {
      const version = entryVersion(raw);
      const child: DependencySpec = {
        name,
        specifier: entrySpecifier(raw),
        scope: snapshot.optionalDependencies && name in snapshot.optionalDependencies
          ? "optionalDependencies"
          : "dependencies",
        resolvedVersion: version,
        source: version ? "pnpm-lock.yaml" : "package.json",
      };
      edges.push({ from: current.name, to: name, ...child });
      if (version) queue.push({ name, version, depth: current.depth + 1 });
      else gaps.push(`No lockfile resolution for ${current.name} -> ${name}`);
    }
  }

  return { dependencies, edges };
}

export function readPackageDependencies(rootPath: string): PackageDependencyReport | null {
  const packageJsonPath = join(rootPath, "package.json");
  if (!existsSync(packageJsonPath)) return null;

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }

  const packageName = asString(manifest.name) ?? basename(rootPath);
  const direct = manifestDependencies(manifest);
  const lockResult = readLockfile(rootPath);
  const gaps: string[] = [];

  if (!lockResult) {
    gaps.push("pnpm-lock.yaml not found; transitive dependency evidence is incomplete");
    return {
      packageName,
      dependencies: direct,
      edges: direct.map((dependency) => ({ from: "__root__", to: dependency.name, ...dependency })),
      lockfilePath: null,
      complete: false,
      gaps,
    };
  }

  if ("error" in lockResult) {
    gaps.push(lockResult.error);
    return {
      packageName,
      dependencies: direct,
      edges: direct.map((dependency) => ({ from: "__root__", to: dependency.name, ...dependency })),
      lockfilePath: lockResult.path,
      complete: false,
      gaps,
    };
  }

  const resolved = lockResolvedDependencies(rootPath, direct, lockResult.lock, gaps);
  const edges = resolved.edges.map((edge) => ({
    ...edge,
    from: edge.from === "__root__" ? packageName : edge.from,
  }));
  return {
    packageName,
    dependencies: resolved.dependencies,
    edges,
    lockfilePath: lockResult.path,
    complete: gaps.length === 0,
    gaps,
  };
}
