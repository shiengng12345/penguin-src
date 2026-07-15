import type { CompactIndexStatus } from "@penguin/knowledge-core";

export interface ClaudeHookOptions {
  event: "session-start" | "user-prompt-submit";
  prompt?: string;
  timeoutMs?: number;
  maxChars?: number;
}

export interface ClaudeHookDeps {
  runPenguin(args: string[], timeoutMs: number): Promise<unknown>;
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

export function selectPromptTarget(prompt: string): string | null {
  const patterns = [
    /\bgrpc::[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/,
    /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|proto)\b/,
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/,
    /\/[A-Za-z0-9_./:{}-]+/,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) return match[0];
  }
  return null;
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

export async function runClaudeHook(
  options: ClaudeHookOptions,
  deps: ClaudeHookDeps,
): Promise<string> {
  const isSessionStart = options.event === "session-start";
  const timeoutMs = options.timeoutMs ?? (isSessionStart ? 800 : 1_200);
  const maxChars = options.maxChars ?? (isSessionStart ? 900 : 1_800);
  try {
    if (isSessionStart) {
      const status = await within(
        deps.runPenguin(["status", "--compact", "--json"], timeoutMs),
        timeoutMs,
      ) as CompactIndexStatus;
      return renderSessionStart(status, maxChars);
    }
    const target = selectPromptTarget(options.prompt ?? "");
    if (!target) return "";
    const context = await within(
      deps.runPenguin(["context", target, "--json"], timeoutMs),
      timeoutMs,
    );
    return truncate(
      `[Penguin index context] target=${target}\n${JSON.stringify(context)}`,
      maxChars,
    );
  } catch {
    return truncate("[Penguin index context unavailable]", maxChars);
  }
}
