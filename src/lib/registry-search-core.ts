// Pure search logic for the installer's Sonatype fuzzy search — no Tauri
// imports so tests can transpile and exercise it directly in node:test.
import Fuse from "fuse.js";
import { protocolFromSnsoftPackageName } from "@penguin/core";

export interface RegistryPackage {
  name: string;
  latest_version: string;
  description: string | null;
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
      { name: "name", weight: 0.8 },
      { name: "description", weight: 0.2 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
  });
  return fuse.search(q, { limit: RESULT_LIMIT }).map((r) => r.item);
}
