import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// A stdio MCP server is launched once by the client and lives for the whole
// session. When the desktop app updates, the code on disk changes underneath
// that running process — but the process keeps serving the OLD build until
// the client happens to restart it, and MCP has no protocol signal for
// "server is outdated" (only tools/list_changed, which means something else).
//
// The app writes the active runtime manifest LAST when it stages a new
// generation, so the manifest's buildId is a READY marker: seeing a
// different buildId than the one recorded at startup means a complete newer
// generation exists on disk. We stat the manifest (cheap, one file, no
// watcher) per tool call rather than fs.watch — a watcher would fire on
// partially-copied trees and cannot be made atomic across many files.
//
// Detection is intentionally sticky: once outdated, stay outdated until the
// process is replaced. Restarting is the CLIENT's job (Claude Code's MCP UI
// / Codex restart); a stdio server that exits on its own is not reconnected
// automatically and would take every tool in the session down with it.

export interface GenerationManifest {
  buildId: string;
  appVersion?: string;
  syncedAt?: string;
}

export interface GenerationState {
  /** buildId observed when this process started; null when no manifest existed. */
  startupBuildId: string | null;
  /** Latest buildId seen on disk (updated by checkGeneration). */
  currentBuildId: string | null;
  /** Sticky: set once a newer complete generation is observed. */
  outdated: boolean;
  /** App version carried by the newer manifest, for the user-facing message. */
  newAppVersion: string | null;
  /** Whether this session already attached the notice to a tool result. */
  noticeDelivered: boolean;
}

export function generationRoot(): string {
  return process.env.PENGUIN_RUNTIME_ROOT?.trim() || join(homedir(), ".penguin", "mcp");
}

export function manifestPath(root = generationRoot()): string {
  return join(root, "manifest.json");
}

function generationPath(path: string, buildId: string): string {
  const root = dirname(path);
  const versioned = join(root, buildId);
  if (existsSync(versioned)) return versioned;
  return join(root, "generations", buildId);
}

export function readGenerationManifest(path: string): GenerationManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as GenerationManifest;
    return typeof parsed?.buildId === "string" && parsed.buildId ? parsed : null;
  } catch {
    // Missing (dev runs, pre-1.16.2 installs) or mid-write — treated as "no
    // new information", never as an update signal.
    return null;
  }
}

export function createGenerationState(path = manifestPath()): GenerationState {
  const manifest = readGenerationManifest(path);
  return {
    startupBuildId: manifest?.buildId ?? null,
    currentBuildId: manifest?.buildId ?? null,
    outdated: false,
    newAppVersion: null,
    noticeDelivered: false,
  };
}

/**
 * Keep the generation used by this long-lived process alive. The desktop app
 * may publish several newer generations while an AI client keeps this stdio
 * process open; a lease prevents cleanup from deleting the files this process
 * still executes. Missing/legacy layouts remain best-effort and never block
 * startup.
 */
export function acquireGenerationLease(path: string, buildId: string | null, pid = process.pid): string | null {
  if (!buildId) return null;
  const lease = join(generationPath(path, buildId), ".leases", `${pid}.lease`);
  try {
    mkdirSync(dirname(lease), { recursive: true });
    writeFileSync(lease, `${new Date().toISOString()}\n`, { flag: "w" });
    return lease;
  } catch {
    return null;
  }
}

export function releaseGenerationLease(lease: string | null): void {
  if (!lease) return;
  try { unlinkSync(lease); } catch { /* already removed or legacy layout */ }
}

/**
 * Cheap per-tool-call check. Stats the manifest first and only re-reads it
 * when the mtime moved, so the steady-state cost is one stat().
 */
export function checkGeneration(
  state: GenerationState,
  path = manifestPath(),
  lastMtimeMs = { value: -1 },
): GenerationState {
  if (state.outdated) return state; // sticky — no further disk work
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return state;
  }
  if (mtimeMs === lastMtimeMs.value) return state;
  lastMtimeMs.value = mtimeMs;
  const manifest = readGenerationManifest(path);
  if (!manifest) return state;
  state.currentBuildId = manifest.buildId;
  // A server that started with no manifest (dev run, or installed before
  // generations existed) must not claim to be outdated the first time one
  // appears — that first manifest may describe the very build it is running.
  if (state.startupBuildId && manifest.buildId !== state.startupBuildId) {
    state.outdated = true;
    state.newAppVersion = manifest.appVersion ?? null;
  }
  return state;
}

export function generationNotice(state: GenerationState): string | null {
  if (!state.outdated) return null;
  const version = state.newAppVersion ? ` (app ${state.newAppVersion})` : "";
  return `Penguin was updated on disk${version}. This MCP server process is still running the previous build — restart the Penguin MCP server in your client to pick it up.`;
}

/** `_meta` payload attached to every tool result while outdated. */
export function generationMeta(state: GenerationState): Record<string, unknown> | null {
  if (!state.outdated) return null;
  return {
    "penguin/serverOutdated": true,
    "penguin/runningBuildId": state.startupBuildId,
    "penguin/availableBuildId": state.currentBuildId,
    ...(state.newAppVersion ? { "penguin/availableAppVersion": state.newAppVersion } : {}),
  };
}

/** Stable top-level fields for clients that ignore MCP `_meta`. */
export function generationAction(state: GenerationState): Record<string, unknown> | null {
  if (!state.outdated) return null;
  return {
    code: "OUTDATED_RUNTIME",
    message: generationNotice(state),
    action: "restart_mcp_session",
    runningBuildId: state.startupBuildId,
    availableBuildId: state.currentBuildId,
  };
}
