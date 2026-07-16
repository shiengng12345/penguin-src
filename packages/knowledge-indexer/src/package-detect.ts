import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  readPackageDependencies,
  type DependencySpec,
  type PackageDependencyEdge,
} from "./package-dependencies.js";

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
  /** Manifest dependencies for this repo/package. */
  dependencies: DependencySpec[];
  /** Direct and lockfile-resolved transitive dependency edges. */
  dependencyEdges: PackageDependencyEdge[];
  /** Sub-package paths (for monorepos) */
  subPackages?: PackageInfo[];
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
  const root = readPackageDependencies(rootPath);
  if (!root) return null;

  // Monorepo: scan packages/*/ sub-packages
  const packagesDir = join(rootPath, "packages");
  const subs: PackageInfo[] = [];
  if (existsSync(packagesDir)) {
    const names = readdirSync(packagesDir);
    for (const name of names) {
      const subDir = join(packagesDir, name);
      if (!statSync(subDir).isDirectory()) continue;
      const sub = readPackageDependencies(subDir);
      if (!sub) continue;
      subs.push({
        name: sub.packageName,
        repoId,
        dependencies: sub.dependencies,
        dependencyEdges: sub.edges,
      });
    }
  }

  return {
    name: root.packageName,
    repoId,
    dependencies: root.dependencies,
    dependencyEdges: root.edges,
    subPackages: subs.length > 0 ? subs : undefined,
  };
}

// Every proto module is codegen'd into FOUR published package variants
// (confirmed on disk: fly/apps/<module>/{output-grpc,output-grpc-json,
// output-grpc-web,output-grpc-web-coco}/package.json, each with a matching
// "name" field) — a consumer can depend on any of the four, and all four are
// genuinely published BY the flyover repo.
const FLYOVER_PACKAGE_SUFFIXES = ["grpc", "grpc-json", "grpc-web", "grpc-web-coco"];

/**
 * For the flyover proto monorepo: generate @snsoft/<module>-{grpc,grpc-json,
 * grpc-web,grpc-web-coco} package names from proto module names detected by
 * the proto parser — flyover is the provider of all four variants.
 */
export function flyoverPackageNames(protoModules: string[]): string[] {
  const names: string[] = [];
  for (const m of protoModules) {
    // Normalize: some modules have sub-paths (e.g. ccms/internal, telesales/packet)
    const name = m.replace(/\//g, "-");
    for (const suffix of FLYOVER_PACKAGE_SUFFIXES) {
      names.push(`@snsoft/${name}-${suffix}`);
    }
  }
  return names;
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
