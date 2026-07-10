import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

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
        if (ALWAYS_IGNORE.has(entry.name) || ignored(rel, entry.name)) continue;
        yield* walk(abs);
      } else if (entry.isFile()) {
        if (ignored(rel, entry.name) || MINIFIED_NAME.test(entry.name)) continue;
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
