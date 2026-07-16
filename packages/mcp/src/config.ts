// Reads the user's .penguin config — the source of truth for environments
// (per-protocol URL, X_ENV_TAG, TOKEN, etc.) and declared package specs.
// Probes the same locations the desktop's read_config command does, minus the
// Tauri-resource paths (those only exist inside the bundled app).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Protocol } from "./penguin-paths.js";

export interface EnvironmentEntry {
  name: string;
  color?: string;
  variables: Record<string, string>;
}

export interface ProtocolSection {
  environments?: EnvironmentEntry[];
  packages?: string[];
}

export interface SlsTargetConfig {
  targetId: string;
  environment: string;
  aliases?: string[];
  regionId: string;
  project: string;
  logstore: string;
  services?: string[];
  enabled?: boolean;
  source?: "config" | "verified_discovery" | "user_supplied";
}

export interface PenguinConfig {
  grpc?: ProtocolSection;
  "grpc-web"?: ProtocolSection;
  sdk?: ProtocolSection;
  sls?: { targets?: SlsTargetConfig[] };
}

export function configPath(): string | null {
  const home = homedir();
  const candidates = [
    join(home, ".penguin", "config.json"),
    join(home, ".penguin.config.json"),
    join(home, ".pengvi.config.json"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export function readConfig(): PenguinConfig {
  const path = configPath();
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as PenguinConfig;
  } catch {
    return {};
  }
}

export function getSection(
  cfg: PenguinConfig,
  protocol: Protocol,
): ProtocolSection {
  return cfg[protocol] ?? {};
}

export function findEnvironment(
  cfg: PenguinConfig,
  protocol: Protocol,
  envName: string,
): EnvironmentEntry | null {
  const envs = getSection(cfg, protocol).environments ?? [];
  return envs.find((e) => e.name === envName) ?? null;
}
