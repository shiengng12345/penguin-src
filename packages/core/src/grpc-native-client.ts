import type { ResponseState, MetadataEntry } from "./types.js";
import type { SidecarRunner } from "./sidecar-runner.js";

export interface GrpcNativeCallParams {
  url: string;
  servicePath: string;
  body: string;
  metadata: MetadataEntry[];
  packagesDir: string;
}

// Builds the full Node.js script (input payload + sidecar logic) for one
// gRPC-Native call. Caller must ensure @grpc/grpc-js and @grpc/proto-loader
// are installed under packagesDir/node_modules.
export function buildGrpcNativeScript(params: GrpcNativeCallParams): string {
  const { url, servicePath, body, metadata, packagesDir } = params;

  const parts = servicePath.replace(/^\//, "").split("/");
  const typeName = parts.length >= 3
    ? parts.slice(1, -1).join(".")
    : parts.slice(0, -1).join(".");
  const methodName = parts[parts.length - 1];

  const enabledMeta = metadata
    .filter((m) => m.enabled && m.key.trim())
    .reduce((acc, m) => {
      acc[m.key] = m.value;
      return acc;
    }, {} as Record<string, string>);

  const request = {
    url,
    typeName,
    methodName,
    body,
    metadata: enabledMeta,
    packagesDir,
  };

  return `process.argv[1] = ${JSON.stringify(JSON.stringify(request))};\n${SIDECAR_SCRIPT}`;
}

export async function callGrpcNative(
  params: GrpcNativeCallParams,
  runner: SidecarRunner,
): Promise<ResponseState> {
  const startTime = performance.now();

  try {
    const fullScript = buildGrpcNativeScript(params);
    const output = await runner(fullScript);
    const duration = performance.now() - startTime;

    if (output.code !== 0) {
      return {
        status: "ERROR",
        statusCode: 0,
        body: "",
        headers: {},
        duration: Math.round(duration),
        error: output.stderr || "Node sidecar process failed",
      };
    }

    try {
      const result = JSON.parse(output.stdout);
      return {
        status: result.error ? `gRPC ${result.statusCode}` : "OK",
        statusCode: result.statusCode ?? 0,
        body:
          typeof result.body === "string"
            ? result.body
            : JSON.stringify(result.body, null, 2),
        headers: result.headers ?? {},
        duration: Math.round(duration),
        error: result.error,
      };
    } catch {
      return {
        status: "OK",
        statusCode: 200,
        body: output.stdout,
        headers: {},
        duration: Math.round(duration),
      };
    }
  } catch (error) {
    const duration = performance.now() - startTime;
    return {
      status: "ERROR",
      statusCode: 0,
      body: "",
      headers: {},
      duration: Math.round(duration),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const SIDECAR_SCRIPT = `
const path = require('path');
const fs = require('fs');
const input = JSON.parse(process.argv[1]);

const modulePath = path.join(input.packagesDir, 'node_modules');
module.paths.unshift(modulePath);

const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const target = input.url.replace(/^https?:\\/\\//, '');
const useTls = input.url.startsWith('https://');

const nodeModules = path.join(input.packagesDir, 'node_modules');
const pkgJson = JSON.parse(fs.readFileSync(path.join(input.packagesDir, 'package.json'), 'utf-8'));
const userDeps = Object.keys(pkgJson.dependencies || {}).filter(d => !d.startsWith('@grpc/'));

function findProtos(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findProtos(full));
    else if (entry.name.endsWith('.proto')) results.push(full);
  }
  return results;
}

const allProtos = [];
const protoOwners = new Map();
const pkgIncludeDirs = new Map();
for (const dep of userDeps) {
  const pkgProtoDir = path.join(nodeModules, dep, 'dist', 'protos');
  const found = findProtos(pkgProtoDir);
  if (found.length === 0) continue;
  const dirs = new Set([pkgProtoDir]);
  for (const p of found) {
    allProtos.push(p);
    protoOwners.set(p, dep);
    dirs.add(path.dirname(p));
  }
  pkgIncludeDirs.set(dep, [...dirs]);
}

if (allProtos.length === 0) {
  console.log(JSON.stringify({ error: 'No .proto files found for packages: ' +userDeps.join(', '), statusCode: 0, body: '', headers: {} }));
  process.exit(0);
}

// Find which proto file(s) define the target service to avoid duplicate symbol errors
const svcShortName = input.typeName.split('.').pop();
const matchingProtos = allProtos.filter(p => {
  try {
    const content = fs.readFileSync(p, 'utf-8');
    return content.includes('service ' +svcShortName);
  } catch { return false; }
});

const protosToLoad = matchingProtos.length > 0 ? matchingProtos : allProtos;

// Group protos by owning package and load each group with ONLY that
// package's proto dirs: several packages ship same-named protos (e.g.
// common.proto), and a shared includeDirs list lets an import resolve to
// another package's copy, breaking type references.
const protosByPkg = new Map();
for (const proto of protosToLoad) {
  const dep = protoOwners.get(proto);
  if (!protosByPkg.has(dep)) protosByPkg.set(dep, []);
  protosByPkg.get(dep).push(proto);
}

function loadProtoGroup(protos, includeDirs) {
  return protoLoader.loadSync(protos, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: false,
    oneofs: true,
    includeDirs: includeDirs,
  });
}

const packageDef = {};
let lastLoadError = null;

function mergeDefinition(single) {
  for (const [k, v] of Object.entries(single)) {
    if (!packageDef[k]) packageDef[k] = v;
  }
}

for (const [dep, protos] of protosByPkg) {
  const includeDirs = pkgIncludeDirs.get(dep) || [];
  try {
    mergeDefinition(loadProtoGroup(protos, includeDirs));
  } catch (loadErr) {
    // Fallback: load one proto at a time and merge, skipping duplicates
    for (const proto of protos) {
      try {
        mergeDefinition(loadProtoGroup([proto], includeDirs));
      } catch (protoErr) {
        lastLoadError = protoErr;
      }
    }
    if (!lastLoadError) lastLoadError = loadErr;
  }
}

const grpcObj = grpc.loadPackageDefinition(packageDef);

function findService(obj, typeName) {
  const parts = typeName.split('.');
  let current = obj;
  for (const p of parts) {
    if (!current || !current[p]) return null;
    current = current[p];
  }
  return current;
}

const ServiceClass = findService(grpcObj, input.typeName);
if (!ServiceClass || !ServiceClass.service) {
  let notFound = 'Service not found: ' +input.typeName;
  if (lastLoadError) {
    notFound += ' (proto load failed: ' +(lastLoadError.message || String(lastLoadError)) +')';
  }
  console.log(JSON.stringify({ error: notFound, statusCode: 0, body: '', headers: {} }));
  process.exit(0);
}

const creds = useTls
  ? grpc.credentials.createSsl()
  : grpc.credentials.createInsecure();

const client = new ServiceClass(target, creds);

const meta = new grpc.Metadata();
for (const [k, v] of Object.entries(input.metadata || {})) {
  if (k && v) meta.set(k, v);
}

let reqBody;
try {
  reqBody = JSON.parse(input.body);
} catch {
  reqBody = {};
}

const method = client[input.methodName];
if (!method) {
  console.log(JSON.stringify({ error: 'Method not found: ' +input.methodName +'. Available: ' +Object.keys(ServiceClass.service).join(', '), statusCode: 0, body: '', headers: {} }));
  client.close();
  process.exit(0);
}

method.call(client, reqBody, meta, (err, response) => {
  if (err) {
    console.log(JSON.stringify({
      error: err.message || err.details,
      statusCode: err.code || 0,
      body: JSON.stringify({ code: err.code, details: err.details, metadata: err.metadata?.toJSON() }, null, 2),
      headers: err.metadata ? err.metadata.toJSON() : {},
    }));
  } else {
    console.log(JSON.stringify({
      statusCode: 0,
      body: JSON.stringify(response, null, 2),
      headers: {},
    }));
  }
  client.close();
  process.exit(0);
});
`;
