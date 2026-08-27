#!/usr/bin/env node
// Penguin MCP server — exposes Penguin's installed @snsoft packages and
// protocol clients (gRPC-Web / gRPC native / @snsoft SDK) as MCP tools so AI
// assistants (Claude, Cursor, etc.) can list and call backend RPCs directly.
//
// Reads from the same ~/.penguin/ tree that the desktop app manages — packages
// you installed via Penguin UI work here automatically. No duplicate install.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Tool definitions stay pure. DB-backed handlers are initialized only on a
// knowledge request; QueryWorkerPool itself creates no SQLite connection in
// this process because each bounded query opens its store inside a worker.
import { KNOWLEDGE_TOOL_DEFS, LOG_INVESTIGATION_TOOL_DEFS, isKnowledgeTool } from "./knowledge-tool-defs.js";
export { KNOWLEDGE_TOOL_DEFS } from "./knowledge-tool-defs.js";
import { CAPABILITIES, capabilityHash } from "@penguin/knowledge-contracts";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { QueryWorkerPool } from "../../knowledge-cli/src/query-server.js";
import {
  callGrpcWeb,
  callGrpcNative,
  callSdk,
  computeServicePath,
  generateDefaultJson,
  snsoftPackageNameFromSpec,
  type MetadataEntry,
  type ProtoMethod,
  type ResponseState,
} from "@penguin/core";
import {
  configPath,
  findEnvironment,
  getSection,
  readConfig,
  type EnvironmentEntry,
} from "./config.js";
import {
  listInstalledPackages,
  penguinRoot,
  protocolDir,
  type Protocol,
} from "./penguin-paths.js";
import { parseServicesForPackage } from "./parse-services.js";
import { PENGUIN_REQUEST_ID_HEADER, generatePenguinRequestId } from "./request-id.js";
import {
  installPackageViaNpm,
  makeLoadModule,
  nodeSidecarRunner,
  uninstallPackageViaNpm,
} from "./runners.js";
import {
  desktopStateStatus,
  readDefaultHeaders,
  readRequestHistory,
  readSavedRequests,
  type DesktopProtocol,
} from "./app-db.js";
import {
  attachRequestId,
  buildDefaultHeaders,
  requireCallTarget,
  serviceCallability,
  serviceNameMatches,
  validateCompareEnvironmentNames,
} from "./mcp-input-validation.js";

const PROTOCOLS: readonly Protocol[] = ["grpc-web", "grpc", "sdk"] as const;
const DESKTOP_PROTOCOLS: readonly DesktopProtocol[] = ["grpc-web", "grpc", "sdk", "rest"] as const;

const MCP_FAST_KNOWLEDGE_TOOLS = new Set([
  "knowledge_capabilities",
  "knowledge_index_status",
  "index_status",
  "knowledge_status_panel",
  "status_panel",
]);

let mcpQueryPool: QueryWorkerPool | undefined;
function knowledgeDbPath(): string {
  return process.env.PENGUIN_KNOWLEDGE_DB ?? join(homedir(), ".penguin", "knowledge", "knowledge.db");
}

function getMcpQueryPool(): QueryWorkerPool {
  mcpQueryPool ??= new QueryWorkerPool({
    dbPath: knowledgeDbPath(),
    ledgerPath: process.env.PENGUIN_KNOWLEDGE_LEDGER ?? join(homedir(), ".penguin", "knowledge", "ledger.jsonl"),
    workerUrl: new URL("./knowledge-worker.js", import.meta.url),
    size: Number(process.env.PENGUIN_MCP_QUERY_WORKERS ?? 2),
    maxQueue: Number(process.env.PENGUIN_MCP_QUERY_MAX_QUEUE ?? 16),
    timeoutMs: Number(process.env.PENGUIN_MCP_QUERY_TIMEOUT_MS ?? 15_000),
  });
  return mcpQueryPool;
}

function isBoundedKnowledgeQuery(name: string): boolean {
  const definition = KNOWLEDGE_TOOL_DEFS.find((tool) => tool.name === name) as
    | { "x-penguin-capability-id"?: string }
    | undefined;
  const capabilityId = definition?.["x-penguin-capability-id"];
  const capability = capabilityId
    ? CAPABILITIES.find((candidate) => candidate.id === capabilityId)
    : undefined;
  return Boolean(capability && !capability.mutating && !MCP_FAST_KNOWLEDGE_TOOLS.has(name));
}

function asMetadata(headers: Record<string, string> | undefined): MetadataEntry[] {
  if (!headers) return [];
  return Object.entries(headers).map(([k, v]) => ({ key: k, value: v, enabled: true }));
}

// Shared by call_method: resolve {url, defaultHeaders} from an environment
// name the same way the resolve_environment tool does, so callers can pass
// environmentName instead of chaining resolve_environment → call_method.
function resolveEnvironmentTarget(
  protocol: Protocol,
  environmentName: string,
): { environment: EnvironmentEntry; url: string; defaultHeaders: Record<string, string> } {
  const cfg = readConfig();
  const env = findEnvironment(cfg, protocol, environmentName);
  if (!env) {
    const available = (getSection(cfg, protocol).environments ?? []).map((e) => e.name);
    const hint = available.length
      ? ` Available: ${available.join(", ")}.`
      : " No environments configured for this protocol — add some to .penguin/config.json.";
    throw new Error(`Environment ${environmentName} not found for ${protocol}.${hint}`);
  }
  return { environment: env, url: env.variables.URL ?? "", defaultHeaders: buildDefaultHeaders(env.variables) };
}

function findService(protocol: Protocol, packageName: string, serviceName: string) {
  const services = parseServicesForPackage(protocol, packageName);
  // Match by short name OR fullName so callers can pass either "Auth" or
  // "pengvi.auth.Auth".
  const service = services.find((s) => serviceNameMatches(s, serviceName));
  if (!service) {
    throw new Error(
      `Service ${serviceName} not found in ${packageName} (have: ${services
        .map((s) => s.fullName)
        .join(", ")})`,
    );
  }
  return service;
}

function findMethod(
  protocol: Protocol,
  packageName: string,
  serviceName: string,
  methodName: string,
): { service: { fullName: string }; method: ProtoMethod } {
  const service = findService(protocol, packageName, serviceName);
  // Methods are matched case-insensitively because SDK uses camelCase
  // ("lookupNationalId") while proto uses PascalCase ("LookupNationalId") —
  // same RPC, different stringly-typed conventions.
  const lowered = methodName.toLowerCase();
  const method = service.methods.find(
    (m) => m.name === methodName || m.name.toLowerCase() === lowered,
  );
  if (!method) {
    throw new Error(
      `Method ${methodName} not found on ${service.fullName} (have: ${service.methods
        .map((m) => m.name)
        .join(", ")})`,
    );
  }
  return { service, method };
}

// Build the protocol-specific routing fields from the unified
// (packageName, serviceName, methodName) triple. Uses the same
// computeServicePath as the desktop app —
// `/<lowercased_gateway_prefix>/<full_typename>/<method>`. For SDK we only
// need the serviceName/methodName fields the SDK runner already expects.
function resolveCallRouting(args: {
  protocol: Protocol;
  packageName?: string;
  serviceName?: string;
  methodName?: string;
  servicePath?: string;
}): {
  servicePath?: string;
  serviceName?: string;
  methodName?: string;
  packageName?: string;
} {
  // Legacy mode: caller already provided servicePath / (sdk) serviceName+methodName.
  if (args.servicePath || !args.packageName || !args.serviceName || !args.methodName) {
    return {
      servicePath: args.servicePath,
      serviceName: args.serviceName,
      methodName: args.methodName,
      packageName: args.packageName,
    };
  }

  const { service, method } = findMethod(
    args.protocol,
    args.packageName,
    args.serviceName,
    args.methodName,
  );

  if (args.protocol === "sdk") {
    return {
      packageName: args.packageName,
      serviceName: service.fullName,
      methodName: method.name,
    };
  }

  // grpc + grpc-web: rebuild servicePath from the fully-qualified method name.
  const lastDot = method.fullName.lastIndexOf(".");
  if (lastDot === -1) {
    throw new Error(
      `Cannot build servicePath: method ${method.name} has no proto package in fullName=${method.fullName}`,
    );
  }
  return {
    packageName: args.packageName,
    servicePath: computeServicePath(method.fullName),
  };
}

async function invokeRpc(args: {
  protocol: Protocol;
  url: string;
  body: string;
  metadata: MetadataEntry[];
  servicePath?: string;
  packageName?: string;
  serviceName?: string;
  methodName?: string;
}): Promise<ResponseState> {
  if (args.protocol === "grpc-web") {
    return await callGrpcWeb({
      url: args.url,
      servicePath: args.servicePath as string,
      body: args.body,
      metadata: args.metadata,
      packageName: args.packageName,
      loadModule: makeLoadModule("grpc-web"),
    });
  }
  if (args.protocol === "grpc") {
    return await callGrpcNative(
      {
        url: args.url,
        servicePath: args.servicePath as string,
        body: args.body,
        metadata: args.metadata,
        packagesDir: protocolDir("grpc"),
      },
      nodeSidecarRunner,
    );
  }
  return await callSdk(
    {
      url: args.url,
      serviceName: args.serviceName as string,
      methodName: args.methodName as string,
      body: args.body,
      metadata: args.metadata,
      packagesDir: protocolDir("sdk"),
    },
    nodeSidecarRunner,
  );
}

function packageNameFromSpec(spec: string): string | null {
  return snsoftPackageNameFromSpec(spec);
}

function jsonResult(value: unknown, isError = false) {
  const enriched = value && typeof value === "object" && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>), ...("hits" in (value as Record<string, unknown>) ? { stats: { rawBytesEstimate: Buffer.byteLength(JSON.stringify(value), "utf8"), sentBytes: Buffer.byteLength(JSON.stringify(value), "utf8"), compactRatio: 1, timingsMs: {} } } : {}) }
    : value;
  const searchSummary = enriched && typeof enriched === "object" && !Array.isArray(enriched) && Array.isArray((enriched as Record<string, unknown>).hits)
    ? `${((enriched as Record<string, unknown>).hits as unknown[]).length} hits${((enriched as Record<string, unknown>).diagnostics as { searchedLanes?: string[] } | undefined)?.searchedLanes ? ` · lanes ${((enriched as Record<string, unknown>).diagnostics as { searchedLanes: string[] }).searchedLanes.join(",")}` : ""}`
    : null;
  const text = searchSummary ?? JSON.stringify(enriched, null, 2);
  const structuredContent = Array.isArray(enriched) ? { items: enriched } : (enriched && typeof enriched === "object" ? enriched : { result: enriched });
  return {
    isError: isError || undefined,
    content: [{ type: "text", text }],
    structuredContent,
  };
}

// Cap the response body MCP returns to AI tools. Backend list endpoints can
// emit megabytes of JSON, which blows through context windows and triggers
// platform-side truncation that hides what was lost. A 32KB cap keeps even
// chatty responses survivable while preserving an explicit `truncated`
// signal the AI can use to ask for a narrower query.
const MAX_RESPONSE_BYTES = 32_000;

interface GuardedResponse extends ResponseState {
  truncated?: true;
  totalBytes?: number;
  hint?: string;
}

function applyResponseGuard(response: ResponseState): GuardedResponse {
  if (!response.body || response.body.length <= MAX_RESPONSE_BYTES) return response;
  return {
    ...response,
    body: response.body.slice(0, MAX_RESPONSE_BYTES),
    truncated: true,
    totalBytes: response.body.length,
    hint: `Response body truncated to ${MAX_RESPONSE_BYTES} bytes (original ${response.body.length}). Narrow the query or call against the live backend if you need the full payload.`,
  };
}

// Catch malformed JSON before we hand it off to the protocol client. The
// downstream errors (e.g. "Invalid JSON request body" from grpc-web-client,
// or whatever the Node SDK produces) lose the position info JSON.parse
// gives us — surfacing this here means the AI sees exactly what to fix.
function preflightJsonBody(body: string): void {
  try {
    JSON.parse(body);
  } catch (e) {
    const preview = body.length > 100 ? `${body.slice(0, 100)}…` : body;
    throw new Error(
      `Invalid JSON request body: ${e instanceof Error ? e.message : String(e)}. body starts: ${preview}`,
    );
  }
}

// Cross-package fuzzy match against installed services + methods. We try a
// few common shapes in priority order rather than rolling Levenshtein — for
// 10–50 installed packages this is plenty fast and gives interpretable
// scores the caller can reason about ("exact match" vs. "substring match").
interface SearchHit {
  protocol: Protocol;
  package: string;
  service: string;
  method: string;
  score: number;
  matchedOn: "method-exact" | "method-prefix" | "method-substring" | "service-substring" | "package-substring";
}

function scoreSearchHit(
  query: string,
  methodName: string,
  serviceName: string,
  packageName: string,
): { score: number; matchedOn: SearchHit["matchedOn"] } | null {
  const q = query.toLowerCase();
  const m = methodName.toLowerCase();
  const s = serviceName.toLowerCase();
  const p = packageName.toLowerCase();
  if (m === q) return { score: 100, matchedOn: "method-exact" };
  if (m.startsWith(q)) return { score: 90, matchedOn: "method-prefix" };
  if (m.includes(q)) return { score: 70, matchedOn: "method-substring" };
  if (s.includes(q)) return { score: 40, matchedOn: "service-substring" };
  if (p.includes(q)) return { score: 20, matchedOn: "package-substring" };
  return null;
}

function searchAllMethods(
  query: string,
  protocolFilter: Protocol | undefined,
  limit: number,
): SearchHit[] {
  const targets = protocolFilter ? [protocolFilter] : PROTOCOLS;
  const hits: SearchHit[] = [];
  for (const protocol of targets) {
    for (const pkg of listInstalledPackages(protocol)) {
      let services;
      try {
        services = parseServicesForPackage(protocol, pkg.name);
      } catch {
        // Parser may fail for half-installed packages — skip rather than
        // erroring out the whole search.
        continue;
      }
      for (const svc of services) {
        for (const method of svc.methods) {
          const scored = scoreSearchHit(query, method.name, svc.fullName, pkg.name);
          if (!scored) continue;
          hits.push({
            protocol,
            package: pkg.name,
            service: svc.fullName,
            method: method.name,
            score: scored.score,
            matchedOn: scored.matchedOn,
          });
        }
      }
    }
  }
  hits.sort((a, b) => b.score - a.score || a.method.localeCompare(b.method));
  return hits.slice(0, limit);
}

const server = new Server(
  { name: "penguin-mcp", version: `0.0.1+knowledge-${capabilityHash(CAPABILITIES).slice(0, 12)}` },
  {
    capabilities: { tools: {} },
    // MCP initialize has no portable custom metadata field. Keep the
    // negotiation tuple in instructions so clients can inspect it before
    // calling a tool; knowledge_capabilities returns the same structured data.
    // schemaVersion is a hand-maintained literal (not imported from
    // @penguin/knowledge-core's SCHEMA_VERSION) because this file must stay
    // free of knowledge-core/native deps so the release-bundled server
    // initializes without workspace node_modules — keep it in sync with
    // SCHEMA_VERSION in packages/knowledge-core/src/schema.ts by hand.
    instructions: JSON.stringify({ contractVersion: "2", schemaVersion: 14, capabilityHash: capabilityHash(CAPABILITIES) }),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...KNOWLEDGE_TOOL_DEFS,
    ...LOG_INVESTIGATION_TOOL_DEFS,
    {
      name: "mcp_health",
      description:
        "Lightweight liveness check with runtime paths and bounded-query limits. This tool deliberately avoids package, environment, and database scans so it remains responsive while another query is slow.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "search_methods",
      description:
        "Fuzzy-search installed @snsoft packages for a method by name. Returns the top matches with package/service/method paths, ranked by score. Pair with describe_method on the top hit to bridge from natural-language ('find the lookup national id one') to a callable method.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "Substring to match against method, service, or package name" },
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          limit: { type: "number", description: "Max hits (default 20)" },
        },
      },
    },
    {
      name: "list_packages",
      description:
        "List @snsoft packages installed under ~/.penguin/. Optional `protocol` filter (grpc-web | grpc | sdk).",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
        },
      },
    },
    {
      name: "list_methods",
      description:
        "List services + methods exposed by a specific @snsoft package for a given protocol.",
      inputSchema: {
        type: "object",
        required: ["protocol", "packageName"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          packageName: { type: "string", description: "e.g. @snsoft/auth-grpc-web" },
        },
      },
    },
    {
      name: "describe_method",
      description:
        "Return one RPC method's full schema — request/response type names plus nested FieldInfo trees (name, type, repeated, optional, enumValues). SDK packages may be unavailable in Node when they require browser APIs or a missing dist/module directory; errors are explicit.",
      inputSchema: {
        type: "object",
        required: ["protocol", "packageName", "serviceName", "methodName"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          packageName: { type: "string", description: "e.g. @snsoft/auth-grpc-web" },
          serviceName: {
            type: "string",
            description: "Short name (e.g. 'Auth') or fullName (e.g. 'pengvi.auth.Auth')",
          },
          methodName: {
            type: "string",
            description: "PascalCase or camelCase — match is case-insensitive",
          },
        },
      },
    },
    {
      name: "describe_service",
      description:
        "Return every method on a service with its full schema and defaultBody in one call — preferred over running describe_method N times when exploring a service. Pair with search_methods → describe_service → call_method for an efficient discover-and-invoke loop.",
      inputSchema: {
        type: "object",
        required: ["protocol", "packageName", "serviceName"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          packageName: { type: "string", description: "e.g. @snsoft/auth-grpc-web" },
          serviceName: {
            type: "string",
            description: "Short name (e.g. 'Auth') or fullName (e.g. 'pengvi.auth.Auth')",
          },
        },
      },
    },
    {
      name: "uninstall_package",
      description:
        "Remove an installed @snsoft package via `npm uninstall --save`. Symmetric with install_package. The Penguin desktop's filesystem watcher refreshes the UI automatically afterwards.",
      inputSchema: {
        type: "object",
        required: ["protocol", "packageName"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          packageName: { type: "string", description: "e.g. @snsoft/auth-grpc-web" },
        },
      },
    },
    {
      name: "install_package",
      description:
        "Install a versioned @snsoft npm package into ~/.penguin/<protocol>/. Runs `npm install --save <packageSpec>` in the protocol's package dir; use list_packages to discover an installed version or provide an explicit registry version. Penguin desktop's filesystem watcher will pick up the change and refresh the UI automatically.",
      inputSchema: {
        type: "object",
        required: ["protocol", "packageSpec"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          packageSpec: {
            type: "string",
            description:
              "Versioned npm spec, e.g. '@snsoft/auth-grpc-web@1.2.3'. Use list_packages for installed versions.",
          },
        },
      },
    },
    {
      name: "list_environments",
      description:
        "List environments configured in .penguin config — name, color, and variables (URL, X_ENV_TAG, TOKEN, ...). Optional `protocol` filter.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
        },
      },
    },
    {
      name: "resolve_environment",
      description:
        "Look up one environment by name. Returns: `url`, `variables` (raw config), and `defaultHeaders` — a ready-to-use map (X_ENV_TAG → x-env-tag, TOKEN → authorization Bearer). Pass `defaultHeaders` straight into call_method's `headers` arg, merged with any overrides.",
      inputSchema: {
        type: "object",
        required: ["protocol", "environmentName"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          environmentName: { type: "string" },
        },
      },
    },
    {
      name: "package_status",
      description:
        "Diagnose package install state — lists every package declared in .penguin config alongside what's actually present in ~/.penguin/<protocol>/node_modules, plus any installed packages that aren't declared. Useful when debugging 'why is this method missing?'",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
        },
      },
    },
    {
      name: "get_default_headers",
      description:
        "Read desktop default request headers from the SQLite app database. Optional protocol filter includes rest.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", enum: [...DESKTOP_PROTOCOLS] },
        },
      },
    },
    {
      name: "list_saved_requests",
      description:
        "Read saved requests from Penguin's SQLite database. Returns replayable request metadata and a capped request body preview.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", enum: [...DESKTOP_PROTOCOLS] },
          query: { type: "string", description: "Substring match against name, method, service, package, URL, or body" },
          limit: { type: "number", description: "Max saved requests to return (default 20, max 100)" },
        },
      },
    },
    {
      name: "search_request_history",
      description:
        "Search recent request history persisted in the SQLite app database. Useful for finding a prior call and replaying it with call_method.",
      inputSchema: {
        type: "object",
        properties: {
          protocol: { type: "string", enum: [...DESKTOP_PROTOCOLS] },
          query: { type: "string", description: "Substring match against method, service, package, URL, or body" },
          limit: { type: "number", description: "Max history entries to return (default 20, max 100)" },
        },
      },
    },
    {
      name: "compare_environments",
      description:
        "Invoke the same RPC across multiple environments and return all responses side-by-side. The AI can then diff them. Routing fields work the same as call_method.",
      inputSchema: {
        type: "object",
        required: ["protocol", "environmentNames", "body"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          environmentNames: {
            type: "array",
            items: { type: "string" },
            description: "Two or more environment names from list_environments",
          },
          packageName: { type: "string", description: "Required when using serviceName+methodName routing" },
          serviceName: { type: "string", description: "Short or fullName, e.g. 'Auth' or 'pengvi.auth.Auth'" },
          methodName: { type: "string", description: "Case-insensitive, e.g. 'lookupNationalId'" },
          servicePath: { type: "string", description: "Legacy/manual override (grpc-web/grpc only)" },
          body: { type: "string", description: "JSON-stringified request body" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra HTTP headers applied to every environment",
          },
        },
      },
    },
    {
      name: "call_method",
      description:
        "Invoke an RPC method on the live backend in one call — no separate resolve_environment step needed. Recommended routing: pass `packageName` + `serviceName` + `methodName` — MCP will resolve the protocol-specific routing fields. Legacy `servicePath` works directly for native grpc; grpc-web still requires `packageName` to load the generated client module. Pass `environmentName` (from list_environments) to auto-resolve the target url and default headers (x-env-tag, authorization); pass `url` directly to bypass environment lookup. The result's `headers` always includes the real `x-penguin-id` correlation id that was actually sent with this request — never guess or synthesize one.",
      inputSchema: {
        type: "object",
        required: ["protocol", "body"],
        properties: {
          protocol: { type: "string", enum: ["grpc-web", "grpc", "sdk"] },
          environmentName: {
            type: "string",
            description:
              "Environment name from list_environments. Resolves url + default headers (x-env-tag, authorization) automatically; explicit `url`/`headers` override the resolved values. Either this or `url` is required.",
          },
          url: { type: "string", description: "Explicit target URL. Either this or `environmentName` is required." },
          packageName: { type: "string", description: "e.g. @snsoft/auth-grpc-web" },
          serviceName: { type: "string", description: "Short or fullName, e.g. 'Auth'" },
          methodName: { type: "string", description: "Case-insensitive, e.g. 'lookupNationalId'" },
          servicePath: { type: "string", description: "Legacy/manual override (grpc-web/grpc only)" },
          body: { type: "string", description: "JSON-stringified request body" },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Extra HTTP headers, e.g. {x-env-tag: brazil, platform-id: 550}. Override resolved environment defaults.",
          },
        },
      },
    },
  ].sort((a, b) => a.name.localeCompare(b.name)),
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  const a = args as Record<string, unknown>;

  try {
    if (isKnowledgeTool(name)) {
      // Preserve the established not-initialized response. A worker cannot
      // open a missing database in read-only schema mode, so only route to the
      // bounded pool after initialization has actually created the DB.
      if (isBoundedKnowledgeQuery(name) && existsSync(knowledgeDbPath())) {
        const result = await getMcpQueryPool().run(
          "knowledge.mcp_tool",
          { name, arguments: a },
          extra.signal,
        );
        return jsonResult(result);
      }
      // Lazy import keeps knowledge-core (native better-sqlite3) out of the
      // server's top-level load — only paid when a knowledge tool is called.
      const { runKnowledgeTool } = await import("./knowledge-tools.js");
      return jsonResult(await runKnowledgeTool(name, a));
    }
    if (name === "mcp_health") {
      return jsonResult({
        configPath: configPath(),
        penguinRoot: penguinRoot(),
        nodeVersion: process.version,
        platform: process.platform,
        cwd: process.cwd(),
        status: "ok",
        queryRuntime: {
          workers: Number(process.env.PENGUIN_MCP_QUERY_WORKERS ?? 2),
          hardTimeoutMs: Number(process.env.PENGUIN_MCP_QUERY_TIMEOUT_MS ?? 15_000),
        },
      });
    }

    if (name === "search_methods") {
      const query = a.query as string;
      const protocolFilter = a.protocol as Protocol | undefined;
      const limit = Math.max(1, Math.min(100, (a.limit as number | undefined) ?? 20));
      if (!query || !query.trim()) {
        throw new Error("search_methods requires a non-empty `query`.");
      }
      const hits = searchAllMethods(query.trim(), protocolFilter, limit);
      return jsonResult({ query, total: hits.length, hits });
    }

    if (name === "list_packages") {
      const protocol = a.protocol as Protocol | undefined;
      const all = (protocol ? [protocol] : PROTOCOLS).flatMap((p) =>
        listInstalledPackages(p).map((pkg) => ({ protocol: p, ...pkg })),
      );
      return jsonResult(all);
    }

    if (name === "list_methods") {
      const services = parseServicesForPackage(
        a.protocol as Protocol,
        a.packageName as string,
      );
      const summary = services.map((svc) => ({
        name: svc.name,
        fullName: svc.fullName,
        methods: svc.methods.map((m) => m.name),
        callability: serviceCallability(svc.fullName),
      }));
      return jsonResult(summary);
    }

    if (name === "describe_method") {
      const { service, method } = findMethod(
        a.protocol as Protocol,
        a.packageName as string,
        a.serviceName as string,
        a.methodName as string,
      );
      // defaultBody seeds call_method — zero-valued JSON matching the request
      // schema. AI fills in the real values without having to guess field
      // names or nesting structure.
      const defaultBody = generateDefaultJson(method.requestFields);
      return jsonResult({ service: service.fullName, ...method, defaultBody });
    }

    if (name === "describe_service") {
      const service = findService(
        a.protocol as Protocol,
        a.packageName as string,
        a.serviceName as string,
      );
      // Synthesize defaultBody per method so the AI gets everything it needs
      // for follow-up call_method without further describe_method round trips.
      const methods = service.methods.map((m) => ({
        ...m,
        defaultBody: generateDefaultJson(m.requestFields),
      }));
      return jsonResult({
        service: service.fullName,
        callability: serviceCallability(service.fullName),
        methodCount: methods.length,
        methods,
      });
    }

    if (name === "uninstall_package") {
      const result = await uninstallPackageViaNpm(
        a.protocol as Protocol,
        a.packageName as string,
      );
      return jsonResult(
        {
          ok: result.ok,
          exitCode: result.code,
          dir: result.dir,
          npmBinary: result.npmBinary,
          output: result.output,
        },
        !result.ok,
      );
    }

    if (name === "install_package") {
      const result = await installPackageViaNpm(
        a.protocol as Protocol,
        a.packageSpec as string,
      );
      return jsonResult(
        {
          ok: result.ok,
          exitCode: result.code,
          dir: result.dir,
          npmBinary: result.npmBinary,
          output: result.output,
        },
        !result.ok,
      );
    }

    if (name === "list_environments") {
      const protocol = a.protocol as Protocol | undefined;
      const cfg = readConfig();
      const targets = protocol ? [protocol] : PROTOCOLS;
      const out = targets.flatMap((p) =>
        (getSection(cfg, p).environments ?? []).map((env) => ({
          protocol: p,
          ...env,
        })),
      );
      return jsonResult(out);
    }

    if (name === "resolve_environment") {
      const protocol = a.protocol as Protocol;
      const { environment: env, url, defaultHeaders } = resolveEnvironmentTarget(
        protocol,
        a.environmentName as string,
      );
      return jsonResult({
        protocol,
        name: env.name,
        url,
        variables: env.variables,
        defaultHeaders,
      });
    }

    if (name === "package_status") {
      const protocol = a.protocol as Protocol | undefined;
      const cfg = readConfig();
      const targets = protocol ? [protocol] : PROTOCOLS;
      const out = targets.map((p) => {
        const declared = getSection(cfg, p).packages ?? [];
        const installed = listInstalledPackages(p);
        const installedMap = new Map(installed.map((i) => [i.name, i.version]));

        const declaredStatus = declared.map((spec) => {
          const name = packageNameFromSpec(spec);
          const installedVersion = name ? installedMap.get(name) : undefined;
          return {
            spec,
            name,
            installed: installedVersion !== undefined,
            installedVersion: installedVersion ?? null,
          };
        });

        const declaredNames = new Set(
          declaredStatus.map((d) => d.name).filter((n): n is string => Boolean(n)),
        );
        const unmanaged = installed
          .filter((i) => !declaredNames.has(i.name))
          .map((i) => ({ name: i.name, version: i.version }));

        return { protocol: p, declared: declaredStatus, unmanaged };
      });
      return jsonResult(out);
    }

    if (name === "get_default_headers") {
      const protocol = a.protocol as DesktopProtocol | undefined;
      return jsonResult({
        sqlite: desktopStateStatus(),
        headers: readDefaultHeaders({ protocol }),
      });
    }

    if (name === "list_saved_requests") {
      return jsonResult({
        sqlite: desktopStateStatus(),
        requests: readSavedRequests({
          protocol: a.protocol as DesktopProtocol | undefined,
          query: a.query as string | undefined,
          limit: a.limit as number | undefined,
        }),
      });
    }

    if (name === "search_request_history") {
      return jsonResult({
        sqlite: desktopStateStatus(),
        history: readRequestHistory({
          protocol: a.protocol as DesktopProtocol | undefined,
          query: a.query as string | undefined,
          limit: a.limit as number | undefined,
        }),
      });
    }

    if (name === "compare_environments") {
      const protocol = a.protocol as Protocol;
      const envNames = (a.environmentNames as string[]) ?? [];
      validateCompareEnvironmentNames(envNames);
      const body = (a.body as string) ?? "{}";
      preflightJsonBody(body);
      const headers = a.headers as Record<string, string> | undefined;
      const cfg = readConfig();
      // Resolve routing once — the same RPC is invoked across every env.
      const routing = resolveCallRouting({
        protocol,
        packageName: a.packageName as string | undefined,
        serviceName: a.serviceName as string | undefined,
        methodName: a.methodName as string | undefined,
        servicePath: a.servicePath as string | undefined,
      });

      const results = await Promise.all(
        envNames.map(async (envName) => {
          const env = findEnvironment(cfg, protocol, envName);
          if (!env || !env.variables.URL) {
            return {
              environment: envName,
              error: env
                ? `Environment ${envName} has no URL variable`
                : `Environment ${envName} not found for ${protocol}`,
            };
          }
          // Each environment gets its own correlation id — same as separate
          // desktop-UI sends would each generate their own.
          const requestId = generatePenguinRequestId();
          const metadata = asMetadata(attachRequestId(headers, PENGUIN_REQUEST_ID_HEADER, requestId));
          try {
            const response = await invokeRpc({
              protocol,
              url: env.variables.URL,
              body,
              metadata,
              ...routing,
            });
            const guarded = applyResponseGuard(response);
            return {
              environment: envName,
              url: env.variables.URL,
              response: {
                ...guarded,
                headers: attachRequestId(guarded.headers, PENGUIN_REQUEST_ID_HEADER, requestId),
              },
            };
          } catch (err) {
            return {
              environment: envName,
              url: env.variables.URL,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      return jsonResult({ protocol, results });
    }

    if (name === "call_method") {
      const protocol = a.protocol as Protocol;
      const environmentName = a.environmentName as string | undefined;
      const explicitUrl = a.url as string | undefined;
      requireCallTarget(explicitUrl, environmentName);
      const resolvedEnv = environmentName ? resolveEnvironmentTarget(protocol, environmentName) : undefined;
      const url = explicitUrl ?? resolvedEnv!.url;
      const headers = { ...(resolvedEnv?.defaultHeaders ?? {}), ...(a.headers as Record<string, string> | undefined) };
      const requestId = generatePenguinRequestId();
      // Always generated fresh, overriding any caller-supplied value — matches
      // the desktop send pipeline's "manually-entered x-penguin-id is replaced"
      // behavior in src/components/request/RequestPanel.tsx.
      const metadata = asMetadata(attachRequestId(headers, PENGUIN_REQUEST_ID_HEADER, requestId));
      const body = (a.body as string) ?? "{}";
      preflightJsonBody(body);
      const routing = resolveCallRouting({
        protocol,
        packageName: a.packageName as string | undefined,
        serviceName: a.serviceName as string | undefined,
        methodName: a.methodName as string | undefined,
        servicePath: a.servicePath as string | undefined,
      });
      const result = await invokeRpc({
        protocol,
        url,
        body,
        metadata,
        ...routing,
      });
      const guarded = applyResponseGuard(result);
      return jsonResult({
        ...guarded,
        environment: resolvedEnv?.environment.name,
        url,
        headers: attachRequestId(guarded.headers, PENGUIN_REQUEST_ID_HEADER, requestId),
      });
    }

    throw new Error(
      `Unknown tool: ${name}. Valid tools: mcp_health, search_methods, list_packages, list_methods, describe_method, describe_service, install_package, uninstall_package, list_environments, resolve_environment, package_status, get_default_headers, list_saved_requests, search_request_history, compare_environments, call_method.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    return jsonResult(
      code ? { code, message: msg, retryable: code === "QUERY_BUSY" } : `Error: ${msg}`,
      true,
    );
  }
});

// Silence the unused-import warning while keeping EnvironmentEntry in the
// public surface — downstream tooling may want to import it from this module.
export type { EnvironmentEntry };

const transport = new StdioServerTransport();
await server.connect(transport);
