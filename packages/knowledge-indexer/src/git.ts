import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface GitContext {
  isGit: boolean;
  branch: string; // real branch name, "(detached)", or "(workdir)" for non-git
  commit: string | null;
  checkoutPath: string; // the working directory being indexed
  // Repo name derived from the `origin` remote URL (e.g. penguin-src), or null
  // when there's no remote — callers fall back to the local folder name.
  repoName: string | null;
}

// Pull the `origin` remote URL out of .git/config and reduce it to a repo name:
//   git@github.com:org/penguin-src.git  → penguin-src
//   https://host/org/repo.git           → repo
function readRepoName(gitDir: string): string | null {
  const cfg = join(commonDir(gitDir), "config");
  if (!existsSync(cfg)) return null;
  const text = readFileSync(cfg, "utf8");
  // find the origin remote's url (fall back to the first remote url found)
  const origin = text.match(/\[remote "origin"\][^[]*?url\s*=\s*(.+)/);
  const any = text.match(/url\s*=\s*(.+)/);
  const url = (origin?.[1] ?? any?.[1] ?? "").trim();
  if (!url) return null;
  const last = url.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop();
  return last || null;
}

// Resolve the git dir for a path: a `.git` directory, or a `.git` file
// ("gitdir: <path>" — submodule/worktree), searching upward (§4.8). null = non-git.
function findGitDir(rootPath: string): { gitDir: string; worktreeRoot: string } | null {
  let dir = resolve(rootPath);
  for (;;) {
    const dotgit = join(dir, ".git");
    if (existsSync(dotgit)) {
      const st = statSync(dotgit);
      // `dir` is the working-tree root regardless of .git being a dir or a file.
      if (st.isDirectory()) return { gitDir: dotgit, worktreeRoot: dir };
      if (st.isFile()) {
        const m = readFileSync(dotgit, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
        if (m) {
          const target = m[1].trim();
          return { gitDir: isAbsolute(target) ? target : resolve(dir, target), worktreeRoot: dir };
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
  const found = findGitDir(rootPath);
  // A git repo's identity is its WORKTREE ROOT, not the arbitrary subdir passed
  // in — so indexing repo/ and repo/src-tauri/ resolve to the same repo (no
  // duplicate). Non-git falls back to the given path.
  const checkoutPath = found ? found.worktreeRoot : resolve(rootPath);
  if (!found || !existsSync(join(found.gitDir, "HEAD"))) {
    return { isGit: false, branch: "(workdir)", commit: null, checkoutPath, repoName: null };
  }
  const gitDir = found.gitDir;
  const repoName = readRepoName(gitDir);
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const refMatch = head.match(/^ref:\s*(.+)$/);
  if (refMatch) {
    const ref = refMatch[1].trim(); // refs/heads/<branch>
    const branch = ref.replace(/^refs\/heads\//, "");
    return { isGit: true, branch, commit: resolveRef(gitDir, ref), checkoutPath, repoName };
  }
  // detached HEAD: HEAD is a raw sha
  if (/^[0-9a-f]{7,40}$/i.test(head)) {
    return { isGit: true, branch: "(detached)", commit: head, checkoutPath, repoName };
  }
  return { isGit: true, branch: "(workdir)", commit: null, checkoutPath, repoName };
}
