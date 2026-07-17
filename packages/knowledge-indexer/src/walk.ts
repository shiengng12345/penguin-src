import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DEFAULT_COVERAGE_POLICY, classifyCoveragePath, type CoveragePolicy } from "./coverage-policy.js";
import { classifyTextBuffer } from "./text-classifier.js";
import type { DiscoveredFile, DiscoveryReport } from "./coverage.js";

export interface WalkedFile {
  absPath: string;
  relPath: string; // posix-style, repo-relative
  mtimeMs: number;
  sizeBytes: number;
}

const ALWAYS_IGNORE = new Set([
  ".git", "node_modules", "target", "dist", "build", ".next", ".turbo",
  "vendor", "bower_components", "coverage", ".nyc_output",
  "__pycache__", ".venv", "venv", ".idea", ".vscode",
]);

const DEFAULT_MAX_BYTES = 1_000_000;

// Minified/generated bundles (`*.min.js`, `vendor.bundle.js`) have no meaningful
// symbols — indexing them floods the graph with single-letter hubs (n/a/i/$).
const MINIFIED_NAME = /\.min\.(js|mjs|cjs|css)$|[.-]bundle\.js$|\.bundle\.min\./i;

// Third-party library SOURCE served as static assets (jQuery, Angular, Flot,
// require.js…) is readable — normal ~30-char lines — so it dodges both the
// minified-name and minified-content checks, then floods the graph with junk
// nodes ("T", "map", "on") and false call edges (`.filter()` → jQuery's filter).
// It always lives under a static-asset dir though. Match the RELATIVE PATH so
// real source `libs/`/`src/lib/` (no public/static/... ancestor) is untouched.
const VENDOR_PATH_RE =
  /(^|\/)(?:public|static|assets|www|TestPage)\/(?:[^/]+\/)*(?:lib|libs|vendor|common)\//i;

// Content heuristic for minified/generated files that dodge the name check: a
// large file whose average line is very long is packed, not hand-written.
export function isLikelyMinified(source: string): boolean {
  if (source.length < 3000) return false;
  const newlines = (source.match(/\n/g) ?? []).length;
  return source.length / (newlines + 1) > 300; // normal source averages ~30–80
}

// Minimal .gitignore support: exact names + `dir/` + `*.ext` globs at repo root.
// Not a full gitignore engine (nested/negation deferred) — enough to skip the
// common heavy dirs/artifacts beyond ALWAYS_IGNORE (§6.1).
function loadGitignore(rootPath: string): (relPath: string, name: string) => boolean {
  const file = join(rootPath, ".gitignore");
  if (!existsSync(file)) return () => false;
  const names = new Set<string>();
  const extGlobs: string[] = [];
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const clean = line.replace(/\/$/, "");
    if (clean.startsWith("*.")) extGlobs.push(clean.slice(1)); // ".log"
    else names.add(clean);
  }
  return (relPath, name) =>
    names.has(name) || names.has(relPath) || extGlobs.some((ext) => name.endsWith(ext));
}

// Walk a repo yielding candidate source files, skipping ignored dirs, gitignored
// entries, and files over maxBytes (§6.1). Synchronous generator (indexer runs
// off the query path; simplicity over async fs here).
export function* walkRepoFiles(
  rootPath: string,
  opts: { maxBytes?: number } = {},
): Generator<WalkedFile> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const ignored = loadGitignore(rootPath);

  function* walk(dir: string): Generator<WalkedFile> {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable dir → skip
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(rootPath, abs).split("\\").join("/");
      if (entry.isDirectory()) {
        if (ALWAYS_IGNORE.has(entry.name) || ignored(rel, entry.name) || VENDOR_PATH_RE.test(`${rel}/`)) continue;
        yield* walk(abs);
      } else if (entry.isFile()) {
        if (ignored(rel, entry.name) || MINIFIED_NAME.test(entry.name) || VENDOR_PATH_RE.test(rel)) continue;
        let st;
        try {
          st = statSync(abs);
        } catch {
          continue;
        }
        if (st.size > maxBytes) continue;
        yield { absPath: abs, relPath: rel, mtimeMs: Math.floor(st.mtimeMs), sizeBytes: st.size };
      }
    }
  }

  yield* walk(rootPath);
}

function gitPaths(rootPath: string, args: string[]): string[] {
  try {
    return execFileSync("git", ["-C", rootPath, ...args], { encoding: "buffer" })
      .toString()
      .split("\0")
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitlinkPaths(rootPath: string): Set<string> {
  try {
    const records = execFileSync("git", ["-C", rootPath, "ls-files", "--stage", "-z"], { encoding: "buffer" })
      .toString()
      .split("\0")
      .filter(Boolean);
    return new Set(records.flatMap((record) => {
      const match = record.match(/^160000\s+\S+\s+\d+\t(.+)$/);
      return match ? [match[1].replaceAll("\\", "/")] : [];
    }));
  } catch {
    return new Set();
  }
}

function safeRelativePath(rootPath: string, filePath: string): string | null {
  const normalized = filePath.replaceAll("\\", "/");
  if (isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  return normalized;
}

function failedFile(absolutePath: string, relativePath: string, gitState: DiscoveredFile["gitState"], reasonCode: "read_error" | "outside_workspace", reason: string): DiscoveredFile {
  return { absolutePath, relativePath, gitState, byteSize: 0, classification: "unknown", coverageStatus: reasonCode === "outside_workspace" ? "excluded" : "failed", reasonCode, reason };
}

export function discoverRepoFiles(
  rootPath: string,
  options: Partial<CoveragePolicy> = {},
): DiscoveredFile[] {
  return discoverRepoCoverage(rootPath, options).files;
}

export function discoverRepoCoverage(
  rootPath: string,
  options: Partial<CoveragePolicy> = {},
): DiscoveryReport {
  const policy = { ...DEFAULT_COVERAGE_POLICY, ...options };
  const tracked = new Set(gitPaths(rootPath, ["ls-files", "--cached", "-z"]));
  const gitlinks = gitlinkPaths(rootPath);
  const candidates = gitPaths(rootPath, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  const ignoredAll = policy.includeIgnoredMetadata
    ? gitPaths(rootPath, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])
    : [];
  const ignored = ignoredAll.slice(0, policy.ignoredMetadataMaxEntries);
  const result: DiscoveredFile[] = [];

  // Some callers index a plain workdir or a lightweight test fixture with a
  // placeholder .git directory. There is no Git candidate truth in that
  // mode, so preserve the existing filesystem walker as an explicit fallback.
  // Real Git repositories always use the ls-files path above.
  if (tracked.size === 0 && candidates.length === 0 && ignoredAll.length === 0) {
    for (const file of walkRepoFiles(rootPath, { maxBytes: policy.hardFileSizeBytes })) {
      let bytes: Buffer;
      try { bytes = readFileSync(file.absPath); } catch {
        result.push(failedFile(file.absPath, file.relPath, "untracked", "read_error", "file could not be read"));
        continue;
      }
      const classification = classifyTextBuffer(bytes, file.relPath, policy);
      result.push({
        absolutePath: file.absPath,
        relativePath: file.relPath,
        gitState: "untracked",
        byteSize: bytes.byteLength,
        classification: classification.classification,
        coverageStatus: classification.status,
        reasonCode: classification.reasonCode,
        reason: classification.reason,
        ...(classification.encoding ? { encoding: classification.encoding } : {}),
        ...(classification.lineCount !== undefined ? { lineCount: classification.lineCount } : {}),
        ...(classification.text !== undefined ? { content: classification.text } : {}),
      });
    }
    return { files: result.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), warnings: [] };
  }

  const seen = new Set<string>();
  const add = (filePath: string, gitState: DiscoveredFile["gitState"]): void => {
    const relativePath = safeRelativePath(rootPath, filePath);
    if (!relativePath || seen.has(relativePath)) return;
    seen.add(relativePath);
    const absolutePath = join(rootPath, relativePath);
    if (gitState === "ignored") {
      const classification = classifyCoveragePath(relativePath, policy);
      result.push({ absolutePath, relativePath, gitState, byteSize: 0, classification: classification.classification, coverageStatus: "excluded", reasonCode: "ignored_by_git", reason: "path is git-ignored; metadata only" });
      return;
    }
    if (gitlinks.has(relativePath)) {
      result.push({ absolutePath, relativePath, gitState, byteSize: 0, classification: "unknown", coverageStatus: "excluded", reasonCode: "submodule", reason: "gitlink entry is a submodule boundary; index the submodule as its own repository" });
      return;
    }
    let stats;
    try { stats = lstatSync(absolutePath); } catch { result.push(failedFile(absolutePath, relativePath, gitState, "read_error", "file disappeared before discovery")); return; }
    if (stats.isSymbolicLink()) {
      try {
        const target = realpathSync(absolutePath);
        const workspace = realpathSync(rootPath);
        if (target !== workspace && !target.startsWith(workspace + "/")) {
          result.push(failedFile(absolutePath, relativePath, gitState, "outside_workspace", "symlink target is outside repository workspace"));
          return;
        }
      } catch {
        result.push(failedFile(absolutePath, relativePath, gitState, "read_error", "symlink target could not be resolved"));
        return;
      }
      result.push({ absolutePath, relativePath, gitState, byteSize: stats.size, classification: "unknown", coverageStatus: "failed", reasonCode: "read_error", reason: "symlink recorded without following target", isSymlink: true });
      return;
    }
    if (!stats.isFile()) {
      result.push({ absolutePath, relativePath, gitState, byteSize: stats.size, classification: "unknown", coverageStatus: "admitted", reasonCode: "text_searchable", reason: "git entry recorded without file content" });
      return;
    }
    let bytes: Buffer;
    try { bytes = readFileSync(absolutePath); } catch { result.push(failedFile(absolutePath, relativePath, gitState, "read_error", "file could not be read")); return; }
    const classification = classifyTextBuffer(bytes, relativePath, policy);
    result.push({
      absolutePath,
      relativePath,
      gitState,
      byteSize: bytes.byteLength,
      classification: classification.classification,
      coverageStatus: classification.status,
      reasonCode: classification.reasonCode,
      reason: classification.reason,
      ...(classification.encoding ? { encoding: classification.encoding } : {}),
      ...(classification.lineCount !== undefined ? { lineCount: classification.lineCount } : {}),
      ...(classification.text !== undefined ? { content: classification.text } : {}),
    });
  };
  for (const filePath of candidates) {
    const gitState = tracked.has(filePath) ? "tracked" : "untracked";
    if (gitState === "tracked" || policy.includeUntracked) add(filePath, gitState);
  }
  for (const filePath of ignored) add(filePath, "ignored");
  return {
    files: result.sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    warnings: ignoredAll.length > ignored.length
      ? [{ code: "IGNORED_METADATA_TRUNCATED", message: "ignored metadata exceeded configured entry limit" }]
      : [],
  };
}
