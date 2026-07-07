// Pure search logic for the installer's Sonatype fuzzy search — no Tauri
// imports so tests can transpile and exercise it directly in node:test.
import Fuse from "fuse.js";
import { protocolFromSnsoftPackageName } from "@penguin/core";

export interface RegistryPackage {
  name: string;
  latest_version: string;
  description: string | null;
  // dist-tags（项目标签，如 kyc-merge-account）——搜索按它命中
  tags: string[];
}

export type PackageProtocol = "grpc-web" | "grpc" | "sdk";

const RESULT_LIMIT = 50;

export function protocolOfPackage(name: string): PackageProtocol | null {
  return protocolFromSnsoftPackageName(name);
}

// Fuzzy filter over the fetched package list. protocol=null → all protocols.
// Empty query returns the (protocol-scoped) list head so the dropdown is
// browsable before the user types anything.
export function filterPackages(
  list: RegistryPackage[],
  query: string,
  protocol: PackageProtocol | null,
): RegistryPackage[] {
  const scoped = protocol
    ? list.filter((p) => protocolOfPackage(p.name) === protocol)
    : list;
  const q = query.trim();
  if (!q) return scoped.slice(0, RESULT_LIMIT);
  const fuse = new Fuse(scoped, {
    keys: [
      { name: "name", weight: 0.7 },
      { name: "tags", weight: 0.5 },
      { name: "description", weight: 0.15 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
  });
  return fuse.search(q, { limit: RESULT_LIMIT }).map((r) => r.item);
}

// 展示排序：命中 query 的 tag 排最前（用户要能看见「为什么匹配」并直接点它）。
// 高亮判断用词元子串——够准且便宜。
export function prioritizeTags(tags: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return tags;
  const tokens = q.split(/\s+/).filter(Boolean);
  const hit = (t: string) => tokens.some((tok) => t.toLowerCase().includes(tok));
  return [...tags.filter(hit), ...tags.filter((t) => !hit(t))];
}

export function tagMatchesQuery(tag: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  return q.split(/\s+/).filter(Boolean).some((tok) => tag.toLowerCase().includes(tok));
}
