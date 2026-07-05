// Mirrors Penguin desktop's package layout under ~/.penguin/. The MCP server
// reads the same directories so any package the user installed via the Penguin
// UI is immediately discoverable from AI tools — no extra wiring.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Protocol = "grpc-web" | "grpc" | "sdk";

export function penguinRoot(): string {
  // Prefer the new ~/.penguin location, but fall back to the legacy ~/.pengvi
  // tree if the user hasn't launched the renamed desktop app yet (the Tauri
  // side runs migrate_legacy_pengvi_dir() on first launch to mv the tree).
  // Lets MCP work immediately after the rename without requiring the desktop
  // app to be opened first.
  const home = homedir();
  const newDir = join(home, ".penguin");
  const oldDir = join(home, ".pengvi");
  if (existsSync(newDir)) return newDir;
  if (existsSync(oldDir)) return oldDir;
  return newDir;
}

export function protocolDir(protocol: Protocol): string {
  return join(penguinRoot(), protocol);
}

// Materialize ~/.penguin/<protocol>/ so npm has somewhere to install into.
// Mirrors the Tauri `ensure_packages_dir` command — same package.json shape
// and .npmrc copy logic — so the directory is interchangeable between the
// desktop app and the MCP server.
export function ensurePackageDir(protocol: Protocol): string {
  const dir = protocolDir(protocol);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const pkgJson = join(dir, "package.json");
  if (!existsSync(pkgJson)) {
    writeFileSync(
      pkgJson,
      JSON.stringify(
        { name: "penguin-packages", version: "1.0.0", private: true },
        null,
        2,
      ),
    );
  }

  // True mirror of ~/.npmrc, matching the Rust `mirror_npmrc` semantics:
  // refresh when the global copy changes (registry settings now live in
  // ~/.npmrc, so a copy-once snapshot would keep stale credentials), and
  // drop the local snapshot when the global file is gone.
  const localNpmrc = join(dir, ".npmrc");
  const globalNpmrc = join(homedir(), ".npmrc");
  try {
    if (existsSync(globalNpmrc)) {
      const globalContent = readFileSync(globalNpmrc);
      const localContent = existsSync(localNpmrc) ? readFileSync(localNpmrc) : null;
      if (localContent === null || !globalContent.equals(localContent)) {
        copyFileSync(globalNpmrc, localNpmrc);
      }
    } else if (existsSync(localNpmrc)) {
      unlinkSync(localNpmrc);
    }
  } catch {
    // Non-fatal: the install will use the global config directly.
  }

  return dir;
}

// List @snsoft/* packages installed under a protocol's node_modules.
// Returns each package's resolved directory + version string from its
// package.json. Silent on missing dirs (fresh install with no packages yet).
export function listInstalledPackages(protocol: Protocol): Array<{
  name: string;
  version: string;
  dir: string;
}> {
  const nodeModules = join(protocolDir(protocol), "node_modules", "@snsoft");
  if (!existsSync(nodeModules)) return [];

  const out: Array<{ name: string; version: string; dir: string }> = [];
  for (const entry of readdirSync(nodeModules)) {
    const dir = join(nodeModules, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const pkgJsonPath = join(dir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        name?: string;
        version?: string;
      };
      out.push({
        name: pkg.name ?? `@snsoft/${entry}`,
        version: pkg.version ?? "unknown",
        dir,
      });
    } catch {
      // Skip unreadable entries — broken installs shouldn't block discovery.
    }
  }
  return out;
}
