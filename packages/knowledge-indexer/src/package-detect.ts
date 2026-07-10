import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Package-level dependency detection for the cross-repo service graph.
 *
 * Detects:
 * 1. What npm packages a repo PUBLISHES (from package.json "name")
 * 2. What @snsoft packages a repo DEPENDS ON (from package.json "dependencies")
 * 3. For monorepos like ntshared and fly, discovers sub-packages
 */

export interface PackageInfo {
  /** npm package name (e.g. "@snsoft/player-grpc") */
  name: string;
  /** Repo id that publishes this package */
  repoId: string;
  /** @snsoft-scoped packages this repo/package depends on */
  dependencies: string[];
  /** Sub-package paths (for monorepos) */
  subPackages?: PackageInfo[];
}

/**
 * Read and parse a package.json file. Returns null if not found or unreadable.
 */
function readPackageJson(dir: string): Record<string, unknown> | null {
  const p = join(dir, "package.json");
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Extract @snsoft-scoped dependency names from a package.json.
 */
function snsoftDeps(pkg: Record<string, unknown>): string[] {
  const deps: Record<string, string> = (pkg.dependencies as Record<string, string>) ?? {};
  const dev: Record<string, string> = (pkg.devDependencies as Record<string, string>) ?? {};
  const all = { ...dev, ...deps }; // include devDeps — they still indicate a dependency
  return Object.keys(all).filter((k) => k.startsWith("@snsoft/"));
}

/**
 * Scan a repo for its published packages and dependencies.
 *
 * For monorepos with a packages/ directory, discovers each sub-package.
 * For the flyover proto monorepo, the packages are inferred from proto modules
 * and mapped to package names via the caller.
 */
export function detectPackages(
  rootPath: string,
  repoId: string,
): PackageInfo | null {
  const root = readPackageJson(rootPath);
  if (!root) return null;

  const pkgName = (root.name as string) ?? "";
  const deps = snsoftDeps(root);

  // Monorepo: scan packages/*/ sub-packages
  const packagesDir = join(rootPath, "packages");
  const subs: PackageInfo[] = [];
  if (existsSync(packagesDir)) {
    const names = readdirSync(packagesDir);
    for (const name of names) {
      const subDir = join(packagesDir, name);
      if (!statSync(subDir).isDirectory()) continue;
      const sub = readPackageJson(subDir);
      if (!sub) continue;
      const subName = (sub.name as string) ?? "";
      const subDeps = snsoftDeps(sub);
      subs.push({ name: subName, repoId, dependencies: subDeps });
    }
  }

  return { name: pkgName, repoId, dependencies: deps, subPackages: subs.length > 0 ? subs : undefined };
}

/**
 * For the flyover proto monorepo: generate @snsoft/<module>-grpc package names
 * from proto module names detected by the proto parser.
 */
export function flyoverPackageNames(protoModules: string[]): string[] {
  return protoModules.map((m) => {
    // Normalize: some modules have sub-paths (e.g. ccms/internal, telesales/packet)
    const name = m.replace(/\//g, "-");
    return `@snsoft/${name}-grpc`;
  });
}

/**
 * Build a global package→repo mapping from multiple indexed repos.
 * Key is the npm package name, value is the repoId that provides it.
 */
export type PackageRegistry = Map<string, string>;

export function buildPackageRegistry(
  packages: (PackageInfo | null)[],
  extraMappings?: Array<{ packageName: string; repoId: string }>,
): PackageRegistry {
  const map: PackageRegistry = new Map();

  for (const p of packages) {
    if (!p) continue;
    if (p.name) map.set(p.name, p.repoId);
    for (const sub of p.subPackages ?? []) {
      if (sub.name) map.set(sub.name, sub.repoId);
    }
  }

  for (const e of extraMappings ?? []) {
    map.set(e.packageName, e.repoId);
  }

  return map;
}
