import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function frame(hash, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

/**
 * Content-address the exact tracked and non-ignored worktree. Dirty builds are
 * labelled worktree:<sha256>; they are never represented as clean HEAD builds.
 */
export function workingTreeProvenance(rootInput) {
  const root = resolve(rootInput);
  const sourceCommit = git(root, ["rev-parse", "HEAD"]).trim();
  const sourceTree = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const dirtyFiles = git(root, ["status", "--porcelain=v1", "--untracked-files=all"])
    .split(/\r?\n/u).filter(Boolean);
  const files = [...new Set(git(root, ["ls-files", "-co", "--exclude-standard", "-z"])
    .split("\0").filter(Boolean))].sort();
  const hash = createHash("sha256");
  frame(hash, "penguin-worktree-v1");
  frame(hash, sourceCommit);
  frame(hash, sourceTree);
  for (const status of dirtyFiles) frame(hash, status);
  for (const relativePath of files) {
    frame(hash, relativePath);
    const absolutePath = resolve(root, relativePath);
    try {
      const stat = lstatSync(absolutePath);
      const mode = stat.mode & 0o777;
      if (stat.isSymbolicLink()) {
        frame(hash, `symlink:${mode.toString(8)}`);
        frame(hash, readlinkSync(absolutePath));
      } else if (stat.isFile()) {
        frame(hash, `file:${mode.toString(8)}`);
        frame(hash, readFileSync(absolutePath));
      } else {
        frame(hash, `special:${mode.toString(8)}`);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      frame(hash, "missing");
    }
  }
  const worktreeDigest = hash.digest("hex");
  const state = dirtyFiles.length === 0 ? "clean" : "dirty";
  return {
    sourceCommit,
    sourceTree,
    state,
    dirtyFiles,
    includedFileCount: files.length,
    worktreeDigest,
    sourceIdentity: state === "clean" ? sourceCommit : `worktree:${worktreeDigest}`,
  };
}
