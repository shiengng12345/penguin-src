// Shared Node.js sidecar plumbing for everything that shells out of the
// webview: gRPC native calls, SDK calls, npm, lark-cli.
//
// Login shells are expensive — `zsh -l` re-sources .zprofile (nvm/volta/fnm
// init) on every spawn, which costs hundreds of ms per request. We pay that
// price once to resolve the absolute node path, cache it for the session,
// and run all subsequent sidecar scripts through a plain (non-login) zsh.
// If the cached path goes stale (node upgraded/removed mid-session, exit
// 127), we re-resolve through a login shell and retry once.
import { Command } from "@tauri-apps/plugin-shell";

// Single source of truth — previously duplicated in package-manager.ts and
// vault-lark.ts (Sprint 4 DEC #115 / Sprint 5 DEC #126).
export const NODE_PATH_SETUP = [
  'export NVM_DIR="$HOME/.nvm"',
  '[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
  // 业务原因：source nvm.sh 只加载函数；不激活版本时 ~/.nvm/versions/node/<v>/bin 不在 PATH，nvm 安装的工具（如 lark-cli / npm）找不到。
  'command -v nvm >/dev/null 2>&1 && (nvm use default >/dev/null 2>&1 || nvm use node >/dev/null 2>&1) || true',
  'export VOLTA_HOME="$HOME/.volta"',
  'export PATH="$VOLTA_HOME/bin:$HOME/.fnm:/opt/homebrew/bin:/usr/local/bin:$PATH"',
  'command -v fnm >/dev/null 2>&1 && eval "$(fnm env 2>/dev/null)"',
  // 业务原因：npm install -g 若配了自定义 prefix（npm config set prefix …），全局 bin
  // 不在上面任何路径里（如 ~/.npm-global/bin）。直接问 npm 拿全局 prefix，覆盖所有安装方式。
  'command -v npm >/dev/null 2>&1 && export PATH="$(npm prefix -g)/bin:$PATH" || true',
].join("; ");

export interface SidecarResult {
  stdout: string;
  stderr: string;
  code: number;
}

let cachedNodePath: string | null = null;
let resolveInFlight: Promise<string | null> | null = null;

async function resolveNodePathViaLoginShell(): Promise<string | null> {
  try {
    const out = await Command.create("node-path", [
      "-l",
      "-c",
      `${NODE_PATH_SETUP}; command -v node`,
    ]).execute();
    const path = out.stdout.trim().split("\n").pop()?.trim() ?? "";
    return out.code === 0 && path.startsWith("/") ? path : null;
  } catch {
    return null;
  }
}

// Resolve (and cache) the absolute node path. Concurrent callers share one
// login-shell resolution instead of each spawning their own.
export async function getNodePath(): Promise<string | null> {
  if (cachedNodePath) return cachedNodePath;
  if (!resolveInFlight) {
    resolveInFlight = resolveNodePathViaLoginShell().finally(() => {
      resolveInFlight = null;
    });
  }
  const resolved = await resolveInFlight;
  if (resolved) cachedNodePath = resolved;
  return resolved;
}

// Test hook / manual invalidation (e.g. after the user changes node managers).
export function invalidateNodePathCache(): void {
  cachedNodePath = null;
}

function encodeScript(script: string): string {
  return btoa(unescape(encodeURIComponent(script)));
}

// `exec` replaces the shell with node, so the spawned pid IS node — killing
// it on abort actually stops the request instead of orphaning a node child
// behind a dead zsh pipeline.
function nodeEvalShellScript(b64: string, nodeInvocation: string, login: boolean): string {
  const run = `exec ${nodeInvocation} -e "$(printf %s '${b64}' | base64 -d)"`;
  return login ? `${NODE_PATH_SETUP}; ${run}` : run;
}

async function runShell(args: string[], signal?: AbortSignal): Promise<SidecarResult> {
  const cmd = args[0] === "-l"
    ? Command.create("node-eval-login", args)
    : Command.create("node-eval", args);
  let stdout = "";
  let stderr = "";
  cmd.stdout.on("data", (d: string) => { stdout += d; });
  cmd.stderr.on("data", (d: string) => { stderr += d; });

  return new Promise<SidecarResult>((resolve, reject) => {
    let settled = false;
    let removeAbortListener = () => {};
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      removeAbortListener();
      fn();
    };

    cmd.on("close", (ev: { code: number | null }) =>
      settle(() => resolve({ stdout, stderr, code: ev.code ?? 0 })),
    );
    cmd.on("error", (err: unknown) =>
      settle(() => resolve({ stdout, stderr: stderr + String(err), code: 1 })),
    );

    cmd
      .spawn()
      .then((child) => {
        if (!signal) return;
        const onAbort = () => {
          settle(() => {
            child.kill().catch(() => {});
            reject(new DOMException("Request cancelled", "AbortError"));
          });
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort);
        removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      })
      .catch((err) => settle(() => resolve({ stdout, stderr: String(err), code: 1 })));
  });
}

// Run a Node script through the sidecar. The optional signal kills the node
// process on abort. Matches @penguin/core's SidecarRunner signature when the
// signal is bound via closure.
export async function runNodeScript(script: string, signal?: AbortSignal): Promise<SidecarResult> {
  const b64 = encodeScript(script);

  const nodePath = await getNodePath();
  if (nodePath) {
    const result = await runShell(
      ["-c", nodeEvalShellScript(b64, JSON.stringify(nodePath), false)],
      signal,
    );
    // 127 = command not found: the cached path went stale. Re-resolve below.
    if (result.code !== 127) return result;
    invalidateNodePathCache();
  }

  // Fallback: full login shell + node-manager activation, node from PATH.
  return runShell(["-l", "-c", nodeEvalShellScript(b64, "node", true)], signal);
}
