// Tauri-invoke wrappers + caches for the installer's Sonatype search.
// The Rust side (registry_search.rs) owns credentials and endpoint fallback;
// this module only caches: the full package list is refetched at most every
// 5 minutes, packuments are cached per name for the session.
import { invoke } from "@tauri-apps/api/core";
import type { RegistryPackage } from "./registry-search-core";

export interface PackageVersions {
  versions: string[]; // Rust 侧已按构建时间戳新→旧排序
  latest: string | null;
  tags: Record<string, string>; // tag → 解析版本（含 latest）
}

// 团队高频 publish：缓存只做「秒开第一屏」，每次打开都后台实时重爬替换；
// 版本/tag（点包之后）永远实时拉、绝不缓存——刚 publish 的立刻可见。
const DISK_CACHE_KEY = "registry:pkg-list:v5"; // v5: 客户端包白名单过滤（丢弃含后端包的旧缓存）
let memoryList: RegistryPackage[] | null = null;
let inflight: Promise<RegistryPackage[]> | null = null;

// 读缓存（内存 → 磁盘，不管多旧）——调用方先展示它，再等实时结果替换。
export async function loadCachedRegistryPackages(): Promise<RegistryPackage[] | null> {
  if (memoryList) return memoryList;
  try {
    const raw = await invoke<string | null>("db_get_app_value", { key: DISK_CACHE_KEY });
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { list?: RegistryPackage[] };
    if (!Array.isArray(parsed.list)) return null;
    memoryList = parsed.list;
    return parsed.list;
  } catch {
    return null;
  }
}

// 永远走网络；普通打开会复用进行中的同一请求，手动刷新可强制开新请求。
export async function fetchRegistryPackages(
  options: { force?: boolean } = {},
): Promise<RegistryPackage[]> {
  if (inflight && !options.force) return inflight;
  const request = invoke<RegistryPackage[]>("registry_search_packages")
    .then((list) => {
      memoryList = list;
      void invoke("db_set_app_value", {
        key: DISK_CACHE_KEY,
        value: JSON.stringify({ at: Date.now(), list }),
      }).catch(() => {
        // 落盘失败只是丢缓存加速，不影响功能
      });
      return list;
    })
    .finally(() => {
      if (inflight === request) inflight = null;
    });
  if (!options.force) inflight = request;
  return request;
}

// 不缓存：版本/tag 必须是 publish 后立刻可见的实时数据。
export async function fetchPackageVersions(name: string): Promise<PackageVersions> {
  return invoke<PackageVersions>("registry_package_versions", { name });
}
