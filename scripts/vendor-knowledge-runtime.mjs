// Assemble a self-contained runtime for the packaged knowledge CLI next to the
// esbuild bundle, so a shipped Tauri app needs NO pnpm node_modules tree:
//
//   packages/knowledge-cli/bundle/
//     penguin.mjs                 (esbuild bundle — built separately)
//     node                        (Node binary; ABI + arch match the .node)
//     node_modules/               (native better-sqlite3 + its runtime closure)
//     wasm/                       (web-tree-sitter runtime + grammar .wasm — arch-independent)
//
// Arch-aware: the release matrix cross-builds arm64 AND x64 on an arm64 runner,
// so the vendored Node binary + better-sqlite3 .node must match the *target*
// arch (PENGUIN_TARGET_ARCH), not the host. When target arch+ABI already match
// the host toolchain we reuse it (fast path); otherwise we download the exact
// official Node binary + better-sqlite3 prebuild for the target.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "packages/knowledge-core/index.js"));
const indexerRequire = createRequire(join(repoRoot, "packages/knowledge-indexer/dist/index.js"));
const bundleDir = join(repoRoot, "packages/knowledge-cli/bundle");
const vendoredModules = join(bundleDir, "node_modules");
const wasmDir = join(bundleDir, "wasm");
const cacheDir = join(repoRoot, ".cache/vendor");

// --- target selection -------------------------------------------------------
const NODE_VERSION = process.env.PENGUIN_NODE_VERSION ?? "v22.23.1"; // Node 22 LTS
// NODE_MODULE_VERSION (native ABI) per Node major — the better-sqlite3 prebuild tag.
const ABI_BY_MAJOR = { 18: 108, 20: 115, 22: 127, 23: 131 };
const nodeMajor = Number(NODE_VERSION.replace(/^v/, "").split(".")[0]);
const targetAbi = ABI_BY_MAJOR[nodeMajor];
if (!targetAbi) throw new Error(`unknown Node ABI for ${NODE_VERSION}; add it to ABI_BY_MAJOR`);

const normArch = (a) => (a === "x86_64" ? "x64" : a === "aarch64" ? "arm64" : a);
const targetArch = normArch(process.env.PENGUIN_TARGET_ARCH ?? process.arch);
const hostArch = normArch(process.arch);
const hostAbi = Number(process.versions.modules);

function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) return dest;
  console.log(`[vendor] download ${url}`);
  execFileSync("curl", ["-fsSL", "-o", dest, url], { stdio: ["ignore", "ignore", "inherit"] });
  return dest;
}
function untar(tgz, into) {
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["-xzf", tgz, "-C", into]);
}

// --- 1) native addon closure: better-sqlite3 → bindings → file-uri-to-path ---
function pkgDir(spec, fromDir) {
  const req = fromDir ? createRequire(join(fromDir, "index.js")) : require;
  return dirname(req.resolve(`${spec}/package.json`));
}
function copyInto(srcDir, spec) {
  const dst = join(vendoredModules, spec);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(srcDir, dst, { recursive: true, dereference: true });
  return dst;
}

rmSync(bundleDir + "/node_modules", { recursive: true, force: true });
mkdirSync(vendoredModules, { recursive: true });
const bsqSrc = pkgDir("better-sqlite3");
const bsqVersion = require(join(bsqSrc, "package.json")).version;
copyInto(bsqSrc, "better-sqlite3");
copyInto(pkgDir("bindings", bsqSrc), "bindings");
copyInto(pkgDir("file-uri-to-path", pkgDir("bindings", bsqSrc)), "file-uri-to-path");

// Overlay the target-arch/ABI prebuilt .node when the installed one (built for
// the host) doesn't match the target. Host-matches-target → keep installed.
const dotNode = join(vendoredModules, "better-sqlite3/build/Release/better_sqlite3.node");
if (targetArch !== hostArch || targetAbi !== hostAbi) {
  const name = `better-sqlite3-v${bsqVersion}-node-v${targetAbi}-darwin-${targetArch}.tar.gz`;
  const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${bsqVersion}/${name}`;
  const tgz = download(url, join(cacheDir, name));
  const tmp = join(cacheDir, `bsq-${targetArch}-${targetAbi}`);
  rmSync(tmp, { recursive: true, force: true });
  untar(tgz, tmp);
  cpSync(join(tmp, "build/Release/better_sqlite3.node"), dotNode, { dereference: true });
  console.log(`[vendor] overlaid better-sqlite3 .node → darwin-${targetArch} abi ${targetAbi}`);
}
if (!statSync(dotNode, { throwIfNoEntry: false })) {
  throw new Error(`vendored better-sqlite3 is missing its native addon: ${dotNode}`);
}

// --- 2) wasm (arch-independent): runtime + every grammar, flattened ----------
function pkgRootByEntry(spec, req) {
  let dir = dirname(req.resolve(spec));
  while (dir !== dirname(dir)) {
    if (statSync(join(dir, "package.json"), { throwIfNoEntry: false })) return dir;
    dir = dirname(dir);
  }
  throw new Error(`package root not found for ${spec}`);
}
rmSync(wasmDir, { recursive: true, force: true });
mkdirSync(wasmDir, { recursive: true });
const wtsDir = pkgRootByEntry("web-tree-sitter", indexerRequire);
cpSync(join(wtsDir, "tree-sitter.wasm"), join(wasmDir, "tree-sitter.wasm"));
const grammarsOut = join(dirname(indexerRequire.resolve("tree-sitter-wasms/package.json")), "out");
let grammarCount = 0;
for (const f of readdirSync(grammarsOut)) {
  if (f.endsWith(".wasm")) {
    cpSync(join(grammarsOut, f), join(wasmDir, f));
    grammarCount++;
  }
}

// --- 3) Node binary (target arch). Reuse host node only when it matches. -----
const nodeDst = join(bundleDir, "node");
const hostMatches = targetArch === hostArch && nodeMajor === Number(process.versions.node.split(".")[0]);
if (hostMatches) {
  cpSync(process.execPath, nodeDst, { dereference: true });
} else {
  const tarName = `node-${NODE_VERSION}-darwin-${targetArch}.tar.gz`;
  const tgz = download(`https://nodejs.org/dist/${NODE_VERSION}/${tarName}`, join(cacheDir, tarName));
  const tmp = join(cacheDir, `node-${NODE_VERSION}-${targetArch}`);
  rmSync(tmp, { recursive: true, force: true });
  untar(tgz, tmp);
  cpSync(join(tmp, `node-${NODE_VERSION}-darwin-${targetArch}/bin/node`), nodeDst, { dereference: true });
}
chmodSync(nodeDst, 0o755);

console.log(
  `[vendor] target=darwin-${targetArch} node=${NODE_VERSION} (abi ${targetAbi})` +
    `${hostMatches ? " [reused host]" : " [downloaded]"}\n` +
    `[vendor] better-sqlite3@${bsqVersion} + ${grammarCount} grammars + runtime wasm → ${bundleDir}`,
);
