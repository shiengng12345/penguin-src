import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "tests", "fixtures", "knowledge-universal-retrieval");

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}

function collectFiles(root, prefix = "") {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const next = prefix ? join(prefix, entry.name) : entry.name;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) return collectFiles(absolute, next);
    return [next];
  });
}

function sha256File(file) {
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function sha256Files(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const absolute = join(ROOT, file);
    if (!existsSync(absolute)) continue;
    hash.update(file);
    hash.update("\0");
    hash.update(readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function runBaselineTest() {
  const result = spawnSync(
    process.execPath,
    ["--test", "tests/knowledge-universal-retrieval-baseline.test.mjs"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const output = (result.stdout || "") + (result.stderr || "");
  const sanitized = output.replaceAll(ROOT, "<repo>");
  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    outputTail: sanitized.trim().split("\n").slice(-12).join("\n"),
  };
}

const schemaSource = readFileSync(
  join(ROOT, "packages", "knowledge-core", "src", "schema.ts"),
  "utf8",
);
const schemaVersion = Number(
  schemaSource.match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1] ?? 0,
);
const status = git(["status", "--short", "--branch"]);
const branch = status.split("\n")[0]?.replace(/^##\s*/, "") || git(["branch", "--show-current"]);
const head = git(["rev-parse", "HEAD"]);
const fixtureFiles = collectFiles(FIXTURE);
const needles = JSON.parse(readFileSync(join(FIXTURE, "needles.json"), "utf8"));
const sourceFiles = [
  "packages/knowledge-core/src/index.ts",
  "packages/knowledge-core/src/query.ts",
  "packages/knowledge-core/src/schema.ts",
  "packages/knowledge-core/src/store.ts",
  "packages/knowledge-indexer/src/pipeline.ts",
  "packages/knowledge-indexer/src/walk.ts",
];
const bundledCli = "packages/knowledge-cli/bundle/penguin.mjs";
const bundledMcp = "packages/mcp/dist/index.js";
const installedMcp = join(process.env.HOME || "", ".penguin", "mcp", "dist", "index.js");
const bundledMcpHash = sha256File(join(ROOT, bundledMcp));
const installedMcpHash = sha256File(installedMcp);
const report = {
  capturedAt: new Date().toISOString(),
  git: {
    branch,
    head,
    dirty: status.split("\n").some((line) => line.startsWith(" M") || line.startsWith("??")),
  },
  schemaVersion,
  sourceCapabilityHash: sha256Files(sourceFiles),
  artifacts: {
    bundledCliHash: sha256File(join(ROOT, bundledCli)),
    bundledMcpHash,
    installedMcpHash,
    installedMcpPresent: Boolean(installedMcpHash),
    mcpDrift: Boolean(bundledMcpHash && installedMcpHash && bundledMcpHash !== installedMcpHash),
  },
  fixture: {
    root: relative(ROOT, FIXTURE),
    fileCount: fixtureFiles.length,
    byteCount: fixtureFiles.reduce(
      (sum, file) => sum + statSync(join(FIXTURE, file)).size,
      0,
    ),
    needleCount: needles.length,
  },
  knownMisses: [],
  tests: {
    baseline: runBaselineTest(),
  },
};

const json = JSON.stringify(report, null, 2);
if (process.argv.includes("--json") || !process.argv.includes("--human")) {
  console.log(json);
} else {
  console.log("Penguin Knowledge baseline snapshot");
  console.log(json);
}

if (process.argv.includes("--gate")) {
  if (report.tests.baseline.status !== "passed") process.exitCode = 1;
  if (report.artifacts.mcpDrift) process.exitCode = 2;
}
