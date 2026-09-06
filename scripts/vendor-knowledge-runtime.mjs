// Assemble a self-contained runtime for the packaged knowledge CLI next to the
// esbuild bundle, so a shipped Tauri app needs NO pnpm node_modules tree:
//
//   packages/knowledge-cli/bundle/
//     penguin.mjs                 (esbuild bundle — built separately)
//     node                        (Node binary; ABI + arch match the .node)
//     node_modules/               (native better-sqlite3 + its runtime closure)
//     wasm/                       (web-tree-sitter runtime + grammar .wasm — arch-independent)
//
// The installed runtime places MCP under the CLI runtime root, so MCP resolves
// the shared Node + node_modules from its parent. The workspace MCP bundle
// remains self-contained for local black-box tests, but Tauri packages only
// its dist tree and package marker (see tauri.conf.json) to avoid a second
// 300+ MB native runtime inside the app.
//
//   packages/mcp/bundle/
//     node                        (same vendored Node binary)
//     node_modules/               (same native better-sqlite3 closure)
//
// Arch-aware: the release matrix cross-builds arm64 AND x64 on an arm64 runner,
// so the vendored Node binary + better-sqlite3 .node must match the *target*
// arch (PENGUIN_TARGET_ARCH), not the host. When target arch+ABI already match
// the host toolchain we reuse it (fast path); otherwise we download the exact
// official Node binary + better-sqlite3 prebuild for the target.
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { materializePinnedEmbeddingModel } from "./lib/knowledge-model-assets.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(repoRoot, "packages/knowledge-core/index.js"));
const indexerRequire = createRequire(join(repoRoot, "packages/knowledge-indexer/dist/index.js"));
const bundleDir = join(repoRoot, "packages/knowledge-cli/bundle");
const vendoredModules = join(bundleDir, "node_modules");
const wasmDir = join(bundleDir, "wasm");
const mcpBundleDir = join(repoRoot, "packages/mcp/bundle");
const cacheDir = join(repoRoot, ".cache/vendor");
const modelConfig = JSON.parse(readFileSync(join(repoRoot, "config/knowledge-embedding-models.json"), "utf8"));

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
function pkgDir(spec, fromDir, entry = "package.json") {
  const req = fromDir ? createRequire(join(fromDir, "index.js")) : require;
  try {
    return dirname(req.resolve(`${spec}/package.json`));
  } catch {
    // The base sqlite-vec package exports its package root but not package.json;
    // platform-only packages export only their loadable library.
    try {
      let candidate = dirname(req.resolve(spec));
      while (candidate !== dirname(candidate) && !statSync(join(candidate, "package.json"), { throwIfNoEntry: false })) candidate = dirname(candidate);
      if (statSync(join(candidate, "package.json"), { throwIfNoEntry: false })) return candidate;
      return dirname(req.resolve(spec));
    } catch {
      let candidate = dirname(req.resolve(`${spec}/${entry}`));
      while (candidate !== dirname(candidate) && !statSync(join(candidate, "package.json"), { throwIfNoEntry: false })) candidate = dirname(candidate);
      return candidate;
    }
  }
}
function copyInto(srcDir, spec) {
  const dst = join(vendoredModules, spec);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(srcDir, dst, { recursive: true, dereference: true });
  return dst;
}

function downloadNpmPackage(spec, version) {
  const archiveName = `${spec}-${version}.tgz`;
  const archive = download(`https://registry.npmjs.org/${spec}/-/${archiveName}`, join(cacheDir, archiveName));
  const unpacked = join(cacheDir, `${spec}-${version}-package`);
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  untar(archive, unpacked);
  const packageRoot = join(unpacked, "package");
  if (!statSync(packageRoot, { throwIfNoEntry: false })) throw new Error(`downloaded npm package has no package directory: ${spec}@${version}`);
  return packageRoot;
}

rmSync(bundleDir + "/node_modules", { recursive: true, force: true });
mkdirSync(vendoredModules, { recursive: true });
const bsqSrc = pkgDir("better-sqlite3");
const bsqVersion = require(join(bsqSrc, "package.json")).version;
copyInto(bsqSrc, "better-sqlite3");
copyInto(pkgDir("bindings", bsqSrc), "bindings");
copyInto(pkgDir("file-uri-to-path", pkgDir("bindings", bsqSrc)), "file-uri-to-path");

// sqlite-vec is a JavaScript loader plus a platform-only dylib. Copy both so
// the loader can resolve the exact target architecture in the isolated bundle.
const sqliteVecSrc = pkgDir("sqlite-vec", undefined, "index.cjs");
const sqliteVecVersion = JSON.parse(readFileSync(join(sqliteVecSrc, "package.json"), "utf8")).version;
const sqliteVecPlatformPackage = `sqlite-vec-darwin-${targetArch}`;
let sqliteVecPlatformSrc;
try {
  sqliteVecPlatformSrc = pkgDir(sqliteVecPlatformPackage, undefined, "vec0.dylib");
} catch {
  sqliteVecPlatformSrc = downloadNpmPackage(sqliteVecPlatformPackage, sqliteVecVersion);
}
copyInto(sqliteVecSrc, "sqlite-vec");
copyInto(sqliteVecPlatformSrc, sqliteVecPlatformPackage);
const sqliteVecLibrary = join(vendoredModules, sqliteVecPlatformPackage, "vec0.dylib");
if (!statSync(sqliteVecLibrary, { throwIfNoEntry: false })) {
  throw new Error(`vendored sqlite-vec is missing its target library: ${sqliteVecLibrary}`);
}

// re2-wasm is loaded lazily by the bundled CLI/MCP regex lane through
// createRequire, so esbuild cannot inline it. Keep the package beside the
// self-contained runtime, including its wasm payload.
copyInto(pkgDir("re2-wasm"), "re2-wasm");

// Transformers.js is bundled into the CLI/MCP JavaScript, while its ONNX
// engine remains external because esbuild cannot inline native `.node` files.
// Copy the exact target native runtime and its dependency beside the bundles.
const transformersSrc = pkgDir("@huggingface/transformers");
copyInto(transformersSrc, "@huggingface/transformers");
const onnxRuntimeSrc = pkgDir("onnxruntime-node", transformersSrc);
const onnxRuntimeVersion = JSON.parse(readFileSync(join(onnxRuntimeSrc, "package.json"), "utf8")).version;
const onnxTargetDir = join(onnxRuntimeSrc, "bin", "napi-v6", "darwin", targetArch);
if (!statSync(onnxTargetDir, { throwIfNoEntry: false })) {
  throw new Error(`onnxruntime-node@${onnxRuntimeVersion} has no darwin-${targetArch} payload; install/vendor the target package before release`);
}
const vendoredOnnxRuntime = copyInto(onnxRuntimeSrc, "onnxruntime-node");
// onnxruntime-node publishes every supported OS/architecture in one npm
// package. A macOS app can execute exactly one target payload, so retaining
// Linux/Windows and the other Mac architecture only inflates the release.
const vendoredOnnxNativeRoot = join(vendoredOnnxRuntime, "bin", "napi-v6");
for (const platform of readdirSync(vendoredOnnxNativeRoot)) {
  const platformDir = join(vendoredOnnxNativeRoot, platform);
  if (!statSync(platformDir).isDirectory()) continue;
  for (const arch of readdirSync(platformDir)) {
    const archDir = join(platformDir, arch);
    if (platform !== "darwin" || arch !== targetArch) {
      rmSync(archDir, { recursive: true, force: true });
    }
  }
  if (readdirSync(platformDir).length === 0) rmSync(platformDir, { recursive: true, force: true });
}
copyInto(pkgDir("onnxruntime-common", onnxRuntimeSrc), "onnxruntime-common");

// Transformers imports Sharp at module initialization even for text-only
// feature extraction. Its JavaScript is bundled, but the target binding and
// libvips payload are resolved dynamically and must sit in node_modules.
const sharpSrc = pkgDir("sharp", transformersSrc);
const sharpVersion = JSON.parse(readFileSync(join(sharpSrc, "package.json"), "utf8")).version;
const sharpPlatformPackage = `@img/sharp-darwin-${targetArch}`;
const sharpLibvipsPackage = `@img/sharp-libvips-darwin-${targetArch}`;
copyInto(sharpSrc, "sharp");
copyInto(pkgDir("@img/colour", sharpSrc), "@img/colour");
copyInto(pkgDir("detect-libc", sharpSrc), "detect-libc");
copyInto(pkgDir("semver", sharpSrc), "semver");
copyInto(pkgDir(sharpPlatformPackage, sharpSrc, "sharp.node"), sharpPlatformPackage);
copyInto(pkgDir(sharpLibvipsPackage, sharpSrc, "lib"), sharpLibvipsPackage);

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

// --- 4) pinned local embedding model (verified, no runtime download) --------
const selectedModel = modelConfig.selected;
if (!selectedModel || selectedModel.runtimeDownloadAllowed !== false) {
  throw new Error("pinned local embedding model is not selected");
}
const modelCacheDir = join(repoRoot, ".cache/models", selectedModel.bundleDirectory);
for (const asset of selectedModel.assets) {
  download(
    `https://huggingface.co/${selectedModel.modelId}/resolve/${selectedModel.revision}/${asset.path}`,
    join(modelCacheDir, asset.path),
  );
}
const modelResult = materializePinnedEmbeddingModel({
  selection: selectedModel,
  cacheDirectory: modelCacheDir,
  outputDirectory: join(bundleDir, "models", selectedModel.bundleDirectory),
});

console.log(
  `[vendor] target=darwin-${targetArch} node=${NODE_VERSION} (abi ${targetAbi})` +
    `${hostMatches ? " [reused host]" : " [downloaded]"}\n` +
    `[vendor] better-sqlite3@${bsqVersion} + sqlite-vec@${sqliteVecVersion} (${sqliteVecPlatformPackage}) + onnxruntime-node@${onnxRuntimeVersion} + sharp@${sharpVersion} (${sharpPlatformPackage}) + ${grammarCount} grammars + runtime wasm → ${bundleDir}\n` +
    `[vendor] ${selectedModel.modelId}@${selectedModel.revision.slice(0, 12)} (${modelResult.modelBytes} bytes, ${modelResult.assetCount} verified assets) → ${modelResult.outputDirectory}`,
);

// --- 5) materialize a self-contained MCP release directory -----------------
// Keep dist beside node_modules so Node cannot accidentally resolve a pnpm
// workspace addon compiled for a different ABI during doctor/release checks.
rmSync(join(mcpBundleDir, "node_modules"), { recursive: true, force: true });
rmSync(join(mcpBundleDir, "dist"), { recursive: true, force: true });
mkdirSync(mcpBundleDir, { recursive: true });
cpSync(vendoredModules, join(mcpBundleDir, "node_modules"), { recursive: true, dereference: true });
cpSync(join(repoRoot, "packages/mcp/dist"), join(mcpBundleDir, "dist"), { recursive: true, dereference: true });
cpSync(join(repoRoot, "packages/mcp/package.json"), join(mcpBundleDir, "package.json"), { dereference: true });
cpSync(nodeDst, join(mcpBundleDir, "node"), { dereference: true });
chmodSync(join(mcpBundleDir, "node"), 0o755);
console.log(`[vendor] materialized self-contained MCP runtime → ${mcpBundleDir}`);
