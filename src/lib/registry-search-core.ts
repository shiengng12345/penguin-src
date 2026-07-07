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
  // 全部版本（新到旧）；JS-SDK 没有 branch 语义，所以列表按版本展开。
  versions?: string[];
  dist_tags?: Record<string, string>;
}

export type PackageProtocol = "grpc-web" | "grpc" | "sdk";
export type PackageProtocolFilter = PackageProtocol | "all";

export interface PackageResultRow extends RegistryPackage {
  protocol: PackageProtocol;
  branch: string;
  version: string;
  install_tag: string;
}

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

function newestFirst(a: RegistryPackage, b: RegistryPackage): number {
  return (
    buildStampOf(b.newest_version) - buildStampOf(a.newest_version) ||
    a.name.localeCompare(b.name)
  );
}

function rowNewestFirst(a: PackageResultRow, b: PackageResultRow): number {
  return (
    buildStampOf(b.version) - buildStampOf(a.version) ||
    a.name.localeCompare(b.name) ||
    a.branch.localeCompare(b.branch)
  );
}

function barePackageName(name: string): string {
  return name.replace(/^@snsoft\//, "");
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/@snsoft\//g, "").replace(/[^a-z0-9]/g, "");
}

function packageStem(name: string, protocol: PackageProtocol): string {
  const bare = barePackageName(name);
  if (protocol === "grpc-web") return bare.replace(/-grpc-web$/, "");
  if (protocol === "grpc") return bare.replace(/-grpc$/, "");
  return bare.replace(/-sdk$/, "");
}

function packageAliases(row: Pick<PackageResultRow, "name" | "protocol">): string[] {
  const bare = barePackageName(row.name);
  return Array.from(new Set([
    normalizeSearchText(packageStem(row.name, row.protocol)),
    normalizeSearchText(bare),
  ])).filter(Boolean);
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

function fuzzyTokenMatches(query: string, target: string): boolean {
  const q = normalizeSearchText(query);
  const t = normalizeSearchText(target);
  if (!q) return true;
  if (!t) return false;
  if (q === t) return true;
  const coverage = q.length / t.length;
  if ((t.startsWith(q) || t.includes(q) || isSubsequence(q, t)) && coverage >= 0.6) {
    return true;
  }
  return false;
}

function removeFirst(value: string, part: string): string {
  const i = value.indexOf(part);
  if (i < 0) return value;
  return `${value.slice(0, i)}${value.slice(i + part.length)}`;
}

function packageMatches(row: PackageResultRow, queryKey: string): boolean {
  return packageAliases(row).some((alias) => fuzzyTokenMatches(queryKey, alias));
}

function branchPackageMatches(row: PackageResultRow, queryKey: string): boolean {
  const branchKey = normalizeSearchText(row.branch);
  const aliases = packageAliases(row);

  if (branchKey && queryKey.includes(branchKey)) {
    const rest = removeFirst(queryKey, branchKey);
    return rest.length === 0 || aliases.some((alias) => fuzzyTokenMatches(rest, alias));
  }

  for (const alias of aliases) {
    if (queryKey.includes(alias)) {
      const rest = removeFirst(queryKey, alias);
      return rest.length === 0 || (branchKey.length > 0 && fuzzyTokenMatches(rest, branchKey));
    }
  }

  return branchKey.length > 0 && fuzzyTokenMatches(queryKey, branchKey);
}

function hasHiddenPackageSegment(name: string): boolean {
  return barePackageName(name).split(/[^a-z0-9]+/i).some((part) => part.toLowerCase() === "coco");
}

function isResolvedVersion(version: string | undefined): boolean {
  const value = version?.trim() ?? "";
  return value.length > 0 && value !== "...";
}

function sortedResolvedVersions(pkg: RegistryPackage): string[] {
  const versions = (pkg.versions ?? [])
    .map((v) => v.trim())
    .filter(isResolvedVersion);
  const unique = Array.from(new Set(versions));
  unique.sort((a, b) => buildStampOf(b) - buildStampOf(a) || b.localeCompare(a));
  if (unique.length > 0) return unique;
  return [pkg.newest_version, pkg.latest_version].filter(isResolvedVersion);
}

function rowsForPackage(pkg: RegistryPackage): PackageResultRow[] {
  if (hasHiddenPackageSegment(pkg.name)) return [];
  const protocol = protocolOfPackage(pkg.name);
  if (!protocol) return [];
  if (!isResolvedVersion(pkg.latest_version) && !isResolvedVersion(pkg.newest_version)) return [];

  if (protocol === "sdk") {
    return sortedResolvedVersions(pkg).map((version) => ({
      ...pkg,
      protocol,
      branch: "",
      version,
      install_tag: version,
    }));
  }

  if (pkg.tags.length === 0) {
    const version = pkg.newest_version || pkg.latest_version;
    return [{ ...pkg, protocol, branch: "", version, install_tag: version }];
  }

  return pkg.tags.map((tag) => ({
    ...pkg,
    protocol,
    branch: tag,
    version: pkg.dist_tags?.[tag] ?? pkg.newest_version,
    install_tag: tag,
  }));
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
      .sort(newestFirst)
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

export function filterPackageRows(
  list: RegistryPackage[],
  filters: {
    query: string;
    // 独立的 branch 过滤条件（不是全局选中分支）——子串命中 row.branch。
    // 空则不过滤；与 query / protocol 是 AND 关系。SDK 行无 branch，
    // 一旦有 branch 过滤即被排除。
    branch?: string;
    protocol: PackageProtocolFilter;
  },
): PackageResultRow[] {
  const branchQuery = (filters.branch ?? "").trim().toLowerCase();
  const scoped = list
    .flatMap(rowsForPackage)
    .filter((pkg) => filters.protocol === "all" || pkg.protocol === filters.protocol)
    // 分支匹配 = 前缀（拍板）：`replace-pulsar-with-temporal` 只命中以它
    // 开头的分支；`origin-edmond-replace-...` 不以它开头，排除。部分输入
    // （mast → master）仍可用。命中后纯按构建时间新→旧排，最新在最上面。
    .filter((pkg) => !branchQuery || pkg.branch.toLowerCase().startsWith(branchQuery));

  const query = filters.query.trim();
  if (!query) {
    return [...scoped].sort(rowNewestFirst).slice(0, RESULT_LIMIT);
  }

  const queryKey = normalizeSearchText(query);
  const structuredHits = scoped.filter((row) => branchPackageMatches(row, queryKey));
  if (structuredHits.length > 0) {
    return structuredHits.sort(rowNewestFirst).slice(0, RESULT_LIMIT);
  }

  return scoped
    .filter((row) => packageMatches(row, queryKey))
    .sort(rowNewestFirst)
    .slice(0, RESULT_LIMIT);
}

// 包家族前缀（去掉协议后缀）：player-grpc-web / player-grpc / player-grpc-json
// → player；js-sdk → js-sdk。用于搜索包名的自动补全建议。
function familyOf(name: string): string {
  const bare = barePackageName(name);
  // 只剥 gRPC 系后缀；SDK 仅 js-sdk 一个包（无 xxx-sdk 家族），保留原名
  return bare.replace(/-(grpc-web|grpc-json|grpc)$/, "");
}

// 从已拉取列表提取去重的包家族前缀，按 query 过滤（前缀命中优先），供
// 搜索包名的自动补全下拉使用。空 query 返回全部家族（字典序）。
export function suggestPackageStems(
  list: RegistryPackage[],
  query: string,
  limit = 8,
): string[] {
  const q = query.trim().toLowerCase();
  const set = new Set<string>();
  for (const pkg of list) {
    const fam = familyOf(pkg.name);
    if (fam) set.add(fam);
  }
  let stems = Array.from(set);
  if (q) {
    stems = stems.filter((s) => s.toLowerCase().includes(q));
    stems.sort((a, b) => {
      const ap = a.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.localeCompare(b);
    });
  } else {
    stems.sort((a, b) => a.localeCompare(b));
  }
  return stems.slice(0, limit);
}

export function isPackageRowInstalled(
  row: Pick<PackageResultRow, "name" | "version"> | undefined,
  packages: Array<{ name: string; version: string }>,
): boolean {
  if (!row) return false;
  return packages.some((pkg) => pkg.name === row.name && pkg.version === row.version);
}

export function buildPackageSpec(name: string, versionOrTag: string): string {
  const version = versionOrTag.trim() || "latest";
  return `${name.trim()}@${version}`;
}

export function completePackageSpec(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return trimmed.lastIndexOf("@") > 0 ? trimmed : buildPackageSpec(trimmed, "latest");
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
