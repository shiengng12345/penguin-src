import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// `penguin init` aimed at a parent folder of checkouts (~/Projects) used to
// index the whole tree as ONE repo — tens of thousands of files, wrong
// semantics, looked "stuck". These helpers detect that case so the CLI can
// offer a picker instead.

export interface RepoCandidate {
  name: string;
  path: string;
}

export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

// One level deep on purpose: the wrong-cwd case is a flat folder of checkouts.
// Deeper nesting (monorepos, vendored trees) stays the user's explicit call.
export function discoverSubRepos(dir: string): RepoCandidate[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.startsWith(".") && isGitRepo(join(dir, name)))
    .map((name) => ({ name, path: join(dir, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
