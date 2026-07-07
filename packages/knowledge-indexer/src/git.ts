import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitContext {
  isGit: boolean;
  branch: string; // real branch name, "(detached)", or "(workdir)" for non-git
  commit: string | null;
  checkoutPath: string; // the working directory being indexed
}

// Resolve the git dir for a path: a `.git` directory, or a `.git` file
// ("gitdir: <path>" — submodule/worktree), searching upward (§4.8). null = non-git.
function findGitDir(rootPath: string): string | null {
  let dir = resolve(rootPath);
  for (;;) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      const st = statSync(dotgit);
      if (st.isDirectory()) return dotgit;
      if (st.isFile()) {
        const m = readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
        if (m) {
          const target = m[1].trim();
          return isAbsolute(target) ? target : resolve(dir, target);
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// For worktrees the per-worktree gitdir has a `commondir` pointing at the main
// git dir where packed-refs / refs live.
function commonDir(gitDir: string): string {
  const cd = join(gitDir, "commondir");
  if (existsSync(cd)) {
    const target = readFileSync(cd, "utf8").trim();
    return isAbsolute(target) ? target : resolve(gitDir, target);
  }
  return gitDir;
}

function resolveRef(gitDir: string, ref: string): string | null {
  const common = commonDir(gitDir);
  for (const base of new Set([gitDir, common])) {
    const loose = join(base, ref);
    if (existsSync(loose)) {
      return readFileSync(loose, "utf8").trim() || null;
    }
  }
  // packed-refs fallback
  for (const base of new Set([gitDir, common])) {
    const packed = join(base, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf8").split("\n")) {
        if (line.startsWith("#") || line.startsWith("^") || !line.trim()) continue;
        const [sha, name] = line.trim().split(/\s+/, 2);
        if (name === ref) return sha;
      }
    }
  }
  return null;
}

// Parse the git context of a working directory using only file reads (no git
// CLI, §4.8). Non-git → implicit "(workdir)" branch so downstream code has one
// path (the "code edges carry branch_id" rule needs no special-case).
export function readGitContext(rootPath: string): GitContext {
  const checkoutPath = resolve(rootPath);
  const gitDir = findGitDir(rootPath);
  if (!gitDir || !existsSync(join(gitDir, "HEAD"))) {
    return { isGit: false, branch: "(workdir)", commit: null, checkoutPath };
  }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (refMatch) {
    const ref = refMatch[1].trim(); // refs/heads/<branch>
    const branch = ref.replace(/^refs\/heads\//, "");
    return { isGit: true, branch, commit: resolveRef(gitDir, ref), checkoutPath };
  }
  // detached HEAD: HEAD is a raw sha
  if (/^[0-9a-f]{7,40}$/i.test(head)) {
    return { isGit: true, branch: "(detached)", commit: head, checkoutPath };
  }
  return { isGit: true, branch: "(workdir)", commit: null, checkoutPath };
}
