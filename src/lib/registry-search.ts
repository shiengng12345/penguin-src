// Tauri-invoke wrappers + caches for the installer's Sonatype search.
// The Rust side (registry_search.rs) owns credentials and endpoint fallback;
// this module only caches: the full package list is refetched at most every
// 5 minutes, packuments are cached per name for the session.
import { invoke } from "@tauri-apps/api/core";
import type { RegistryPackage } from "./registry-search-core";

export interface PackageVersions {
  versions: string[]; // Rust 侧已按构建时间戳新→旧排序
  latest: string | null;
}

const LIST_TTL_MS = 5 * 60_000;
let listCache: { at: number; list: RegistryPackage[] } | null = null;
const versionsCache = new Map<string, PackageVersions>();

export async function fetchRegistryPackages(force = false): Promise<RegistryPackage[]> {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.list;
  }
  const list = await invoke<RegistryPackage[]>("registry_search_packages");
  listCache = { at: Date.now(), list };
  return list;
}

export async function fetchPackageVersions(name: string): Promise<PackageVersions> {
  const cached = versionsCache.get(name);
  if (cached) return cached;
  const result = await invoke<PackageVersions>("registry_package_versions", { name });
  versionsCache.set(name, result);
  return result;
}
