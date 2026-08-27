export async function readBoundedHookInput(input, maxBytes = 64 * 1024) {
    const encoder = new TextEncoder();
    const chunks = [];
    let total = 0;
    for await (const chunk of input) {
        const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
        total += bytes.byteLength;
        if (total > maxBytes)
            return null;
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
function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    if (maxChars <= 1)
        return text.slice(0, maxChars);
    return `${text.slice(0, maxChars - 1)}…`;
}
export function selectPromptTarget(prompt) {
    const patterns = [
        /\bgrpc::[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/,
        /\b[A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|go|py|java|kt|proto)\b/,
        /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/,
        /\/[A-Za-z0-9_./:{}-]+/,
    ];
    for (const pattern of patterns) {
        const match = prompt.match(pattern);
        if (match)
            return match[0];
    }
    return null;
}
export function renderSessionStart(status, maxChars = 900) {
    const { summary } = status;
    const lines = [
        `[Penguin index context] repos=${summary.totalRepos} fresh=${summary.fresh} dirty=${summary.dirty} stale=${summary.stale} unknown=${summary.unknown} errors=${summary.errors}`,
        ...status.repos.map((repo) => `${repo.repo}:${repo.liveBranch ?? "—"}:${repo.freshness}`
            + `${repo.dirtyFileCount ? `:dirtyFiles=${repo.dirtyFileCount}` : ""}`),
    ];
    return truncate(lines.join("\n"), maxChars);
}
async function within(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("hook timeout")), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer !== undefined)
            clearTimeout(timer);
    }
}
export async function runClaudeHook(options, deps) {
    const isSessionStart = options.event === "session-start";
    const timeoutMs = options.timeoutMs ?? (isSessionStart ? 800 : 1_200);
    const maxChars = options.maxChars ?? (isSessionStart ? 900 : 1_800);
    try {
        if (isSessionStart) {
            const status = await within(deps.runPenguin(["status", "--compact", "--json"], timeoutMs), timeoutMs);
            return renderSessionStart(status, maxChars);
        }
        const target = selectPromptTarget(options.prompt ?? "");
        if (!target)
            return "";
        const context = await within(deps.runPenguin(["context", target, "--json"], timeoutMs), timeoutMs);
        return truncate(`[Penguin index context] target=${target}\n${JSON.stringify(context)}`, maxChars);
    }
    catch {
        return truncate("[Penguin index context unavailable]", maxChars);
    }
}
//# sourceMappingURL=claude-hook.js.map