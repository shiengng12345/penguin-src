#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const DB = join(homedir(), ".penguin", "knowledge", "knowledge.db");
const PROJECTS = "/Users/shieng/Desktop/Projects";
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  ".git", ".codegraph", ".next", ".nuxt", ".turbo", ".yarn", "coverage", "dist",
  "build", "node_modules", "target", "graphify-out",
]);

export function sql(query, dbPath = DB) {
  // `immutable=1` ignores WAL content and can silently audit a pre-rebuild
  // snapshot. Plain read-only URI mode remains non-mutating while observing
  // committed rows from both the main database and its WAL.
  const out = spawnSync("sqlite3", ["-json", `file:${dbPath}?mode=ro`, query], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (out.error) throw out.error;
  if (out.status !== 0) throw new Error(out.stderr || "sqlite query failed");
  return JSON.parse(out.stdout || "[]");
}

function walk(root, accept) {
  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".env")) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(absolute);
      } else if (entry.isFile() && accept(absolute)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  return null;
}

function receiverName(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)
    || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && node.expression.kind === ts.SyntaxKind.ThisKeyword) return node.name.text;
  return null;
}

export function getterClientCalls(sourceFile) {
  const clients = new Set();
  const collectClients = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isPropertyAccessExpression(node.initializer.expression)
      && /^get\w*Client$/i.test(node.initializer.expression.name.text)
      && /grpc/i.test(receiverName(node.initializer.expression.expression) ?? "")) {
      clients.add(node.name.text);
    }
    ts.forEachChild(node, collectClients);
  };
  collectClients(sourceFile);

  const calls = [];
  const collectCalls = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = receiverName(node.expression.expression);
      if (receiver && clients.has(receiver)) {
        calls.push({ method: node.expression.name.text, line: lineOf(sourceFile, node) });
      }
    }
    ts.forEachChild(node, collectCalls);
  };
  collectCalls(sourceFile);
  return calls;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function endpointKey(service, method) {
  return `grpc::${service}.${method.toLowerCase()}`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function smallestEnclosingSymbol(symbolsByFile, repo, relPath, line) {
  const rows = symbolsByFile.get(`${repo}\0${relPath}`) ?? [];
  return rows
    .filter((row) => row.startLine <= line && line <= row.endLine)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0] ?? null;
}

function getServiceBindings(sourceFile) {
  const bindings = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "getService") {
      const arg = node.arguments.find(ts.isStringLiteralLike);
      const service = arg?.text ?? node.typeArguments?.[0]?.getText(sourceFile).replace(/<.*$/, "") ?? null;
      if (service) {
        const parent = node.parent;
        if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const name = receiverName(parent.left);
          if (name) bindings.set(name, service);
        } else if (ts.isVariableDeclaration(parent)) {
          const name = propertyName(parent.name);
          if (name) bindings.set(name, service);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function forwardingMethods(sourceFile) {
  const methods = new Set();
  const visit = (node) => {
    if (ts.isPropertyDeclaration(node)
      && node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword)
      && node.initializer && ts.isArrowFunction(node.initializer)) {
      const name = propertyName(node.name);
      if (!name) return;
      const netCalls = [];
      const scan = (child) => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression)) {
          const outer = child.expression;
          if (ts.isPropertyAccessExpression(outer.expression)
            && outer.expression.expression.kind === ts.SyntaxKind.ThisKeyword
            && outer.expression.name.text === "_net") netCalls.push(outer.name.text);
        }
        ts.forEachChild(child, scan);
      };
      scan(node.initializer.body);
      if (netCalls.length === 1 && netCalls[0] === name) methods.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return methods;
}

function functionNameCalls(sourceFile, verifiedMethods) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const firstObject = node.arguments.find(ts.isObjectLiteralExpression);
      const property = firstObject?.properties.find((item) =>
        ts.isPropertyAssignment(item) && propertyName(item.name) === "functionName");
      if (property && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
        && verifiedMethods.has(property.initializer.text)) {
        calls.push({ method: property.initializer.text, line: lineOf(sourceFile, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

export function handleApiRequestCalls(sourceFile) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "handleApiRequest") {
      const method = node.arguments.find(ts.isStringLiteralLike);
      if (method) calls.push({ method: method.text, line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function grpcProxyCalls(sourceFile, bindings) {
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const receiver = receiverName(node.expression.expression);
      const service = receiver ? bindings.get(receiver) : null;
      if (service) calls.push({ service, method: node.expression.name.text, line: lineOf(sourceFile, node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

function fpmsJsCalls(source) {
  const services = new Map();
  for (const match of source.matchAll(/\[(\w+)\]\s*:\s*\{[^}]*serviceName\s*:\s*['"](\w+)['"]/g)) {
    services.set(match[1], match[2]);
  }
  const calls = [];
  for (const match of source.matchAll(/(\w+)\s*:\s*(?:async\s+)?function\s*\([^)]*\)\s*\{/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let cursor = start;
    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = source.slice(start, cursor - 1);
    const serviceKey = body.match(/createGrpcClientFromRegistry\((\w+)/)?.[1];
    const method = body.match(/grpcClientCall\([^,]+,\s*['"](\w+)['"]/)?.[1];
    const service = serviceKey ? services.get(serviceKey) : null;
    if (service && method) {
      calls.push({ service, method, line: source.slice(0, match.index).split("\n").length });
    }
  }
  return calls;
}

function parseProtoRpcs(file, root) {
  const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const rows = [];
  for (const serviceMatch of source.matchAll(/\bservice\s+(\w+)\s*\{/g)) {
    let depth = 1;
    let cursor = serviceMatch.index + serviceMatch[0].length;
    while (depth > 0 && cursor < source.length) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") depth -= 1;
      cursor += 1;
    }
    const body = source.slice(serviceMatch.index + serviceMatch[0].length, cursor - 1);
    for (const rpc of body.matchAll(/\brpc\s+(\w+)\s*\(/g)) {
      rows.push({ key: endpointKey(serviceMatch[1], rpc[1]), file: relative(root, file) });
    }
  }
  return rows;
}

export function scoreRelationSets(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const tp = [...expectedSet].filter((key) => actualSet.has(key)).length;
  const fp = [...actualSet].filter((key) => !expectedSet.has(key)).length;
  const fn = [...expectedSet].filter((key) => !actualSet.has(key)).length;
  return {
    expected: expectedSet.size, actual: actualSet.size, tp, fp, fn,
    precision: actualSet.size === 0 ? (expectedSet.size === 0 ? 1 : 0) : tp / actualSet.size,
    recall: expectedSet.size === 0 ? 1 : tp / expectedSet.size,
  };
}

export function relationSetDifferences(expected, actual) {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  return {
    missing: [...expectedSet].filter((key) => !actualSet.has(key)).sort(),
    extra: [...actualSet].filter((key) => !expectedSet.has(key)).sort(),
  };
}

export function auditPassed({ precisionFailures, unsupportedCandidates, perRepo, flyoverProto }) {
  return precisionFailures.length === 0
    && unsupportedCandidates.length === 0
    && perRepo.every((row) => row.precision === 1 && row.recall === 1)
    && flyoverProto.precision === 1
    && flyoverProto.recall === 1;
}

function audit() {
  const repos = sql(`SELECT name, root_path AS rootPath FROM repos WHERE root_path LIKE '${PROJECTS.replaceAll("'", "''")}/%' ORDER BY root_path`)
    .filter((repo) => existsSync(repo.rootPath));
  const symbols = sql(`
    SELECT r.name AS repo, sv.file_path AS filePath, n.id AS nodeId,
           sv.start_line AS startLine, sv.end_line AS endLine
      FROM symbol_versions sv
      JOIN branches b ON b.id=sv.branch_id AND b.status='live'
      JOIN nodes n ON n.id=sv.node_id
      JOIN repos r ON r.id=n.repo_id
     WHERE sv.status='fresh' AND r.root_path LIKE '${PROJECTS.replaceAll("'", "''")}/%'
  `);
  const symbolsByFile = new Map();
  for (const row of symbols) {
    const key = `${row.repo}\0${row.filePath}`;
    const bucket = symbolsByFile.get(key) ?? [];
    bucket.push(row);
    symbolsByFile.set(key, bucket);
  }
  const endpoints = sql(`
    SELECT identity_key AS endpointKey, json_extract(meta,'$.service') AS service,
           json_extract(meta,'$.method') AS method
      FROM nodes WHERE node_type='endpoint' AND repo_id IS NULL
  `);
  const servicesByMethod = new Map();
  for (const endpoint of endpoints) {
    const key = String(endpoint.method ?? "").toLowerCase();
    const bucket = servicesByMethod.get(key) ?? [];
    if (endpoint.service && !bucket.includes(endpoint.service)) bucket.push(endpoint.service);
    servicesByMethod.set(key, bucket);
  }
  const invokes = sql(`
    SELECT DISTINCT r.name AS repo, r.root_path AS rootPath, n.id AS srcId,
           sv.file_path AS filePath, sv.start_line AS startLine, sv.end_line AS endLine,
           d.identity_key AS endpointKey, json_extract(d.meta,'$.method') AS method,
           COALESCE(e.source_type,'backend') AS sourceType
      FROM edges e
      JOIN nodes n ON n.id=e.src
      JOIN repos r ON r.id=n.repo_id
      JOIN symbol_versions sv ON sv.node_id=n.id AND sv.status='fresh'
      JOIN branches b ON b.id=sv.branch_id AND b.status='live'
      JOIN nodes d ON d.id=e.dst
     WHERE e.edge_type='invokes' AND e.status='active'
       AND r.root_path LIKE '${PROJECTS.replaceAll("'", "''")}/%'
  `);

  const actualByRepo = new Map();
  const precisionFailures = [];
  for (const edge of invokes) {
    const relation = `${edge.srcId}\0${edge.endpointKey}`;
    const bucket = actualByRepo.get(edge.repo) ?? [];
    bucket.push(relation);
    actualByRepo.set(edge.repo, bucket);
    const absolute = join(edge.rootPath, edge.filePath);
    if (!existsSync(absolute)) {
      precisionFailures.push({ ...edge, reason: "source_file_missing" });
      continue;
    }
    const source = readFileSync(absolute, "utf8");
    const snippet = source.split(/\r?\n/).slice(Math.max(0, edge.startLine - 1), edge.endLine).join("\n");
    const method = String(edge.method ?? "");
    const escapedMethod = escapeRegExp(method);
    const grounded = new RegExp(`\\.${escapedMethod}\\s*\\(`, "i").test(snippet)
      || new RegExp(`functionName\\s*:\\s*['\"]${escapedMethod}['\"]`, "i").test(snippet)
      || new RegExp(`grpcClientCall\\([^,]+,\\s*['\"]${escapedMethod}['\"]`, "i").test(snippet);
    if (!grounded) precisionFailures.push({ ...edge, reason: "method_not_in_symbol_source" });
  }

  const expectedByRepo = new Map();
  const unsupported = [];
  for (const repo of repos) {
    const files = walk(repo.rootPath, (file) => SOURCE_EXTENSIONS.has(extname(file)) && statSync(file).size < 2_000_000);
    const parsed = [];
    const verified = new Set();
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind(file));
      parsed.push({ file, source, sourceFile });
      for (const method of forwardingMethods(sourceFile)) verified.add(method);
    }
    const expected = [];
    for (const { file, source, sourceFile } of parsed) {
      const relPath = relative(repo.rootPath, file);
      const candidates = grpcProxyCalls(sourceFile, getServiceBindings(sourceFile));
      if (file.endsWith(".js")) candidates.push(...fpmsJsCalls(source));
      for (const call of functionNameCalls(sourceFile, verified)) {
        const services = servicesByMethod.get(call.method.toLowerCase()) ?? [];
        if (services.length === 1) candidates.push({ ...call, service: services[0] });
      }
      for (const call of getterClientCalls(sourceFile)) {
        const services = servicesByMethod.get(call.method.toLowerCase()) ?? [];
        if (services.length === 1) candidates.push({ ...call, service: services[0] });
      }
      for (const candidate of candidates) {
        const symbol = smallestEnclosingSymbol(symbolsByFile, repo.name, relPath, candidate.line);
        if (!symbol) {
          unsupported.push({ repo: repo.name, file: relPath, line: candidate.line, reason: "no_enclosing_symbol" });
          continue;
        }
        expected.push(`${symbol.nodeId}\0${endpointKey(candidate.service, candidate.method)}`);
      }
    }
    expectedByRepo.set(repo.name, expected);
  }

  const perRepo = repos.map((repo) => {
    const expected = new Set(expectedByRepo.get(repo.name) ?? []);
    const actual = new Set(actualByRepo.get(repo.name) ?? []);
    return {
      repo: repo.name,
      ...scoreRelationSets(expected, actual),
      ...relationSetDifferences(expected, actual),
    };
  });

  const fly = repos.find((repo) => repo.rootPath === join(PROJECTS, "fly"));
  let proto = { expected: 0, actual: 0, tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, missing: [], extra: [] };
  if (fly) {
    const expected = walk(fly.rootPath, (file) => file.endsWith(".proto"))
      .flatMap((file) => parseProtoRpcs(file, fly.rootPath))
      .map((row) => `${row.key}\0${row.file}`);
    const actual = sql(`
      SELECT n.identity_key AS endpointKey, json_extract(e.provenance,'$.file') AS filePath
        FROM edges e JOIN nodes n ON n.id=e.src
       WHERE e.edge_type='handles' AND e.status='active'
         AND json_extract(e.provenance,'$.repo')=(SELECT id FROM repos WHERE root_path='${fly.rootPath.replaceAll("'", "''")}')
    `).map((row) => `${row.endpointKey}\0${row.filePath}`);
    proto = { ...scoreRelationSets(expected, actual), ...relationSetDifferences(expected, actual) };
  }

  const passed = auditPassed({
    precisionFailures,
    unsupportedCandidates: unsupported,
    perRepo,
    flyoverProto: proto,
  });
  return {
    version: 1,
    scope: PROJECTS,
    repos: repos.length,
    relationEdges: invokes.length,
    precisionFailures,
    unsupportedCandidates: unsupported,
    perRepo,
    flyoverProto: proto,
    passed,
  };
}

const invokedDirectly = process.argv[1]
  ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
  : false;
if (invokedDirectly) {
  const result = audit();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}
