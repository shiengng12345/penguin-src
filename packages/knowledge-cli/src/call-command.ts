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
import { readFileSync } from "node:fs";
import {
  callConnect,
  callGrpcWeb,
  computeConnectServicePath,
  computeServicePath,
  generatePenguinRequestId,
  PENGUIN_REQUEST_ID_HEADER,
  type MetadataEntry,
} from "@penguin/core";
import {
  findPenguinEnvironment,
  installedSnsoftPackages,
  loadInstalledModule,
  readPenguinEnvironments,
} from "@penguin/core/node";

export interface CallCommandDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  json: boolean;
}

// `player.FrontendLoginConfigService.GetX` → `@snsoft/player-grpc-web` by the
// repo-wide naming convention, falling back to a scan of installed packages.
function normalizePackageToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@snsoft\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Proto packages can be multi-segment (`pengvi.auth.Auth.lookup` → package
// "pengvi.auth"), so a single token is not enough: try the full dotted package
// (normalized), then its last segment, then its first — the first candidate
// with a match wins, ambiguity within a candidate is an error, never a guess.
export function packageCandidatesFromFullName(fullName: string): string[] {
  const segments = fullName.split(".");
  // last segment = method, second-to-last = service → the rest is the package.
  const packageSegments = segments.slice(0, Math.max(1, segments.length - 2));
  const full = packageSegments.join(".");
  const candidates = [full, packageSegments[packageSegments.length - 1], packageSegments[0]];
  return [...new Set(candidates.filter(Boolean))];
}

export function resolvePackage(
  protoPackages: string[],
  explicit: string | undefined,
  installed = installedSnsoftPackages("grpc-web"),
): string {
  if (explicit?.trim()) return explicit;
  for (const protoPackage of protoPackages) {
    const conventional = `@snsoft/${protoPackage.toLowerCase().replace(/\./g, "-")}-grpc-web`;
    // Return the ACTUAL installed entry, not the constructed lowercase name —
    // on case-sensitive filesystems the constructed name may not exist on disk.
    const exact = installed.find((name) => name.toLowerCase() === conventional);
    if (exact) return exact;
    const normalizedProto = normalizePackageToken(protoPackage);
    const matches = installed.filter((name) =>
      normalizePackageToken(name) === normalizedProto
        || normalizePackageToken(name).startsWith(`${normalizedProto}-`),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(
        `Proto package "${protoPackage}" matches several installed packages (${matches.join(", ")}) — pass --package to pick one.`,
      );
    }
  }
  throw new Error(
    `No installed grpc-web package matches proto package "${protoPackages[0]}". Installed: ${installed.join(", ") || "(none)"} — pass --package explicitly or install one.`,
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
  // first, then case-insensitive — the shared rule in @penguin/core/node).
  if (!url) {
    if (!env) {
      deps.err(`either --env or --url is required\n${CALL_USAGE}`);
      return 2;
    }
    const found = findPenguinEnvironment("grpc-web", env);
    if (!found) {
      const envs = readPenguinEnvironments("grpc-web");
      deps.err(
        `environment ${env} not found. Available: ${envs.map((e) => e.name).join(", ") || "(none configured)"}`,
      );
      return 2;
    }
    url = found.variables.URL ?? "";
    // User-supplied --header wins over env defaults regardless of key CASING —
    // HTTP header names are case-insensitive, and the transport applies these
    // in insertion order, so a case-mismatched env default would silently
    // overwrite the user's explicit credential on the wire.
    const userHeaderKeys = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
    const tag = found.variables.X_ENV_TAG?.trim();
    if (tag && !userHeaderKeys.has("x-env-tag")) headers["x-env-tag"] = tag;
    const token = found.variables.TOKEN?.trim();
    if (token && !userHeaderKeys.has("authorization")) {
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

  const packageName = resolvePackage(packageCandidatesFromFullName(fullName), explicitPackage);
  const servicePath =
    transport === "connect" ? computeConnectServicePath(fullName) : computeServicePath(fullName);

  // Fresh correlation id per call, always overriding a caller-supplied one —
  // same rule (and same generator) as the desktop send pipeline and MCP.
  const requestId = generatePenguinRequestId();
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
      loadModule: (name: string) => loadInstalledModule("grpc-web", name),
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
