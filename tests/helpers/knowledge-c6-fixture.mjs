import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KnowledgeStore } from "../../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../../packages/knowledge-indexer/dist/index.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin C6 Fixture",
  GIT_AUTHOR_EMAIL: "penguin-c6@example.invalid",
  GIT_COMMITTER_NAME: "Penguin C6 Fixture",
  GIT_COMMITTER_EMAIL: "penguin-c6@example.invalid",
};

function initGit(root) {
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: gitEnv, stdio: "ignore" });
  execFileSync("git", ["-C", root, "add", "."], { env: gitEnv, stdio: "ignore" });
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "fixture"], { env: gitEnv, stdio: "ignore" });
}

export async function createIndexedC6Fixture({ repoCount = 1, filesPerRepo = 3 } = {}) {
  const parent = mkdtempSync(join(tmpdir(), "penguin-c6-corpus-"));
  const roots = [];
  for (let repoIndex = 0; repoIndex < repoCount; repoIndex += 1) {
    const root = join(parent, `repo-${repoIndex}`);
    mkdirSync(join(root, "src"), { recursive: true });
    for (let fileIndex = 0; fileIndex < filesPerRepo; fileIndex += 1) {
      writeFileSync(
        join(root, "src", `fixture-${fileIndex}.ts`),
        `export function c6Fixture${repoIndex}_${fileIndex}() { return "fixture-${repoIndex}-${fileIndex}"; }\n`,
      );
    }
    initGit(root);
    roots.push(root);
  }
  const databaseDirectory = mkdtempSync(join(tmpdir(), "penguin-c6-db-"));
  const dbPath = join(databaseDirectory, "knowledge.db");
  const ledgerPath = join(databaseDirectory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  for (const root of roots) {
    await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: false } });
  }
  return { parent, roots, databaseDirectory, dbPath, ledgerPath, store };
}

export function closeFixture(fixture) {
  fixture?.store?.close();
}
