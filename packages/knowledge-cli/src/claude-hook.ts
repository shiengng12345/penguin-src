import type { CompactIndexStatus, ExplorePack, ExternalCallGroup } from "@penguin/knowledge-core";
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
  // "compact" (default): relations + signatures + file:line pointers, ≤2KB —
  // the agent pulls full source itself via knowledge_explore when it wants
  // it. "full": legacy verbatim source blocks (penguin hook ... --full).
  mode?: "compact" | "full";
}

export interface ClaudeHookDeps {
  /** `signal` aborts once the hook's own deadline passes — see runClaudeHook. */
  runPenguin(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
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
  // Cut on a code point, never mid-surrogate: slicing UTF-16 units can strip
  // the low half of an emoji or CJK-extension character, and the lone high
  // surrogate becomes U+FFFD once the hook output is encoded as UTF-8.
  const head = text.slice(0, maxChars - 1);
  const lastUnit = head.charCodeAt(head.length - 1);
  const safe = lastUnit >= 0xd800 && lastUnit <= 0xdbff ? head.slice(0, -1) : head;
  return `${safe}…`;
}

// Alternates, in priority order: grpc:: names, file paths, dotted symbols,
// routes, then BARE code identifiers — camelCase/PascalCase with an internal
// capital (buildStatusPanel, RepoStatusPanel) and snake_case with an
// underscore (resolve_branch_base). Plain prose words match neither bare
// form, and any false positive that still slips through resolves to an
// empty ExplorePack, which the compact renderer drops (see packHasSignal).
const PROMPT_TARGET_PATTERN = /\bgrpc::[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|proto)\b|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b|\/[A-Za-z0-9_./:{}-]+|\b[A-Za-z_$][a-z0-9$]*[A-Z][\w$]*\b|\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const COMMON_PROSE_DOTTED_TOKENS = new Set(["e.g", "i.e", "etc."]);

// Bare identifiers shorter than this are almost always prose or a variable
// name too generic to resolve ("user", "id", "cfg") — each one costs a DB
// query on the hook's 800ms budget for a result that gets filtered anyway.
const MIN_BARE_IDENTIFIER_LENGTH = 6;

export function selectPromptTargets(prompt: string): string[] {
  const matches = prompt.match(PROMPT_TARGET_PATTERN) ?? [];
  const useful = matches.filter((match) => {
    if (COMMON_PROSE_DOTTED_TOKENS.has(match)) return false;
    const bare = !/[.\/:]/.test(match);
    return !bare || match.length >= MIN_BARE_IDENTIFIER_LENGTH;
  });
  return [...new Set(useful)].slice(0, 4);
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

function briefTitles(items: Array<{ title: string }>, max: number): string {
  if (items.length === 0) return "none indexed";
  const titles = items.slice(0, max).map((item) => item.title).filter(Boolean);
  const extra = items.length > max ? ` (+${items.length - max} more)` : "";
  return `${titles.join(", ")}${extra}`;
}

// A pack with nothing resolved (no focus, no relations, no candidates) is a
// false-positive target — injecting "target=GitHub: not indexed" into every
// prompt that mentions a brand name is pure noise. Compact mode drops these.
export function packHasSignal(pack: ExplorePack): boolean {
  return Boolean(
    pack.focus
    || pack.sources.length > 0
    || pack.callers.length > 0
    || pack.calls.length > 0
    || (pack.renderedBy ?? []).length > 0
    || (pack.renders ?? []).length > 0
    || (pack.invokedDynamicallyBy ?? []).length > 0
    || (pack.invokesDynamic ?? []).length > 0
    || pack.blastRadius.length > 0
    // A sparse pack can still be worth injecting: a resolved call path or a
    // covering test means the target WAS found, just with few relations.
    // Diagnostics and staleness deliberately do NOT count on their own — an
    // unindexed prose word produces both ("not indexed", trust_unavailable)
    // and would put noise back into every prompt.
    || pack.callPath.length > 0
    || pack.tests.length > 0
    || (pack.ambiguousCandidates?.length ?? 0) > 0,
  );
}

// Head-of-implementation lines carried in compact mode. Twelve covers most
// small functions outright while leaving room for relations inside 2KB.
const COMPACT_FOCUS_LINES = 12;

function signatureLine(code: string): string {
  for (const line of code.split("\n")) {
    const trimmed = line.trim();
    // Skip punctuation-only lines (a stale index range can start on a bare
    // "}" when the file shifted under it) — a brace tells the agent nothing.
    if (trimmed && /[\p{L}\p{N}]/u.test(trimmed)) return truncate(trimmed, 160);
  }
  return "";
}

// Compact prompt injection: everything the agent needs to DECIDE (what this
// is, who touches it, where it lives) in ≤2KB, never the source bodies — the
// agent pulls those itself via knowledge_explore / `penguin explore` only
// when it actually needs them. Injecting full source into every prompt is
// what makes hook-based context expensive; pointers are almost always enough.
export function renderExploreHookCompact(
  target: string,
  pack: ExplorePack,
  maxChars = 2_000,
): string {
  // Ambiguous-only pack (nothing resolved, only candidates): one line, no
  // node ids. A prose word matching 18 symbols must not dump a candidate
  // table into every prompt; an agent that cares can explore a precise name.
  const resolvedNothing = !pack.focus && pack.sources.length === 0 && pack.callers.length === 0 && pack.calls.length === 0;
  if (resolvedNothing && pack.ambiguousCandidates?.length) {
    return truncate(
      `[Penguin] "${target}" is ambiguous (${pack.ambiguousCandidates.length} matches) — if relevant, call knowledge_explore with a more specific name.`,
      maxChars,
    );
  }
  const lines = [
    `[Penguin explore context] target=${target} (compact — full source: MCP knowledge_explore or \`penguin explore ${target}\`)`,
    `freshness=${pack.freshness.stale ? "stale" : "fresh"}${pack.freshness.reason ? ` reason=${pack.freshness.reason}` : ""}`,
  ];
  const focusSource = pack.sources.find((source) => source.role === "focus") ?? pack.sources[0];
  if (focusSource) {
    lines.push(`focus: ${focusSource.filePath}:${focusSource.startLine}-${focusSource.endLine}`);
    // Include the opening lines of the implementation, not just the
    // signature. A summary of shape ("who calls this") cannot answer "why
    // does this return the wrong value", and an agent that finds the context
    // plausible often will not spend a second tool call to fetch the body.
    // Head-of-body fits the budget and covers the common small function.
    const head = focusSource.code.split("\n").slice(0, COMPACT_FOCUS_LINES);
    const clipped = focusSource.code.split("\n").length > COMPACT_FOCUS_LINES;
    if (head.length > 0) {
      // The body is read from disk at the line range the INDEX recorded. With
      // a stale index those lines can have shifted, so the snippet may start
      // mid-declaration or show a neighbour. Say so rather than presenting
      // possibly-misaligned code as if it were verified.
      if (pack.freshness.stale) {
        lines.push("(index is stale — the line range below may have shifted; verify before editing)");
      }
      lines.push(
        `\`\`\`${focusSource.lang ?? "text"}`,
        head.join("\n"),
        clipped ? "… (truncated — knowledge_explore returns the full body)" : "",
        "```",
      );
    }
  }
  if (pack.callPath.length > 1) {
    lines.push(`call path: ${pack.callPath.slice(0, 8).map((step) => step.title).join(" → ")}`);
  }
  lines.push(`callers(${pack.callers.length}): ${briefTitles(pack.callers, 5)}; calls(${pack.calls.length}): ${briefTitles(pack.calls, 5)}`);
  const externalLine = externalCallsLine(pack);
  if (externalLine) lines.push(externalLine);
  const uiRelations = [
    ...(pack.renderedBy ?? []).map((item) => `rendered-by:${item.title}`),
    ...(pack.renders ?? []).map((item) => `renders:${item.title}`),
    ...(pack.invokedDynamicallyBy ?? []).map((item) => `dynamic-by:${item.title}`),
    ...(pack.invokesDynamic ?? []).map((item) => `invokes-dynamic:${item.title}`),
  ];
  if (uiRelations.length > 0) lines.push(`ui relations: ${truncate(uiRelations.join(", "), 300)}`);
  if (pack.blastRadius.length > 0) lines.push(`blast radius(${pack.blastRadius.length}): ${briefTitles(pack.blastRadius, 5)}`);
  if (pack.tests.length > 0) lines.push(`tests(${pack.tests.length}): ${briefTitles(pack.tests, 4)}`);
  const otherFiles = pack.sources
    .filter((source) => source !== focusSource)
    .slice(0, 4)
    .map((source) => `${source.filePath}:${source.startLine}-${source.endLine} (${source.role})`);
  if (otherFiles.length > 0) lines.push(`related files: ${otherFiles.join(", ")}`);
  if (pack.diagnostics.length > 0) lines.push(`diagnostics: ${truncate(pack.diagnostics.join("; "), 300)}`);
  if (pack.ambiguousCandidates?.length) {
    lines.push(
      "ambiguous candidates: "
      + pack.ambiguousCandidates.map((candidate) => `${candidate.title} [${candidate.nodeId}]`).join(", "),
    );
  }
  return truncate(lines.join("\n"), maxChars);
}

/** One compact line naming the packages the calls list could not follow into.
 * Sits directly under the callers/calls counts because that is the number it
 * corrects — in a 2KB budget a footer note gets cut, and the count alone reads
 * as the whole truth. */
function externalCallsLine(pack: { externalCalls?: ExternalCallGroup[] }): string | null {
  const groups = pack.externalCalls ?? [];
  if (groups.length === 0) return null;
  const count = groups.reduce((sum, group) => sum + group.callees.length, 0);
  const detail = groups
    .map((group) => `${group.specifier}(${group.callees.map((c) => c.callee).join(",")})`)
    .join("; ");
  return `+${count} unresolved external call(s) — calls list is incomplete: ${truncate(detail, 240)}`;
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
  const externalLine = externalCallsLine(pack);
  if (externalLine) lines.push(externalLine);
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
  const mode = options.mode ?? "compact";
  const timeoutMs = options.timeoutMs ?? (isSessionStart ? 800 : 800);
  const maxChars = options.maxChars ?? (isSessionStart ? 900 : mode === "compact" ? 2_000 : 6_000);
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
    // Abandoning the hook on timeout used to leave its explore queries running:
    // every subsequent prompt piled on another batch against the same SQLite
    // file. Signal cancellation so a slow query stops doing work the moment
    // its output can no longer be used.
    const controller = new AbortController();
    let packs: Array<{ target: string; pack: ExplorePack }>;
    try {
      packs = await within(
        Promise.all(targets.map(async (target) => {
          const pack = await deps.runPenguin(["explore", target, "--json"], timeoutMs, controller.signal) as ExplorePack;
          deps.markTargetSeen?.(target);
          return { target, pack };
        })),
        timeoutMs,
      );
    } finally {
      controller.abort();
    }
    const rendered = mode === "compact" ? packs.filter(({ pack }) => packHasSignal(pack)) : packs;
    return truncate(
      rendered
        .map(({ target, pack }) => mode === "compact"
          ? renderExploreHookCompact(target, pack, maxChars)
          : renderExploreHook(target, pack, {
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
