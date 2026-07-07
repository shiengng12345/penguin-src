// Pure search logic for the installer's Sonatype fuzzy search — no Tauri
// imports so tests can transpile and exercise it directly in node:test.
import Fuse from "fuse.js";
import { protocolFromSnsoftPackageName } from "@penguin/core";

export interface RegistryPackage {
  name: string;
  latest_version: string;
  // 全部版本（含任意 tag）里构建时间最新者——「最近发布」排序/显示用它
  newest_version: string;
  description: string | null;
  // dist-tags（项目标签，如 kyc-merge-account）——搜索按它命中
  tags: string[];
}

export type PackageProtocol = "grpc-web" | "grpc" | "sdk";

const RESULT_LIMIT = 50;

// 构建时间戳双格式：14 位 YYYYMMDDHHMMSS（grpc 系）与
// ISO 风格 YYYY-MM-DDTHH-MM-SS（js-sdk 系）；无戳视为最旧。
function buildStampOf(version: string): number {
  const iso = version.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (iso) return Number(iso.slice(1, 7).join(""));
  const m = version.match(/(?:^|\D)(\d{14})(?!\d)/);
  return m ? Number(m[1]) : 0;
}

export function protocolOfPackage(name: string): PackageProtocol | null {
  return protocolFromSnsoftPackageName(name);
}

// Fuzzy filter over the fetched package list. protocols=null → 不过滤（含
// 未知后缀的包）；传数组 → 只留协议在集合内的包。Empty query returns the
// scoped list head so the dropdown is browsable before typing.
export function filterPackages(
  list: RegistryPackage[],
  query: string,
  protocols: readonly PackageProtocol[] | null,
): RegistryPackage[] {
  const scoped = protocols
    ? list.filter((p) => {
        const pr = protocolOfPackage(p.name);
        return pr !== null && protocols.includes(pr);
      })
    : list;
  const q = query.trim();
  // 浏览态（空 query）按发布时间新→旧——用户扫的是「最近上了什么」，
  // 按名排会让日期乱跳。
  if (!q) {
    return [...scoped]
      .sort(
        (a, b) =>
          buildStampOf(b.newest_version) - buildStampOf(a.newest_version) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, RESULT_LIMIT);
  }
  // tag 命中 = 前缀匹配（拍板：只允许「后模糊」——mast 中 master/master-dev，
  // 前面不通配，cicd-master 不命中）；包名/描述仍走 fuse 模糊。tag 命中优先。
  const ql = q.toLowerCase();
  const tagHits = scoped.filter((p) =>
    p.tags.some((t) => t.toLowerCase().startsWith(ql)),
  );
  const tagHitNames = new Set(tagHits.map((p) => p.name));
  const fuse = new Fuse(scoped, {
    keys: [
      { name: "name", weight: 0.8 },
      { name: "description", weight: 0.2 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
  });
  const nameHits = fuse
    .search(q, { limit: RESULT_LIMIT })
    .map((r) => r.item)
    .filter((p) => !tagHitNames.has(p.name));
  return [...tagHits, ...nameHits].slice(0, RESULT_LIMIT);
}

// 展示排序：前缀命中 query 的 tag 排最前（用户要能看见「为什么匹配」并直接点它）。
export function prioritizeTags(tags: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return tags;
  const hit = (t: string) => t.toLowerCase().startsWith(q);
  return [...tags.filter(hit), ...tags.filter((t) => !hit(t))];
}

// 固定 tag 浏览（如 master 页签）：带指定 dist-tag 的包，按协议过滤、按名排序。
export function packagesWithTag(
  list: RegistryPackage[],
  tag: string,
  protocol: PackageProtocol | null,
): RegistryPackage[] {
  return list
    .filter(
      (p) =>
        p.tags.includes(tag) &&
        (protocol === null || protocolOfPackage(p.name) === protocol),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function tagMatchesQuery(tag: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return tag.toLowerCase().startsWith(q);
}
