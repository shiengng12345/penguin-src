import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { discoverRepoCoverage, discoverRepoFiles } from "../packages/knowledge-indexer/dist/walk.js";

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

test("discovery follows git truth for tracked/untracked/ignored and nested gitignore", () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-discovery-"));
  const submodule = mkdtempSync(join(tmpdir(), "pk-discovery-submodule-"));
  git(repo, "init", "-q");
  git(submodule, "init", "-q");
  git(submodule, "config", "user.email", "test@example.invalid");
  git(submodule, "config", "user.name", "Penguin Test");
  writeFileSync(join(submodule, "module.ts"), "export const submodule = true;\n");
  git(submodule, "add", "module.ts");
  git(submodule, "commit", "-qm", "submodule fixture");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "user.name", "Penguin Test");
  writeFileSync(join(repo, ".gitignore"), "ignored-root/\n");
  mkdirSync(join(repo, "nested"));
  writeFileSync(join(repo, "nested", ".gitignore"), "ignored-nested.txt\n");
  writeFileSync(join(repo, "tracked.ts"), "tracked");
  mkdirSync(join(repo, "ignored-root"), { recursive: true });
  writeFileSync(join(repo, "ignored-root", "ignored.txt"), "ignored");
  writeFileSync(join(repo, "nested", "ignored-nested.txt"), "ignored");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture");
  git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", submodule, "modules/child");
  git(repo, "commit", "-qm", "add submodule");
  writeFileSync(join(repo, "untracked.ts"), "untracked");
  writeFileSync(join(repo, "nested", "kept.txt"), "kept");
  const files = discoverRepoFiles(repo);
  const byPath = new Map(files.map((file) => [file.relativePath, file]));
  assert.equal(byPath.get("tracked.ts")?.gitState, "tracked");
  assert.equal(byPath.get("untracked.ts")?.gitState, "untracked");
  assert.equal(byPath.get("ignored-root/ignored.txt")?.gitState, "ignored");
  assert.equal(byPath.get("nested/ignored-nested.txt")?.gitState, "ignored");
  assert.equal(byPath.get("nested/kept.txt")?.gitState, "untracked");
  assert.equal(byPath.get("modules/child")?.gitState, "tracked");
  assert.equal(byPath.get("modules/child")?.coverageStatus, "excluded");
  assert.equal(discoverRepoFiles(repo, { includeUntracked: false }).some((file) => file.gitState === "untracked"), false);
  rmSync(join(repo, "tracked.ts"));
  assert.equal(discoverRepoFiles(repo).find((file) => file.relativePath === "tracked.ts")?.coverageStatus, "failed");
});

test("discovery records ignored metadata without reading ignored content and normalizes paths", () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-discovery-ignored-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, ".gitignore"), "*.secret\n");
  writeFileSync(join(repo, "private.secret"), "DO_NOT_READ");
  writeFileSync(join(repo, ".env"), "SECRET_TOKEN=DO_NOT_READ");
  writeFileSync(join(repo, ".gitignore"), "*.secret\n.env\n");
  const files = discoverRepoFiles(repo, { includeIgnoredMetadata: true });
  const ignored = files.find((file) => file.relativePath === "private.secret");
  assert.equal(ignored?.gitState, "ignored");
  assert.equal(ignored?.coverageStatus, "excluded");
  assert.equal(ignored?.reasonCode, "ignored_by_git");
  assert.equal(files.find((file) => file.relativePath === ".env")?.content, undefined);
  assert.ok(files.every((file) => !file.relativePath.includes("\\")));
});

test("discovery bounds ignored metadata and preserves admitted large text", () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-discovery-large-"));
  git(repo, "init", "-q");
  writeFileSync(join(repo, ".gitignore"), "*.ignored\n");
  for (const name of ["one.ignored", "two.ignored"]) writeFileSync(join(repo, name), "ignored");
  writeFileSync(join(repo, "large.txt"), "large-needle\n".repeat(150000));
  const report = discoverRepoCoverage(repo, { ignoredMetadataMaxEntries: 1 });
  assert.equal(report.warnings[0]?.code, "IGNORED_METADATA_TRUNCATED");
  assert.equal(report.files.find((file) => file.relativePath === "large.txt")?.coverageStatus, "admitted");
});

test("discovery records symlink itself and marks outside-workspace target", () => {
  const repo = mkdtempSync(join(tmpdir(), "pk-discovery-link-"));
  git(repo, "init", "-q");
  const outside = mkdtempSync(join(tmpdir(), "pk-outside-"));
  writeFileSync(join(outside, "secret.ts"), "outside");
  symlinkSync(join(outside, "secret.ts"), join(repo, "outside-link.ts"));
  const file = discoverRepoFiles(repo).find((entry) => entry.relativePath === "outside-link.ts");
  assert.equal(file?.coverageStatus, "excluded");
  assert.equal(file?.reasonCode, "outside_workspace");
});
