// `penguin call` — invoke a backend RPC from ONE shell command, no MCP
// session or discovery round-trips. Built for agents chasing sub-10s
// end-to-end latency: method full name in, JSON result out.
//
//   penguin call player.FrontendLoginConfigService.GetFrontendLoginConfigNoAuth \
//     --env QAT --body '{"platformId":"50"}'
//
// Routing mirrors the desktop/MCP send pipeline exactly: the same
// computeServicePath rules, the same grpc-web/connect transports from
// @penguin/core, and a fresh `penguin-<uuidv7>` x-penguin-id stamped on every
// request (never caller-supplied). Environments come from the same
// ~/.penguin/config.json the desktop and MCP server read; generated client
// modules load from the same ~/.penguin/grpc-web/node_modules tree.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  callConnect,
  callGrpcWeb,
  computeConnectServicePath,
  computeServicePath,
  type MetadataEntry,
} from "@penguin/core";

export interface CallCommandDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  json: boolean;
}

// Mirrors packages/mcp/src/request-id.ts (which itself mirrors the desktop's
// src/lib/penguin-request-id.ts) — three runtimes, one wire format
// (`penguin-<uuidv7>`), so ids from any path are indistinguishable in logs.
const PENGUIN_REQUEST_ID_HEADER = "x-penguin-id";

function uuidv7(): string {
  const timestampMs = Date.now();
  const bytes = new Uint8Array(16);
  bytes[0] = Math.floor(timestampMs / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(timestampMs / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(timestampMs / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(timestampMs / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;
  bytes.set(randomBytes(10), 6);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- ~/.penguin plumbing (mirrors packages/mcp/src/{config,penguin-paths}) --

function penguinRoot(): string {
  const home = homedir();
  const next = join(home, ".penguin");
  const legacy = join(home, ".pengvi");
  if (existsSync(next)) return next;
  if (existsSync(legacy)) return legacy;
  return next;
}

interface EnvironmentEntry {
  name: string;
  variables: Record<string, string>;
}

function readGrpcWebEnvironments(): EnvironmentEntry[] {
  const home = homedir();
  const path = [
    join(home, ".penguin", "config.json"),
    join(home, ".penguin.config.json"),
    join(home, ".pengvi.config.json"),
  ].find((p) => existsSync(p));
  if (!path) return [];
  try {
    const cfg = JSON.parse(readFileSync(path, "utf-8")) as {
      "grpc-web"?: { environments?: EnvironmentEntry[] };
    };
    return cfg["grpc-web"]?.environments ?? [];
  } catch {
    return [];
  }
}

function grpcWebModulesDir(): string {
  return join(penguinRoot(), "grpc-web", "node_modules");
}

function installedSnsoftPackages(): string[] {
  const dir = join(grpcWebModulesDir(), "@snsoft");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => !entry.startsWith("."))
    .map((entry) => `@snsoft/${entry}`);
}

// Same entry resolution as the MCP server's makeLoadModule (runners.ts).
async function loadModule(packageName: string): Promise<Record<string, unknown>> {
  const dir = join(grpcWebModulesDir(), packageName);
  if (!existsSync(dir)) {
    throw new Error(`Package ${packageName} not installed for grpc-web (looked in ${dir})`);
  }
  const pkgJson = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
    main?: string;
    module?: string;
  };
  const entry = join(dir, pkgJson.module ?? pkgJson.main ?? "index.js");
  if (!existsSync(entry)) {
    throw new Error(`Entry point missing for ${packageName} (expected at ${entry})`);
  }
  return (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
}

// `player.FrontendLoginConfigService.GetX` → `@snsoft/player-grpc-web` by the
// repo-wide naming convention, falling back to a scan of installed packages.
function resolvePackage(protoPackage: string, explicit: string | undefined): string {
  if (explicit) return explicit;
  const conventional = `@snsoft/${protoPackage.toLowerCase()}-grpc-web`;
  const installed = installedSnsoftPackages();
  if (installed.some((name) => name.toLowerCase() === conventional)) return conventional;
  const matches = installed.filter((name) =>
    name.toLowerCase().includes(protoPackage.toLowerCase()),
  );
  if (matches.length === 1) return matches[0];
  throw new Error(
    matches.length === 0
      ? `No installed grpc-web package matches proto package "${protoPackage}". Installed: ${installed.join(", ") || "(none)"} — pass --package explicitly or install one.`
      : `Proto package "${protoPackage}" matches several installed packages (${matches.join(", ")}) — pass --package to pick one.`,
  );
}

const CALL_USAGE = `usage: penguin call <pkg.Service.Method> (--env <name> | --url <base>) [options]

  --env <name>          environment from ~/.penguin/config.json (case-insensitive);
                        resolves URL + x-env-tag + authorization automatically
  --url <base>          explicit base URL (bypasses environment lookup)
  --body '<json>'       request body (default {})
  --body-file <path>    read the request body from a file
  --header k=v          extra header (repeatable; overrides env defaults)
  --transport <t>       grpc-web (default, old servers) | connect (migrated servers)
  --package <name>      generated client package (default: derived from method name)
  --json                structured output

example:
  penguin call player.FrontendLoginConfigService.GetFrontendLoginConfigNoAuth --env QAT --body '{"platformId":"50"}'`;

export async function runCallCommand(argv: string[], deps: CallCommandDeps): Promise<number> {
  const positional: string[] = [];
  const headers: Record<string, string> = {};
  let env: string | undefined;
  let url: string | undefined;
  let body: string | undefined;
  let bodyFile: string | undefined;
  let transport = "grpc-web";
  let explicitPackage: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === "--env") env = next();
    else if (arg === "--url") url = next();
    else if (arg === "--body") body = next();
    else if (arg === "--body-file") bodyFile = next();
    else if (arg === "--transport") transport = next();
    else if (arg === "--package") explicitPackage = next();
    else if (arg === "--header") {
      const raw = next();
      const idx = raw.indexOf("=");
      if (idx <= 0) throw new Error(`--header expects k=v, got: ${raw}`);
      headers[raw.slice(0, idx).trim()] = raw.slice(idx + 1).trim();
    } else if (arg === "--json") {
      // handled by dispatch; tolerated here so flag order doesn't matter
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option ${arg}\n${CALL_USAGE}`);
    } else positional.push(arg);
  }

  const fullName = positional[0];
  if (!fullName || fullName.split(".").length < 3) {
    deps.err(CALL_USAGE);
    return 2;
  }
  if (transport !== "grpc-web" && transport !== "connect") {
    deps.err(`--transport must be grpc-web or connect, got: ${transport}`);
    return 2;
  }

  // Resolve the target URL + default headers from the environment (exact name
  // first, then case-insensitive — same rule as the MCP server).
  if (!url) {
    if (!env) {
      deps.err(`either --env or --url is required\n${CALL_USAGE}`);
      return 2;
    }
    const envs = readGrpcWebEnvironments();
    const found =
      envs.find((e) => e.name === env) ??
      envs.find((e) => e.name.toLowerCase() === env!.toLowerCase());
    if (!found) {
      deps.err(
        `environment ${env} not found. Available: ${envs.map((e) => e.name).join(", ") || "(none configured)"}`,
      );
      return 2;
    }
    url = found.variables.URL ?? "";
    const tag = found.variables.X_ENV_TAG?.trim();
    if (tag && headers["x-env-tag"] === undefined) headers["x-env-tag"] = tag;
    const token = found.variables.TOKEN?.trim();
    if (token && headers.authorization === undefined) {
      headers.authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
    }
    if (!url) {
      deps.err(`environment ${found.name} has no URL variable`);
      return 2;
    }
  }

  if (bodyFile) body = readFileSync(bodyFile, "utf-8");
  const requestBody = body ?? "{}";
  try {
    JSON.parse(requestBody);
  } catch {
    deps.err("request body is not valid JSON");
    return 2;
  }

  const protoPackage = fullName.split(".")[0];
  const packageName = resolvePackage(protoPackage, explicitPackage);
  const servicePath =
    transport === "connect" ? computeConnectServicePath(fullName) : computeServicePath(fullName);

  // Fresh correlation id per call, always overriding a caller-supplied one —
  // same rule as the desktop send pipeline and the MCP server.
  const requestId = `penguin-${uuidv7()}`;
  headers[PENGUIN_REQUEST_ID_HEADER] = requestId;
  const metadata: MetadataEntry[] = Object.entries(headers).map(([key, value]) => ({
    key,
    value,
    enabled: true,
  }));

  const call = transport === "connect" ? callConnect : callGrpcWeb;
  // core's transport logs inspection metadata via console.info; keep stdout
  // pure (agents pipe --json into jq) — the same facts are in the result.
  const originalInfo = console.info;
  console.info = () => {};
  let result;
  try {
    result = await call({
      url,
      servicePath,
      body: requestBody,
      metadata,
      packageName,
      loadModule,
    });
  } finally {
    console.info = originalInfo;
  }

  const ok = result.status === "OK";
  const structured = {
    ok,
    status: result.status,
    statusCode: result.statusCode,
    xPenguinId: requestId,
    url: `${url.replace(/\/$/, "")}${servicePath}`,
    transport,
    packageName,
    requestHeaders: headers,
    durationMs: result.duration,
    ...(result.error ? { error: result.error } : {}),
    body: result.body,
  };
  if (deps.json) {
    deps.out(JSON.stringify(structured, null, 2));
  } else {
    deps.out(
      `${result.status} (HTTP ${result.statusCode}, ${result.duration}ms) · ${PENGUIN_REQUEST_ID_HEADER}: ${requestId}`,
    );
    if (result.error) deps.err(result.error);
    if (result.body) deps.out(result.body);
  }
  return ok ? 0 : 1;
}
