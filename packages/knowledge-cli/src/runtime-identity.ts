import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface RuntimeNativeDependency {
  name: string;
  version: string;
  path: string;
  sha256: string;
  status: "ready" | "unavailable" | "mismatch";
}

export interface RuntimeIdentity {
  appVersion: string;
  buildId: string;
  capabilityHash: string;
  schemaVersion: number;
  modelHash: string;
  contractVersion: string;
  runtimeRoot: string;
  nodeVersion: string;
  platform: string;
  architecture: string;
  nativeDependencies: RuntimeNativeDependency[];
  signing: { status: "signed" | "unsigned" | "unknown"; identity?: string; notarized?: boolean };
  generation: {
    runningBuildId: string;
    availableBuildId: string;
    outdated: boolean;
    restartRequired: boolean;
  };
}

type RuntimeManifest = {
  buildId?: unknown;
  appVersion?: unknown;
  capabilityHash?: unknown;
  contractSchemaVersion?: unknown;
  contractVersion?: unknown;
  modelHash?: unknown;
  nodePath?: unknown;
  nativeDependencies?: unknown;
  signing?: unknown;
};

function runtimeRootFromEnv(): string {
  return process.env.PENGUIN_RUNTIME_ROOT?.trim() || join(homedir(), ".penguin", "runtimes");
}

export function readRuntimeManifest(runtimeRoot = runtimeRootFromEnv()): RuntimeManifest | null {
  const candidates = [join(runtimeRoot, "manifest.json"), join(runtimeRoot, "current", "manifest.json")];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as RuntimeManifest;
      if (parsed && typeof parsed === "object" && typeof parsed.buildId === "string" && parsed.buildId) return parsed;
    } catch {
      // A missing or atomically replaced manifest is a truthful unknown state.
    }
  }
  return null;
}

function sha256File(path: string): string {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return ""; }
}

function nativeDependencies(manifest: RuntimeManifest | null, runtimeRoot: string): RuntimeNativeDependency[] {
  const currentRoot = resolve(runtimeRoot, "current");
  if (Array.isArray(manifest?.nativeDependencies)) {
    return manifest.nativeDependencies.flatMap((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const value = raw as Record<string, unknown>;
      const relative = typeof value.path === "string" ? value.path : "";
      const absolute = relative && !relative.startsWith("/") ? resolve(currentRoot, relative) : relative;
      const expected = typeof value.sha256 === "string" ? value.sha256 : "";
      const actual = absolute ? sha256File(absolute) : "";
      const status = !absolute || !existsSync(absolute)
        ? "unavailable"
        : expected && actual !== expected
          ? "mismatch"
          : "ready";
      return [{
        name: typeof value.name === "string" ? value.name : "unknown",
        version: typeof value.version === "string" ? value.version : "unknown",
        path: absolute || relative,
        sha256: actual || expected,
        status: status as RuntimeNativeDependency["status"],
      }];
    });
  }
  const relative = typeof manifest?.nodePath === "string" && manifest.nodePath ? manifest.nodePath : "node";
  const nodePath = resolve(currentRoot, relative);
  const hash = sha256File(nodePath);
  return [{
    name: "node",
    version: process.versions.node,
    path: nodePath,
    sha256: hash,
    status: existsSync(nodePath) ? "ready" : "unavailable",
  }];
}

function signing(manifest: RuntimeManifest | null): RuntimeIdentity["signing"] {
  const value = manifest?.signing;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const status = record.status === "signed" || record.status === "unsigned" || record.status === "unknown" ? record.status : "unknown";
    return {
      status,
      ...(typeof record.identity === "string" ? { identity: record.identity } : {}),
      ...(typeof record.notarized === "boolean" ? { notarized: record.notarized } : {}),
    };
  }
  const status = process.env.PENGUIN_SIGNING_STATUS;
  return { status: status === "signed" || status === "unsigned" ? status : "unknown" };
}

export function runtimeIdentity(options: {
  runtimeRoot?: string;
  manifest?: RuntimeManifest | null;
  runningBuildId?: string | null;
  availableBuildId?: string | null;
  outdated?: boolean;
} = {}): RuntimeIdentity {
  const runtimeRoot = options.runtimeRoot ?? runtimeRootFromEnv();
  const manifest = options.manifest === undefined ? readRuntimeManifest(runtimeRoot) : options.manifest;
  const runningBuildId = options.runningBuildId || process.env.PENGUIN_BUILD_ID || (typeof manifest?.buildId === "string" ? manifest.buildId : "local");
  const availableBuildId = options.availableBuildId || (typeof manifest?.buildId === "string" ? manifest.buildId : runningBuildId);
  const outdated = options.outdated ?? runningBuildId !== availableBuildId;
  const capabilityHash = typeof manifest?.capabilityHash === "string" && manifest.capabilityHash
    ? manifest.capabilityHash
    : process.env.PENGUIN_CAPABILITY_HASH || "unknown";
  const schemaValue = Number(manifest?.contractSchemaVersion ?? process.env.PENGUIN_SCHEMA_VERSION ?? 18);
  return {
    appVersion: typeof manifest?.appVersion === "string" ? manifest.appVersion : process.env.PENGUIN_APP_VERSION || "unknown",
    buildId: runningBuildId,
    capabilityHash,
    schemaVersion: Number.isInteger(schemaValue) && schemaValue > 0 ? schemaValue : 18,
    modelHash: typeof manifest?.modelHash === "string" && manifest.modelHash
      ? manifest.modelHash
      : process.env.PENGUIN_MODEL_HASH || "unknown",
    contractVersion: typeof manifest?.contractVersion === "string" ? manifest.contractVersion : "2",
    runtimeRoot,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    nativeDependencies: nativeDependencies(manifest, runtimeRoot),
    signing: signing(manifest),
    generation: { runningBuildId, availableBuildId, outdated, restartRequired: outdated },
  };
}
