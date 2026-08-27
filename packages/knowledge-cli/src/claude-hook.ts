import type { CompactIndexStatus, ExplorePack } from "@penguin/knowledge-core";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export interface ClaudeHookOptions {
  event: "session-start" | "user-prompt-submit";
  prompt?: string;
  timeoutMs?: number;
  maxChars?: number;
  sessionId?: string;
  seenTargets?: ReadonlySet<string>;
}

export interface ClaudeHookDeps {
  runPenguin(args: string[], timeoutMs: number): Promise<unknown>;
  markTargetSeen?(target: string): void;
}

export interface HookSessionState {
  path: string;
  targetHashes: Set<string>;
  updatedAt: number;
}

const HOOK_STATE_VERSION = 1;
const HOOK_STATE_TTL_MS = 24 * 60 * 60 * 1_000;
const HOOK_STATE_MAX_TARGETS = 128;

export function hashHookTarget(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function loadHookSessionState(
  stateDir: string | undefined,
  sessionId: string,
  now = Date.now(),
): HookSessionState {
  const path = stateDir ? join(stateDir, `${hashHookTarget(sessionId)}.json`) : "";
  const empty = { path, targetHashes: new Set<string>(), updatedAt: now };
  if (!path) return empty;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as {
      version?: unknown;
      sessionHash?: unknown;
      targetHashes?: unknown;
      updatedAt?: unknown;
    };
    if (
      value.version !== HOOK_STATE_VERSION
      || value.sessionHash !== hashHookTarget(sessionId)
      || !Array.isArray(value.targetHashes)
      || typeof value.updatedAt !== "number"
      || !Number.isFinite(value.updatedAt)
      || now - value.updatedAt > HOOK_STATE_TTL_MS
    ) return empty;
    const targetHashes = new Set(
      value.targetHashes
        .filter((hash): hash is string => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))
        .slice(-HOOK_STATE_MAX_TARGETS),
    );
    return { path, targetHashes, updatedAt: value.updatedAt };
  } catch {
    return empty;
  }
}

export function saveHookSessionState(
  stateDir: string | undefined,
  sessionId: string,
  state: HookSessionState,
  now = Date.now(),
): void {
  if (!stateDir || !sessionId) return;
  const path = state.path || join(stateDir, `${hashHookTarget(sessionId)}.json`);
  const temp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temp, JSON.stringify({
      version: HOOK_STATE_VERSION,
      sessionHash: hashHookTarget(sessionId),
      targetHashes: [...state.targetHashes].slice(-HOOK_STATE_MAX_TARGETS),
      updatedAt: now,
    }), { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    try { unlinkSync(temp); } catch { /* best effort cleanup */ }
  }
}

export async function readBoundedHookInput(
  input: AsyncIterable<string | Uint8Array>,
  maxBytes = 64 * 1024,
): Promise<string | null> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of input) {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    total += bytes.byteLength;
    if (total > maxBytes) return null;
    chunks.push(bytes);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return text.slice(0, maxChars);
  return `${text.slice(0, maxChars - 1)}…`;
}

const PROMPT_TARGET_PATTERN = /\bgrpc::[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|proto)\b|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\/[A-Za-z0-9_./:{}-]+/g;
const COMMON_PROSE_DOTTED_TOKENS = new Set(["e.g", "i.e", "etc."]);

export function selectPromptTargets(prompt: string): string[] {
  const matches = prompt.match(PROMPT_TARGET_PATTERN) ?? [];
  return [...new Set(matches.filter((match) => !COMMON_PROSE_DOTTED_TOKENS.has(match)))].slice(0, 4);
}

export function selectPromptTarget(prompt: string): string | null {
  return selectPromptTargets(prompt)[0] ?? null;
}

export function renderSessionStart(
  status: CompactIndexStatus,
  maxChars = 900,
): string {
  const { summary } = status;
  const lines = [
    `[Penguin index context] repos=${summary.totalRepos} fresh=${summary.fresh} dirty=${summary.dirty} stale=${summary.stale} unknown=${summary.unknown} errors=${summary.errors}`,
    ...status.repos.map(
      (repo) =>
        `${repo.repo}:${repo.liveBranch ?? "—"}:${repo.freshness}`
        + `${repo.dirtyFileCount ? `:dirtyFiles=${repo.dirtyFileCount}` : ""}`,
    ),
  ];
  return truncate(lines.join("\n"), maxChars);
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("hook timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function relationTitles(pack: ExplorePack, key: "callers" | "calls"): string {
  const titles = pack[key].map((item) => item.title).filter(Boolean);
  return titles.length > 0 ? titles.join(", ") : "none indexed";
}

export function renderExploreHook(
  target: string,
  pack: ExplorePack,
  options: { includeSource?: boolean; maxChars?: number } = {},
): string {
  const includeSource = options.includeSource !== false;
  const lines = [
    `[Penguin explore context] target=${target}`,
    `freshness=${pack.freshness.stale ? "stale" : "fresh"}${pack.freshness.reason ? ` reason=${pack.freshness.reason}` : ""}`,
    `relations: callers=${relationTitles(pack, "callers")}; calls=${relationTitles(pack, "calls")}`,
  ];
  const uiRelations = [
    ...(pack.renderedBy ?? []).map((item) => `rendered-by:${item.title}`),
    ...(pack.renders ?? []).map((item) => `renders:${item.title}`),
    ...(pack.invokedDynamicallyBy ?? []).map((item) => `dynamic-by:${item.title}`),
    ...(pack.invokesDynamic ?? []).map((item) => `invokes-dynamic:${item.title}`),
  ];
  if (uiRelations.length > 0) lines.push(`ui relations: ${uiRelations.join(", ")}`);
  if (pack.diagnostics.length > 0) lines.push(`diagnostics: ${pack.diagnostics.join("; ")}`);
  if (pack.ambiguousCandidates?.length) {
    lines.push(
      "ambiguous candidates: "
      + pack.ambiguousCandidates.map((candidate) => `${candidate.title} [${candidate.nodeId}]`).join(", "),
    );
  }
  if (includeSource) {
    for (const source of pack.sources) {
      lines.push(
        `\n[${source.role}] ${source.title} ${source.filePath}:${source.startLine}-${source.endLine}${source.truncated ? " [truncated]" : ""}`,
        `\`\`\`${source.lang ?? "text"}`,
        source.code,
        "```",
      );
    }
    if (pack.sources.length === 0) lines.push("source: unavailable; use the indexed relations above");
    if (pack.sourcesOmitted.length > 0) lines.push(`omitted: ${pack.sourcesOmitted.join("; ")}`);
  } else {
    lines.push("source: already provided for this session target; relations only");
  }
  return truncate(lines.join("\n"), options.maxChars ?? 6_000);
}

export async function runClaudeHook(
  options: ClaudeHookOptions,
  deps: ClaudeHookDeps,
): Promise<string> {
  const isSessionStart = options.event === "session-start";
  const timeoutMs = options.timeoutMs ?? (isSessionStart ? 800 : 800);
  const maxChars = options.maxChars ?? (isSessionStart ? 900 : 6_000);
  try {
    if (isSessionStart) {
      const status = await within(
        deps.runPenguin(["status", "--compact", "--json"], timeoutMs),
        timeoutMs,
      ) as CompactIndexStatus;
      return renderSessionStart(status, maxChars);
    }
    const targets = selectPromptTargets(options.prompt ?? "");
    if (targets.length === 0) return "";
    const packs = await within(
      Promise.all(targets.map(async (target) => {
        const pack = await deps.runPenguin(["explore", target, "--json"], timeoutMs) as ExplorePack;
        deps.markTargetSeen?.(target);
        return { target, pack };
      })),
      timeoutMs,
    );
    return truncate(
      packs
        .map(({ target, pack }) => renderExploreHook(target, pack, {
          includeSource: !options.seenTargets?.has(target),
          maxChars,
        }))
        .join("\n\n"),
      maxChars,
    );
  } catch {
    return truncate("[Penguin index context unavailable]", maxChars);
  }
}
