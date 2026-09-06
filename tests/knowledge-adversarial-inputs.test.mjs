import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  HmacSearchCursorCodec,
  KnowledgeStore,
  assertWorkspacePath,
  canonicalPathForCheck,
} from "../packages/knowledge-core/dist/index.js";
import { DEFAULT_COVERAGE_POLICY, classifyTextBuffer, discoverRepoCoverage, indexRepo, isLikelyMinified } from "../packages/knowledge-indexer/dist/index.js";
import {
  MutationTargetResolutionError,
  resolveMutationTargetRoot,
} from "../packages/knowledge-core/dist/target-resolution.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Penguin C6 Adversarial Fixture",
  GIT_AUTHOR_EMAIL: "penguin-c6@example.invalid",
  GIT_COMMITTER_NAME: "Penguin C6 Adversarial Fixture",
  GIT_COMMITTER_EMAIL: "penguin-c6@example.invalid",
};

function git(root, ...args) {
  execFileSync("git", ["-C", root, ...args], { env: gitEnv, stdio: "ignore" });
}

function initRepo(root) {
  execFileSync("git", ["init", "-q", "-b", "main", root], { env: gitEnv, stdio: "ignore" });
  writeFileSync(join(root, ".penguin-fixture"), "fixture\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
}

test("C6 adversarial paths and text classes stay bounded and typed", () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-c6-adversarial-root-"));
  const outside = mkdtempSync(join(tmpdir(), "penguin-c6-adversarial-outside-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(outside, "outside-secret.ts"), "export const mustNotBeRead = true;\n");
  symlinkSync(join(outside, "outside-secret.ts"), join(root, "src", "outside-link.ts"));
  initRepo(root);

  const outsideLink = discoverRepoCoverage(root).files.find((file) => file.relativePath === "src/outside-link.ts");
  assert.equal(outsideLink?.coverageStatus, "excluded");
  assert.equal(outsideLink?.reasonCode, "outside_workspace");
  assert.equal(outsideLink?.content, undefined, "an outside symlink must never be read into the corpus");

  const aliasDirectory = mkdtempSync(join(tmpdir(), "penguin-c6-adversarial-alias-"));
  const alias = join(aliasDirectory, "repo");
  symlinkSync(root, alias);
  assert.equal(canonicalPathForCheck(alias), canonicalPathForCheck(root));
  assert.equal(assertWorkspacePath(alias, [root]), canonicalPathForCheck(root));
  assert.throws(
    () => assertWorkspacePath(join(root, "..", "outside-target"), [root]),
    /WORKSPACE_SCOPE_DENIED/,
  );

  const empty = classifyTextBuffer(Buffer.from(""), "empty.ts", DEFAULT_COVERAGE_POLICY);
  assert.equal(empty.status, "admitted");
  assert.equal(empty.lineCount, 0);
  const binary = classifyTextBuffer(Buffer.from([0x65, 0x00, 0x66]), "data.bin", DEFAULT_COVERAGE_POLICY);
  assert.equal(binary.status, "excluded");
  assert.equal(binary.reasonCode, "binary");
  const hardLimit = classifyTextBuffer(Buffer.from("123456789"), "large.ts", { ...DEFAULT_COVERAGE_POLICY, hardFileSizeBytes: 8 });
  assert.equal(hardLimit.status, "excluded");
  assert.equal(hardLimit.reasonCode, "hard_size_limit");
  assert.equal(isLikelyMinified("const packed = ".padEnd(4_001, "x")), true);

  const cursor = new HmacSearchCursorCodec("c6-adversarial-secret");
  assert.throws(() => cursor.decode("not-a-valid-cursor"), /CURSOR_INVALID/);
});

test("C6 indexing tolerates binary, secret, minified, and deleted files without mutating source", async () => {
  const root = mkdtempSync(join(tmpdir(), "penguin-c6-adversarial-index-"));
  mkdirSync(join(root, "src"), { recursive: true });
  const valid = join(root, "src", "valid.ts");
  const deleted = join(root, "src", "deleted.ts");
  writeFileSync(valid, "export function adversarialValidSymbol() { return 'safe'; }\n");
  writeFileSync(deleted, "export function adversarialDeletedSymbol() { return 'retire-me'; }\n");
  writeFileSync(join(root, "src", "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(join(root, ".env"), "TOKEN=must-not-enter-index\n");
  writeFileSync(join(root, "src", "packed.js"), "const packed = ".padEnd(4_001, "x"));
  initRepo(root);

  const beforeHash = createHash("sha256").update(readFileSync(valid)).digest("hex");
  const directory = mkdtempSync(join(tmpdir(), "penguin-c6-adversarial-db-"));
  const dbPath = join(directory, "knowledge.db");
  const ledgerPath = join(directory, "ledger.jsonl");
  const store = KnowledgeStore.open({ dbPath, ledgerPath });
  const first = await indexRepo({ store, rootPath: root, mode: "rebuild", semantic: { enabled: false } });
  assert.equal(first.errors, 0, JSON.stringify(first));
  assert.ok(first.parsed >= 2, `valid source files must remain searchable: ${JSON.stringify(first)}`);
  assert.equal(createHash("sha256").update(readFileSync(valid)).digest("hex"), beforeHash);

  const coverage = store.db.prepare(`
    SELECT file_path AS filePath,coverage_status AS coverageStatus,reason_code AS reasonCode,
           parser_status AS parserStatus,parser_error AS parserError
      FROM coverage_records WHERE repo_id=? ORDER BY file_path
  `).all(first.repoId);
  assert.equal(coverage.find((row) => row.filePath === ".env")?.reasonCode, "secret_policy");
  assert.equal(coverage.find((row) => row.filePath === "src/binary.bin")?.reasonCode, "binary");
  assert.equal(coverage.find((row) => row.filePath === "src/packed.js")?.parserStatus, "excluded");
  assert.equal(coverage.some((row) => row.parserError?.includes("must-not-enter-index")), false);

  unlinkSync(deleted);
  const second = await indexRepo({ store, rootPath: root, mode: "incremental", semantic: { enabled: false } });
  assert.equal(second.errors, 0, JSON.stringify(second));
  assert.ok(second.deleted >= 1, `deleted tracked files must retire cleanly: ${JSON.stringify(second)}`);
  assert.equal(createHash("sha256").update(readFileSync(valid)).digest("hex"), beforeHash);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM meta WHERE key LIKE 'index_lock::%'").get().count, 0);
  store.close();
});

test("strict mutation target resolution rejects malformed, unsafe, and non-repository roots", () => {
  const workspace = mkdtempSync(join(tmpdir(), "penguin-mutation-workspace-"));
  const validRepo = join(workspace, "valid-repo");
  const nonGitDirectory = join(workspace, "plain-directory");
  const regularFile = join(workspace, "regular-file");
  const outside = mkdtempSync(join(tmpdir(), "penguin-mutation-outside-"));
  const outsideRepo = join(outside, "outside-repo");
  mkdirSync(validRepo);
  mkdirSync(nonGitDirectory);
  mkdirSync(outsideRepo);
  writeFileSync(regularFile, "not a directory\n");
  initRepo(validRepo);
  initRepo(outsideRepo);
  const escape = join(workspace, "escape");
  symlinkSync(outsideRepo, escape, "dir");

  const reject = (requestedRoot, code) => assert.throws(
    () => resolveMutationTargetRoot({
      action: "register",
      requestedRoot,
      ownerApprovedRoots: [workspace],
    }),
    (error) => error instanceof MutationTargetResolutionError && error.code === code,
  );

  reject("", "ROOT_PATH_REQUIRED");
  reject("relative/repo", "MUTATION_PREFLIGHT_INVALID");
  reject(join(workspace, "missing"), "MUTATION_PREFLIGHT_INVALID");
  reject(regularFile, "MUTATION_PREFLIGHT_INVALID");
  reject(nonGitDirectory, "MUTATION_PREFLIGHT_INVALID");
  reject(outsideRepo, "ROOT_PATH_OUT_OF_SCOPE");
  reject(escape, "ROOT_PATH_OUT_OF_SCOPE");

  const resolved = resolveMutationTargetRoot({
    action: "register",
    requestedRoot: validRepo,
    ownerApprovedRoots: [workspace],
  });
  assert.equal(resolved.rootPath, canonicalPathForCheck(validRepo));
  assert.equal(resolved.repositoryRoot, resolved.rootPath);
});

test("confirmed mutation recheck requires the exact canonical root and detects a symlink swap", () => {
  const workspace = mkdtempSync(join(tmpdir(), "penguin-mutation-recheck-"));
  const firstRepo = join(workspace, "first");
  const secondRepo = join(workspace, "second");
  mkdirSync(firstRepo);
  mkdirSync(secondRepo);
  initRepo(firstRepo);
  initRepo(secondRepo);
  const alias = join(workspace, "selected");
  symlinkSync(firstRepo, alias, "dir");

  const preflight = resolveMutationTargetRoot({
    action: "rebuild",
    requestedRoot: alias,
    ownerApprovedRoots: [workspace],
  });
  assert.equal(preflight.rootPath, canonicalPathForCheck(firstRepo));

  assert.throws(
    () => resolveMutationTargetRoot({
      action: "rebuild",
      requestedRoot: alias,
      ownerApprovedRoots: [workspace],
      requireCanonicalInput: true,
    }),
    (error) => error instanceof MutationTargetResolutionError && error.code === "MUTATION_TARGET_CHANGED",
  );

  unlinkSync(alias);
  symlinkSync(secondRepo, alias, "dir");
  assert.throws(
    () => resolveMutationTargetRoot({
      action: "rebuild",
      requestedRoot: alias,
      ownerApprovedRoots: [workspace],
      expectedCanonicalRoot: preflight.rootPath,
      requireCanonicalInput: true,
    }),
    (error) => error instanceof MutationTargetResolutionError && error.code === "MUTATION_TARGET_CHANGED",
  );
});
