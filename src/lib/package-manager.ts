import { invoke } from "@tauri-apps/api/core";
import { isAllowedSnsoftPackageSpec } from "@penguin/core";
import { NODE_PATH_SETUP } from "./sidecar";
import type { ProtocolTab, InstalledPackage } from "./store";

interface RawProtoFile {
  name: string;
  path: string;
  content: string;
}

interface RawInstalledPackage {
  name: string;
  version: string;
  protos: RawProtoFile[];
}

export async function ensurePackagesDir(
  protocol: ProtocolTab
): Promise<string> {
  return invoke<string>("ensure_packages_dir", { protocol });
}

export async function getPackagesDir(protocol: ProtocolTab): Promise<string> {
  return invoke<string>("get_packages_dir", { protocol });
}

export async function listInstalledPackages(
  protocol: ProtocolTab
): Promise<InstalledPackage[]> {
  const raw = await invoke<RawInstalledPackage[]>("list_installed_packages", {
    protocol,
  });

  const { parseProtoContent, parseSdkDts } = await import("@penguin/core");

  return raw.map((pkg) => {
    const files = pkg.protos.map((p) => ({ name: p.name, content: p.content }));
    const services =
      protocol === "sdk" ? parseSdkDts(files) : parseProtoContent(files);
    return {
      name: pkg.name,
      version: pkg.version,
      protoFiles: pkg.protos.map((p) => p.name),
      services,
    };
  });
}

const INSTALL_TIMEOUT_MS = 300_000;

async function shellCmd(script: string, cwd: string) {
  const { Command } = await import("@tauri-apps/plugin-shell");
  return Command.create("npm-package", ["-l", "-c", `${NODE_PATH_SETUP}; cd ${JSON.stringify(cwd)} && ${script}`]);
}

interface CommandRunResult {
  ok: boolean;
  exitCode: number | null;
  output: string;
}

async function runLoggedCommand(
  script: string,
  cwd: string,
  onLog: (line: string) => void,
  timeoutMessage: string
): Promise<CommandRunResult> {
  const cmd = await shellCmd(script, cwd);

  let finished = false;
  let output = "";
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const appendOutput = (data: string) => {
    output += data;
    if (data.trim()) onLog(data.trimEnd());
  };

  cmd.stdout.on("data", appendOutput);
  cmd.stderr.on("data", appendOutput);

  const result = new Promise<CommandRunResult>((resolve) => {
    const resolveOnce = (value: CommandRunResult) => {
      if (finished) return;
      finished = true;
      if (timeoutId) clearTimeout(timeoutId);
      resolve(value);
    };

    cmd.on("close", (ev) => {
      resolveOnce({
        ok: ev.code === 0,
        exitCode: ev.code,
        output,
      });
    });

    cmd.on("error", (err) => {
      onLog(`Error: ${err}`);
      resolveOnce({
        ok: false,
        exitCode: null,
        output: output + String(err),
      });
    });
  });

  let child;
  try {
    child = await cmd.spawn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    onLog(`Error: ${message}`);
    return {
      ok: false,
      exitCode: null,
      output: output + message,
    };
  }

  timeoutId = setTimeout(() => {
    if (finished) return;
    onLog(timeoutMessage);
    child.kill();
  }, INSTALL_TIMEOUT_MS);

  return result;
}

function isLikelyStalePackument(result: CommandRunResult): boolean {
  return (
    result.output.includes("ETARGET") ||
    result.output.includes("No matching version found")
  );
}

// A publish race — the requested package is live but a transitive @snsoft
// dependency it pins hasn't landed on the registry yet — surfaces as a
// lingering ETARGET even after a fresh-metadata fetch. These multi-package
// publishes self-heal within minutes, so back off and retry a couple of times
// before giving up. Delays are in ms; the array length is the retry count.
const ETARGET_RETRY_DELAYS_MS = [30_000, 60_000];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function npmInstallScript(packageSpec: string, cacheDir: string): string {
  const args = [
    "npm",
    "install",
    "--save",
    "--no-audit",
    "--no-fund",
    // npm defaults to 5-min fetch-timeout + 2 retries = up to 15 min silent
    // hang when the registry is unreachable. Cap aggressively so users see
    // the real DNS/auth/network error within ~1 minute instead of a perpetual
    // spinner.
    "--fetch-timeout=30000",
    "--fetch-retries=1",
    "--cache",
    JSON.stringify(cacheDir),
    // --prefer-online (NOT --prefer-offline): @snsoft versions are
    // timestamp-tagged and installed minutes after publish. A packument
    // cached from before the publish makes npm resolve against stale metadata
    // and fail with ETARGET for a version that is live on the registry.
    // --prefer-online forces a manifest revalidation while still reusing
    // cached tarballs, so already-cached versions install with no slowdown.
    "--prefer-online",
  ];

  args.push(JSON.stringify(packageSpec));
  return args.join(" ");
}

const installLocks = new Map<string, Promise<boolean>>();

async function installPackageOnce(
  protocol: ProtocolTab,
  packageSpec: string,
  onLog: (line: string) => void,
): Promise<boolean> {
  if (!isAllowedSnsoftPackageSpec(packageSpec)) {
    onLog(`Invalid package spec: ${packageSpec}`);
    return false;
  }

  const dir = await ensurePackagesDir(protocol);
  onLog(`Installing ${packageSpec}...`);
  onLog(`Protocol: ${protocol.toUpperCase()}`);
  onLog(`Target: ${dir}`);

  const cacheDir = `${dir}/.npm-cache`;
  let result = await runLoggedCommand(
    npmInstallScript(packageSpec, cacheDir),
    dir,
    onLog,
    "Installation timed out (5 min). Killing process..."
  );

  // The install already forces a fresh manifest (--prefer-online), so an
  // ETARGET here is not a stale cache — it's a publish race: a pinned @snsoft
  // dependency hasn't landed on the registry yet. These clear within a few
  // minutes, so back off and retry.
  for (
    let attempt = 0;
    !result.ok && isLikelyStalePackument(result) && attempt < ETARGET_RETRY_DELAYS_MS.length;
    attempt++
  ) {
    const waitMs = ETARGET_RETRY_DELAYS_MS[attempt];
    onLog(
      `A pinned dependency isn't on the registry yet (likely a publish still in progress). ` +
        `Waiting ${waitMs / 1000}s, then retry ${attempt + 1}/${ETARGET_RETRY_DELAYS_MS.length}...`
    );
    await delay(waitMs);
    result = await runLoggedCommand(
      npmInstallScript(packageSpec, cacheDir),
      dir,
      onLog,
      "Retry timed out (5 min). Killing process..."
    );
  }

  if (result.ok) {
    onLog("Installation complete!");
    return true;
  }

  onLog(`Installation failed (exit code ${result.exitCode ?? "unknown"})`);
  onLog("");
  onLog("Common causes:");
  onLog("  • Just published? A pinned dependency may still be landing on the registry — wait a minute and retry");
  onLog("  • Network / VPN — check connectivity to your registry");
  onLog("  • Auth expired — update token in Settings → Package Registry");
  onLog("  • Registry URL wrong — verify scope (@snsoft) points to correct URL");
  return false;
}

export async function installPackage(
  protocol: ProtocolTab,
  packageSpec: string,
  onLog: (line: string) => void,
): Promise<boolean> {
  const key = `${protocol}:${packageSpec}`;
  const existing = installLocks.get(key);
  if (existing) return existing;

  const current = installPackageOnce(protocol, packageSpec, onLog);
  installLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (installLocks.get(key) === current) installLocks.delete(key);
  }
}

export async function uninstallPackage(
  protocol: ProtocolTab,
  packageName: string,
  onLog: (line: string) => void
): Promise<boolean> {
  const dir = await ensurePackagesDir(protocol);
  onLog(`Removing ${packageName}...`);

  const result = await runLoggedCommand(
    `npm uninstall --no-audit --no-fund ${JSON.stringify(packageName)}`,
    dir,
    onLog,
    "Uninstall timed out (5 min). Killing process..."
  );

  if (result.ok) onLog("Package removed!");
  else onLog(`Removal failed (exit code ${result.exitCode ?? "unknown"})`);

  return result.ok;
}
