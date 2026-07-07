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
// Nexus 逐页爬列表首拉可达 10-30s——把结果落盘（app_kv），下次打开安装器
// 先秒出旧列表、后台刷新替换（stale-while-revalidate）。
const DISK_CACHE_KEY = "registry:pkg-list:v1";
let listCache: { at: number; list: RegistryPackage[] } | null = null;
const versionsCache = new Map<string, PackageVersions>();

// 读磁盘缓存（不管多旧）——调用方先展示它，再等 fetch 的新结果。
export async function loadCachedRegistryPackages(): Promise<RegistryPackage[] | null> {
  if (listCache) return listCache.list;
  try {
    const raw = await invoke<string | null>("db_get_app_value", { key: DISK_CACHE_KEY });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: number; list?: RegistryPackage[] };
    if (!Array.isArray(parsed.list)) return null;
    listCache = { at: parsed.at ?? 0, list: parsed.list };
    return parsed.list;
  } catch {
    return null;
  }
}

export async function fetchRegistryPackages(force = false): Promise<RegistryPackage[]> {
  if (!force && listCache && Date.now() - listCache.at < LIST_TTL_MS) {
    return listCache.list;
  }
  const list = await invoke<RegistryPackage[]>("registry_search_packages");
  listCache = { at: Date.now(), list };
  void invoke("db_set_app_value", {
    key: DISK_CACHE_KEY,
    value: JSON.stringify({ at: listCache.at, list }),
  }).catch(() => {
    // 落盘失败只是丢缓存加速，不影响功能
  });
  return list;
}

export async function fetchPackageVersions(name: string): Promise<PackageVersions> {
  const cached = versionsCache.get(name);
  if (cached) return cached;
  const result = await invoke<PackageVersions>("registry_package_versions", { name });
  versionsCache.set(name, result);
  return result;
}
