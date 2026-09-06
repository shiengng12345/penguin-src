import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { KnowledgeStore, buildOnboardingDocument, readPersistedCorpusTruth } from "../packages/knowledge-core/dist/index.js";
import { indexRepo } from "../packages/knowledge-indexer/dist/index.js";
import { CAPABILITIES, createSurfaceRegistrations } from "../packages/knowledge-contracts/dist/index.js";

function put(root, path, content) {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

function repo(prefix, files) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  for (const [path, content] of Object.entries(files)) put(root, path, content);
  execFileSync("git", ["add", "-A"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: root, stdio: "ignore" });
  return root;
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), "penguin-onboarding-canonical-"));
  return {
    store: KnowledgeStore.open({ dbPath: join(dir, "knowledge.db"), ledgerPath: join(dir, "ledger.jsonl") }),
  };
}

test("Rust onboarding selects Cargo checks and never recommends pnpm as the primary tool", async () => {
  const { store } = open();
  const root = repo("penguin-onboarding-rust-", {
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    "src/main.rs": "fn main() {}\n",
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const onboarding = buildOnboardingDocument(store, report.repoId).markdown;
    assert.match(onboarding, /技术栈：Rust\/Cargo/);
    assert.match(onboarding, /`cargo check`/);
    assert.match(onboarding, /`cargo test`/);
    assert.doesNotMatch(onboarding, /`pnpm test`/);
    // The count comes from the persisted canonical snapshot projection,
    // including both the Cargo manifest and admitted Rust source.
    assert.match(onboarding, /已索引文件：2/);
  } finally {
    store.close();
  }
});

test("Node onboarding reports canonical files and current-revision endpoints once", async () => {
  const { store } = open();
  const root = repo("penguin-onboarding-node-", {
    "package.json": JSON.stringify({ name: "fixture", scripts: { test: "node --test", typecheck: "tsc --noEmit" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "proto/health.proto": "syntax = \"proto3\"; package fixture; message Req {} message Res {} service HealthService { rpc Check (Req) returns (Res); }\n",
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const onboarding = buildOnboardingDocument(store, report.repoId).markdown;
    assert.match(onboarding, /技术栈：Node\/pnpm workspace/);
    assert.match(onboarding, /`pnpm test`/);
    assert.match(onboarding, /`pnpm run typecheck`/);
    assert.match(onboarding, /当前 revision endpoints：1/);
    assert.equal((onboarding.match(/fixture\.HealthService\.Check/g) ?? []).length, 1);
    assert.match(onboarding, /当前 revision 未发现已索引 endpoint|fixture\.HealthService\.Check/);
  } finally {
    store.close();
  }
});

test("onboarding uses canonical wire names and never aliases in tool call examples", async () => {
  const { store } = open();
  const root = repo("penguin-onboarding-wirenames-", {
    "package.json": JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const onboarding = buildOnboardingDocument(store, report.repoId).markdown;
    // Capability aliases must not appear as callable tool names (backtick-enclosed calls)
    assert.doesNotMatch(onboarding, /`get_architecture\s*\(/);
    assert.doesNotMatch(onboarding, /`index_status\s*\(/);
    assert.doesNotMatch(onboarding, /`get_node\s*\(/);
    // The canonical wire names must be present instead
    assert.match(onboarding, /`knowledge_architecture\s*\(/);
    assert.match(onboarding, /`knowledge_index_status\s*\(/);
    assert.match(onboarding, /`knowledge_get_node\s*\(/);
  } finally {
    store.close();
  }
});

test("onboarding omits a capability wire name when absent from the injected manifest", async () => {
  const { store } = open();
  const root = repo("penguin-onboarding-no-flow-", {
    "package.json": JSON.stringify({ name: "fixture" }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const reducedRegistrations = createSurfaceRegistrations("mcp",
      CAPABILITIES.filter((c) => c.id !== "knowledge.flow"));
    const onboarding = buildOnboardingDocument(store, report.repoId, reducedRegistrations).markdown;
    // knowledge_flow must not appear in the onboarding when capability is absent from manifest
    assert.doesNotMatch(onboarding, /knowledge_flow/);
    // A full-manifest onboarding must still include the flow wire name
    const fullOnboarding = buildOnboardingDocument(store, report.repoId).markdown;
    assert.match(fullOnboarding, /knowledge_flow/);
  } finally {
    store.close();
  }
});

test("onboarding counts match readPersistedCorpusTruth canonical projection", async () => {
  const { store } = open();
  const root = repo("penguin-onboarding-count-parity-", {
    "package.json": JSON.stringify({ name: "fixture", scripts: { test: "node --test" } }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "src/a.ts": "export function a() {}\n",
    "src/b.ts": "export function b() {}\n",
  });
  try {
    const report = await indexRepo({ store, rootPath: root, mode: "incremental" });
    const branchRow = store.db
      .prepare("SELECT id, current_snapshot_id FROM branches WHERE repo_id=? AND status='live' LIMIT 1")
      .get(report.repoId);
    assert.ok(branchRow, "a live branch must exist after indexing");
    const persisted = readPersistedCorpusTruth(store, {
      repoId: report.repoId,
      branchId: branchRow.id,
      snapshotId: branchRow.current_snapshot_id,
    });
    const onboarding = buildOnboardingDocument(store, report.repoId).markdown;
    // Displayed file count must match the canonical persisted projection
    assert.match(onboarding, new RegExp(`已索引文件：${persisted.counts.files}(?:[^0-9]|$)`));
    // Displayed symbol count must match
    assert.match(onboarding, new RegExp(`当前 revision symbols：${persisted.counts.symbols}(?:[^0-9]|$)`));
  } finally {
    store.close();
  }
});
