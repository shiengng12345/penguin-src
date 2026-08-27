import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
export function isGitRepo(dir) {
    return existsSync(join(dir, ".git"));
}
// One level deep on purpose: the wrong-cwd case is a flat folder of checkouts.
// Deeper nesting (monorepos, vendored trees) stays the user's explicit call.
export function discoverSubRepos(dir) {
    let names;
    try {
        names = readdirSync(dir, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => !name.startsWith(".") && isGitRepo(join(dir, name)))
        .map((name) => ({ name, path: join(dir, name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
//# sourceMappingURL=multi-repo.js.map