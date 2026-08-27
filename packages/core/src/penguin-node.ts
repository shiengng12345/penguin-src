// Node-only helpers for the ~/.penguin tree, shared by the knowledge CLI and
// (progressively) the MCP server — exported via the "@penguin/core/node"
// subpath so the browser bundle never sees node:fs. These were previously
// copy-pasted per consumer (CLI mirrored mcp/{config,penguin-paths,runners}),
// and the copies had already drifted; this module is the single home.
// TODO(follow-up): migrate packages/mcp/src/{config,penguin-paths,runners}
// onto these helpers too — they carry extra surface (ensurePackageDir, SLS
// targets) that needs its own pass.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export type PenguinProtocol = "grpc-web" | "grpc" | "sdk";

export function penguinRoot(): string {
  const home = homedir();
  const next = join(home, ".penguin");
  const legacy = join(home, ".pengvi");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

export interface PenguinEnvironmentEntry {
  name: string;
  color?: string;
  variables: Record<string, string>;
}

export function penguinConfigPath(): string | null {
  const home = homedir();
  const candidates = [
    join(home, ".penguin", "config.json"),
    join(home, ".penguin.config.json"),
    join(home, ".pengvi.config.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function readPenguinEnvironments(protocol: PenguinProtocol): PenguinEnvironmentEntry[] {
  const path = penguinConfigPath();
  if (!path) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as Partial<
      Record<PenguinProtocol, { environments?: PenguinEnvironmentEntry[] }>
    >;
    return cfg[protocol]?.environments ?? [];
  } catch {
    return [];
  }
}

/** Exact name first, then case-insensitive — one rule everywhere. */
export function findPenguinEnvironment(
  protocol: PenguinProtocol,
  name: string,
): PenguinEnvironmentEntry | null {
  const envs = readPenguinEnvironments(protocol);
  return (
    envs.find((e) => e.name === name) ??
    envs.find((e) => e.name.toLowerCase() === name.toLowerCase()) ??
    null
  );
}

export function penguinModulesDir(protocol: PenguinProtocol): string {
  return join(penguinRoot(), protocol, "node_modules");
}

export function installedSnsoftPackages(protocol: PenguinProtocol): string[] {
  const dir = join(penguinModulesDir(protocol), "@snsoft");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry: string) => !entry.startsWith("."))
    .map((entry: string) => `@snsoft/${entry}`);
}

// Same entry resolution as the MCP server's makeLoadModule (runners.ts):
// package.json `module` wins over `main`, defaulting to index.js.
export async function loadInstalledModule(
  protocol: PenguinProtocol,
  packageName: string,
): Promise<Record<string, unknown>> {
  const dir = join(penguinModulesDir(protocol), packageName);
  if (!existsSync(dir)) {
    throw new Error(`Package ${packageName} not installed for ${protocol} (looked in ${dir})`);
  }
  const pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
    main?: string;
    module?: string;
  };
  const entry = join(dir, pkgJson.module ?? pkgJson.main ?? "index.js");
  if (!existsSync(entry)) {
    throw new Error(`Entry point ${entry} missing for ${packageName}`);
  }
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}
